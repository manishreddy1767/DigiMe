from pathlib import Path
from unittest.mock import patch

from fastapi.testclient import TestClient

from app.main import app
from app.services.personalization import (
    build_proactive_suggestions,
    find_recurring_preference_suggestions,
    summarize_recurring_topics,
)
from app.services.storage import MAX_PERSONALIZATION_MESSAGES, Database


def test_personalization_settings_persist_across_database_instances(
    tmp_path: Path,
) -> None:
    database_path = tmp_path / "digital-me.sqlite3"
    database = Database(database_path)

    assert database.get_personalization_settings()["enabled"] is True
    database.update_personalization_settings(False)

    assert Database(database_path).get_personalization_settings()["enabled"] is False


def test_personalization_message_read_is_recent_role_filtered_and_bounded(
    tmp_path: Path,
) -> None:
    database = Database(tmp_path / "digital-me.sqlite3")
    conversation = database.create_conversation()
    for index in range(MAX_PERSONALIZATION_MESSAGES + 2):
        database.add_message(conversation["id"], "user", f"Recent user message {index}")
    database.add_message(conversation["id"], "assistant", "Assistant messages are excluded.")

    messages = database.get_recent_user_messages()

    assert len(messages) == MAX_PERSONALIZATION_MESSAGES
    assert all(message["role"] == "user" for message in messages)
    assert all(len(message["content"]) <= 1_200 for message in messages)
    assert all("Assistant messages" not in message["content"] for message in messages)


def test_topic_summaries_only_count_safe_topics_in_user_messages() -> None:
    summaries = summarize_recurring_topics(
        [
            {
                "role": "user",
                "conversation_id": "one",
                "content": "I want to learn more about Python programming.",
            },
            {
                "role": "assistant",
                "conversation_id": "one",
                "content": "Python programming is useful.",
            },
            {
                "role": "user",
                "conversation_id": "two",
                "content": "Can you explain programming with another example?",
            },
            {
                "role": "user",
                "conversation_id": "two",
                "content": "I discuss politics and religion.",
            },
            {
                "role": "user",
                "conversation_id": "three",
                "content": "I discuss politics and religion.",
            },
            {
                "role": "user",
                "conversation_id": "three",
                "content": "I enjoy reading about religion.",
            },
            {
                "role": "user",
                "conversation_id": "four",
                "content": "I enjoy reading about religion.",
            },
        ]
    )

    assert summaries == [
        {
            "topic": "programming",
            "message_count": 2,
            "conversation_count": 2,
            "summary": (
                "Programming appeared in 2 recent user messages across "
                "2 conversations."
            ),
        }
    ]


def test_preferences_require_repeated_explicit_non_sensitive_statements() -> None:
    suggestions = find_recurring_preference_suggestions(
        [
            {"role": "user", "content": "I enjoy cooking at home."},
            {"role": "user", "content": "I am interested in cooking."},
            {"role": "user", "content": "I prefer concise answers."},
            {"role": "user", "content": "I prefer concise responses."},
            {"role": "user", "content": "I don't like cooking."},
            {"role": "user", "content": "I don't like cooking."},
            {"role": "user", "content": "I enjoy reading about religion."},
            {"role": "user", "content": "I enjoy reading about religion."},
            {"role": "user", "content": "I like politics."},
            {"role": "assistant", "content": "I enjoy cooking too."},
        ]
    )

    assert suggestions == [
        "I prefer concise responses.",
        "I enjoy cooking.",
    ]


def test_proactive_suggestions_are_allowlisted_deduplicated_and_source_labeled() -> None:
    suggestions = build_proactive_suggestions(
        [
            {
                "role": "user",
                "conversation_id": "one",
                "content": "I have a programming question.",
            },
            {
                "role": "user",
                "conversation_id": "two",
                "content": "Let's discuss programming again.",
            },
        ],
        [
            {
                "id": "safe",
                "content": "I enjoy cooking.",
            },
            {"id": "sensitive", "content": "I discuss politics."},
        ],
    )

    assert suggestions == [
        {
            "topic": "programming",
            "prompt": "Give me a small programming example.",
            "source": "recurring topic",
        },
        {
            "topic": "cooking",
            "prompt": "Suggest a simple recipe or cooking technique.",
            "source": "approved memory",
        },
    ]
    assert all("politics" not in suggestion["prompt"] for suggestion in suggestions)


