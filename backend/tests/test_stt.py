import sys
from io import BytesIO
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

from fastapi.testclient import TestClient
import pytest

from app.main import app
from app.services.speech import TranscriptionResult, WhisperService


class MockFFmpegError(Exception):
    pass


def mocked_speech_modules(model: Mock) -> dict[str, SimpleNamespace]:
    return {
        "faster_whisper": SimpleNamespace(WhisperModel=Mock(return_value=model)),
        "av": SimpleNamespace(error=SimpleNamespace(FFmpegError=MockFFmpegError)),
    }


def test_whisper_service_uses_local_base_cpu_int8_and_transcribes_bytes() -> None:
    model = Mock()
    model.transcribe.return_value = (
        iter([SimpleNamespace(text=" Local "), SimpleNamespace(text=" transcription. ")]),
        SimpleNamespace(language="en"),
    )
    modules = mocked_speech_modules(model)

    with patch.dict(sys.modules, modules):
        service = WhisperService()
        result = service.transcribe_bytes(b"mock audio bytes")

    modules["faster_whisper"].WhisperModel.assert_called_once_with(
        "base",
        device="cpu",
        compute_type="int8",
        cpu_threads=4,
    )
    audio_source = model.transcribe.call_args.args[0]
    assert isinstance(audio_source, BytesIO)
    assert audio_source.read() == b"mock audio bytes"
    assert model.transcribe.call_args.kwargs == {"beam_size": 1, "vad_filter": True}
    assert result.text == "Local transcription."
    assert result.language == "en"


def test_whisper_service_reports_invalid_audio() -> None:
    model = Mock()
    model.transcribe.side_effect = MockFFmpegError("Invalid media")

    with patch.dict(sys.modules, mocked_speech_modules(model)):
        service = WhisperService()
        with pytest.raises(ValueError, match="unsupported audio format"):
            service.transcribe_bytes(b"invalid audio")


def test_stt_endpoint_returns_mocked_transcription_without_caching() -> None:
    service = Mock()
    service.transcribe_bytes.return_value = TranscriptionResult(
        text="Recognized words.",
        language="en",
        elapsed_seconds=0.1,
    )

    with patch("app.main.get_whisper_service", return_value=service):
        response = TestClient(app).post(
            "/api/stt",
            content=b"mock audio bytes",
            headers={"Content-Type": "audio/webm;codecs=opus"},
        )

    assert response.status_code == 200
    assert response.headers["cache-control"] == "no-store"
    assert response.json() == {"text": "Recognized words."}
    service.transcribe_bytes.assert_called_once_with(b"mock audio bytes")


def test_stt_endpoint_reports_empty_invalid_and_unavailable_audio_paths() -> None:
    client = TestClient(app)
    empty_response = client.post(
        "/api/stt",
        content=b"",
        headers={"Content-Type": "audio/webm"},
    )
    invalid_type_response = client.post(
        "/api/stt",
        content=b"mock audio",
        headers={"Content-Type": "application/json"},
    )

    service = Mock()
    service.transcribe_bytes.side_effect = ValueError("Invalid or unsupported audio.")
    with patch("app.main.get_whisper_service", return_value=service):
        invalid_audio_response = client.post(
            "/api/stt",
            content=b"not audio",
            headers={"Content-Type": "audio/webm"},
        )

    with patch(
        "app.main.get_whisper_service",
        side_effect=RuntimeError("Could not load faster-whisper."),
    ):
        unavailable_response = client.post(
            "/api/stt",
            content=b"mock audio",
            headers={"Content-Type": "audio/webm"},
        )

    assert empty_response.status_code == 422
    assert invalid_type_response.status_code == 415
    assert invalid_audio_response.status_code == 422
    assert unavailable_response.status_code == 503


def test_file_based_feasibility_transcription_remains_available(tmp_path: Path) -> None:
    audio_path = tmp_path / "test.wav"
    audio_path.write_bytes(b"mock local wav")
    expected = TranscriptionResult(text="Feasibility test.", language="en", elapsed_seconds=0.1)
    service = object.__new__(WhisperService)

    with patch.object(service, "_transcribe", return_value=expected) as mock_transcribe:
        result = service.transcribe(audio_path)

    mock_transcribe.assert_called_once_with(str(audio_path))
    assert result == expected
