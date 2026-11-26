# Digital Me

A private, local-first AI digital human. It combines text chat with a local
Ollama model and keeps conversation history only in the current browser session.

## What works

- React/Three.js VRM viewer and text chat UI.
- FastAPI chat endpoint backed by Ollama's local `/api/chat` endpoint.
- Qwen3 4B with a 4K-token context; sent history is bounded to the latest 20
  messages and 12,000 characters, including the system prompt.
- New-conversation, loading and error states.
- VRM idle motion and blinking, with thinking and brief speaking expressions
  driven by chat activity. The avatar supports a happy expression, but chat does
  not infer or select emotions automatically.
- Speaking is a visual response cue, not audio-driven lip synchronization.
- No cloud API, microphone, speech processing, database, or permanent memory.

## Prerequisites

- Python 3.11+ and Node.js/npm.
- Ollama running locally.
- A compatible VRM file at `frontend\public\models\avatar.vrm` to display the
  avatar. Model files are local-only and ignored by Git.

## Install

In PowerShell:

```powershell
cd backend
python -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install -e ".[test]"
ollama pull qwen3:4b
```

In another terminal:

```powershell
cd frontend
npm ci
```

Ollama model downloads happen locally. Chat requests go only to Ollama at
`127.0.0.1:11434`; the backend and Vite development server bind to loopback.

## Run the chat

Start the backend from `backend`:

```powershell
.\.venv\Scripts\Activate.ps1
uvicorn app.main:app --host 127.0.0.1 --port 8000
```

Start the frontend from `frontend`:

```powershell
npm run dev -- --host 127.0.0.1
```

Open the localhost URL printed by Vite. The chat and avatar appear side by side
on wider screens and stack on smaller screens. Submit messages in the chat
panel; follow-up turns include the in-memory browser conversation. **New
conversation** clears the current messages. Reloading the page also clears
them; nothing is persisted to disk.

If Ollama is stopped or Qwen3 4B is unavailable, the UI shows the backend error
and keeps the message visible so you can resend it after fixing the local runtime.

## Tests

Backend tests mock Ollama responses and do not require a running model:

```powershell
cd backend
.\.venv\Scripts\Activate.ps1
python -m pytest -q
```

Frontend tests mock the chat HTTP response and do not call Ollama:

```powershell
cd frontend
npm test
npm run build
```

## Hardware feasibility checks

The existing standalone checks remain available. Install their optional CPU
speech dependencies only when running them:

```powershell
cd backend
.\.venv\Scripts\Activate.ps1
python -m pip install -e ".[feasibility]"
python scripts\check_llm.py
python scripts\check_tts.py
python scripts\check_stt.py artifacts\feasibility\kokoro-check.wav
```

Speech checks run on CPU. The generated Kokoro WAV is test audio; no microphone
recording or uploaded voice data is involved.
