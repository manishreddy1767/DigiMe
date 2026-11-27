"""Speaking as yourself: the digital version of the person, in the first person."""

from unittest.mock import patch

from fastapi.testclient import TestClient

from app.main import app
from app.services.chat_context import build_answerability_guidance
from app.services.ollama import SYSTEM_PROMPT, build_bounded_chat_messages
from app.services.storage import Database


def test_self_prompt_speaks_in_the_first_person_and_stays_honest() -> None:
    bounded = build_bounded_chat_messages(
        [{"role": "user", "content": "Tell me about yourself."}],
        "Your profile:\nName: Asha",
        personality={"name": "Asha", "speaking_as": "self"},
    )
    system = bounded[0]["content"]

    assert system.startswith("You are the digital version of Asha")
    assert "first person" in system
    assert "never talk about Asha in the third person" in system
    assert "say plainly that you are an AI digital version of Asha" in system
    assert "Not known about you unless written there" in system
    assert "These are facts about yourself" in system
    assert SYSTEM_PROMPT not in system


def test_self_check_comes_right_before_the_reply() -> None:
    guidance = build_answerability_guidance(
        [{"role": "user", "content": "What's your favourite movie?"}], set(), speaking_as_self=True
    )
    bounded = build_bounded_chat_messages(
        [{"role": "user", "content": "What's your favourite movie?"}],
        personality={"name": "Asha", "speaking_as": "self"},
        chat_guidance=guidance,
    )

    assert [message["role"] for message in bounded] == ["system", "system", "user"]
    assert bounded[1]["content"].startswith("For your next reply:")
    assert "do not name any example" in bounded[1]["content"]
    assert bounded[-1]["content"] == "What's your favourite movie?"
    assert "Answerability check" not in bounded[0]["content"]


def test_assistant_mode_keeps_the_original_prompt() -> None:
    bounded = build_bounded_chat_messages(
        [{"role": "user", "content": "Hello"}],
        personality={"name": "Digital Me", "speaking_as": "assistant"},
    )

    assert bounded[0]["content"].startswith(SYSTEM_PROMPT)


def test_questions_about_yourself_are_answered_only_from_known_facts() -> None:
    question = [{"role": "user", "content": "What is your favourite movie?"}]

    assert "say only that you haven't shared that yet" in (
        build_answerability_guidance(question, set(), speaking_as_self=True) or ""
    )
    assert build_answerability_guidance(question, set(), speaking_as_self=False) is None


def test_chat_uses_your_profile_and_memories_as_your_own(tmp_path, monkeypatch) -> None:
    monkeypatch.setenv("DIGITAL_ME_DATA_DIR", str(tmp_path))
    client = TestClient(app)
    client.put("/api/profile", json={"name": "Asha", "about": "I study physics."})
    Database().create_memory("Asha's project is a weather station.")
    saved = client.put("/api/personality", json={"name": "Asha", "speaking_as": "self"})

    with patch(
        "app.main.OllamaService.generate_chat_response",
        return_value="I'm building a weather station.",
    ) as mocked_chat:
        client.post(
            "/api/chat",
            json={"messages": [{"role": "user", "content": "What is your project?"}]},
        )

    kwargs = mocked_chat.call_args.kwargs
    assert saved.json()["speaking_as"] == "self"
    assert kwargs["personality"]["speaking_as"] == "self"
    assert kwargs["additional_context"].startswith("Your profile:\nName: Asha")
    assert "Your approved memories (facts about you):" in kwargs["additional_context"]
    assert "This asks about you." in kwargs["chat_guidance"]
    assert client.get("/api/status").json()["speaking_as"] == "self"


def test_speaking_as_rejects_unknown_modes_and_resets(tmp_path, monkeypatch) -> None:
    monkeypatch.setenv("DIGITAL_ME_DATA_DIR", str(tmp_path))
    client = TestClient(app)

    assert client.put("/api/personality", json={"speaking_as": "someone"}).status_code == 422
    client.put("/api/personality", json={"speaking_as": "self"})
    assert client.post("/api/personality/reset").json()["speaking_as"] == "assistant"
