# Digital Me

A private, local-first AI digital human. It combines text chat with a local
Ollama model, persistent local conversations, and user-approved long-term
memories.

## What works

- React/Three.js procedural human avatar and text chat UI; a compatible local
  VRM can optionally replace the fallback later.
- FastAPI chat endpoint backed by Ollama's local `/api/chat` endpoint.
- Qwen3 4B with a 4K-token context; sent history is bounded to the latest 20
  messages and 12,000 characters, including the system prompt.
- SQLite conversation history with separate conversation IDs, restore-on-start,
  history selection, and conversation deletion.
- An editable local profile and explicitly approved long-term memories with
  FTS5 search, editing, deletion, and relevant-memory retrieval.
- Persistent digital personality settings for name, communication style,
  response length, and custom instructions.
- Optional local personalization with persistent enable/disable control,
  recurring broad-topic summaries, explicit recurring-preference suggestions,
  and user-requested proactive ideas.
- Follow-up-aware use of bounded recent turns during approved-memory search,
  cautious handling of unknown personal facts, and warnings for a small set of
  clearly conflicting saved attributes.
- New-conversation, loading and error states.
- A model-free procedural avatar with gentle head/shoulder movement, irregular
  blinking, eye gaze, and locally animated facial features.
- Conservative, deterministic response-text cues select happy, sad, or curious
  expressions; ambiguous or ordinary replies stay neutral. Chat loading uses a
  thinking expression.
- Kokoro text-to-speech uses the local NVIDIA GPU when available, with a CPU
  fallback when CUDA is unavailable, GPU memory is low, or GPU synthesis runs
  out of memory. Audio is held temporarily in browser memory and is not saved
  by the backend.
- Push-to-talk speech recognition uses faster-whisper `base` on CPU with int8.
  Transcripts appear in the editable message input before they are sent.
- Optional automatic speech playback and explicitly started continuous voice
  conversation reuse the local Kokoro and faster-whisper services.
- The speaking expression follows audio playback; mouth openness responds to
  audio amplitude when Web Audio analysis is available. This is not
  phoneme-level lip synchronization.
- No cloud APIs, background listening, wake-word detection, voice cloning,
  automatic memory extraction, or remote database.

## Prerequisites

- Python 3.11+ and Node.js/npm.
- Ollama running locally.
- A browser with microphone and Web Audio support; grant permission when
  prompted.
- No avatar asset is required. The procedural avatar renders immediately.

To optionally replace the procedural avatar in the future, use a VRM 1.0 model
you have permission to use, then copy it to the expected path from the
repository root:

```powershell
New-Item -ItemType Directory -Force frontend\public\models
Copy-Item "$env:USERPROFILE\Downloads\your-avatar.vrm" frontend\public\models\avatar.vrm
Set-Content frontend\.env.local "VITE_ENABLE_LOCAL_VRM=true"
```

The model must include VRM 1.0 metadata. The procedural avatar remains active
by default and when VRM loading is disabled or fails. Set the local Vite flag
only after supplying the model, then restart Vite. Model files and the local
flag are ignored by Git. No avatar model is included, downloaded, or generated
by this project.

## Install

In PowerShell:

```powershell
cd backend
python -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install -e ".[test,tts,stt]"
ollama pull qwen3:4b
```

In another terminal:

```powershell
cd frontend
npm ci
```

Semantic memory search is optional. To enable it, install the `memory` extra
and cache the selected `sentence-transformers/all-MiniLM-L6-v2` model once:

```powershell
cd backend
.\.venv\Scripts\Activate.ps1
python -m pip install -e ".[memory]"
python -c "from sentence_transformers import SentenceTransformer; SentenceTransformer('sentence-transformers/all-MiniLM-L6-v2', device='cpu')"
```

The one-time model setup fetches model files only. At runtime, embeddings are
generated locally on the CPU; conversation and memory text is not sent to model
hosting. If the optional package or cached weights are unavailable, memory
search and chat retrieval continue with SQLite FTS5.

