import wave
from io import BytesIO
from pathlib import Path
from unittest.mock import Mock, patch

from fastapi.testclient import TestClient

from app.main import app
from app.services.speech import KokoroService, SAMPLE_RATE


def test_tts_endpoint_returns_mocked_local_wav() -> None:
    service = Mock()
    service.synthesize_to_wav.return_value = b"RIFF-mocked-wav"

    with patch("app.main.get_kokoro_service", return_value=service):
        response = TestClient(app).post("/api/tts", json={"text": "Hello there."})

    assert response.status_code == 200
    assert response.headers["content-type"] == "audio/wav"
    assert response.headers["cache-control"] == "no-store"
    assert response.content == b"RIFF-mocked-wav"
    service.synthesize_to_wav.assert_called_once_with("Hello there.")


def test_tts_endpoint_reports_unavailable_or_failed_synthesis() -> None:
    with patch(
        "app.main.get_kokoro_service",
        side_effect=RuntimeError("Could not load the local Kokoro model."),
    ):
        unavailable_response = TestClient(app).post(
            "/api/tts",
            json={"text": "Hello there."},
        )

    service = Mock()
    service.synthesize_to_wav.side_effect = RuntimeError("Kokoro speech synthesis failed.")
    with patch("app.main.get_kokoro_service", return_value=service):
        synthesis_response = TestClient(app).post(
            "/api/tts",
            json={"text": "Hello there."},
        )

    assert unavailable_response.status_code == 503
    assert unavailable_response.json()["detail"] == "Could not load the local Kokoro model."
    assert synthesis_response.status_code == 503
    assert synthesis_response.json()["detail"] == "Kokoro speech synthesis failed."


def test_tts_endpoint_rejects_blank_or_oversized_text() -> None:
    client = TestClient(app)

    blank_response = client.post("/api/tts", json={"text": "  "})
    oversized_response = client.post("/api/tts", json={"text": "x" * 4_001})

    assert blank_response.status_code == 422
    assert oversized_response.status_code == 422


def test_feasibility_service_still_writes_audio_files(tmp_path: Path) -> None:
    output = BytesIO()
    with wave.open(output, "wb") as wav_file:
        wav_file.setnchannels(1)
        wav_file.setsampwidth(2)
        wav_file.setframerate(SAMPLE_RATE)
        wav_file.writeframes(b"\x00\x00" * (SAMPLE_RATE // 100))

    service = object.__new__(KokoroService)
    output_path = tmp_path / "feasibility.wav"
    with patch.object(service, "synthesize_to_wav", return_value=output.getvalue()):
        _, duration = service.synthesize_to_file(output_path, "A test sentence.")

    assert output_path.read_bytes().startswith(b"RIFF")
    assert round(duration, 2) == 0.01
