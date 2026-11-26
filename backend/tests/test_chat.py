import json
from io import BytesIO
from unittest.mock import patch

from fastapi.testclient import TestClient

from app.main import app
from app.services.ollama import (
    CONTEXT_SIZE,
    MAX_ADDITIONAL_CONTEXT_CHARS,
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


def test_approved_context_is_bounded_and_preserves_recent_chat() -> None:
    messages = [{"role": "user", "content": "What do I enjoy?"}]

    bounded = build_bounded_chat_messages(messages, "Profile and memories " * 500)

    assert bounded[0]["role"] == "system"
    assert "User-approved context:" in bounded[0]["content"]
    assert len(bounded[0]["content"]) <= len(SYSTEM_PROMPT) + len(
        "\n\nUser-approved context:\n"
    ) + MAX_ADDITIONAL_CONTEXT_CHARS
    assert bounded[-1] == messages[0]
    assert sum(len(message["content"]) for message in bounded) <= MAX_CONTEXT_CHARS


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


def test_endpoint_persists_chat_and_rejects_invalid_history(
    tmp_path, monkeypatch
) -> None:
    monkeypatch.setenv("DIGITAL_ME_DATA_DIR", str(tmp_path))
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
    assert response.json()["message"] == "Mocked answer"
    assert response.json()["conversation_id"]
    assert invalid_response.status_code == 422
    mocked_chat.assert_called_once_with([{"role": "user", "content": "Hi"}])


def test_conversation_endpoints_restore_and_delete_conversations(
    tmp_path, monkeypatch
) -> None:
    monkeypatch.setenv("DIGITAL_ME_DATA_DIR", str(tmp_path))
    client = TestClient(app)
    conversation = client.post("/api/conversations").json()
    with patch(
        "app.main.OllamaService.generate_chat_response",
        return_value="Mocked answer",
    ):
        client.post(
            "/api/chat",
            json={
                "conversation_id": conversation["id"],
                "messages": [{"role": "user", "content": "Persistent question"}],
            },
        )

    listed = client.get("/api/conversations")
    restored = client.get(f"/api/conversations/{conversation['id']}")

    assert listed.status_code == 200
    assert listed.json()[0]["id"] == conversation["id"]
    assert [message["content"] for message in restored.json()["messages"]] == [
        "Persistent question",
        "Mocked answer",
    ]
    assert client.delete(f"/api/conversations/{conversation['id']}").status_code == 204
    assert client.get(f"/api/conversations/{conversation['id']}").status_code == 404


def test_chat_context_is_loaded_from_only_the_selected_conversation(
    tmp_path, monkeypatch
) -> None:
    monkeypatch.setenv("DIGITAL_ME_DATA_DIR", str(tmp_path))
    client = TestClient(app)
    first = client.post("/api/conversations").json()
    second = client.post("/api/conversations").json()

    with patch(
        "app.main.OllamaService.generate_chat_response",
        side_effect=["First answer", "Second answer", "Isolated answer"],
    ) as mocked_chat:
        client.post(
            "/api/chat",
            json={
                "conversation_id": first["id"],
                "messages": [{"role": "user", "content": "First question"}],
            },
        )
        client.post(
            "/api/chat",
            json={
                "conversation_id": first["id"],
                "messages": [{"role": "user", "content": "Follow-up"}],
            },
        )
        client.post(
            "/api/chat",
            json={
                "conversation_id": second["id"],
                "messages": [{"role": "user", "content": "Other topic"}],
            },
        )

    assert mocked_chat.call_args_list[1].args[0] == [
        {"role": "user", "content": "First question"},
        {"role": "assistant", "content": "First answer"},
        {"role": "user", "content": "Follow-up"},
    ]
    assert mocked_chat.call_args_list[2].args[0] == [
        {"role": "user", "content": "Other topic"},
    ]


def test_chat_receives_profile_and_only_relevant_approved_memories(
    tmp_path, monkeypatch
) -> None:
    monkeypatch.setenv("DIGITAL_ME_DATA_DIR", str(tmp_path))
    client = TestClient(app)
    client.put(
        "/api/profile",
        json={"name": "Alex", "about": "", "preferences": "Be concise."},
    )
    client.post(
        "/api/memories",
        json={"content": "I work at a local library."},
    )
    client.post(
        "/api/memories",
        json={"content": "My favorite color is green."},
    )

    with patch(
        "app.main.OllamaService.generate_chat_response",
        return_value="You work at a local library.",
    ) as mocked_chat:
        response = client.post(
            "/api/chat",
            json={"messages": [{"role": "user", "content": "Tell me about my library work."}]},
        )

    assert response.status_code == 200
    context = mocked_chat.call_args.args[1]
    assert "Name: Alex" in context
    assert "Preferences: Be concise." in context
    assert "I work at a local library." in context
    assert "favorite color is green" not in context


def test_endpoint_returns_gateway_error_and_keeps_user_message(
    tmp_path, monkeypatch
) -> None:
    monkeypatch.setenv("DIGITAL_ME_DATA_DIR", str(tmp_path))
    with patch(
        "app.main.OllamaService.generate_chat_response",
        side_effect=RuntimeError("Could not reach local Ollama."),
    ) as mocked_chat:
        response = TestClient(app).post(
            "/api/chat",
            json={"messages": [{"role": "user", "content": "Hi"}]},
        )

    assert response.status_code == 502
    assert response.json()["detail"]["message"] == "Could not reach local Ollama."
    assert response.json()["detail"]["conversation_id"]
    mocked_chat.assert_called_once_with([{"role": "user", "content": "Hi"}])
    conversations = TestClient(app).get("/api/conversations").json()
    assert len(conversations) == 1
    restored = TestClient(app).get(f"/api/conversations/{conversations[0]['id']}").json()
    assert [message["content"] for message in restored["messages"]] == ["Hi"]