Ollama model downloads happen locally. Chat requests go only to Ollama at
`127.0.0.1:11434`; the backend and Vite development server bind to loopback.
Kokoro inference runs locally on the RTX GPU when CUDA is available and at
least 1.5 GiB is free; otherwise it falls back to CPU. The backend warms Kokoro
in the background at startup so the first spoken response can use the warmed
model. The first startup can take longer while the local TTS model loads and
warms; typed chat remains available meanwhile. faster-whisper transcription
remains on the CPU with int8. On first startup/use, Kokoro and faster-whisper
may download model and voice weights into the local Hugging Face cache. Only
model weights are fetched from model hosting; conversation text and microphone
recordings are processed by local services and are not uploaded. Later
processing uses the cached weights.
Kokoro and Ollama share GPU memory, so Kokoro automatically uses the CPU when
available GPU memory is below the threshold or CUDA runs out of memory.

Conversation history, the editable profile, and approved memories are stored
in a local SQLite database outside the source repository. By default, the file
is `%LOCALAPPDATA%\DigitalMe\digital-me.sqlite3` on Windows,
`~/Library/Application Support/DigitalMe/digital-me.sqlite3` on macOS, or
`$XDG_DATA_HOME/digital-me/digital-me.sqlite3` (defaulting to
`~/.local/share/digital-me/digital-me.sqlite3`) on Linux. Set
`DIGITAL_ME_DATA_DIR` before starting the backend to choose another data
directory; keep it outside the repository. The database is local but is not
encrypted by the application.

## Run the app

Start the backend from `backend`:

```powershell
.\.venv\Scripts\Activate.ps1
uvicorn app.main:app --host 127.0.0.1 --port 8000
```

Start the frontend from `frontend`:

```powershell
npm run dev -- --host 127.0.0.1
```

Open the localhost URL printed by Vite. The procedural avatar and chat appear
side by side on wider screens and stack on smaller screens. Select a saved conversation to
restore it, or use **New conversation** to start a separate history. The most
recent conversation is restored after restarting the application. Delete a
conversation from the history controls when you no longer want to retain it.

Expand **Digital personality** to set its name, choose a friendly, professional,
or casual style, choose concise, balanced, or detailed replies, and provide
optional custom instructions. Settings are persisted locally and applied in
every conversation as system-prompt instructions, separate from the editable
user profile and approved memories. Save changes explicitly or reset the
personality to its defaults. Ordinary chat messages never change these saved
settings.

Expand **Personalization & optional ideas** to enable or disable use of the
editable profile and approved memories in chat. The setting is stored locally
and defaults to enabled to preserve the existing profile and memory behavior.
Personality settings remain separate and take priority over saved response
preferences. Disabling personalization stops those profile and memory details
from being added to chat context and hides derived topic summaries and
suggestions; it does not delete the profile, approved memories, or pending
suggestions.

Recurring topics are calculated on demand from at most the 200 most recent
user messages, with each message limited to 1,200 characters. Only broad,
allowlisted general-interest categories are summarized; the summary is not
stored. A conservative keyword filter skips messages with recognized sensitive
topics, but it is not a general-purpose sensitive-data classifier. **Show
optional ideas** is user-triggered, returns at most three generic prompts based
on recurring topics and approved-memory topics, and does not send anything.
At most the 100 most recently updated approved memories are considered.
Choose **Use in draft** to edit the prompt before sending, or dismiss it.

If Ollama is stopped or Qwen3 4B is unavailable, the UI shows the backend error
and keeps the message visible so you can resend it after fixing the local runtime.

For an assistant response, choose **Generate audio** to synthesize speech
locally. When it is ready, use **Play audio**, **Pause audio**, **Resume audio**
and **Stop audio**. Only one response can play at a time; sending another chat
message or starting a new conversation stops current speech. If Kokoro or its
weights are unavailable, the UI displays an error while leaving the text reply
available. TTS is optional; the chat works without installing the `tts` extra.

For push-to-talk, select **Start recording**, speak, then select **Stop
recording**. After local transcription completes, the text is inserted into the
message box; review or edit it before sending, or select **Discard
transcription** to restore the previous draft. Microphone permission is
requested only after you start recording. Recordings are held in memory,
limited to 20 MB, and are not written to disk. The app does not listen in the
background.

