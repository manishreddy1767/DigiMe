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
    assert client.get("/api/memories?q=mountain+hikes").json() == [saved.json()]
    assert client.get("/api/memories?q=jazz").json() == [second.json()]

    edited = client.put(
        f"/api/memories/{saved.json()['id']}",
        json={"content": "I enjoy weekend coastal walks."},
    )
    assert edited.status_code == 200
    assert client.get("/api/memories?q=mountain").json() == []
    assert client.get("/api/memories?q=coastal").json() == [edited.json()]

    assert client.delete(f"/api/memories/{saved.json()['id']}").status_code == 204
    assert client.get("/api/memories?q=coastal").json() == []
    assert client.delete(f"/api/memories/{saved.json()['id']}").status_code == 404


def test_memory_endpoint_rejects_blank_content(tmp_path, monkeypatch) -> None:
    monkeypatch.setenv("DIGITAL_ME_DATA_DIR", str(tmp_path))

    response = TestClient(app).post("/api/memories", json={"content": "  "})

    assert response.status_code == 422
