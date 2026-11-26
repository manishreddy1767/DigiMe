import struct
from unittest.mock import patch

from fastapi.testclient import TestClient

from app.main import app
from app.services.embeddings import EMBEDDING_MODEL
from app.services.storage import Database


def _embedding_for(text: str) -> bytes:
    lowered = text.casefold()
    if "hiking" in lowered or "mountain" in lowered:
        return struct.pack("<3f", 1, 0, 0)
    if "reading" in lowered or "books" in lowered:
        return struct.pack("<3f", 0, 1, 0)
    return struct.pack("<3f", 0, 0, 1)


def test_memory_api_caches_embeddings_and_warns_before_similar_save(
    tmp_path, monkeypatch
) -> None:
    monkeypatch.setenv("DIGITAL_ME_DATA_DIR", str(tmp_path))
    monkeypatch.setattr(
        "app.main.try_embed_text",
        lambda text: (_embedding_for(text), None),
    )
    client = TestClient(app)
    saved = client.post(
        "/api/memories",
        json={"content": "I enjoy mountain hiking.", "importance": 5},
    )
    duplicate_warning = client.post(
        "/api/memories",
        json={"content": "I like hiking in the mountains.", "importance": 2},
    )

    assert saved.status_code == 201
    assert saved.json()["importance"] == 5
    assert duplicate_warning.status_code == 409
    assert duplicate_warning.json()["detail"]["similar_memories"][0]["id"] == saved.json()["id"]
    assert len(client.get("/api/memories").json()) == 1

    confirmed = client.post(
        "/api/memories",
        json={
            "content": "I like hiking in the mountains.",
            "importance": 2,
            "confirm_similar": True,
        },
    )
    assert confirmed.status_code == 201
    assert confirmed.json()["importance"] == 2
    assert len(client.get("/api/memories").json()) == 2


def test_importance_edit_reuses_embedding_and_content_edit_refreshes_it(
    tmp_path, monkeypatch
) -> None:
    monkeypatch.setenv("DIGITAL_ME_DATA_DIR", str(tmp_path))
    with patch(
        "app.main.try_embed_text",
        side_effect=lambda text: (_embedding_for(text), None),
    ) as embed:
        client = TestClient(app)
        memory = client.post(
            "/api/memories",
            json={"content": "I enjoy mountain hiking.", "importance": 3},
        ).json()
        after_create = embed.call_count
        importance_only = client.put(
            f"/api/memories/{memory['id']}",
            json={"content": memory["content"], "importance": 5},
        )
        after_importance = embed.call_count
        changed = client.put(
            f"/api/memories/{memory['id']}",
            json={"content": "I enjoy reading books.", "importance": 4},
        )

    assert after_create == 1
    assert after_importance == after_create
    assert embed.call_count == after_importance + 1
    assert importance_only.json()["importance"] == 5
    assert changed.json()["content"] == "I enjoy reading books."
    assert changed.json()["importance"] == 4
    assert client.delete(f"/api/memories/{memory['id']}").status_code == 204


def test_chat_retrieval_uses_semantic_and_fts_fallback_when_embeddings_fail(
    tmp_path, monkeypatch
) -> None:
    monkeypatch.setenv("DIGITAL_ME_DATA_DIR", str(tmp_path))
    database = Database()
    database.create_memory(
        "A saved interest in mountain hiking.",
        importance=5,
        embedding=_embedding_for("mountain hiking"),
        embedding_model=EMBEDDING_MODEL,
    )
    database.create_memory(
        "A saved interest in reading books.",
        importance=1,
        embedding=_embedding_for("reading books"),
        embedding_model=EMBEDDING_MODEL,
    )

    with (
        patch("app.main.try_embed_text", return_value=(_embedding_for("hiking"), None)),
        patch(
            "app.main.OllamaService.generate_chat_response",
            return_value="Mocked local answer.",
        ) as mocked_chat,
    ):
        response = TestClient(app).post(
            "/api/chat",
            json={"messages": [{"role": "user", "content": "Tell me about trails."}]},
        )

    assert response.status_code == 200
    context = mocked_chat.call_args.kwargs["additional_context"]
    assert "mountain hiking" in context
    assert "reading books" not in context

    with (
        patch("app.main.try_embed_text", return_value=(None, "Local model unavailable.")),
        patch(
            "app.main.OllamaService.generate_chat_response",
            return_value="Fallback answer.",
        ) as fallback_chat,
    ):
        fallback_response = TestClient(app).post(
            "/api/chat",
            json={"messages": [{"role": "user", "content": "Tell me about mountain hiking."}]},
        )

    assert fallback_response.status_code == 200
    fallback_context = fallback_chat.call_args.kwargs["additional_context"]
    assert "mountain hiking" in fallback_context


def test_conversation_suggestions_are_not_memories_until_approved(
    tmp_path, monkeypatch
) -> None:
    monkeypatch.setenv("DIGITAL_ME_DATA_DIR", str(tmp_path))
    database = Database()
    conversation = database.create_conversation()
    database.add_message(conversation["id"], "user", "I enjoy mountain hiking.")
    database.add_message(conversation["id"], "assistant", "That sounds enjoyable.")
    client = TestClient(app)

    with patch(
        "app.main.OllamaService.generate_memory_suggestions",
        return_value=[
            "The user enjoys mountain hiking.",
            "The user prefers concise replies.",
        ],
    ) as mocked_suggestions:
        suggestions = client.post(
            f"/api/conversations/{conversation['id']}/memory-suggestions",
        )

    assert suggestions.status_code == 200
    assert mocked_suggestions.call_args.args[0] == [
        {"role": "user", "content": "I enjoy mountain hiking."},
        {"role": "assistant", "content": "That sounds enjoyable."},
    ]
    assert client.get("/api/memories").json() == []
    pending = suggestions.json()
    assert len(pending) == 2

    with patch(
        "app.main.try_embed_text",
        side_effect=lambda text: (_embedding_for(text), None),
    ):
        approved = client.post(
            f"/api/memory-suggestions/{pending[0]['id']}/approve",
            json={"importance": 5},
        )
    dismissed = client.delete(f"/api/memory-suggestions/{pending[1]['id']}")

    assert approved.status_code == 201
    assert approved.json()["importance"] == 5
    assert len(client.get("/api/memories").json()) == 1
    assert dismissed.status_code == 204
    assert client.get(
        f"/api/conversations/{conversation['id']}/memory-suggestions"
    ).json() == []
