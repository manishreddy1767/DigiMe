from unittest.mock import patch

from fastapi.testclient import TestClient

from app.main import app


def test_profile_can_be_edited_and_reloaded(tmp_path, monkeypatch) -> None:
    monkeypatch.setenv("DIGITAL_ME_DATA_DIR", str(tmp_path))
    client = TestClient(app)

    updated = client.put(
        "/api/profile",
        json={
            "name": "  Alex  ",
            "about": "A local profile.",
            "preferences": "Concise answers.",
        },
    )
    restored = client.get("/api/profile")

    assert updated.status_code == 200
    assert updated.json()["name"] == "Alex"
    assert restored.json() == updated.json()


def test_memories_require_explicit_save_and_support_search_edit_and_delete(
    tmp_path, monkeypatch
) -> None:
    monkeypatch.setenv("DIGITAL_ME_DATA_DIR", str(tmp_path))
    monkeypatch.setattr(
        "app.main.try_embed_text",
        lambda text: (None, "Test embeddings unavailable."),
    )
    client = TestClient(app)
    with patch(
        "app.main.OllamaService.generate_chat_response",
        return_value="I will not save that automatically.",
    ):
        client.post(
            "/api/chat",
            json={"messages": [{"role": "user", "content": "I enjoy mountain hikes."}]},
        )

    assert client.get("/api/memories").json() == []
    saved = client.post(
        "/api/memories",
        json={"content": "I enjoy weekend mountain hikes."},
    )
    second = client.post(
        "/api/memories",
        json={"content": "My preferred music is jazz."},
    )

    assert saved.status_code == 201
    assert client.get("/api/memories?q=mountain+hikes").json()[0]["id"] == saved.json()["id"]
    assert client.get("/api/memories?q=jazz").json()[0]["id"] == second.json()["id"]

    edited = client.put(
        f"/api/memories/{saved.json()['id']}",
        json={"content": "I enjoy weekend coastal walks."},
    )
    assert edited.status_code == 200
    assert client.get("/api/memories?q=mountain").json() == []
    assert client.get("/api/memories?q=coastal").json()[0]["id"] == edited.json()["id"]

    assert client.delete(f"/api/memories/{saved.json()['id']}").status_code == 204
    assert client.get("/api/memories?q=coastal").json() == []
    assert client.delete(f"/api/memories/{saved.json()['id']}").status_code == 404


def test_memory_endpoint_rejects_blank_content(tmp_path, monkeypatch) -> None:
    monkeypatch.setenv("DIGITAL_ME_DATA_DIR", str(tmp_path))

    response = TestClient(app).post("/api/memories", json={"content": "  "})

    assert response.status_code == 422


def test_memory_search_matches_word_forms_and_rebuilds_old_indexes(tmp_path) -> None:
    import sqlite3

    from app.services.storage import Database

    database_path = tmp_path / "digital-me.sqlite3"
    database = Database(database_path)
    database.create_memory("My project Atlas detects code vulnerabilities.")

    assert [m["content"] for m in database.search_memories("What projects am I working on?")] == [
        "My project Atlas detects code vulnerabilities."
    ]

    with sqlite3.connect(database_path) as connection:
        connection.execute("DROP TABLE memory_search")
        connection.execute("CREATE VIRTUAL TABLE memory_search USING fts5(content)")
        connection.execute(
            "INSERT INTO memory_search (rowid, content) SELECT rowid, content FROM memories"
        )

    rebuilt = Database(database_path)
    assert len(rebuilt.search_memories("projects")) == 1
    rebuilt.create_memory("I am working on interview preparation.")
    assert len(rebuilt.search_memories("work")) == 1
