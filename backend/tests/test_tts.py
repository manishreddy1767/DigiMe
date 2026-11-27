import wave
from io import BytesIO
from pathlib import Path
from sys import modules
from types import ModuleType, SimpleNamespace
from unittest.mock import Mock, patch

from fastapi.testclient import TestClient

from app.main import _warm_kokoro_service, app
from app.services.speech import (
    KOKORO_GPU_MIN_FREE_BYTES,
    KOKORO_MODEL_REPO_ID,
    KokoroService,
    SAMPLE_RATE,
    prepare_speech_text,
)


def fake_tts_modules(
    pipeline_factory: Mock,
    cuda_available: bool = True,
    free_bytes: int = 2 * 1024**3,
) -> tuple[ModuleType, ModuleType, type[RuntimeError]]:
    torch_module = ModuleType("torch")
    torch_module.set_num_threads = Mock()
    out_of_memory_error = type("CudaOutOfMemoryError", (RuntimeError,), {})
    torch_module.cuda = SimpleNamespace(
        is_available=Mock(return_value=cuda_available),
        mem_get_info=Mock(return_value=(free_bytes, 6 * 1024**3)),
        empty_cache=Mock(),
        OutOfMemoryError=out_of_memory_error,
    )
    kokoro_module = ModuleType("kokoro")
    kokoro_module.KPipeline = pipeline_factory
    return torch_module, kokoro_module, out_of_memory_error


def test_tts_endpoint_returns_mocked_local_wav(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setenv("DIGITAL_ME_DATA_DIR", str(tmp_path))
    service = Mock()
    service.synthesize_to_wav.return_value = b"RIFF-mocked-wav"

    with patch("app.main.get_kokoro_service", return_value=service):
        response = TestClient(app).post("/api/tts", json={"text": "Hello there."})

    assert response.status_code == 200
    assert response.headers["content-type"] == "audio/wav"
    assert response.headers["cache-control"] == "no-store"
    assert response.content == b"RIFF-mocked-wav"
    service.synthesize_to_wav.assert_called_once_with("Hello there.", voice="af_heart")


def test_tts_endpoint_uses_saved_voice_and_speaks_plain_text(
    tmp_path: Path,
    monkeypatch,
) -> None:
    monkeypatch.setenv("DIGITAL_ME_DATA_DIR", str(tmp_path))
    client = TestClient(app)
    client.put(
        "/api/voice-settings",
        json={
            "auto_play_responses": False,
            "continuous_conversation_enabled": False,
            "voice": "am_michael",
        },
    )
    service = Mock()
    service.synthesize_to_wav.return_value = b"RIFF-mocked-wav"

    with patch("app.main.get_kokoro_service", return_value=service):
        response = client.post("/api/tts", json={"text": "The answer is **391**."})
        unspeakable = client.post("/api/tts", json={"text": "**  **"})

    assert response.status_code == 200
    service.synthesize_to_wav.assert_called_once_with(
        "The answer is 391.",
        voice="am_michael",
    )
    assert unspeakable.status_code == 422


def test_speech_text_removes_markdown_and_emoji_but_keeps_words() -> None:
    markdown = (
        "## Plan\n"
        "17 \u00d7 23 equals **391**. \U0001F60A\n"
        "- Step *one* with `code`\n"
        "1. See [the docs](http://example.test)\n"
        "```python\nprint(1)\n```\n"
        "> quoted _note_ about snake_case_name"
    )

    assert prepare_speech_text(markdown) == (
        "Plan\n"
        "17 \u00d7 23 equals 391.\n"
        "Step one with code\n"
        "See the docs\n"
        "(code omitted)\n"
        "quoted note about snake_case_name"
    )


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


def test_kokoro_prefers_cuda_when_enough_memory_is_available() -> None:
    pipeline_factory = Mock(return_value=object())
    torch_module, kokoro_module, _ = fake_tts_modules(pipeline_factory)

    with patch.dict(modules, {"torch": torch_module, "kokoro": kokoro_module}):
        service = KokoroService()

    assert service.device == "cuda"
    pipeline_factory.assert_called_once_with(
        lang_code="a",
        repo_id=KOKORO_MODEL_REPO_ID,
        device="cuda",
    )


def test_kokoro_uses_cpu_when_gpu_memory_is_low() -> None:
    pipeline_factory = Mock(return_value=object())
    torch_module, kokoro_module, _ = fake_tts_modules(
        pipeline_factory,
        free_bytes=KOKORO_GPU_MIN_FREE_BYTES - 1,
    )

    with patch.dict(modules, {"torch": torch_module, "kokoro": kokoro_module}):
        service = KokoroService()

    assert service.device == "cpu"
    pipeline_factory.assert_called_once_with(
        lang_code="a",
        repo_id=KOKORO_MODEL_REPO_ID,
        device="cpu",
    )


def test_kokoro_uses_cpu_when_cuda_is_unavailable() -> None:
    pipeline_factory = Mock(return_value=object())
    torch_module, kokoro_module, _ = fake_tts_modules(
        pipeline_factory,
        cuda_available=False,
    )

    with patch.dict(modules, {"torch": torch_module, "kokoro": kokoro_module}):
        service = KokoroService()

    assert service.device == "cpu"
    pipeline_factory.assert_called_once_with(
        lang_code="a",
        repo_id=KOKORO_MODEL_REPO_ID,
        device="cpu",
    )


def test_kokoro_falls_back_to_cpu_when_gpu_initialization_fails() -> None:
    pipeline_factory = Mock(side_effect=[RuntimeError("CUDA initialization failed"), object()])
    torch_module, kokoro_module, _ = fake_tts_modules(pipeline_factory)

    with patch.dict(modules, {"torch": torch_module, "kokoro": kokoro_module}):
        service = KokoroService()

    assert service.device == "cpu"
    assert [call.kwargs["device"] for call in pipeline_factory.call_args_list] == [
        "cuda",
        "cpu",
    ]


def test_kokoro_falls_back_to_cpu_after_gpu_out_of_memory() -> None:
    pipeline_factory = Mock(side_effect=[object(), object()])
    torch_module, kokoro_module, out_of_memory_error = fake_tts_modules(pipeline_factory)

    with patch.dict(modules, {"torch": torch_module, "kokoro": kokoro_module}):
        service = KokoroService()
        with patch.object(
            service,
            "_synthesize_to_wav",
            side_effect=[out_of_memory_error("CUDA out of memory"), b"cpu-audio"],
        ):
            audio = service.synthesize_to_wav("Hello there.")

    assert audio == b"cpu-audio"
    assert service.device == "cpu"
    assert [call.kwargs["device"] for call in pipeline_factory.call_args_list] == [
        "cuda",
        "cpu",
    ]
    torch_module.cuda.empty_cache.assert_called_once()


def test_backend_warmup_initializes_kokoro_service(caplog) -> None:
    service = Mock(device="cuda")
    caplog.set_level("INFO")

    with patch("app.main.get_kokoro_service", return_value=service):
        _warm_kokoro_service()

    service.warm_up.assert_called_once()
    assert "warmed on cuda" in caplog.text


def test_backend_warmup_logs_model_failure_without_raising(caplog) -> None:
    with patch(
        "app.main.get_kokoro_service",
        side_effect=RuntimeError("Kokoro model unavailable."),
    ):
        _warm_kokoro_service()

    assert "Kokoro warm-up failed" in caplog.text
