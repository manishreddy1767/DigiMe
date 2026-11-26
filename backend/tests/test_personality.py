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
