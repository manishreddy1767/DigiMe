from pathlib import Path

from app.services.storage import Database


def test_conversations_persist_and_keep_messages_isolated(tmp_path: Path) -> None:
    database_path = tmp_path / "digital-me.sqlite3"
    first_database = Database(database_path)
    first = first_database.create_conversation()
    second = first_database.create_conversation()
    first_database.add_message(first["id"], "user", "First conversation question")
    first_database.add_message(first["id"], "assistant", "First conversation answer")
    first_database.add_message(second["id"], "user", "Separate conversation")

    reopened_database = Database(database_path)
    restored_first = reopened_database.get_conversation(first["id"])
    restored_second = reopened_database.get_conversation(second["id"])

    assert restored_first is not None
    assert [message["content"] for message in restored_first["messages"]] == [
        "First conversation question",
        "First conversation answer",
    ]
    assert restored_first["title"] == "First conversation question"
    assert restored_second is not None
    assert [message["content"] for message in restored_second["messages"]] == [
        "Separate conversation",
    ]


def test_profile_is_editable_and_persists(tmp_path: Path) -> None:
    database = Database(tmp_path / "digital-me.sqlite3")

    updated = database.update_profile("Alex", "A short bio.", "Keep replies concise.")
    restored = Database(database.path).get_profile()

    assert updated["name"] == "Alex"
    assert restored == updated


def test_memories_can_be_searched_updated_and_deleted(tmp_path: Path) -> None:
    database = Database(tmp_path / "digital-me.sqlite3")
    memory = database.create_memory("I enjoy weekend mountain hikes.")
    other_memory = database.create_memory("My preferred music is jazz.")

    results = database.search_memories("mountain hikes")
    updated = database.update_memory(memory["id"], "I enjoy weekend coastal walks.")

    assert [result["id"] for result in results] == [memory["id"]]
    assert database.search_memories("mountain hikes") == []
    assert database.search_memories("coastal walks")[0]["content"] == updated["content"]
    assert database.delete_memory(memory["id"])
    assert [item["id"] for item in database.list_memories()] == [other_memory["id"]]
    assert database.search_memories("coastal") == []
