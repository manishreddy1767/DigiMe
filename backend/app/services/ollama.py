import json
import time
from dataclasses import dataclass
from urllib.error import URLError
from urllib.request import Request, urlopen

OLLAMA_URL = "http://127.0.0.1:11434"
MODEL = "qwen3:4b"
CONTEXT_SIZE = 4096
MAX_HISTORY_MESSAGES = 20
MAX_CONTEXT_CHARS = 12_000
SYSTEM_PROMPT = (
    "You are Digital Me, a personal AI assistant. Be helpful and conversational. "
    "Do not invent personal facts or experiences; say when you do not know."
)


@dataclass(frozen=True)
class GenerationResult:
    text: str
    elapsed_seconds: float
    token_count: int | None
    tokens_per_second: float | None


class OllamaService:
    def generate_check_response(self) -> GenerationResult:
        request_body = {
            "model": MODEL,
            "prompt": "Reply in one short sentence confirming local inference is working.",
            "stream": False,
            "keep_alive": "0",
            "options": {
                "num_ctx": CONTEXT_SIZE,
                "temperature": 0.1,
            },
        }
        request = Request(
            f"{OLLAMA_URL}/api/generate",
            data=json.dumps(request_body).encode("utf-8"),
            headers={"Content-Type": "application/json"},
            method="POST",
        )

        started = time.perf_counter()
        try:
            with urlopen(request, timeout=600) as response:
                payload = json.load(response)
        except URLError as error:
            raise RuntimeError(
                "Could not reach Ollama at 127.0.0.1:11434. Start Ollama and "
                f"ensure {MODEL} is available."
            ) from error

        elapsed = time.perf_counter() - started
        text = payload.get("response", "").strip()
        if not text:
            raise RuntimeError(f"Ollama returned no generated text: {payload!r}")

        token_count = payload.get("eval_count")
        eval_duration = payload.get("eval_duration")
        tokens_per_second = None
        if isinstance(token_count, int) and isinstance(eval_duration, int) and eval_duration > 0:
            tokens_per_second = token_count / (eval_duration / 1_000_000_000)

        return GenerationResult(
            text=text,
            elapsed_seconds=elapsed,
            token_count=token_count if isinstance(token_count, int) else None,
            tokens_per_second=tokens_per_second,
        )

    def generate_chat_response(self, messages: list[dict[str, str]]) -> str:
        bounded_messages = build_bounded_chat_messages(messages)
        request_body = {
            "model": MODEL,
            "messages": bounded_messages,
            "stream": False,
            "options": {
                "num_ctx": CONTEXT_SIZE,
            },
        }
        request = Request(
            f"{OLLAMA_URL}/api/chat",
            data=json.dumps(request_body).encode("utf-8"),
            headers={"Content-Type": "application/json"},
            method="POST",
        )

        try:
            with urlopen(request, timeout=600) as response:
                payload = json.load(response)
        except (URLError, TimeoutError) as error:
            raise RuntimeError(
                "Could not reach Ollama at 127.0.0.1:11434. Start Ollama and "
                f"ensure {MODEL} is available."
            ) from error
        except (json.JSONDecodeError, UnicodeDecodeError) as error:
            raise RuntimeError("Ollama returned an invalid chat response.") from error

        if not isinstance(payload, dict):
            raise RuntimeError("Ollama returned an invalid chat response.")

        response_message = payload.get("message")
        text = (
            response_message.get("content", "").strip()
            if isinstance(response_message, dict)
            and isinstance(response_message.get("content"), str)
            else ""
        )
        if not text:
            raise RuntimeError("Ollama returned no chat text.")

        return text


def build_bounded_chat_messages(messages: list[dict[str, str]]) -> list[dict[str, str]]:
    remaining_chars = MAX_CONTEXT_CHARS - len(SYSTEM_PROMPT)
    selected: list[dict[str, str]] = []

    for message in reversed(messages[-MAX_HISTORY_MESSAGES:]):
        content = message["content"].strip()
        if not content or remaining_chars <= 0:
            continue

        content = content[-remaining_chars:]
        selected.append({"role": message["role"], "content": content})
        remaining_chars -= len(content)

    return [{"role": "system", "content": SYSTEM_PROMPT}, *reversed(selected)]
