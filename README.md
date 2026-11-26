# Digital Me

A private, local-first AI digital human. The initial project foundation focuses on
testing the selected hardware path before implementing conversations or memory.

## Foundation scope

- FastAPI health endpoint bound to `127.0.0.1`.
- Independent feasibility checks for Ollama/Qwen3 4B, CPU Kokoro TTS, and CPU
  faster-whisper STT.
- A React/Three.js viewer for a VRM model served from the local frontend.
- No chat, microphone capture, persistent personal memory, or cloud API yet.

## Prerequisites

- Python 3.12 (or Python 3.11+).
- Node.js and npm.
- Ollama for the LLM check.
- A compatible VRM file. Keep personal models local; model files are ignored by
  Git.

## Hardware feasibility checks

Create a backend environment and install its optional speech dependencies:

```powershell
cd backend
python -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install -e ".[feasibility]"
```

Kokoro may require the Windows eSpeak NG installer; see the
[Kokoro Windows instructions](https://github.com/hexgrad/kokoro#windows-installation).
Speech checks force CPU execution. The feasibility extra caps PyAV below v19
because the current faster-whisper release still passes an option removed in
PyAV 19.

Pull and check only the approved 4B model (do not substitute an 8B model):

```powershell
ollama pull qwen3:4b
python scripts\check_llm.py
python scripts\check_tts.py
python scripts\check_stt.py artifacts\feasibility\kokoro-check.wav
```

The STT check accepts any local audio file; using the generated Kokoro WAV checks
the processing path without recording or uploading a personal voice sample.

## Run the foundation

From `backend`, run the local API health endpoint:

```powershell
uvicorn app.main:app --host 127.0.0.1 --port 8000
```

In another terminal:

```powershell
cd frontend
npm install
npm run dev -- --host 127.0.0.1
```

Place a compatible local model at `frontend\public\models\avatar.vrm` to verify
rendering. The viewer reports a clear error if that file is absent or invalid.
The supplied project does not include or publish any identity assets.
