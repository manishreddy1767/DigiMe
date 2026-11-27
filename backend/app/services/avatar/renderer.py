"""Run the LivePortrait render script in LivePortrait's own Python environment.

LivePortrait needs a CUDA build of PyTorch; the backend uses a CPU build for its speech models.
Keeping them in separate environments means neither install can break the other.
"""

from __future__ import annotations

import json
import logging
import os
import subprocess
import sys
from collections.abc import Callable
from pathlib import Path
from typing import Protocol

from ..paths import models_dir

log = logging.getLogger(__name__)
DEFAULT_ROOT = models_dir() / "liveportrait"
SCRIPT = Path(__file__).with_name("lp_render.py")
WEIGHTS = ("pretrained_weights/liveportrait/base_models/spade_generator.pth",
           "pretrained_weights/insightface/models/buffalo_l/det_10g.onnx")

Progress = Callable[[int, int], None]


class RenderError(Exception):
    """Rendering failed; the message is shown to the user."""


class Renderer(Protocol):
    def unavailable_reason(self) -> str | None: ...

    def render(self, photo: Path, out_dir: Path, plan: list[dict], on_progress: Progress) -> None: ...


def venv_python(root: Path) -> Path:
    return root / ".venv" / ("Scripts/python.exe" if os.name == "nt" else "bin/python")


class LivePortraitRenderer:
    def __init__(self, root: Path = DEFAULT_ROOT, python: Path | None = None, timeout: float = 900):
        self.root = root
        self.python = python or venv_python(root)
        self.timeout = timeout

    def unavailable_reason(self) -> str | None:
        if not self.python.is_file():
            return "LivePortrait is not installed (run scripts\\setup-avatar.ps1)"
        if not all((self.root / weight).is_file() for weight in WEIGHTS):
            return "LivePortrait's model files are missing (run scripts\\setup-avatar.ps1)"
        return None

    def render(self, photo: Path, out_dir: Path, plan: list[dict], on_progress: Progress) -> None:
        reason = self.unavailable_reason()
        if reason:
            raise RenderError(reason)
        out_dir.mkdir(parents=True, exist_ok=True)
        plan_path = out_dir / "plan.json"
        plan_path.write_text(json.dumps(plan), encoding="utf-8")
        command = [str(self.python), str(SCRIPT), "--liveportrait", str(self.root),
                   "--photo", str(photo), "--plan", str(plan_path), "--out", str(out_dir)]
        # stderr goes to a log file: LivePortrait is chatty, and an unread pipe could block it.
        log_path = out_dir.parent / "render.log"
        flags = subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0
        with open(log_path, "w", encoding="utf-8", errors="replace") as log_file:
            process = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=log_file, text=True,
                                       encoding="utf-8", errors="replace", creationflags=flags)
            error = None
            try:
                for line in process.stdout:  # type: ignore[union-attr]
                    error = parse_line(line, on_progress) or error
                code = process.wait(timeout=self.timeout)
            except subprocess.TimeoutExpired:
                process.kill()
                raise RenderError("Creating the avatar took too long") from None
        plan_path.unlink(missing_ok=True)
        if code != 0:
            log.error("Avatar render failed with exit code %s; see %s", code, log_path)
            raise RenderError(error or "Creating the avatar failed")


def parse_line(line: str, on_progress: Progress) -> str | None:
    """Handle one stdout line from the render script. Returns an error message, if any."""
    parts = line.strip().split(" ", 1)
    if parts[0] == "progress" and len(parts) == 2:
        try:
            done, total = (int(n) for n in parts[1].split())
        except ValueError:
            return None
        on_progress(done, total)
    elif parts[0] == "error" and len(parts) == 2:
        return parts[1]
    return None
