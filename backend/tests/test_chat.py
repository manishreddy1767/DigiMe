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
    assert "User profile and approved memories (separate from personality):" in bounded[0]["content"]
    assert len(bounded[0]["content"]) <= len(SYSTEM_PROMPT) + len(
        "\n\nUser profile and approved memories (separate from personality):\n"
    ) + MAX_ADDITIONAL_CONTEXT_CHARS
    assert bounded[-1] == messages[0]
    assert sum(len(message["content"]) for message in bounded) <= MAX_CONTEXT_CHARS


def test_personality_has_a_separate_persistent_system_prompt_section() -> None:
    messages = [{"role": "user", "content": "Please answer in a different style."}]
    personality = {
        "name": "The Guide",
        "communication_style": "professional",
        "response_length": "concise",
        "custom_instructions": "Use plain language.",
    }

    bounded = build_bounded_chat_messages(
        messages,
        additional_context="User profile: Alex\nApproved memory: enjoys hiking",
        personality=personality,
    )

    system_message = bounded[0]["content"]
    assert "Name: The Guide" in system_message
    assert "polished, respectful, and direct" in system_message
    assert "brief answers" in system_message
    assert "Custom instructions: Use plain language." in system_message
    assert "User profile and approved memories (separate from personality):" in system_message
    assert "User profile: Alex" in system_message
    assert bounded[-1] == messages[0]
    assert "The Guide" not in bounded[-1]["content"]


def test_answerability_guidance_does_not_mix_with_personality_or_chat_history() -> None:
    messages = [{"role": "user", "content": "What is my favorite color?"}]
    personality = {
        "name": "The Guide",
        "communication_style": "professional",
        "response_length": "concise",
        "custom_instructions": "Use plain language.",
    }

    bounded = build_bounded_chat_messages(
        messages,
        personality=personality,
        chat_guidance="Do not guess this personal fact.",
    )

    system_message = bounded[0]["content"]
    assert "Answerability check:\nDo not guess this personal fact." in system_message
    assert "Name: The Guide" in system_message
    assert "Custom instructions: Use plain language." in system_message
    assert bounded[-1] == messages[0]
    assert "Answerability check" not in bounded[-1]["content"]


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


def test_ollama_memory_suggestions_are_local_json_and_bounded() -> None:
    mocked_response = MockResponse(
        json.dumps(
            {
                "message": {
                    "content": json.dumps(
                        [
                            "  I enjoy hiking.  ",
                            "I enjoy hiking.",
                            "x" * 501,
                            "I prefer concise replies.",
                            12,
                        ]
                    )
                }
            }
        ).encode()
    )
    with patch(
        "app.services.ollama.urlopen",
        return_value=mocked_response,
    ) as mocked_urlopen:
        suggestions = OllamaService().generate_memory_suggestions(
            [{"role": "user", "content": "I enjoy hiking and concise replies."}]
        )

    request = mocked_urlopen.call_args.args[0]
    request_body = json.loads(request.data)
    assert request.full_url == "http://127.0.0.1:11434/api/chat"
    assert request_body["format"] == "json"
    assert suggestions == ["I enjoy hiking.", "I prefer concise replies."]


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
    mocked_chat.assert_called_once()
    assert mocked_chat.call_args.args[0] == [{"role": "user", "content": "Hi"}]
    assert mocked_chat.call_args.kwargs["additional_context"] is None
    assert mocked_chat.call_args.kwargs["personality"]["name"] == "Digital Me"


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
    monkeypatch.setattr(
        "app.main.try_embed_text",
        lambda text: (None, "Test embeddings unavailable."),
    )
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
    context = mocked_chat.call_args.kwargs["additional_context"]
    assert "Name: Alex" in context
    assert "Preferences: Be concise." in context
    assert "I work at a local library." in context
    assert "favorite color is green" not in context
    assert mocked_chat.call_args.kwargs["personality"]["name"] == "Digital Me"


