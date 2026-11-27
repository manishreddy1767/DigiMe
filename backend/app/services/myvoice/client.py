"""Talks to the voice helper (worker.py) running in the GPU Python environment.

One request at a time, over the helper's stdin/stdout. The helper is started on first use and
started again if it dies; a request that times out kills it, so a stuck GPU can't hang replies.
"""

from __future__ import annotations

import base64
import json
import logging
import queue
import subprocess
import sys
import threading
from pathlib import Path
from typing import Protocol

import numpy as np

from ..avatar.renderer import DEFAULT_ROOT as GPU_ENV_ROOT
from ..avatar.renderer import venv_python
from ..paths import models_dir

log = logging.getLogger(__name__)
WORKER = Path(__file__).with_name("worker.py")
OPENVOICE_ROOT = models_dir() / "openvoice"
CONVERTER = OPENVOICE_ROOT / "checkpoints_v2" / "converter" / "checkpoint.pth"
START_TIMEOUT = 120.0


class VoiceHelperError(Exception):
    """The helper failed. `user` is True when the message is meant for the person (bad recording)."""

    def __init__(self, message: str, *, user: bool = False):
        super().__init__(message)
        self.user = user


class Helper(Protocol):
    def unavailable_reason(self) -> str | None: ...

    def prepare(self, src: Path, dst: Path) -> float: ...

    def voiceprint(self, samples: list[Path], out: Path) -> None: ...

    def convert(self, audio: np.ndarray, sample_rate: int, target: Path, source: str) -> tuple[np.ndarray, int]: ...

    def close(self) -> None: ...


class VoiceHelper:
    def __init__(self, python: Path | None = None, openvoice: Path = OPENVOICE_ROOT,
                 log_path: Path | None = None, timeout: float = 30.0):
        self.python = python or venv_python(GPU_ENV_ROOT)
        self.openvoice = openvoice
        self.log_path = log_path
        self.timeout = timeout
        self._process: subprocess.Popen[str] | None = None
        self._replies: queue.Queue[str | None] = queue.Queue()
        self._lock = threading.Lock()
        self._next_id = 1

    def unavailable_reason(self) -> str | None:
        if not self.python.is_file():
            return "The GPU environment is not installed (run scripts\\setup-voice.ps1)"
        if not (self.openvoice / "checkpoints_v2" / "converter" / "checkpoint.pth").is_file():
            return "OpenVoice is not installed (run scripts\\setup-voice.ps1)"
        return None

    # ---------------------------------------------------------------- commands

    def prepare(self, src: Path, dst: Path) -> float:
        return float(self._ask({"cmd": "prepare", "src": str(src), "dst": str(dst)}, timeout=180)["seconds"])

    def voiceprint(self, samples: list[Path], out: Path) -> None:
        self._ask({"cmd": "voiceprint", "samples": [str(p) for p in samples], "out": str(out)}, timeout=180)

    def convert(self, audio: np.ndarray, sample_rate: int, target: Path, source: str) -> tuple[np.ndarray, int]:
        data = base64.b64encode(np.ascontiguousarray(audio, dtype=np.float32).tobytes()).decode("ascii")
        reply = self._ask({"cmd": "convert", "audio": data, "sr": sample_rate, "target": str(target), "source": source})
        return np.frombuffer(base64.b64decode(reply["audio"]), dtype=np.float32), int(reply["sr"])

    def warm_up(self) -> None:
        self._ask({"cmd": "ping"})

    def close(self) -> None:
        with self._lock:
            self._stop()

    # ---------------------------------------------------------------- plumbing

    def _ask(self, request: dict, timeout: float | None = None) -> dict:
        with self._lock:
            self._ensure_started()
            request = {"id": self._next_id, **request}
            self._next_id += 1
            assert self._process is not None and self._process.stdin is not None
            try:
                self._process.stdin.write(json.dumps(request) + "\n")
                self._process.stdin.flush()
            except OSError:
                self._stop()
                raise VoiceHelperError("The voice helper stopped unexpectedly") from None
            reply = self._read(timeout or self.timeout)
            if reply.get("id") != request["id"]:
                self._stop()
                raise VoiceHelperError("The voice helper got out of step")
        if not reply.get("ok"):
            raise VoiceHelperError(reply.get("error") or "The voice helper failed", user=bool(reply.get("user")))
        return reply

    def _read(self, timeout: float) -> dict:
        try:
            line = self._replies.get(timeout=timeout)
        except queue.Empty:
            self._stop()
            raise VoiceHelperError("The voice helper took too long") from None
        if line is None:
            self._stop()
            raise VoiceHelperError("The voice helper stopped unexpectedly")
        return json.loads(line)

    def _ensure_started(self) -> None:
        if self._process is not None and self._process.poll() is None:
            return
        reason = self.unavailable_reason()
        if reason:
            raise VoiceHelperError(reason)
        log_file = open(self.log_path, "a", encoding="utf-8") if self.log_path else subprocess.DEVNULL  # noqa: SIM115
        flags = subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0
        self._process = subprocess.Popen(
            [str(self.python), str(WORKER), str(self.openvoice)],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=log_file,
            text=True, encoding="utf-8", bufsize=1, creationflags=flags,
        )
        self._replies = queue.Queue()
        threading.Thread(target=self._pump, args=(self._process, self._replies), daemon=True).start()
        hello = self._read(START_TIMEOUT)
        if not hello.get("ok"):
            self._stop()
            raise VoiceHelperError(hello.get("error") or "The voice helper failed to start")
        log.info("Voice helper started on %s", hello.get("device"))

    @staticmethod
    def _pump(process: subprocess.Popen[str], replies: queue.Queue[str | None]) -> None:
        assert process.stdout is not None
        for line in process.stdout:
            if line.strip():
                replies.put(line)
        replies.put(None)  # the helper exited

    def _stop(self) -> None:
        if self._process is None:
            return
        try:
            if self._process.stdin:
                self._process.stdin.close()
            self._process.wait(timeout=5)
        except (OSError, subprocess.TimeoutExpired):
            self._process.kill()
        self._process = None
