"""The instance's photo avatar: upload, render in the background, serve frames, remove.

Files live in the instance's private avatar folder (never committed):

    photo.jpg              the cleaned upload
    frames/                the rendered poses and manifest.json
    render.log             LivePortrait's output from the last render
"""

from __future__ import annotations

import asyncio
import json
import logging
import shutil
import time
from collections.abc import Awaitable, Callable
from pathlib import Path

from .photo import clean_photo
from .poses import render_plan
from .renderer import Renderer, RenderError

log = logging.getLogger(__name__)
Hook = Callable[[], Awaitable[None]]


class AvatarBusyError(Exception):
    """An avatar is being created; wait for it to finish."""


class AvatarService:
    def __init__(self, directory: Path, renderer: Renderer, *,
                 before_render: Hook | None = None, after_render: Hook | None = None):
        self.directory = directory
        self.renderer = renderer
        self.before_render = before_render
        self.after_render = after_render
        self.rendering = False
        self.progress: tuple[int, int] | None = None
        self.error: str | None = None
        self._task: asyncio.Task[None] | None = None

    @property
    def photo_path(self) -> Path:
        return self.directory / "photo.jpg"

    @property
    def frames_dir(self) -> Path:
        return self.directory / "frames"

    def manifest(self) -> dict | None:
        try:
            manifest = json.loads((self.frames_dir / "manifest.json").read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return None
        return manifest if isinstance(manifest, dict) and manifest.get("frames") else None

    def state(self) -> dict:
        manifest = self.manifest()
        if self.rendering:
            status = "rendering"
        elif self.error:
            status = "error"
        else:
            status = "ready" if manifest else "none"
        return {
            "status": status,
            "progress": {"done": self.progress[0], "total": self.progress[1]} if self.rendering and self.progress else None,
            "error": self.error if status == "error" else None,
            "unavailable": self.renderer.unavailable_reason(),
            "avatar": manifest,  # still shown while a new one is being created
        }

    def frame_path(self, name: str) -> Path | None:
        """Only files listed in the manifest are served."""
        manifest = self.manifest()
        if not manifest or name not in manifest["frames"]:
            return None
        path = self.frames_dir / name
        return path if path.is_file() else None

    async def upload(self, data: bytes) -> None:
        """Store a new photo and start creating the avatar from it. Raises PhotoError."""
        if self.rendering:
            raise AvatarBusyError("Your avatar is still being created")
        reason = self.renderer.unavailable_reason()
        if reason:
            raise RenderError(reason)
        photo = clean_photo(data)
        self.directory.mkdir(parents=True, exist_ok=True)
        temporary = self.photo_path.with_suffix(".tmp")
        temporary.write_bytes(photo)
        temporary.replace(self.photo_path)
        self.rendering, self.progress, self.error = True, (0, len(render_plan())), None
        self._task = asyncio.create_task(self._render())

    async def wait(self) -> None:
        if self._task is not None:
            await self._task

    async def _render(self) -> None:
        staging = self.directory / "frames.new"
        shutil.rmtree(staging, ignore_errors=True)
        try:
            if self.before_render:
                await _quietly(self.before_render)
            started = time.perf_counter()
            await asyncio.to_thread(
                self.renderer.render, self.photo_path, staging, render_plan(), self._on_progress
            )
            manifest = json.loads((staging / "manifest.json").read_text(encoding="utf-8"))
            manifest["version"] = time.time_ns()  # lets the browser drop cached frames
            (staging / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
            shutil.rmtree(self.frames_dir, ignore_errors=True)
            staging.replace(self.frames_dir)
            log.info("Avatar created in %.0f s", time.perf_counter() - started)
        except RenderError as exc:
            self.error = str(exc)
        except Exception:
            log.exception("Avatar render failed")
            self.error = "Creating the avatar failed"
        finally:
            shutil.rmtree(staging, ignore_errors=True)
            self.rendering = False
            if self.after_render:
                await _quietly(self.after_render)

    def _on_progress(self, done: int, total: int) -> None:
        self.progress = (done, total)

    def remove(self) -> None:
        if self.rendering:
            raise AvatarBusyError("Your avatar is still being created")
        shutil.rmtree(self.frames_dir, ignore_errors=True)
        self.photo_path.unlink(missing_ok=True)
        (self.directory / "render.log").unlink(missing_ok=True)
        self.error = None


async def _quietly(hook: Hook) -> None:
    try:
        await hook()
    except Exception:  # freeing or reloading the GPU is best effort
        log.warning("Avatar render hook failed", exc_info=True)
