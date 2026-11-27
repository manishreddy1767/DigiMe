"""Your own avatar and your own voice: API routes and the shared local services.

Both features run their GPU models in a separate Python environment (see
scripts/setup-avatar.ps1 and scripts/setup-voice.ps1). Photos, recordings and rendered
frames stay in private folders next to the local database, never in the repository.
"""

import asyncio
import logging
from io import BytesIO
from pathlib import Path

from fastapi import APIRouter, HTTPException, Request, Response
from fastapi.responses import FileResponse
from pydantic import BaseModel, ConfigDict

from app.services.avatar.photo import PhotoError
from app.services.avatar.renderer import LivePortraitRenderer, Renderer, RenderError
from app.services.avatar.service import AvatarBusyError, AvatarService
from app.services.myvoice.client import Helper, VoiceHelper, VoiceHelperError
from app.services.myvoice.service import MyVoice, MyVoiceError
from app.services.ollama import OllamaService
from app.services.paths import private_media_dir
from app.services.storage import Database

log = logging.getLogger(__name__)
router = APIRouter()

MAX_PHOTO_BYTES = 20 * 1024 * 1024
MAX_SAMPLE_BYTES = 25 * 1024 * 1024


class MyVoiceUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    enabled: bool | None = None


class DatabaseMyVoicePreferences:
    """Stores the "speak in my voice" switch in the local database."""

    def enabled(self) -> bool:
        return Database().get_my_voice_enabled()

    def set_enabled(self, enabled: bool) -> None:
        Database().set_my_voice_enabled(enabled)


# ------------------------------------------------------------------ shared services

def make_renderer() -> Renderer:
    return LivePortraitRenderer()


def make_voice_helper(log_path: Path) -> Helper:
    return VoiceHelper(log_path=log_path)


_avatar_services: dict[Path, AvatarService] = {}
_my_voices: dict[Path, MyVoice] = {}


async def _free_gpu_for_render() -> None:
    """LivePortrait needs most of a small GPU: unload the language models first.

    Ollama loads the model again on the next message.
    """
    await asyncio.to_thread(OllamaService().unload_models)


def get_avatar_service() -> AvatarService:
    directory = private_media_dir("avatar")
    service = _avatar_services.get(directory)
    if service is None:
        service = AvatarService(directory, make_renderer(), before_render=_free_gpu_for_render)
        _avatar_services[directory] = service
    return service


def get_my_voice() -> MyVoice:
    directory = private_media_dir("voice")
    my_voice = _my_voices.get(directory)
    if my_voice is None:
        directory.mkdir(parents=True, exist_ok=True)
        my_voice = MyVoice(
            directory,
            make_voice_helper(directory / "helper.log"),
            DatabaseMyVoicePreferences(),
        )
        _my_voices[directory] = my_voice
    return my_voice


def apply_my_voice(wav: bytes, voice: str, mine: bool | None = None) -> bytes:
    """Turn built-in speech into the person's own voice when it is switched on.

    `mine` forces it on or off (for a preview); None follows the saved switch. Any failure
    keeps the built-in voice, so speech never breaks because of voice cloning.
    """
    my_voice = get_my_voice()
    use = my_voice.active if mine is None else (mine and my_voice.ready)
    if not use:
        return wav
    try:
        import soundfile

        audio, rate = soundfile.read(BytesIO(wav), dtype="float32")
        converted, converted_rate = my_voice.helper.convert(
            audio, rate, my_voice.voiceprint_path, f"en:{voice}"
        )
        output = BytesIO()
        soundfile.write(output, converted, converted_rate, format="WAV")
        return output.getvalue()
    except (VoiceHelperError, ImportError, RuntimeError, ValueError, OSError):
        log.warning("Using the built-in voice: the voice helper failed", exc_info=True)
        return wav


# ------------------------------------------------------------------ avatar routes

@router.get("/api/avatar")
def get_avatar() -> dict:
    return get_avatar_service().state()


@router.put("/api/avatar", status_code=202)
async def upload_avatar(request: Request) -> dict:
    avatar = get_avatar_service()
    if not request.headers.get("content-type", "").startswith("image/"):
        raise HTTPException(status_code=415, detail="Please send a photo")
    if int(request.headers.get("content-length") or 0) > MAX_PHOTO_BYTES:
        raise HTTPException(status_code=413, detail="The photo is too large (20 MB at most)")
    try:
        await avatar.upload(await request.body())
    except PhotoError as error:
        raise HTTPException(status_code=422, detail=str(error)) from None
    except AvatarBusyError as error:
        raise HTTPException(status_code=409, detail=str(error)) from None
    except RenderError as error:
        raise HTTPException(status_code=503, detail=str(error)) from None
    return avatar.state()


@router.delete("/api/avatar", status_code=204)
def delete_avatar() -> Response:
    try:
        get_avatar_service().remove()
    except AvatarBusyError as error:
        raise HTTPException(status_code=409, detail=str(error)) from None
    return Response(status_code=204)


@router.get("/api/avatar/frames/{name}")
def avatar_frame(name: str) -> FileResponse:
    path = get_avatar_service().frame_path(name)
    if path is None:
        raise HTTPException(status_code=404, detail="No such frame")
    # Frame URLs carry the avatar's version, so a new avatar never shows stale frames.
    return FileResponse(
        path,
        media_type="image/jpeg",
        headers={"Cache-Control": "private, max-age=31536000, immutable"},
    )


# ------------------------------------------------------------------ own-voice routes

@router.get("/api/my-voice")
def get_my_voice_state() -> dict:
    return get_my_voice().state()


@router.post("/api/my-voice/samples", status_code=201)
async def add_voice_sample(request: Request) -> dict:
    my_voice = get_my_voice()
    content_type = request.headers.get("content-type", "")
    if not content_type.startswith(("audio/", "video/webm")):
        raise HTTPException(status_code=415, detail="Please send an audio recording")
    if int(request.headers.get("content-length") or 0) > MAX_SAMPLE_BYTES:
        raise HTTPException(status_code=413, detail="The recording is too large (25 MB at most)")
    try:
        return await asyncio.to_thread(my_voice.add_sample, await request.body(), content_type)
    except MyVoiceError as error:
        raise HTTPException(status_code=422, detail=str(error)) from None


@router.get("/api/my-voice/samples/{name}")
def voice_sample(name: str) -> FileResponse:
    path = get_my_voice().sample_path(name)
    if path is None:
        raise HTTPException(status_code=404, detail="No such recording")
    return FileResponse(path, media_type="audio/wav", headers={"Cache-Control": "no-store"})


@router.delete("/api/my-voice/samples/{name}")
async def delete_voice_sample(name: str) -> dict:
    try:
        return await asyncio.to_thread(get_my_voice().remove_sample, name)
    except KeyError:
        raise HTTPException(status_code=404, detail="No such recording") from None
    except MyVoiceError as error:
        raise HTTPException(status_code=422, detail=str(error)) from None


@router.put("/api/my-voice")
async def update_my_voice(change: MyVoiceUpdate) -> dict:
    my_voice = get_my_voice()
    if change.enabled is None:
        return my_voice.state()
    try:
        return my_voice.set_enabled(change.enabled)
    except MyVoiceError as error:
        raise HTTPException(status_code=422, detail=str(error)) from None


@router.delete("/api/my-voice", status_code=204)
async def delete_my_voice() -> Response:
    await asyncio.to_thread(get_my_voice().clear)
    return Response(status_code=204)
