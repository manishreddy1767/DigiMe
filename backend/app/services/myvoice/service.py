"""The person's own voice: recordings, the voiceprint learnt from them, and the on/off switch.

Files live in the instance's private voice folder (never committed):

    samples/001.wav ...   the recordings, cleaned (trimmed, mono, normalised)
    voiceprint.npy        what the voice sounds like, learnt from all the samples
    helper.log            the voice helper's output
"""

from __future__ import annotations

import logging
import re
import threading
from pathlib import Path

from typing import Protocol

import soundfile

from .client import Helper, VoiceHelperError

log = logging.getLogger(__name__)

MIN_SECONDS = 10.0  # enough to switch the voice on
RECOMMENDED_SECONDS = 60.0  # more recordings: a closer match
MAX_SAMPLES = 40
MAX_UPLOAD_BYTES = 25 * 1024 * 1024
SAMPLE_NAME = re.compile(r"^\d{3}\.wav$")
UPLOAD_SUFFIXES = {
    "audio/wav": ".wav", "audio/x-wav": ".wav", "audio/wave": ".wav", "audio/mpeg": ".mp3",
    "audio/mp4": ".m4a", "audio/x-m4a": ".m4a", "audio/aac": ".aac", "audio/ogg": ".ogg",
    "audio/webm": ".webm", "audio/flac": ".flac", "video/webm": ".webm",
}


class MyVoicePreferences(Protocol):
    """Where the on/off switch is stored (the local database in the app)."""

    def enabled(self) -> bool: ...

    def set_enabled(self, enabled: bool) -> None: ...


class MyVoiceError(Exception):
    """Shown to the person as is."""


class MyVoice:
    def __init__(self, directory: Path, helper: Helper, preferences: MyVoicePreferences):
        self.directory = directory
        self.helper = helper
        self.preferences = preferences
        self._lock = threading.Lock()

    @property
    def samples_dir(self) -> Path:
        return self.directory / "samples"

    @property
    def voiceprint_path(self) -> Path:
        return self.directory / "voiceprint.npy"

    # ---------------------------------------------------------------- reading

    def samples(self) -> list[dict]:
        found = []
        for path in sorted(self.samples_dir.glob("*.wav")):
            if not SAMPLE_NAME.match(path.name):
                continue
            try:
                found.append({"name": path.name, "seconds": round(soundfile.info(str(path)).duration, 1)})
            except RuntimeError:  # unreadable file: ignore it rather than break the panel
                log.warning("Skipping unreadable voice sample %s", path)
        return found

    def seconds(self) -> float:
        return round(sum(s["seconds"] for s in self.samples()), 1)

    @property
    def ready(self) -> bool:
        """Enough recordings and a voiceprint: the voice can be used."""
        return self.voiceprint_path.is_file() and self.seconds() >= MIN_SECONDS

    @property
    def active(self) -> bool:
        return self.preferences.enabled() and self.ready

    @property
    def variant(self) -> str:
        """Changes whenever the spoken voice would change (cache key for pre-made clips)."""
        if not self.active:
            return ""
        return f"mine-{self.voiceprint_path.stat().st_mtime_ns}"

    def state(self) -> dict:
        samples = self.samples()
        seconds = round(sum(s["seconds"] for s in samples), 1)
        ready = self.voiceprint_path.is_file() and seconds >= MIN_SECONDS
        return {
            "status": "ready" if ready else ("collecting" if samples else "none"),
            "samples": samples,
            "seconds": seconds,
            "min_seconds": MIN_SECONDS,
            "recommended_seconds": RECOMMENDED_SECONDS,
            "max_samples": MAX_SAMPLES,
            "enabled": self.preferences.enabled() and ready,
            "unavailable": self.helper.unavailable_reason(),
        }

    def sample_path(self, name: str) -> Path | None:
        if not SAMPLE_NAME.match(name):
            return None
        path = self.samples_dir / name
        return path if path.is_file() else None

    # ---------------------------------------------------------------- changing (blocking)

    def add_sample(self, data: bytes, content_type: str) -> dict:
        suffix = UPLOAD_SUFFIXES.get(content_type.split(";")[0].strip().lower())
        if suffix is None:
            raise MyVoiceError("Please use an audio recording (WAV, MP3, M4A, OGG, WebM or FLAC)")
        if not data:
            raise MyVoiceError("The recording is empty")
        if len(data) > MAX_UPLOAD_BYTES:
            raise MyVoiceError("The recording is too large (25 MB at most)")
        reason = self.helper.unavailable_reason()
        if reason:
            raise MyVoiceError(reason)
        with self._lock:
            existing = self.samples()
            if len(existing) >= MAX_SAMPLES:
                raise MyVoiceError(f"That's the most recordings it keeps ({MAX_SAMPLES}). Remove some first")
            number = max((int(s["name"][:3]) for s in existing), default=0) + 1
            self.samples_dir.mkdir(parents=True, exist_ok=True)
            upload = self.directory / f"upload{suffix}"
            upload.write_bytes(data)
            try:
                self.helper.prepare(upload, self.samples_dir / f"{number:03}.wav")
            except VoiceHelperError as exc:
                raise MyVoiceError(str(exc) if exc.user else f"Could not use the recording: {exc}") from None
            finally:
                upload.unlink(missing_ok=True)
            self._rebuild()
        return self.state()

    def remove_sample(self, name: str) -> dict:
        with self._lock:
            path = self.sample_path(name)
            if path is None:
                raise KeyError(name)
            path.unlink()
            self._rebuild()
        return self.state()

    def clear(self) -> None:
        with self._lock:
            for path in self.samples_dir.glob("*.wav"):
                path.unlink()
            self.voiceprint_path.unlink(missing_ok=True)
            self.preferences.set_enabled(False)

    def set_enabled(self, enabled: bool) -> dict:
        if enabled and not self.ready:
            raise MyVoiceError(f"Record at least {MIN_SECONDS:.0f} seconds first")
        self.preferences.set_enabled(enabled)
        return self.state()

    def _rebuild(self) -> None:
        samples = [self.samples_dir / s["name"] for s in self.samples()]
        if not samples:
            self.voiceprint_path.unlink(missing_ok=True)
            return
        try:
            self.helper.voiceprint(samples, self.voiceprint_path)
        except VoiceHelperError as exc:
            raise MyVoiceError(f"Could not learn the voice: {exc}") from None
