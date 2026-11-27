import gc
import logging
import re
import wave
from dataclasses import dataclass
from functools import lru_cache
from io import BytesIO
from pathlib import Path
from threading import RLock
from time import perf_counter
from typing import BinaryIO

KOKORO_CPU_DEVICE = "cpu"
KOKORO_GPU_DEVICE = "cuda"
KOKORO_GPU_MIN_FREE_BYTES = 1_536 * 1024 * 1024
KOKORO_MODEL_REPO_ID = "hexgrad/Kokoro-82M"
KOKORO_CPU_THREADS = 4
KOKORO_LANGUAGE = "a"
KOKORO_VOICE = "af_heart"
SAMPLE_RATE = 24_000
TTS_TEST_TEXT = "This is a local speech processing check."
logger = logging.getLogger(__name__)

_CODE_BLOCK = re.compile(r"```.*?(?:```|$)", re.DOTALL)
_INLINE_CODE = re.compile(r"`([^`\n]*)`")
_IMAGE = re.compile(r"!\[([^\]]*)\]\([^)]*\)")
_LINK = re.compile(r"\[([^\]]+)\]\([^)]*\)")
_HEADING = re.compile(r"^\s{0,3}#{1,6}\s+", re.MULTILINE)
_BLOCKQUOTE = re.compile(r"^\s{0,3}>\s?", re.MULTILINE)
_LIST_MARKER = re.compile(r"^\s*(?:[-*+]|\d+[.)])\s+", re.MULTILINE)
_TABLE_RULE = re.compile(r"^\s*\|?\s*:?-{3,}.*$", re.MULTILINE)
_HORIZONTAL_RULE = re.compile(r"^\s*(?:[-*_]\s*){3,}$", re.MULTILINE)
_EMPHASIS = re.compile(r"(\*{1,3}|~~)(?=\S)(.+?)(?<=\S)\1")
_UNDERSCORE_EMPHASIS = re.compile(r"(?<!\w)(_{1,3})(?=\S)(.+?)(?<=\S)\1(?!\w)")
_EMOJI = re.compile("[\U0001F000-\U0001FAFF\u2600-\u27BF\uFE0F\u200D]")


