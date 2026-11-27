"""Voice helper: turns speech into the person's own voice with OpenVoice V2, on the GPU.

Runs in the GPU Python environment (models/liveportrait/.venv, which has CUDA PyTorch), not in
the backend's, so it must not import digital_me. It reads one JSON request per line on stdin and
writes one JSON reply per line on stdout:

    {"id": 1, "cmd": "prepare", "src": "upload.m4a", "dst": "samples/001.wav"}
    {"id": 2, "cmd": "voiceprint", "samples": ["samples/001.wav"], "out": "voiceprint.npy"}
    {"id": 3, "cmd": "convert", "audio": "<base64 float32>", "sr": 24000,
     "target": "voiceprint.npy", "source": "en:af_heart"}

Every converted clip carries OpenVoice's inaudible watermark (wavmark) saying it is AI-made.
Everything runs offline; the models are downloaded once by scripts/setup-voice.ps1.
"""

from __future__ import annotations

import base64
import json
import os
import subprocess
import sys
import traceback

PROTOCOL = sys.stdout
sys.stdout = sys.stderr  # libraries print freely; only replies go to the real stdout

os.environ.setdefault("HF_HUB_OFFLINE", "1")

SAMPLE_MIN_SECONDS = 2.0
SAMPLE_MAX_SECONDS = 60.0
WATERMARK = "AI-made"
CHUNK = 16000  # wavmark marks 16000-sample chunks; OpenVoice marks every other one


class SampleError(Exception):
    """The recording can't be used; the message is shown to the person."""


