import json
from io import BytesIO
from unittest.mock import patch
from urllib.error import URLError

from fastapi.testclient import TestClient

from app.main import app
from app.services.ollama import MODEL, REASONING_MODEL


class MockResponse(BytesIO):
    def __enter__(self) -> "MockResponse":
        return self

    def __exit__(self, *args: object) -> None:
        self.close()


def tags(*names: str) -> MockResponse:
    return MockResponse(json.dumps({"models": [{"name": name} for name in names]}).encode())


def test_status_reports_the_active_model_and_whether_it_is_installed(
    tmp_path, monkeypatch
) -> None:
    monkeypatch.setenv("DIGITAL_ME_DATA_DIR", str(tmp_path))
    client = TestClient(app)

    with patch("app.services.ollama.urlopen", return_value=tags(MODEL)):
        fast = client.get("/api/status").json()

    client.put("/api/personality", json={"name": "Nova", "deep_reasoning": True})
    with patch("app.services.ollama.urlopen", return_value=tags(MODEL)):
        deep = client.get("/api/status").json()

    assert fast == {
        "assistant_name": "Digital Me",
        "model": MODEL,
        "deep_reasoning": False,
        "speaking_as": "assistant",
        "ollama_reachable": True,
        "model_available": True,
    }
    assert deep["assistant_name"] == "Nova"
    assert deep["model"] == REASONING_MODEL
    assert deep["model_available"] is False


def test_status_reports_when_ollama_is_not_running(tmp_path, monkeypatch) -> None:
    monkeypatch.setenv("DIGITAL_ME_DATA_DIR", str(tmp_path))

    with patch("app.services.ollama.urlopen", side_effect=URLError("refused")):
        status = TestClient(app).get("/api/status").json()

    assert status["ollama_reachable"] is False
    assert status["model_available"] is False
