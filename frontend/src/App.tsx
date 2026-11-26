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

const IDLE_SPEECH_STATE: SpeechState = {
  status: "idle",
  messageIndex: null,
  error: null,
};

function App() {
  const [avatarLoaded, setAvatarLoaded] = useState(false);
  const [avatarError, setAvatarError] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [speech, setSpeech] = useState<SpeechState>(IDLE_SPEECH_STATE);
  const requestId = useRef(0);
  const activeRequest = useRef<AbortController | null>(null);
  const speechRequestId = useRef(0);
  const speechController = useRef<AbortController | null>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  const audioUrl = useRef<string | null>(null);
  const audioMessageIndex = useRef<number | null>(null);
  const avatarState: AvatarAnimationState = loading
    ? "thinking"
    : speech.status === "playing"
      ? "speaking"
      : "idle";

  useEffect(() => () => {
    speechRequestId.current += 1;
    speechController.current?.abort();
    audioRef.current?.pause();
    if (audioUrl.current !== null) {
      URL.revokeObjectURL(audioUrl.current);
    }
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

          <form className="composer" onSubmit={sendMessage}>
            <label className="sr-only" htmlFor="chat-message">Message</label>
            <textarea
              id="chat-message"
              maxLength={4000}
              onChange={(event) => setDraft(event.target.value)}
              placeholder="Write a message…"
              rows={2}
              value={draft}
            />
            <button disabled={loading || !draft.trim()} type="submit">
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
