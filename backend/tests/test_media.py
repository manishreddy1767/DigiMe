"""Your own avatar and your own voice, with the GPU models replaced by fakes."""

import io
import json
import time
import wave
from pathlib import Path
from unittest.mock import Mock

import numpy as np
import pytest
from fastapi.testclient import TestClient
from PIL import Image

import app.main as main_module
import app.media as media
from app.services.avatar.photo import PhotoError, clean_photo
from app.services.avatar.poses import render_plan
from app.services.avatar.renderer import RenderError
from app.services.myvoice.client import VoiceHelperError

JPEG = {"content-type": "image/jpeg"}
WAV = {"content-type": "audio/wav"}


def photo_bytes(size=(600, 800), fmt="JPEG", **save) -> bytes:
    out = io.BytesIO()
    Image.new("RGB", size, (180, 140, 120)).save(out, format=fmt, **save)
    return out.getvalue()


def tone_wav(seconds=0.5, rate=24_000) -> bytes:
    import soundfile

    out = io.BytesIO()
    soundfile.write(out, np.full(int(seconds * rate), 0.1, dtype=np.float32), rate, format="WAV")
    return out.getvalue()


class FakeRenderer:
    """Writes tiny frames like the real LivePortrait script, reporting progress."""

    def __init__(self, *, error=None, unavailable=None):
        self.error = error
        self.unavailable = unavailable

    def unavailable_reason(self):
        return self.unavailable

    def render(self, photo: Path, out_dir: Path, plan, on_progress):
        out_dir.mkdir(parents=True, exist_ok=True)
        for index, pose in enumerate(plan, start=1):
            Image.new("RGB", (8, 10)).save(out_dir / pose["file"], format="JPEG")
            on_progress(index, len(plan))
            if self.error and index == 2:
                raise RenderError(self.error)
        manifest = {"width": 8, "height": 10, "frames": [pose["file"] for pose in plan]}
        (out_dir / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")


class FakeVoiceHelper:
    """Stands in for the GPU voice helper: uploads become 6-second tone recordings."""

    def __init__(self, *, unavailable=None, convert_error=None):
        self.unavailable = unavailable
        self.convert_error = convert_error
        self.calls = []

    def unavailable_reason(self):
        return self.unavailable

    def prepare(self, src, dst):
        import soundfile

        self.calls.append(("prepare", src.suffix))
        if b"bad" in src.read_bytes():
            raise VoiceHelperError("The recording is too short or silent", user=True)
        dst.parent.mkdir(parents=True, exist_ok=True)
        soundfile.write(str(dst), np.full(6 * 22050, 0.1, dtype=np.float32), 22050)
        return 6.0

    def voiceprint(self, samples, out):
        self.calls.append(("voiceprint", len(samples)))
        np.save(out, np.ones((1, 256, 1), dtype=np.float32))

    def convert(self, audio, sample_rate, target, source):
        self.calls.append(("convert", source))
        if self.convert_error:
            raise self.convert_error
        return np.asarray(audio, dtype=np.float32) * 0.5, 22050

    def close(self):
        pass


@pytest.fixture
def media_env(tmp_path, monkeypatch):
    """A private data folder, fake GPU helpers, and no real model warm-up."""
    monkeypatch.setenv("DIGITAL_ME_DATA_DIR", str(tmp_path))
    monkeypatch.setattr(main_module, "_warm_kokoro_service", lambda: None)
    media._avatar_services.clear()
    media._my_voices.clear()
    renderer = FakeRenderer()
    helper = FakeVoiceHelper()
    monkeypatch.setattr(media, "make_renderer", lambda: renderer)
    monkeypatch.setattr(media, "make_voice_helper", lambda log_path: helper)
    unloads = []

    async def fake_free_gpu():
        unloads.append(True)

    monkeypatch.setattr(media, "_free_gpu_for_render", fake_free_gpu)
    # Entered like the real server so background renders keep running between requests.
    with TestClient(main_module.app) as client:
        yield {"client": client, "renderer": renderer, "helper": helper, "unloads": unloads,
               "data": tmp_path}
    media._avatar_services.clear()
    media._my_voices.clear()


def wait_until_rendered(client, timeout=10.0):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        state = client.get("/api/avatar").json()
        if state["status"] != "rendering":
            return state
        time.sleep(0.02)
    raise AssertionError("avatar never finished")


# ------------------------------------------------------------------ photo cleaning

@pytest.mark.parametrize("fmt", ["JPEG", "PNG", "WEBP"])
def test_common_photo_formats_become_jpeg(fmt):
    image = Image.open(io.BytesIO(clean_photo(photo_bytes(size=(800, 1000), fmt=fmt))))
    assert image.format == "JPEG" and image.size == (800, 1000)


def test_photo_location_and_camera_details_are_removed():
    exif = Image.Exif()
    exif[0x010F] = "PhoneMaker"
    exif[0x8825] = {1: "N", 2: (17.0, 23.0, 0.0)}
    cleaned = clean_photo(photo_bytes(exif=exif))
    assert not Image.open(io.BytesIO(cleaned)).getexif()
    assert b"PhoneMaker" not in cleaned


@pytest.mark.parametrize(
    ("data", "message"),
    [
        (b"", "empty"),
        (b"%PDF-1.7 not an image", "isn't a photo"),
        (photo_bytes(size=(100, 100)), "too small"),
        (photo_bytes(fmt="GIF"), "JPEG, PNG or WebP"),
    ],
)
def test_unusable_photos_are_refused_clearly(data, message):
    with pytest.raises(PhotoError, match=message):
        clean_photo(data)


# ------------------------------------------------------------------ avatar API

def test_default_avatar_is_kept_until_a_photo_is_added(media_env):
    state = media_env["client"].get("/api/avatar").json()
    assert state == {"status": "none", "progress": None, "error": None, "unavailable": None,
                     "avatar": None}


def test_photo_becomes_an_avatar_after_freeing_the_gpu(media_env):
    client = media_env["client"]

    accepted = client.put("/api/avatar", content=photo_bytes(), headers=JPEG)
    state = wait_until_rendered(client)

    assert accepted.status_code == 202
    assert state["status"] == "ready"
    assert len(state["avatar"]["frames"]) == len(render_plan())
    assert media_env["unloads"] == [True]
    frame = client.get(f"/api/avatar/frames/{state['avatar']['frames'][0]}")
    assert frame.status_code == 200 and frame.headers["content-type"] == "image/jpeg"
    assert client.get("/api/avatar/frames/photo.jpg").status_code == 404
    assert (media_env["data"] / "avatar" / "photo.jpg").is_file()


def test_removing_the_avatar_returns_to_the_default(media_env):
    client = media_env["client"]
    client.put("/api/avatar", content=photo_bytes(), headers=JPEG)
    wait_until_rendered(client)

    assert client.delete("/api/avatar").status_code == 204
    assert client.get("/api/avatar").json()["status"] == "none"
    assert not (media_env["data"] / "avatar" / "photo.jpg").exists()


def test_avatar_upload_errors_are_reported(media_env):
    client = media_env["client"]
    assert client.put("/api/avatar", content=b"x", headers={"content-type": "text/plain"}).status_code == 415
    assert client.put("/api/avatar", content=b"not a photo", headers=JPEG).status_code == 422
    too_big = {**JPEG, "content-length": str(30 * 1024 * 1024)}
    assert client.put("/api/avatar", content=b"x", headers=too_big).status_code == 413

    media_env["renderer"].error = "No face found in the photo"
    client.put("/api/avatar", content=photo_bytes(), headers=JPEG)
    state = wait_until_rendered(client)
    assert state["status"] == "error" and state["error"] == "No face found in the photo"


def test_missing_liveportrait_is_explained(media_env):
    media_env["renderer"].unavailable = "LivePortrait is not installed"
    client = media_env["client"]

    response = client.put("/api/avatar", content=photo_bytes(), headers=JPEG)

    assert response.status_code == 503
    assert client.get("/api/avatar").json()["unavailable"] == "LivePortrait is not installed"


# ------------------------------------------------------------------ own voice API

def test_recordings_teach_the_voice_and_the_switch_needs_enough_speech(media_env):
    client = media_env["client"]

    empty = client.get("/api/my-voice").json()
    first = client.post("/api/my-voice/samples", content=b"a", headers=WAV)
    too_early = client.put("/api/my-voice", json={"enabled": True})
    client.post("/api/my-voice/samples", content=b"b", headers={"content-type": "audio/x-m4a"})
    enabled = client.put("/api/my-voice", json={"enabled": True})

    assert empty["status"] == "none" and empty["enabled"] is False
    assert first.status_code == 201 and first.json()["status"] == "collecting"
    assert too_early.status_code == 422
    assert enabled.json()["status"] == "ready" and enabled.json()["enabled"] is True
    assert ("prepare", ".m4a") in media_env["helper"].calls
    assert client.get("/api/my-voice/samples/001.wav").status_code == 200
    assert client.get("/api/my-voice/samples/voiceprint.npy").status_code == 404


def test_bad_recordings_and_removal(media_env):
    client = media_env["client"]

    bad = client.post("/api/my-voice/samples", content=b"bad", headers=WAV)
    wrong_type = client.post("/api/my-voice/samples", content=b"a", headers={"content-type": "text/plain"})
    client.post("/api/my-voice/samples", content=b"a", headers=WAV)
    removed = client.delete("/api/my-voice/samples/001.wav")

    assert bad.status_code == 422 and "silent" in bad.json()["detail"]
    assert wrong_type.status_code == 415
    assert removed.json()["samples"] == []
    assert client.delete("/api/my-voice/samples/001.wav").status_code == 404


def test_clearing_the_voice_switches_it_off(media_env):
    client = media_env["client"]
    for data in (b"a", b"b"):
        client.post("/api/my-voice/samples", content=data, headers=WAV)
    client.put("/api/my-voice", json={"enabled": True})

    assert client.delete("/api/my-voice").status_code == 204
    state = client.get("/api/my-voice").json()
    assert state["samples"] == [] and state["enabled"] is False


def _patch_kokoro(monkeypatch):
    kokoro = Mock()
    kokoro.synthesize_to_wav.return_value = tone_wav()
    monkeypatch.setattr(main_module, "get_kokoro_service", lambda: kokoro)
    return kokoro


def _sample_rate(wav: bytes) -> int:
    with wave.open(io.BytesIO(wav), "rb") as audio:
        return audio.getframerate()


def test_replies_are_spoken_in_my_voice_only_when_switched_on(media_env, monkeypatch):
    kokoro = _patch_kokoro(monkeypatch)
    client = media_env["client"]

    built_in = client.post("/api/tts", json={"text": "Hello there."})
    for data in (b"a", b"b"):
        client.post("/api/my-voice/samples", content=data, headers=WAV)
    client.put("/api/my-voice", json={"enabled": True})
    mine = client.post("/api/tts", json={"text": "Hello there."})

    assert _sample_rate(built_in.content) == 24_000
    assert _sample_rate(mine.content) == 22_050
    assert ("convert", "en:af_heart") in media_env["helper"].calls
    assert kokoro.synthesize_to_wav.call_count == 2


def test_voice_helper_failure_falls_back_to_the_built_in_voice(media_env, monkeypatch):
    _patch_kokoro(monkeypatch)
    client = media_env["client"]
    for data in (b"a", b"b"):
        client.post("/api/my-voice/samples", content=data, headers=WAV)
    client.put("/api/my-voice", json={"enabled": True})
    media_env["helper"].convert_error = VoiceHelperError("GPU busy")

    response = client.post("/api/tts", json={"text": "Hello there."})

    assert response.status_code == 200
    assert _sample_rate(response.content) == 24_000


def test_preview_plays_a_chosen_voice_or_my_own(media_env, monkeypatch):
    kokoro = _patch_kokoro(monkeypatch)
    client = media_env["client"]
    for data in (b"a", b"b"):
        client.post("/api/my-voice/samples", content=data, headers=WAV)

    built_in = client.post("/api/voice/preview", json={"voice": "am_michael"})
    mine = client.post("/api/voice/preview", json={"voice": "af_bella", "my_voice": True})
    unknown = client.post("/api/voice/preview", json={"voice": "nope"})

    assert built_in.status_code == 200 and _sample_rate(built_in.content) == 24_000
    assert _sample_rate(mine.content) == 22_050
    assert kokoro.synthesize_to_wav.call_args_list[0].kwargs["voice"] == "am_michael"
    assert unknown.status_code == 422
