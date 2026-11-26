from dataclasses import dataclass
from pathlib import Path
from time import perf_counter

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
                'Install optional speech dependencies with: '
                'python -m pip install -e ".[feasibility]".'
            ) from error

        torch.set_num_threads(4)
        started = perf_counter()
        self._pipeline = KPipeline(lang_code="a", device="cpu")
        self.load_seconds = perf_counter() - started

    def synthesize_to_file(
        self,
        output_path: Path,
        text: str = TTS_TEST_TEXT,
    ) -> tuple[float, float]:
        try:
            import numpy as np
            import soundfile as sf
        except ImportError as error:
            raise RuntimeError(
                'Install optional speech dependencies with: '
                'python -m pip install -e ".[feasibility]".'
            ) from error

        chunks = []
        started = perf_counter()
        for _, _, audio in self._pipeline(text, voice="af_heart"):
            if hasattr(audio, "detach"):
                audio = audio.detach().cpu().numpy()
            chunks.append(np.asarray(audio, dtype=np.float32).reshape(-1))

        if not chunks:
            raise RuntimeError("Kokoro produced no audio chunks.")

        samples = np.concatenate(chunks)
        output_path.parent.mkdir(parents=True, exist_ok=True)
        sf.write(output_path, samples, SAMPLE_RATE)
        elapsed = perf_counter() - started
        return elapsed, len(samples) / SAMPLE_RATE


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