def prepare_speech_text(text: str) -> str:
    """Convert Markdown-formatted chat text into plain text suitable for speech."""
    spoken = _CODE_BLOCK.sub(" (code omitted) ", text)
    spoken = _INLINE_CODE.sub(r"\1", spoken)
    spoken = _IMAGE.sub(r"\1", spoken)
    spoken = _LINK.sub(r"\1", spoken)
    spoken = _TABLE_RULE.sub("", spoken)
    spoken = _HORIZONTAL_RULE.sub("", spoken)
    spoken = _HEADING.sub("", spoken)
    spoken = _BLOCKQUOTE.sub("", spoken)
    spoken = _LIST_MARKER.sub("", spoken)
    previous = None
    while previous != spoken:
        previous = spoken
        spoken = _EMPHASIS.sub(r"\2", spoken)
        spoken = _UNDERSCORE_EMPHASIS.sub(r"\2", spoken)
    spoken = _EMOJI.sub("", spoken)
    spoken = spoken.replace("|", ", ")
    lines = [" ".join(line.split()) for line in spoken.splitlines()]
    return "\n".join(line for line in lines if line).strip()


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

        self._torch = torch
        self._pipeline_factory = KPipeline
        self._inference_lock = RLock()
        torch.set_num_threads(KOKORO_CPU_THREADS)
        self.device = self._select_device()
        started = perf_counter()
        try:
            self._pipeline = self._load_pipeline(self.device)
        except (OSError, RuntimeError) as error:
            if self.device != KOKORO_GPU_DEVICE:
                raise RuntimeError(
                    "Could not load the local Kokoro model. Check that its model files "
                    "are available in the local cache."
                ) from error
            logger.warning(
                "Kokoro GPU initialization failed; falling back to CPU: %s",
                error,
            )
            self.device = KOKORO_CPU_DEVICE
            try:
                self._pipeline = self._load_pipeline(self.device)
            except (OSError, RuntimeError) as cpu_error:
                raise RuntimeError(
                    "Could not load the local Kokoro model on GPU or CPU. Check that "
                    "its model files are available in the local cache."
                ) from cpu_error
        self.load_seconds = perf_counter() - started

    def synthesize_to_wav(self, text: str, voice: str = KOKORO_VOICE) -> bytes:
        with self._inference_lock:
            try:
                return self._synthesize_to_wav(text, voice)
            except RuntimeError as error:
                if self.device != KOKORO_GPU_DEVICE or not self._is_cuda_oom(error):
                    raise
                self._fallback_to_cpu(error)
                return self._synthesize_to_wav(text, voice)

    def warm_up(self) -> None:
        self.synthesize_to_wav(TTS_TEST_TEXT)

    def _select_device(self) -> str:
        try:
            cuda_available = self._torch.cuda.is_available()
        except RuntimeError as error:
            logger.warning(
                "Could not initialize CUDA detection; using CPU for Kokoro: %s",
                error,
            )
            return KOKORO_CPU_DEVICE

        if not cuda_available:
            logger.info("CUDA is unavailable; using CPU for Kokoro.")
            return KOKORO_CPU_DEVICE

        try:
            free_bytes, _ = self._torch.cuda.mem_get_info()
        except RuntimeError as error:
            logger.warning(
                "Could not inspect CUDA memory; using CPU for Kokoro: %s",
                error,
            )
            return KOKORO_CPU_DEVICE

        if free_bytes < KOKORO_GPU_MIN_FREE_BYTES:
            logger.info(
                "Only %.2f GiB of CUDA memory is free; using CPU for Kokoro.",
                free_bytes / (1024**3),
            )
            return KOKORO_CPU_DEVICE
        return KOKORO_GPU_DEVICE

    def _load_pipeline(self, device: str):
        return self._pipeline_factory(
            lang_code=KOKORO_LANGUAGE,
            repo_id=KOKORO_MODEL_REPO_ID,
            device=device,
        )

    def _is_cuda_oom(self, error: RuntimeError) -> bool:
        oom_error = getattr(self._torch.cuda, "OutOfMemoryError", None)
        return oom_error is not None and isinstance(error, oom_error)

    def _fallback_to_cpu(self, error: RuntimeError) -> None:
        logger.warning("Kokoro ran out of CUDA memory; falling back to CPU: %s", error)
        gpu_pipeline = self._pipeline
        self._pipeline = None
        gc.collect()
        self._torch.cuda.empty_cache()
        try:
            self._pipeline = self._load_pipeline(KOKORO_CPU_DEVICE)
        except (OSError, RuntimeError) as cpu_error:
            self._pipeline = gpu_pipeline
            raise RuntimeError(
                "Kokoro ran out of GPU memory and could not fall back to CPU."
            ) from cpu_error
        self.device = KOKORO_CPU_DEVICE

    def _synthesize_to_wav(self, text: str, voice: str = KOKORO_VOICE) -> bytes:
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
            for _, _, audio in self._pipeline(text, voice=voice):
                if hasattr(audio, "detach"):
                    audio = audio.detach().cpu().numpy()
                chunks.append(np.asarray(audio, dtype=np.float32).reshape(-1))
        except (OSError, RuntimeError, ValueError) as error:
            if isinstance(error, RuntimeError) and self._is_cuda_oom(error):
                raise
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
                'Install local STT dependencies with: '
                'python -m pip install -e ".[stt]".'
            ) from error

        try:
            self._model = WhisperModel(
                "base",
                device="cpu",
                compute_type="int8",
                cpu_threads=4,
            )
        except (OSError, RuntimeError) as error:
            raise RuntimeError(
                "Could not load the local faster-whisper base model. "
                "Check that its model files are available in the local cache."
            ) from error

    def transcribe(self, audio_path: Path) -> TranscriptionResult:
        if not audio_path.is_file():
            raise FileNotFoundError(f"Audio file not found: {audio_path}")

        return self._transcribe(str(audio_path))

    def transcribe_bytes(self, audio_data: bytes) -> TranscriptionResult:
        if not audio_data:
            raise ValueError("No audio was received.")

        return self._transcribe(BytesIO(audio_data))

    def _transcribe(self, audio: str | BinaryIO) -> TranscriptionResult:
        try:
            import av
        except ImportError as error:
            raise RuntimeError(
                'Install local STT dependencies with: '
                'python -m pip install -e ".[stt]".'
            ) from error

        started = perf_counter()
        try:
            segments, info = self._model.transcribe(
                audio,
                beam_size=1,
                vad_filter=True,
            )
            text = " ".join(segment.text.strip() for segment in segments).strip()
        except (av.error.FFmpegError, ValueError) as error:
            raise ValueError(
                "The recording is empty or uses an unsupported audio format."
            ) from error
        except (OSError, RuntimeError) as error:
            raise RuntimeError("Local speech transcription failed.") from error
        return TranscriptionResult(
            text=text,
            language=info.language,
            elapsed_seconds=perf_counter() - started,
        )


_kokoro_service: KokoroService | None = None
_kokoro_service_lock = RLock()


def get_kokoro_service() -> KokoroService:
    global _kokoro_service
    if _kokoro_service is not None:
        return _kokoro_service
    with _kokoro_service_lock:
        if _kokoro_service is None:
            _kokoro_service = KokoroService()
        return _kokoro_service


@lru_cache(maxsize=1)
def get_whisper_service() -> WhisperService:
    return WhisperService()
