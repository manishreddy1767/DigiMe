from pathlib import Path

from fastapi.testclient import TestClient

from app.main import app
from app.services.storage import DEFAULT_PERSONALITY, Database


def test_personality_defaults_persist_and_can_be_reset(tmp_path: Path) -> None:
    database_path = tmp_path / "digital-me.sqlite3"
    database = Database(database_path)

    assert {
        key: database.get_personality()[key]
        for key in DEFAULT_PERSONALITY
    } == DEFAULT_PERSONALITY

    updated = database.update_personality(
        name="The Guide",
        communication_style="professional",
        response_length="detailed",
        custom_instructions="Use examples when helpful.",
    )
    restored = Database(database_path).get_personality()
    reset = Database(database_path).reset_personality()

    assert restored == updated
    assert reset["name"] == DEFAULT_PERSONALITY["name"]
    assert reset["communication_style"] == DEFAULT_PERSONALITY["communication_style"]
    assert reset["response_length"] == DEFAULT_PERSONALITY["response_length"]
    assert reset["custom_instructions"] == ""


def test_personality_api_saves_loads_and_resets_locally(
    tmp_path: Path, monkeypatch
) -> None:
    monkeypatch.setenv("DIGITAL_ME_DATA_DIR", str(tmp_path))
    client = TestClient(app)
    updated = client.put(
        "/api/personality",
        json={
            "name": "  The Guide  ",
            "communication_style": "professional",
            "response_length": "concise",
            "custom_instructions": "  Use direct language.  ",
        },
    )

    assert updated.status_code == 200
    assert updated.json()["name"] == "The Guide"
    assert updated.json()["custom_instructions"] == "Use direct language."
    assert client.get("/api/personality").json() == updated.json()
    assert client.post("/api/personality/reset").json()["name"] == "Digital Me"
    assert client.get("/api/personality").json()["communication_style"] == "friendly"


def test_personality_api_rejects_invalid_values_and_blank_name(
    tmp_path: Path, monkeypatch
) -> None:
    monkeypatch.setenv("DIGITAL_ME_DATA_DIR", str(tmp_path))
    client = TestClient(app)

    invalid_style = client.put(
        "/api/personality",
        json={"communication_style": "sarcastic"},
    )
    blank_name = client.put(
        "/api/personality",
        json={"name": "   "},
    )

    assert invalid_style.status_code == 422
    assert blank_name.status_code == 422


def test_deep_reasoning_persists_resets_and_migrates_older_databases(
    tmp_path: Path, monkeypatch
) -> None:
    import sqlite3

    database_path = tmp_path / "digital-me.sqlite3"
    with sqlite3.connect(database_path) as connection:
        connection.executescript(
            """
            CREATE TABLE personality (
                id INTEGER PRIMARY KEY CHECK (id = 1),
                name TEXT NOT NULL DEFAULT 'Digital Me',
                communication_style TEXT NOT NULL DEFAULT 'friendly',
                response_length TEXT NOT NULL DEFAULT 'balanced',
                custom_instructions TEXT NOT NULL DEFAULT '',
                updated_at TEXT NOT NULL
            );
            INSERT INTO personality (id, name, updated_at) VALUES (1, 'Old Name', '');
            CREATE TABLE voice_settings (
                id INTEGER PRIMARY KEY CHECK (id = 1),
                auto_play_responses INTEGER NOT NULL DEFAULT 0,
                continuous_conversation_enabled INTEGER NOT NULL DEFAULT 0,
                updated_at TEXT NOT NULL
            );
            INSERT INTO voice_settings (id, updated_at) VALUES (1, '');
            """
        )

    migrated = Database(database_path)
    assert migrated.get_personality()["name"] == "Old Name"
    assert migrated.get_personality()["deep_reasoning"] is False
    assert migrated.get_voice_settings()["voice"] == "af_heart"

    monkeypatch.setenv("DIGITAL_ME_DATA_DIR", str(tmp_path))
    client = TestClient(app)
    saved = client.put(
        "/api/personality",
        json={"name": "Old Name", "deep_reasoning": True},
    )

    assert saved.status_code == 200
    assert saved.json()["deep_reasoning"] is True
    assert client.get("/api/personality").json()["deep_reasoning"] is True
    assert client.post("/api/personality/reset").json()["deep_reasoning"] is False