Expand **Voice settings** to enable automatic playback and continuous voice
conversation. Save settings explicitly. Enabling continuous mode only makes the
mode available; use **Start voice conversation** to activate the microphone for
that session. The app does not resume listening after a restart. In this mode,
recording stops after approximately 0.9 seconds of detected silence following
speech, then local faster-whisper transcription is sent directly to chat and
the reply is spoken with Kokoro. If Web Audio silence detection is unavailable,
stop each utterance manually. **Stop voice conversation** ends the session.

While speech is generating or playing, **Interrupt and listen** cancels the
current audio and opens the microphone immediately. This is half-duplex
turn-taking: the microphone is not monitoring while Digital Me speaks. The
existing push-to-talk controls remain available outside a continuous session;
their transcript can still be reviewed and edited before sending. If the
browser blocks automatic playback, the UI reports the error and manual playback
remains available.

Speech synthesis is limited to 4,000 characters per reply, matching the local
TTS endpoint limit. Longer replies remain fully available as text and are not
submitted for synthesis. The avatar's mouth follows measured playback
amplitude, not phonemes; without audio-level analysis it stays closed. Raw
microphone recordings and generated audio remain temporary in memory; voice
preferences are stored in the local SQLite database.

Expand **User profile** to edit the name, about text, and response preferences.
The profile is included with chat context. Expand **Approved long-term
memories** to enter a fact and explicitly save it, search saved memories, edit
them, or delete them. No conversation text is extracted into memories
automatically. Only approved memories relevant to the current user message are
added to the bounded local LLM context. Clearing profile fields and saving
removes those profile values; deleting saved conversations and memories is
available in the interface.

With the optional memory extra installed and the embedding model cached,
approved memories use local 384-dimensional MiniLM embeddings plus FTS5 for
hybrid retrieval. Embeddings are cached with each memory and refreshed when its
content changes; weak semantic matches are excluded, and importance has only a
small effect on the ranking of otherwise relevant results. Follow-up messages
can include a bounded slice of recent turns in the search query; ordinary
standalone questions search using only the latest message. Saving or editing a
memory that resembles another shows a warning; the app never merges or deletes
memories automatically.

Use **Suggest from current conversation** to ask the local Ollama model for
possible durable memories. Suggestions remain pending and separate from
approved memories. Review, set importance, then explicitly approve or dismiss
each suggestion; nothing is saved as a long-term memory without approval.

**Suggest recurring preferences** checks the same bounded local message history
for repeated, explicit statements in allowlisted general-interest categories
and a few response-format preferences. It does not infer a preference from
topic frequency alone or suggest recognized sensitive categories. Candidates
appear as pending suggestions in the memory panel; approve one explicitly to
save it, or dismiss it. Approved memories can still be inspected, edited, and
deleted there. Topic summaries are transient and need no deletion.

Chat prompts ask the local model to distinguish known information from
uncertainty, avoid guessing personal facts, and request clarification only when
needed. A deterministic heuristic flags conflicting saved residence, employer,
or favorite-value statements when they are retrieved; it does not determine
which statement is current. These are prompt and retrieval safeguards, not
calibrated confidence scores or guarantees against model errors. Other kinds
of contradictions may not be detected.

## Tests

Backend tests mock Ollama, Kokoro and faster-whisper and do not require running
AI models:

```powershell
cd backend
.\.venv\Scripts\Activate.ps1
python -m pytest -q
```

Frontend tests mock chat, TTS, STT and browser recording APIs; they do not call
Ollama, Kokoro or faster-whisper:

```powershell
cd frontend
npm test
npm run build
```

## Hardware feasibility checks

The existing standalone checks remain available. The `tts` and `stt` extras
install only their corresponding app dependencies. Install the separate
feasibility extra only when running all feasibility checks:

```powershell
cd backend
.\.venv\Scripts\Activate.ps1
python -m pip install -e ".[feasibility]"
python scripts\check_llm.py
python scripts\check_tts.py
python scripts\check_stt.py artifacts\feasibility\kokoro-check.wav
```

Speech checks run on CPU. The feasibility script writes test WAV files under
`backend\artifacts\feasibility`; no microphone recording or uploaded voice data
is involved.