class Helper:
    def __init__(self, openvoice: str):
        import librosa
        import numpy as np
        import torch
        import wavmark
        from huggingface_hub import hf_hub_download

        sys.path.insert(0, openvoice)
        from openvoice import utils
        from openvoice.mel_processing import spectrogram_torch
        from openvoice.models import SynthesizerTrn

        self.np, self.torch, self.librosa = np, torch, librosa
        self.utils, self.spectrogram = utils, spectrogram_torch
        self.device = "cuda" if torch.cuda.is_available() else "cpu"
        converter = os.path.join(openvoice, "checkpoints_v2", "converter")
        hps = utils.get_hparams_from_file(os.path.join(converter, "config.json"))
        self.hps = hps
        self.rate = hps.data.sampling_rate
        model = SynthesizerTrn(len(getattr(hps, "symbols", [])), hps.data.filter_length // 2 + 1,
                               n_speakers=hps.data.n_speakers, **hps.model)
        state = torch.load(os.path.join(converter, "checkpoint.pth"), map_location="cpu", weights_only=True)
        model.load_state_dict(state["model"], strict=False)
        self.model = model.eval().to(self.device)
        marker_path = hf_hub_download(
            "M4869/WavMark", "step59000_snr39.99_pesq4.35_BERP_none0.30_mean1.81_std1.81.model.pkl",
            local_files_only=True,
        )
        self.marker = wavmark.load_model(marker_path).eval().to(self.device)
        self.bits = utils.string_to_bits(WATERMARK).reshape(-1)[:32]
        self.sources: dict[str, tuple] = {}  # running mean voiceprint of each built-in voice
        self.targets: dict[str, tuple] = {}  # loaded voiceprints by path, with their mtime

    # ---------------------------------------------------------------- helpers

    def _spec(self, audio):
        y = self.torch.FloatTensor(audio).unsqueeze(0).to(self.device)
        d = self.hps.data
        return self.spectrogram(y, d.filter_length, self.rate, d.hop_length, d.win_length, center=False)

    def _print_of(self, audio):
        with self.torch.no_grad():
            return self.model.ref_enc(self._spec(audio).transpose(1, 2)).unsqueeze(-1)

    def _decode(self, path: str):
        """Any audio file (wav, mp3, m4a, webm, ...) to mono float32 at the converter's rate."""
        import imageio_ffmpeg

        command = [imageio_ffmpeg.get_ffmpeg_exe(), "-v", "error", "-i", path, "-ac", "1",
                   "-ar", str(self.rate), "-f", "f32le", "-"]
        flags = subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0
        result = subprocess.run(command, capture_output=True, timeout=120, creationflags=flags)
        if result.returncode != 0:
            raise SampleError("That file isn't a recording Digital Me can read")
        return self.np.frombuffer(result.stdout, dtype=self.np.float32).copy()

    def _target(self, path: str):
        mtime = os.path.getmtime(path)
        cached = self.targets.get(path)
        if cached is None or cached[0] != mtime:
            cached = (mtime, self.torch.from_numpy(self.np.load(path)).to(self.device))
            self.targets[path] = cached
        return cached[1]

    def _watermark(self, audio):
        with self.torch.no_grad():
            for n in range(len(self.bits) // 32):
                start = 2 * n * CHUNK
                chunk = audio[start:start + CHUNK]
                if chunk.numel() < CHUNK:
                    break  # clips under ~0.7 s are too short to carry the mark
                bits = self.torch.FloatTensor(self.bits[n * 32:(n + 1) * 32]).to(self.device)[None]
                audio[start:start + CHUNK] = self.marker.encode(chunk[None], bits).squeeze()
        return audio

    # ---------------------------------------------------------------- commands

    def prepare(self, src: str, dst: str) -> dict:
        audio = self._decode(src)
        audio, _ = self.librosa.effects.trim(audio, top_db=35)
        seconds = len(audio) / self.rate
        if seconds < SAMPLE_MIN_SECONDS:
            raise SampleError("The recording is too short or silent (2 seconds of speech at least)")
        if seconds > SAMPLE_MAX_SECONDS:
            audio = audio[: int(SAMPLE_MAX_SECONDS * self.rate)]
            seconds = SAMPLE_MAX_SECONDS
        peak = float(self.np.abs(audio).max())
        if peak < 0.02:
            raise SampleError("The recording is too quiet. Hold the microphone closer and try again")
        clipped = float((self.np.abs(audio) > 0.99).mean())
        if clipped > 0.01:
            raise SampleError("The recording is distorted (too loud). Move the microphone a little away")
        import soundfile

        os.makedirs(os.path.dirname(dst), exist_ok=True)
        soundfile.write(dst, audio / max(peak, 1e-6) * 0.9, self.rate, subtype="PCM_16")
        return {"seconds": round(seconds, 2)}

    def voiceprint(self, samples: list[str], out: str) -> dict:
        prints = [self._print_of(self.librosa.load(path, sr=self.rate)[0]) for path in samples]
        mean = self.torch.stack(prints).mean(0).cpu().numpy()
        temporary = out + ".tmp.npy"
        self.np.save(temporary, mean)
        os.replace(temporary, out)
        self.targets.pop(out, None)
        return {}

    def convert(self, audio_b64: str, sr: int, target: str, source: str) -> dict:
        audio = self.np.frombuffer(base64.b64decode(audio_b64), dtype=self.np.float32)
        if sr != self.rate:
            audio = self.librosa.resample(audio, orig_sr=sr, target_sr=self.rate)
        own = self._print_of(audio)
        count, mean = self.sources.get(source, (0, None))
        # The built-in voice's print, averaged over everything it has said: steadier than one clip.
        mean = own if mean is None else (mean * count + own) / (count + 1)
        self.sources[source] = (min(count + 1, 50), mean)
        with self.torch.no_grad():
            spec = self._spec(audio)
            lengths = self.torch.LongTensor([spec.size(-1)]).to(self.device)
            out = self.model.voice_conversion(spec, lengths, sid_src=mean, sid_tgt=self._target(target), tau=0.3)[0][0, 0]
            out = self._watermark(out.float())
        data = out.clamp(-1, 1).cpu().numpy().astype(self.np.float32)
        return {"audio": base64.b64encode(data.tobytes()).decode("ascii"), "sr": self.rate}


def main() -> int:
    openvoice = sys.argv[1]
    try:
        helper = Helper(openvoice)
    except Exception as exc:  # missing install: tell the backend, then stop
        PROTOCOL.write(json.dumps({"id": 0, "ok": False, "error": f"Voice helper failed to start: {exc}"}) + "\n")
        PROTOCOL.flush()
        traceback.print_exc()
        return 2
    PROTOCOL.write(json.dumps({"id": 0, "ok": True, "device": helper.device}) + "\n")
    PROTOCOL.flush()
    for line in sys.stdin:
        if not line.strip():
            continue
        request = json.loads(line)
        reply: dict = {"id": request.get("id")}
        try:
            cmd = request["cmd"]
            if cmd == "prepare":
                reply.update(helper.prepare(request["src"], request["dst"]))
            elif cmd == "voiceprint":
                reply.update(helper.voiceprint(request["samples"], request["out"]))
            elif cmd == "convert":
                reply.update(helper.convert(request["audio"], request["sr"], request["target"], request["source"]))
            elif cmd != "ping":
                raise ValueError(f"unknown command {cmd!r}")
            reply["ok"] = True
        except SampleError as exc:
            reply.update(ok=False, error=str(exc), user=True)
        except Exception as exc:
            traceback.print_exc()
            reply.update(ok=False, error=str(exc))
        PROTOCOL.write(json.dumps(reply) + "\n")
        PROTOCOL.flush()
    return 0


if __name__ == "__main__":
    sys.exit(main())