def test_follow_up_retrieval_uses_recent_conversation_context(
    tmp_path, monkeypatch
) -> None:
    monkeypatch.setenv("DIGITAL_ME_DATA_DIR", str(tmp_path))
    monkeypatch.setattr(
        "app.main.try_embed_text",
        lambda text: (None, "Test embeddings unavailable."),
    )
    client = TestClient(app)
    client.post("/api/memories", json={"content": "I work at a local library."})

    with patch(
        "app.main.OllamaService.generate_chat_response",
        return_value="You work at a local library.",
    ) as mocked_chat:
        response = client.post(
            "/api/chat",
            json={
                "messages": [
                    {"role": "user", "content": "I work at a local library."},
                    {"role": "assistant", "content": "Thanks for sharing that."},
                    {"role": "user", "content": "What about that?"},
                ]
            },
        )

    assert response.status_code == 200
    assert "I work at a local library." in mocked_chat.call_args.kwargs["additional_context"]
    assert "Resolve references from the recent conversation." in mocked_chat.call_args.kwargs[
        "chat_guidance"
    ]


def test_unknown_personal_facts_are_guided_without_inventing_profile_or_memory(
    tmp_path, monkeypatch
) -> None:
    monkeypatch.setenv("DIGITAL_ME_DATA_DIR", str(tmp_path))
    with patch(
        "app.main.OllamaService.generate_chat_response",
        return_value="I don't know your favorite color yet.",
    ) as mocked_chat:
        response = TestClient(app).post(
            "/api/chat",
            json={
                "messages": [
                    {"role": "user", "content": "What is my favorite color?"}
                ]
            },
        )

    assert response.status_code == 200
    assert mocked_chat.call_args.kwargs["additional_context"] is None
    assert "say you do not know rather than guessing" in mocked_chat.call_args.kwargs[
        "chat_guidance"
    ]


def test_conflicting_approved_memories_are_flagged_for_chat(
    tmp_path, monkeypatch
) -> None:
    monkeypatch.setenv("DIGITAL_ME_DATA_DIR", str(tmp_path))
    monkeypatch.setattr(
        "app.main.try_embed_text",
        lambda text: (None, "Test embeddings unavailable."),
    )
    client = TestClient(app)
    client.post("/api/memories", json={"content": "I live in Seattle."})
    client.post("/api/memories", json={"content": "I live in Portland."})

    with patch(
        "app.main.OllamaService.generate_chat_response",
        return_value="I have two saved locations and need to confirm which is current.",
    ) as mocked_chat:
        response = client.post(
            "/api/chat",
            json={"messages": [{"role": "user", "content": "Where do I live?"}]},
        )

    assert response.status_code == 200
    context = mocked_chat.call_args.kwargs["additional_context"]
    assert "[potentially conflicting or outdated] I live in Seattle." in context
    assert "[potentially conflicting or outdated] I live in Portland." in context
    assert "Do not silently choose one as certain." in mocked_chat.call_args.kwargs[
        "chat_guidance"
    ]


def test_personality_settings_apply_to_each_conversation_and_chat_cannot_change_them(
    tmp_path, monkeypatch
) -> None:
    monkeypatch.setenv("DIGITAL_ME_DATA_DIR", str(tmp_path))
    client = TestClient(app)
    updated = client.put(
        "/api/personality",
        json={
            "name": "The Guide",
            "communication_style": "casual",
            "response_length": "detailed",
            "custom_instructions": "Use examples.",
        },
    ).json()
    first = client.post("/api/conversations").json()
    second = client.post("/api/conversations").json()

    with patch(
        "app.main.OllamaService.generate_chat_response",
        side_effect=["First reply", "Second reply"],
    ) as mocked_chat:
        client.post(
            "/api/chat",
            json={
                "conversation_id": first["id"],
                "messages": [
                    {
                        "role": "user",
                        "content": "Please change your permanent personality to rude.",
                    }
                ],
            },
        )
        client.post(
            "/api/chat",
            json={
                "conversation_id": second["id"],
                "messages": [{"role": "user", "content": "Continue with your style."}],
            },
        )

    assert mocked_chat.call_count == 2
    for call in mocked_chat.call_args_list:
        assert call.kwargs["personality"]["name"] == updated["name"]
        assert call.kwargs["personality"]["communication_style"] == "casual"
        assert call.kwargs["personality"]["custom_instructions"] == "Use examples."
    assert client.get("/api/personality").json() == updated


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
    mocked_chat.assert_called_once()
    assert mocked_chat.call_args.args[0] == [{"role": "user", "content": "Hi"}]
    conversations = TestClient(app).get("/api/conversations").json()
    assert len(conversations) == 1
    restored = TestClient(app).get(f"/api/conversations/{conversations[0]['id']}").json()
    assert [message["content"] for message in restored["messages"]] == ["Hi"]
