import struct
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


def test_hybrid_retrieval_uses_semantics_fts_and_importance(tmp_path: Path) -> None:
    database = Database(tmp_path / "digital-me.sqlite3")
    semantic = database.create_memory(
        "A topic with no shared words.",
        importance=3,
        embedding=struct.pack("<3f", 1, 0, 0),
        embedding_model="test-model",
    )
    lexical = database.create_memory(
        "Mountain hiking is enjoyable.",
        importance=1,
        embedding=struct.pack("<3f", 0, 1, 0),
        embedding_model="test-model",
    )
    more_important = database.create_memory(
        "Important unrelated note.",
        importance=5,
        embedding=struct.pack("<3f", 1, 0, 0),
        embedding_model="test-model",
    )

    results = database.search_memories_hybrid(
        "mountain hiking",
        struct.pack("<3f", 1, 0, 0),
        "test-model",
    )
    fallback = database.search_memories_hybrid(
        "mountain hiking",
        None,
        "test-model",
    )

    assert results[0]["id"] == more_important["id"]
    assert semantic["id"] in [item["id"] for item in results]
    assert lexical["id"] in [item["id"] for item in results]
    assert fallback[0]["id"] == lexical["id"]
    assert all(item["similarity"] is None for item in fallback)


def test_memory_embedding_is_kept_for_importance_edit_and_invalidated_on_content_edit(
    tmp_path: Path,
) -> None:
    database = Database(tmp_path / "digital-me.sqlite3")
    embedding = struct.pack("<3f", 1, 0, 0)
    memory = database.create_memory(
        "A cached local memory.",
        embedding=embedding,
        embedding_model="test-model",
    )

    updated_importance = database.update_memory(
        memory["id"],
        "A cached local memory.",
        importance=5,
    )
    with database._connection() as connection:
        cached_after_importance_edit = connection.execute(
            "SELECT embedding, embedding_model FROM memories WHERE id = ?",
            (memory["id"],),
        ).fetchone()

    updated_content = database.update_memory(
        memory["id"],
        "Changed content requires a new vector.",
        importance=5,
    )
    with database._connection() as connection:
        cached_after_content_edit = connection.execute(
            "SELECT embedding, embedding_model FROM memories WHERE id = ?",
            (memory["id"],),
        ).fetchone()

    assert updated_importance["importance"] == 5
    assert cached_after_importance_edit["embedding"] == embedding
    assert cached_after_importance_edit["embedding_model"] == "test-model"
    assert updated_content["content"] == "Changed content requires a new vector."
    assert cached_after_content_edit["embedding"] is None
    assert cached_after_content_edit["embedding_model"] is None


def test_similar_memory_detection_warns_without_mutating_memories(tmp_path: Path) -> None:
    database = Database(tmp_path / "digital-me.sqlite3")
    original = database.create_memory(
        "I enjoy hiking in the mountains.",
        embedding=struct.pack("<3f", 1, 0, 0),
        embedding_model="test-model",
    )

    similar = database.find_similar_memories(
        "I like mountain hiking.",
        struct.pack("<3f", 0.9, 0.1, 0),
        "test-model",
    )
    duplicate = database.find_similar_memories(
        "  I ENJOY hiking in the mountains. ",
        None,
        "test-model",
    )

    assert similar[0]["id"] == original["id"]
    assert similar[0]["kind"] == "similar"
    assert duplicate[0]["kind"] == "duplicate"
    assert len(database.list_memories()) == 1


def test_memory_suggestions_need_approval_and_can_be_dismissed(tmp_path: Path) -> None:
    database = Database(tmp_path / "digital-me.sqlite3")
    conversation = database.create_conversation()
    suggestions = database.create_memory_suggestions(
        conversation["id"],
        ["The user enjoys hiking.", "The user prefers concise answers."],
    )
    suggestion = suggestions[0]
    dismissed_content = suggestion["content"]

    assert [memory["id"] for memory in database.list_memories()] == []
    assert database.dismiss_memory_suggestion(suggestion["id"])
    assert database.get_memory_suggestion(suggestion["id"]) is None
    assert [
        item["content"] for item in database.list_memory_suggestions(conversation["id"])
    ] == [item["content"] for item in suggestions if item["content"] != dismissed_content]