def test_proactive_suggestions_skip_sensitive_context_in_approved_memories() -> None:
    suggestions = build_proactive_suggestions(
        [],
        [{"id": "memory", "content": "I enjoy cooking and discuss religion."}],
    )

    assert suggestions == []


def test_preference_suggestions_need_approval_and_can_be_deleted(
    tmp_path, monkeypatch
) -> None:
    monkeypatch.setenv("DIGITAL_ME_DATA_DIR", str(tmp_path))
    database = Database()
    conversation = database.create_conversation()
    for content in (
        "I love programming.",
        "I enjoy programming.",
        "I like discussing politics.",
        "I like discussing politics.",
    ):
        database.add_message(conversation["id"], "user", content)
    client = TestClient(app)

    response = client.post(
        f"/api/conversations/{conversation['id']}/preference-suggestions"
    )

    assert response.status_code == 200
    pending = response.json()
    assert [item["content"] for item in pending] == ["I enjoy programming."]
    assert client.get("/api/memories").json() == []

    saved = client.post(
        f"/api/memory-suggestions/{pending[0]['id']}/approve",
        json={"importance": 3},
    )
    assert saved.status_code == 201
    assert [item["content"] for item in client.get("/api/memories").json()] == [
        "I enjoy programming."
    ]
    assert client.delete(f"/api/memories/{saved.json()['id']}").status_code == 204
    assert client.get("/api/memories").json() == []
    with database._connection() as connection:
        retained_suggestion = connection.execute(
            "SELECT id FROM memory_suggestions WHERE memory_id = ?",
            (saved.json()["id"],),
        ).fetchone()
    assert retained_suggestion is None


def test_personalization_api_topics_and_proactive_suggestions_are_local(
    tmp_path, monkeypatch
) -> None:
    monkeypatch.setenv("DIGITAL_ME_DATA_DIR", str(tmp_path))
    database = Database()
    first = database.create_conversation()
    second = database.create_conversation()
    database.add_message(first["id"], "user", "Could you explain Python programming?")
    database.add_message(second["id"], "user", "I want another Python programming example.")
    memory = database.create_memory("I enjoy cooking.")
    client = TestClient(app)

    settings = client.get("/api/personalization/settings")
    topics = client.get("/api/personalization/topics")
    suggestions = client.get("/api/personalization/proactive-suggestions")

    assert settings.status_code == 200
    assert settings.json()["enabled"] is True
    assert [topic["topic"] for topic in topics.json()] == ["programming"]
    assert suggestions.json() == [
        {
            "topic": "programming",
            "prompt": "Give me a small programming example.",
            "source": "recurring topic",
        },
        {
            "topic": "cooking",
            "prompt": "Suggest a simple recipe or cooking technique.",
            "source": "approved memory",
        },
    ]
    assert client.delete(f"/api/memories/{memory['id']}").status_code == 204
    assert [item["topic"] for item in client.get(
        "/api/personalization/proactive-suggestions"
    ).json()] == ["programming"]


def test_disabling_personalization_hides_summaries_and_gates_chat_context(
    tmp_path, monkeypatch
) -> None:
    monkeypatch.setenv("DIGITAL_ME_DATA_DIR", str(tmp_path))
    database = Database()
    database.update_profile("Alex", "A profile.", "Prefer examples.")
    database.create_memory("I enjoy programming.")
    conversation = database.create_conversation()
    database.add_message(conversation["id"], "user", "I enjoy programming.")
    database.add_message(conversation["id"], "user", "I like coding.")
    database.update_personality(
        "The Guide",
        "professional",
        "concise",
        "Use clear language.",
    )
    client = TestClient(app)

    saved = client.put(
        "/api/personalization/settings",
        json={"enabled": False},
    )
    topics = client.get("/api/personalization/topics")
    suggestions = client.get("/api/personalization/proactive-suggestions")
    preference_suggestions = client.post(
        f"/api/conversations/{conversation['id']}/preference-suggestions"
    )
    with patch(
        "app.main.OllamaService.generate_chat_response",
        return_value="A neutral response.",
    ) as mocked_chat:
        chat = client.post(
            "/api/chat",
            json={
                "conversation_id": conversation["id"],
                "messages": [{"role": "user", "content": "Explain programming."}],
            },
        )

    assert saved.json()["enabled"] is False
    assert topics.json() == []
    assert suggestions.status_code == 409
    assert preference_suggestions.status_code == 409
    assert chat.status_code == 200
    assert mocked_chat.call_args.kwargs["additional_context"] is None
    assert mocked_chat.call_args.kwargs["personality"]["name"] == "The Guide"
