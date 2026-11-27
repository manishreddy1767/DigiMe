from pathlib import Path

from fastapi.testclient import TestClient

from app.main import app
from app.services.storage import DEFAULT_VOICE_SETTINGS, Database


def test_voice_settings_default_and_persist_across_database_instances(
    tmp_path: Path,
) -> None:
    database_path = tmp_path / "digital-me.sqlite3"
    database = Database(database_path)

    defaults = database.get_voice_settings()
    updated = database.update_voice_settings(True, True)
    restored = Database(database_path).get_voice_settings()

    assert {
        key: defaults[key]
        for key in DEFAULT_VOICE_SETTINGS
    } == DEFAULT_VOICE_SETTINGS
    assert updated["auto_play_responses"] is True
    assert updated["continuous_conversation_enabled"] is True
    assert updated["voice"] == "af_heart"
    assert restored == updated


def test_voice_choice_persists_and_rejects_unknown_voices(
    tmp_path: Path,
    monkeypatch,
) -> None:
    monkeypatch.setenv("DIGITAL_ME_DATA_DIR", str(tmp_path))
    client = TestClient(app)

    saved = client.put(
        "/api/voice-settings",
        json={
            "auto_play_responses": True,
            "continuous_conversation_enabled": False,
            "voice": "af_bella",
        },
    )
    rejected = client.put(
        "/api/voice-settings",
        json={
            "auto_play_responses": True,
            "continuous_conversation_enabled": False,
            "voice": "not-a-voice",
        },
    )

    assert saved.status_code == 200
    assert saved.json()["voice"] == "af_bella"
    assert rejected.status_code == 422
    assert client.get("/api/voice-settings").json()["voice"] == "af_bella"


def test_voice_settings_api_loads_and_persists_locally(
    tmp_path: Path,
    monkeypatch,
) -> None:
    monkeypatch.setenv("DIGITAL_ME_DATA_DIR", str(tmp_path))
    client = TestClient(app)

    defaults = client.get("/api/voice-settings")
    saved = client.put(
        "/api/voice-settings",
        json={
            "auto_play_responses": True,
            "continuous_conversation_enabled": False,
        },
    )

    assert defaults.status_code == 200
    assert defaults.json()["auto_play_responses"] is False
    assert defaults.json()["continuous_conversation_enabled"] is False
    assert saved.status_code == 200
    assert saved.json()["auto_play_responses"] is True
    assert saved.json()["continuous_conversation_enabled"] is False
    assert client.get("/api/voice-settings").json() == saved.json()
