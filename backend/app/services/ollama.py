import json
import time
from dataclasses import dataclass
from urllib.error import URLError
from urllib.request import Request, urlopen

OLLAMA_URL = "http://127.0.0.1:11434"
MODEL = "qwen3:4b"
CONTEXT_SIZE = 4096


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
