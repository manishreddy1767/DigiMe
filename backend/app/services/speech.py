import wave
from dataclasses import dataclass
from functools import lru_cache
from io import BytesIO
from pathlib import Path
from time import perf_counter

KOKORO_CPU_DEVICE = "cpu"
KOKORO_MODEL_REPO_ID = "hexgrad/Kokoro-82M"
KOKORO_CPU_THREADS = 4
KOKORO_LANGUAGE = "a"
KOKORO_VOICE = "af_heart"
SAMPLE_RATE = 24_000
TTS_TEST_TEXT = "This is a local CPU speech processing check."


@dataclass(frozen=True)
class TranscriptionResult:
    text: str
    language: str
    elapsed_seconds: float


class KokoroService:
    def __init__(self) -> None:
        try:
            import torch
            from kokoro import KPipeline
        except ImportError as error:
            raise RuntimeError(
                'Install local TTS dependencies with: '
                'python -m pip install -e ".[tts]".'
            ) from error

        torch.set_num_threads(KOKORO_CPU_THREADS)
        started = perf_counter()
        try:
            self._pipeline = KPipeline(
                lang_code=KOKORO_LANGUAGE,
                repo_id=KOKORO_MODEL_REPO_ID,
                device=KOKORO_CPU_DEVICE,
            )
        except (OSError, RuntimeError) as error:
            raise RuntimeError(
                "Could not load the local Kokoro model. Check that its model files "
                "are available in the local cache."
            ) from error
        self.load_seconds = perf_counter() - started

    def synthesize_to_wav(self, text: str) -> bytes:
        try:
            import numpy as np
            import soundfile as sf
        except ImportError as error:
            raise RuntimeError(
                'Install local TTS dependencies with: '
                'python -m pip install -e ".[tts]".'
            ) from error

        chunks = []
        try:
            for _, _, audio in self._pipeline(text, voice=KOKORO_VOICE):
                if hasattr(audio, "detach"):
                    audio = audio.detach().cpu().numpy()
                chunks.append(np.asarray(audio, dtype=np.float32).reshape(-1))
        except (OSError, RuntimeError, ValueError) as error:
            raise RuntimeError("Kokoro speech synthesis failed.") from error

        if not chunks:
            raise RuntimeError("Kokoro produced no audio chunks.")

        try:
            samples = np.concatenate(chunks)
        except ValueError as error:
            raise RuntimeError("Kokoro produced invalid audio samples.") from error
        if samples.size == 0:
            raise RuntimeError("Kokoro produced no audio samples.")
        output = BytesIO()
        try:
            sf.write(output, samples, SAMPLE_RATE, format="WAV")
        except (OSError, RuntimeError, ValueError) as error:
            raise RuntimeError("Could not encode the generated speech audio.") from error
        return output.getvalue()

    def synthesize_to_file(
        self,
        output_path: Path,
        text: str = TTS_TEST_TEXT,
    ) -> tuple[float, float]:
        output_path.parent.mkdir(parents=True, exist_ok=True)
        started = perf_counter()
        wav_bytes = self.synthesize_to_wav(text)
        output_path.write_bytes(wav_bytes)
        elapsed = perf_counter() - started
        with wave.open(BytesIO(wav_bytes), "rb") as wav_file:
            audio_seconds = wav_file.getnframes() / wav_file.getframerate()
        return elapsed, audio_seconds


class WhisperService:
    def __init__(self) -> None:
        try:
            from faster_whisper import WhisperModel
        except ImportError as error:
            raise RuntimeError(
                'Install optional speech dependencies with: '
                'python -m pip install -e ".[feasibility]".'
            ) from error

        self._model = WhisperModel(
            "base",
            device="cpu",
            compute_type="int8",
            cpu_threads=4,
        )

    def transcribe(self, audio_path: Path) -> TranscriptionResult:
        if not audio_path.is_file():
            raise FileNotFoundError(f"Audio file not found: {audio_path}")

        started = perf_counter()
        segments, info = self._model.transcribe(
            str(audio_path),
            beam_size=1,
            vad_filter=True,
        )
        text = " ".join(segment.text.strip() for segment in segments).strip()
        return TranscriptionResult(
            text=text,
            language=info.language,
            elapsed_seconds=perf_counter() - started,
        )


@lru_cache(maxsize=1)
def get_kokoro_service() -> KokoroService:
    return KokoroService()
