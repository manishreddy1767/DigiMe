import { FormEvent, useCallback, useEffect, useRef, useState } from "react";
import AvatarView from "./avatar/AvatarView";
import type { AvatarAnimationState } from "./avatar/avatarAnimation";

type ChatMessage = {
  role: "user" | "assistant";
  content: string;
};

type SpeechStatus = "idle" | "generating" | "ready" | "playing" | "paused" | "error";

type SpeechState = {
  status: SpeechStatus;
  messageIndex: number | null;
  error: string | null;
};

type TranscriptionStatus =
  | "idle"
  | "requesting"
  | "recording"
  | "transcribing"
  | "transcribed"
  | "error";

const IDLE_SPEECH_STATE: SpeechState = {
  status: "idle",
  messageIndex: null,
  error: null,
};

const MAX_RECORDING_BYTES = 20 * 1024 * 1024;

function stopStream(stream: MediaStream | null) {
  stream?.getTracks().forEach((track) => track.stop());
}

function App() {
  const [avatarLoaded, setAvatarLoaded] = useState(false);
  const [avatarError, setAvatarError] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [speech, setSpeech] = useState<SpeechState>(IDLE_SPEECH_STATE);
  const [transcriptionStatus, setTranscriptionStatus] =
    useState<TranscriptionStatus>("idle");
  const [transcriptionError, setTranscriptionError] = useState<string | null>(null);
  const requestId = useRef(0);
  const activeRequest = useRef<AbortController | null>(null);
  const speechRequestId = useRef(0);
  const speechController = useRef<AbortController | null>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  const audioUrl = useRef<string | null>(null);
  const audioMessageIndex = useRef<number | null>(null);
  const transcriptionRequestId = useRef(0);
  const transcriptionController = useRef<AbortController | null>(null);
  const mediaRecorder = useRef<MediaRecorder | null>(null);
  const recordingStream = useRef<MediaStream | null>(null);
  const recordingChunks = useRef<Blob[]>([]);
  const recordingBytes = useRef(0);
  const recordingTooLarge = useRef(false);
  const draftBeforeRecording = useRef("");
  const avatarState: AvatarAnimationState = loading
    ? "thinking"
    : speech.status === "playing"
      ? "speaking"
      : "idle";
  const speechInputBusy = ["requesting", "recording", "transcribing"].includes(
    transcriptionStatus,
  );

  useEffect(() => () => {
    speechRequestId.current += 1;
    speechController.current?.abort();
    audioRef.current?.pause();
    if (audioUrl.current !== null) {
      URL.revokeObjectURL(audioUrl.current);
    }
    transcriptionRequestId.current += 1;
    transcriptionController.current?.abort();
    const recorder = mediaRecorder.current;
    if (recorder && recorder.state !== "inactive") {
      recorder.ondataavailable = null;
      recorder.onstop = null;
      recorder.onerror = null;
      recorder.stop();
    }
    stopStream(recordingStream.current);
  }, []);

  const handleAvatarLoaded = useCallback(() => {
    setAvatarLoaded(true);
    setAvatarError(null);
  }, []);

  const handleAvatarError = useCallback((message: string) => {
    setAvatarLoaded(false);
    setAvatarError(message);
  }, []);

  const clearAudio = () => {
    const audio = audioRef.current;
    if (audio) {
      audio.pause();
      audio.removeAttribute("src");
      audio.load();
    }
    if (audioUrl.current !== null) {
      URL.revokeObjectURL(audioUrl.current);
      audioUrl.current = null;
    }
    audioMessageIndex.current = null;
  };

  const stopSpeech = () => {
    speechRequestId.current += 1;
    speechController.current?.abort();
    speechController.current = null;
    clearAudio();
    setSpeech(IDLE_SPEECH_STATE);
  };

  const transcribeRecording = async (recording: Blob, operationId: number) => {
    const controller = new AbortController();
    transcriptionController.current = controller;
    setTranscriptionStatus("transcribing");

    try {
      const response = await fetch("/api/stt", {
        method: "POST",
        headers: {
          "Content-Type": recording.type || "application/octet-stream",
        },
        body: recording,
        signal: controller.signal,
      });

      const result: unknown = await response.json();
      if (!response.ok) {
        const detail =
          typeof result === "object" && result !== null && "detail" in result &&
          typeof result.detail === "string"
            ? result.detail
            : `Transcription failed (${response.status}).`;
        throw new Error(detail);
      }
      if (
        typeof result !== "object" ||
        result === null ||
        !("text" in result) ||
        typeof result.text !== "string"
      ) {
        throw new Error("The speech service returned an invalid transcription.");
      }
      if (operationId !== transcriptionRequestId.current) return;

      const text = result.text.trim();
      if (!text) {
        setTranscriptionStatus("error");
        setTranscriptionError("No speech was recognized. Try recording again.");
        return;
      }

      const previousDraft = draftBeforeRecording.current.trim();
      setDraft(previousDraft ? `${previousDraft} ${text}` : text);
      setTranscriptionStatus("transcribed");
      setTranscriptionError(null);
    } catch (requestError) {
      if (controller.signal.aborted || operationId !== transcriptionRequestId.current) return;
      setTranscriptionStatus("error");
      setTranscriptionError(
        requestError instanceof Error
          ? requestError.message
          : "Local transcription failed. Please try again.",
      );
    } finally {
      if (operationId === transcriptionRequestId.current) {
        transcriptionController.current = null;
      }
    }
  };

  const startRecording = async () => {
    if (
      transcriptionStatus === "requesting" ||
      transcriptionStatus === "recording" ||
      transcriptionStatus === "transcribing"
    ) {
      return;
    }
    if (
      !navigator.mediaDevices ||
      typeof navigator.mediaDevices.getUserMedia !== "function" ||
      typeof MediaRecorder === "undefined"
    ) {
      setTranscriptionStatus("error");
      setTranscriptionError("Microphone recording is not supported in this browser.");
      return;
    }

    const operationId = ++transcriptionRequestId.current;
    draftBeforeRecording.current = draft;
    recordingChunks.current = [];
    recordingBytes.current = 0;
    recordingTooLarge.current = false;
    setTranscriptionStatus("requesting");
    setTranscriptionError(null);

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (operationId !== transcriptionRequestId.current) {
        stopStream(stream);
        return;
      }

      recordingStream.current = stream;
      const recorder = new MediaRecorder(stream);
      mediaRecorder.current = recorder;
      recorder.ondataavailable = (event) => {
        if (operationId !== transcriptionRequestId.current || recordingTooLarge.current) return;
        if (event.data.size === 0) return;
        if (recordingBytes.current + event.data.size > MAX_RECORDING_BYTES) {
          recordingTooLarge.current = true;
          if (recorder.state === "recording") recorder.stop();
          return;
        }
        recordingBytes.current += event.data.size;
        recordingChunks.current.push(event.data);
      };
      recorder.onstop = () => {
        stopStream(recordingStream.current);
        recordingStream.current = null;
        if (mediaRecorder.current === recorder) mediaRecorder.current = null;
        if (operationId !== transcriptionRequestId.current) return;
        if (recordingTooLarge.current) {
          recordingChunks.current = [];
          setTranscriptionStatus("error");
          setTranscriptionError("Recording exceeded the 20 MB limit. Record a shorter clip.");
          return;
        }

        const chunks = recordingChunks.current;
        recordingChunks.current = [];
        recordingBytes.current = 0;
        const recording = new Blob(chunks, {
          type: recorder.mimeType || chunks[0]?.type || "application/octet-stream",
        });
        if (recording.size === 0) {
          setTranscriptionStatus("error");
          setTranscriptionError("No audio was captured. Record a short message and try again.");
          return;
        }
        void transcribeRecording(recording, operationId);
      };
      recorder.onerror = () => {
        if (operationId !== transcriptionRequestId.current) return;
        transcriptionRequestId.current += 1;
        recordingChunks.current = [];
        recordingBytes.current = 0;
        stopStream(recordingStream.current);
        recordingStream.current = null;
        mediaRecorder.current = null;
        setTranscriptionStatus("error");
        setTranscriptionError("Microphone recording failed. Check the microphone and try again.");
      };
      recorder.start(1_000);
      setTranscriptionStatus("recording");
    } catch (recordingError) {
      if (operationId !== transcriptionRequestId.current) return;
      const recorder = mediaRecorder.current;
      if (recorder && recorder.state !== "inactive") {
        recorder.ondataavailable = null;
        recorder.onstop = null;
        recorder.onerror = null;
        recorder.stop();
      }
      mediaRecorder.current = null;
      stopStream(recordingStream.current);
      recordingStream.current = null;
      setTranscriptionStatus("error");
      const errorName =
        typeof recordingError === "object" &&
        recordingError !== null &&
        "name" in recordingError &&
        typeof recordingError.name === "string"
          ? recordingError.name
          : "";
      setTranscriptionError(
        errorName === "NotAllowedError" || errorName === "SecurityError"
          ? "Microphone permission was denied. Allow microphone access and try again."
          : errorName === "NotFoundError"
            ? "No microphone was found. Connect a microphone and try again."
            : recordingError instanceof Error
              ? `Could not start microphone recording: ${recordingError.message}`
              : "Could not start microphone recording.",
      );
    }
  };

  const stopRecording = () => {
    const recorder = mediaRecorder.current;
    if (recorder?.state === "recording") {
      recorder.stop();
    }
  };

  const cancelTranscription = () => {
    transcriptionRequestId.current += 1;
    transcriptionController.current?.abort();
    transcriptionController.current = null;
    const recorder = mediaRecorder.current;
    if (recorder && recorder.state !== "inactive") {
      recorder.ondataavailable = null;
      recorder.onstop = null;
      recorder.onerror = null;
      recorder.stop();
    }
    mediaRecorder.current = null;
    stopStream(recordingStream.current);
    recordingStream.current = null;
    recordingChunks.current = [];
    recordingBytes.current = 0;
    recordingTooLarge.current = false;
    setTranscriptionStatus("idle");
    setTranscriptionError(null);
  };

  const discardTranscription = () => {
    setDraft(draftBeforeRecording.current);
    setTranscriptionStatus("idle");
    setTranscriptionError(null);
  };

  const generateSpeech = async (messageIndex: number, text: string) => {
    stopSpeech();
    const controller = new AbortController();
    const currentRequestId = ++speechRequestId.current;
    speechController.current = controller;
    setSpeech({ status: "generating", messageIndex, error: null });

    try {
      const response = await fetch("/api/tts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
        signal: controller.signal,
      });

      if (!response.ok) {
        const result: unknown = await response.json();
        const detail =
          typeof result === "object" && result !== null && "detail" in result &&
          typeof result.detail === "string"
            ? result.detail
            : `Speech generation failed (${response.status}).`;
        throw new Error(detail);
      }

      const blob = await response.blob();
      if (blob.size === 0) {
        throw new Error("The speech service returned empty audio.");
      }
      if (currentRequestId !== speechRequestId.current) return;

      const audio = audioRef.current;
      if (!audio) {
        throw new Error("Audio playback is not available.");
      }
      const objectUrl = URL.createObjectURL(blob);
      audioUrl.current = objectUrl;
      audioMessageIndex.current = messageIndex;
      audio.src = objectUrl;
      setSpeech({ status: "ready", messageIndex, error: null });
    } catch (requestError) {
      if (controller.signal.aborted || currentRequestId !== speechRequestId.current) return;
      setSpeech({
        status: "error",
        messageIndex,
        error: requestError instanceof Error
          ? requestError.message
          : "Local speech generation failed. Please try again.",
      });
    } finally {
      if (currentRequestId === speechRequestId.current) {
        speechController.current = null;
      }
    }
  };

  const playSpeech = async (messageIndex: number, resume = false) => {
    const audio = audioRef.current;
    const currentAudioUrl = audioUrl.current;
    if (
      !audio ||
      currentAudioUrl === null ||
      audioMessageIndex.current !== messageIndex
    ) {
      return;
    }

    try {
      if (!resume) {
        audio.currentTime = 0;
      }
      await audio.play();
      if (audioUrl.current === currentAudioUrl) {
        setSpeech({ status: "playing", messageIndex, error: null });
      }
    } catch (playError) {
      if (audioUrl.current !== currentAudioUrl) return;
      setSpeech({
        status: "error",
        messageIndex,
        error: playError instanceof Error
          ? playError.message
          : "Audio playback failed. Please try again.",
      });
    }
  };

  const startNewConversation = () => {
    requestId.current += 1;
    activeRequest.current?.abort();
    activeRequest.current = null;
    stopSpeech();
    cancelTranscription();
    setMessages([]);
    setDraft("");
    setError(null);
    setLoading(false);
  };

  const sendMessage = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const content = draft.trim();
    if (!content || loading) return;

    stopSpeech();
    const nextMessages = [...messages, { role: "user" as const, content }];
    const currentRequestId = ++requestId.current;
    const controller = new AbortController();
    activeRequest.current = controller;
    setMessages(nextMessages);
    setDraft("");
    setError(null);
    setTranscriptionStatus("idle");
    setTranscriptionError(null);
    setLoading(true);

    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: nextMessages }),
        signal: controller.signal,
      });

      const result: unknown = await response.json();
      if (!response.ok) {
        const detail =
          typeof result === "object" && result !== null && "detail" in result &&
          typeof result.detail === "string"
            ? result.detail
            : `Chat request failed (${response.status}).`;
        throw new Error(detail);
      }
      if (
        typeof result !== "object" ||
        result === null ||
        !("message" in result) ||
        typeof result.message !== "string" ||
        !result.message.trim()
      ) {
        throw new Error("The chat service returned an invalid response.");
      }

      if (currentRequestId === requestId.current) {
        setMessages([...nextMessages, { role: "assistant", content: result.message }]);
      }
    } catch (requestError) {
      if (controller.signal.aborted || currentRequestId !== requestId.current) return;
      setError(
        requestError instanceof Error
          ? requestError.message
          : "The chat request failed. Please try again.",
      );
    } finally {
      if (currentRequestId === requestId.current) {
        activeRequest.current = null;
        setLoading(false);
      }
    }
  };

  return (
    <main className="shell">
      <header className="header">
        <div>
          <p className="eyebrow">LOCAL DIGITAL HUMAN</p>
          <h1>Digital Me</h1>
        </div>
        <div className="header-actions">
          <span className="privacy-badge">Local-only</span>
          <button className="new-conversation" onClick={startNewConversation} type="button">
            New conversation
          </button>
        </div>
      </header>

      <section className="workspace" aria-label="Digital Me chat">
        <div className="avatar-panel">
          <AvatarView
            state={avatarState}
            onLoaded={handleAvatarLoaded}
            onError={handleAvatarError}
          />
          <div className="avatar-status" role="status">
            <span className={`status-dot ${avatarLoaded ? "ready" : ""}`} />
            {avatarError ?? (avatarLoaded ? "VRM loaded locally" : "Loading local VRM…")}
          </div>
        </div>

        <section className="chat-panel" aria-label="Conversation">
          <div className="messages" role="log" aria-live="polite" aria-relevant="additions">
            {messages.length === 0 ? (
              <p className="empty-state">Send a message to start a conversation.</p>
            ) : (
              messages.map((message, index) => (
                <article className={`message ${message.role}`} key={`${index}-${message.role}`}>
                  <span className="message-author">
                    {message.role === "user" ? "You" : "Digital Me"}
                  </span>
                  <p>{message.content}</p>
                  {message.role === "assistant" && (
                    <div className="speech-controls">
                      {speech.messageIndex === index && speech.status === "generating" ? (
                        <>
                          <button disabled type="button">Generating audio…</button>
                          <button onClick={stopSpeech} type="button">Stop audio</button>
                        </>
                      ) : speech.messageIndex === index && audioUrl.current !== null ? (
                        <>
                          {speech.status === "playing" ? (
                            <button onClick={() => audioRef.current?.pause()} type="button">
                              Pause audio
                            </button>
                          ) : speech.status === "paused" ? (
                            <button onClick={() => void playSpeech(index, true)} type="button">
                              Resume audio
                            </button>
                          ) : (
                            <button onClick={() => void playSpeech(index)} type="button">
                              {speech.status === "ready" ? "Play audio" : "Retry playback"}
                            </button>
                          )}
                          <button onClick={stopSpeech} type="button">Stop audio</button>
                        </>
                      ) : (
                        <button
                          disabled={speech.status === "generating"}
                          onClick={() => void generateSpeech(index, message.content)}
                          type="button"
                        >
                          {speech.status === "error" && speech.messageIndex === index
                            ? "Retry audio"
                            : "Generate audio"}
                        </button>
                      )}
                      {speech.messageIndex === index && (
                        <p className="speech-status" role="status">
                          {speech.status === "generating" && "Generating speech locally…"}
                          {speech.status === "ready" && "Audio ready."}
                          {speech.status === "playing" && "Playing audio."}
                          {speech.status === "paused" && "Audio paused."}
                        </p>
                      )}
                      {speech.messageIndex === index && speech.status === "error" && (
                        <p className="speech-error" role="alert">{speech.error}</p>
                      )}
                    </div>
                  )}
                </article>
              ))
            )}
            {loading && <p className="thinking" role="status">Digital Me is thinking…</p>}
            {error && <p className="error-message" role="alert">{error}</p>}
          </div>

          <div className="recording-controls">
            {transcriptionStatus === "recording" ? (
              <button onClick={stopRecording} type="button">Stop recording</button>
            ) : (
              <button
                disabled={
                  loading ||
                  transcriptionStatus === "requesting" ||
                  transcriptionStatus === "transcribing"
                }
                onClick={() => void startRecording()}
                type="button"
              >
                {transcriptionStatus === "requesting"
                  ? "Requesting microphone…"
                  : transcriptionStatus === "transcribing"
                    ? "Transcribing…"
                    : "Start recording"}
              </button>
            )}
            {transcriptionStatus === "transcribed" && (
              <button onClick={discardTranscription} type="button">
                Discard transcription
              </button>
            )}
            {transcriptionStatus === "recording" && (
              <p role="status">Recording locally. Stop to transcribe.</p>
            )}
            {transcriptionStatus === "transcribing" && (
              <p role="status">Transcribing locally…</p>
            )}
            {transcriptionStatus === "transcribed" && (
              <p role="status">Review or edit the transcription before sending.</p>
            )}
            {transcriptionError && <p role="alert">{transcriptionError}</p>}
          </div>
          <form className="composer" onSubmit={sendMessage}>
            <label className="sr-only" htmlFor="chat-message">Message</label>
            <textarea
              id="chat-message"
              disabled={speechInputBusy}
              maxLength={4000}
              onChange={(event) => setDraft(event.target.value)}
              placeholder="Write a message…"
              rows={2}
              value={draft}
            />
            <button
              disabled={loading || speechInputBusy || !draft.trim()}
              type="submit"
            >
              {loading ? "Thinking…" : "Send"}
            </button>
          </form>
          <p className="chat-note">Conversation history stays in this page and clears with a new conversation.</p>
          <audio
            aria-hidden="true"
            hidden
            onEnded={() => {
              setSpeech((current) => current.status === "playing"
                ? { ...current, status: "ready" }
                : current);
            }}
            onError={() => {
              if (audioMessageIndex.current !== null) {
                setSpeech({
                  status: "error",
                  messageIndex: audioMessageIndex.current,
                  error: "Could not play the generated audio.",
                });
              }
            }}
            onPause={() => {
              if (audioRef.current?.ended) return;
              setSpeech((current) => current.status === "playing"
                ? { ...current, status: "paused" }
                : current);
            }}
            onPlay={() => {
              if (audioMessageIndex.current !== null) {
                setSpeech({
                  status: "playing",
                  messageIndex: audioMessageIndex.current,
                  error: null,
                });
              }
            }}
            ref={audioRef}
          />
        </section>
      </section>
    </main>
  );
}

export default App;
