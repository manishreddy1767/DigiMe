import { FormEvent, useCallback, useEffect, useRef, useState } from "react";
import AvatarView from "./avatar/AvatarView";
import {
  SPEAKING_DISPLAY_DURATION_MS,
  type AvatarAnimationState,
} from "./avatar/avatarAnimation";

type ChatMessage = {
  role: "user" | "assistant";
  content: string;
};

function App() {
  const [avatarLoaded, setAvatarLoaded] = useState(false);
  const [avatarError, setAvatarError] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [avatarState, setAvatarState] = useState<AvatarAnimationState>("idle");
  const requestId = useRef(0);
  const activeRequest = useRef<AbortController | null>(null);
  const speakingTimer = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (speakingTimer.current !== null) {
        window.clearTimeout(speakingTimer.current);
      }
    },
    [],
  );

  const handleAvatarLoaded = useCallback(() => {
    setAvatarLoaded(true);
    setAvatarError(null);
  }, []);

  const handleAvatarError = useCallback((message: string) => {
    setAvatarLoaded(false);
    setAvatarError(message);
  }, []);

  const clearSpeakingTimer = () => {
    if (speakingTimer.current !== null) {
      window.clearTimeout(speakingTimer.current);
      speakingTimer.current = null;
    }
  };

  const startNewConversation = () => {
    requestId.current += 1;
    activeRequest.current?.abort();
    activeRequest.current = null;
    clearSpeakingTimer();
    setMessages([]);
    setDraft("");
    setError(null);
    setLoading(false);
    setAvatarState("idle");
  };

  const sendMessage = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const content = draft.trim();
    if (!content || loading) return;

    const nextMessages = [...messages, { role: "user" as const, content }];
    const currentRequestId = ++requestId.current;
    const controller = new AbortController();
    clearSpeakingTimer();
    activeRequest.current = controller;
    setMessages(nextMessages);
    setDraft("");
    setError(null);
    setLoading(true);
    setAvatarState("thinking");

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
        setAvatarState("speaking");
        speakingTimer.current = window.setTimeout(() => {
          if (currentRequestId === requestId.current) {
            setAvatarState("idle");
          }
          speakingTimer.current = null;
        }, SPEAKING_DISPLAY_DURATION_MS);
      }
    } catch (requestError) {
      if (controller.signal.aborted || currentRequestId !== requestId.current) return;
      setAvatarState("idle");
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
        </section>
      </section>
    </main>
  );
}

export default App;
