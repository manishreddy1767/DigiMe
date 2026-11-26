import json
from io import BytesIO
from unittest.mock import patch

from fastapi.testclient import TestClient

from app.main import app
from app.services.ollama import (
    CONTEXT_SIZE,
    MAX_CONTEXT_CHARS,
    MODEL,
    OllamaService,
    SYSTEM_PROMPT,
    build_bounded_chat_messages,
)


class MockResponse(BytesIO):
    def __enter__(self) -> "MockResponse":
        return self

    def __exit__(self, *args: object) -> None:
        self.close()


def test_context_is_bounded_and_keeps_most_recent_messages() -> None:
    messages = [
        {"role": "user" if index % 2 == 0 else "assistant", "content": "x" * 4_000}
        for index in range(40)
    ]
    messages[-1]["role"] = "user"

    bounded = build_bounded_chat_messages(messages)

    assert bounded[0] == {"role": "system", "content": SYSTEM_PROMPT}
    assert bounded[-1] == {"role": "user", "content": "x" * 4_000}
    assert sum(len(message["content"]) for message in bounded) <= MAX_CONTEXT_CHARS
    assert len(bounded) <= 1 + 20


def test_ollama_chat_uses_local_qwen_and_returns_mocked_response() -> None:
    mocked_response = MockResponse(
        json.dumps({"message": {"content": "Hello from the local model."}}).encode()
    )
    messages = [{"role": "user", "content": "Hello"}]

    with patch("app.services.ollama.urlopen", return_value=mocked_response) as mocked_urlopen:
        result = OllamaService().generate_chat_response(messages)

    request = mocked_urlopen.call_args.args[0]
    request_body = json.loads(request.data)
    assert request.full_url == "http://127.0.0.1:11434/api/chat"
    assert request_body["model"] == MODEL
    assert request_body["options"]["num_ctx"] == CONTEXT_SIZE
    assert request_body["messages"][-1] == messages[0]
    assert result == "Hello from the local model."


def test_endpoint_returns_mocked_response_and_rejects_invalid_history() -> None:
    client = TestClient(app)
    with patch(
        "app.main.OllamaService.generate_chat_response",
        return_value="Mocked answer",
    ) as mocked_chat:
        response = client.post(
            "/api/chat",
            json={"messages": [{"role": "user", "content": "Hi"}]},
        )
        invalid_response = client.post(
            "/api/chat",
            json={"messages": [{"role": "assistant", "content": "Not a user turn"}]},
        )

    assert response.status_code == 200
    assert response.json() == {"message": "Mocked answer"}
    assert invalid_response.status_code == 422
    mocked_chat.assert_called_once_with([{"role": "user", "content": "Hi"}])


def test_endpoint_returns_gateway_error_when_ollama_is_unavailable() -> None:
    with patch(
        "app.main.OllamaService.generate_chat_response",
        side_effect=RuntimeError("Could not reach local Ollama."),
    ):
        response = TestClient(app).post(
            "/api/chat",
            json={"messages": [{"role": "user", "content": "Hi"}]},
        )

    assert response.status_code == 502
    assert response.json()["detail"] == "Could not reach local Ollama."
