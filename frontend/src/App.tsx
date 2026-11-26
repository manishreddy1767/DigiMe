import { FormEvent, useCallback, useEffect, useRef, useState } from "react";
import AvatarView from "./avatar/AvatarView";
import type { AvatarAnimationState } from "./avatar/avatarAnimation";
import MemorySettings from "./MemorySettings";
import PersonalitySettings from "./PersonalitySettings";

type ChatMessage = {
  role: "user" | "assistant";
  content: string;
};

type ConversationSummary = {
  id: string;
  title: string;
};

type ConversationRecord = ConversationSummary & {
  messages: ChatMessage[];
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
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [conversationBusy, setConversationBusy] = useState(false);
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
  const conversationRequestId = useRef(0);
  const conversationChangedByUser = useRef(false);
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

  useEffect(() => {
    const operationId = ++conversationRequestId.current;
    void (async () => {
      try {
        const response = await fetch("/api/conversations");
        const result: unknown = await response.json();
        if (!response.ok) {
          const detail =
            typeof result === "object" && result !== null && "detail" in result &&
            typeof result.detail === "string"
              ? result.detail
              : `Could not load conversation history (${response.status}).`;
          throw new Error(detail);
        }
        if (!Array.isArray(result)) {
          throw new Error("The conversation history response was invalid.");
        }

        const savedConversations = result.filter(
          (item): item is ConversationSummary =>
            typeof item === "object" &&
            item !== null &&
            "id" in item &&
            typeof item.id === "string" &&
            "title" in item &&
            typeof item.title === "string",
        );
        setConversations((current) => {
          const currentIds = new Set(current.map((item) => item.id));
          return [
            ...current,
            ...savedConversations.filter((item) => !currentIds.has(item.id)),
          ];
        });
        if (
          operationId !== conversationRequestId.current ||
          conversationChangedByUser.current
        ) {
          return;
        }
        const latest = savedConversations[0];
        if (!latest) return;

        const conversationResponse = await fetch(
          `/api/conversations/${encodeURIComponent(latest.id)}`,
        );
        const conversationResult: unknown = await conversationResponse.json();
        if (!conversationResponse.ok) {
          throw new Error(`Could not restore conversation (${conversationResponse.status}).`);
        }
        if (
          operationId !== conversationRequestId.current ||
          conversationChangedByUser.current ||
          typeof conversationResult !== "object" ||
          conversationResult === null ||
          !("id" in conversationResult) ||
          conversationResult.id !== latest.id ||
          !("messages" in conversationResult) ||
          !Array.isArray(conversationResult.messages)
        ) {
          if (operationId === conversationRequestId.current) {
            throw new Error("The saved conversation response was invalid.");
          }
          return;
        }
        const restoredMessages = conversationResult.messages.filter(
          (item): item is ChatMessage =>
            typeof item === "object" &&
            item !== null &&
            "role" in item &&
            (item.role === "user" || item.role === "assistant") &&
            "content" in item &&
            typeof item.content === "string",
        );
        setConversationId(latest.id);
        setMessages(restoredMessages);
      } catch (historyError) {
        if (operationId !== conversationRequestId.current) return;
        setError(
          historyError instanceof Error
            ? historyError.message
            : "Could not restore local conversation history.",
        );
      }
    })();

    return () => {
      if (operationId === conversationRequestId.current) {
        conversationRequestId.current += 1;
      }
    };
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

  const selectConversation = async (selectedId: string) => {
    if (!selectedId || selectedId === conversationId) return;
    conversationChangedByUser.current = true;
    const operationId = ++conversationRequestId.current;
    requestId.current += 1;
    activeRequest.current?.abort();
    activeRequest.current = null;
    stopSpeech();
    cancelTranscription();
    setConversationId(selectedId);
    setMessages([]);
    setDraft("");
    setError(null);
    setLoading(false);
    setConversationBusy(true);

    try {
      const response = await fetch(
        `/api/conversations/${encodeURIComponent(selectedId)}`,
      );
      const result: unknown = await response.json();
      if (!response.ok) {
        const detail =
          typeof result === "object" && result !== null && "detail" in result &&
          typeof result.detail === "string"
            ? result.detail
            : `Could not restore conversation (${response.status}).`;
        throw new Error(detail);
      }
      if (
        typeof result !== "object" ||
        result === null ||
        !("id" in result) ||
        result.id !== selectedId ||
        !("messages" in result) ||
        !Array.isArray(result.messages)
      ) {
        throw new Error("The saved conversation response was invalid.");
      }
      if (operationId !== conversationRequestId.current) return;
      const restoredMessages = result.messages.filter(
        (item): item is ChatMessage =>
          typeof item === "object" &&
          item !== null &&
          "role" in item &&
          (item.role === "user" || item.role === "assistant") &&
          "content" in item &&
          typeof item.content === "string",
      );
      setMessages(restoredMessages);
    } catch (loadError) {
      if (operationId !== conversationRequestId.current) return;
      setConversationId(null);
      setError(
        loadError instanceof Error
          ? loadError.message
          : "Could not restore the selected conversation.",
      );
    } finally {
      if (operationId === conversationRequestId.current) {
        setConversationBusy(false);
      }
    }
  };

  const startNewConversation = async () => {
    conversationChangedByUser.current = true;
    const operationId = ++conversationRequestId.current;
    requestId.current += 1;
    activeRequest.current?.abort();
    activeRequest.current = null;
    stopSpeech();
    cancelTranscription();
    setMessages([]);
    setDraft("");
    setError(null);
    setLoading(false);
    setConversationId(null);
    setConversationBusy(true);
    try {
      const response = await fetch("/api/conversations", { method: "POST" });
      const result: unknown = await response.json();
      if (!response.ok) {
        const detail =
          typeof result === "object" && result !== null && "detail" in result &&
          typeof result.detail === "string"
            ? result.detail
            : `Could not create a conversation (${response.status}).`;
        throw new Error(detail);
      }
      if (
        typeof result !== "object" ||
        result === null ||
        !("id" in result) ||
        typeof result.id !== "string" ||
        !("title" in result) ||
        typeof result.title !== "string"
      ) {
        throw new Error("The conversation service returned an invalid response.");
      }
      if (operationId !== conversationRequestId.current) return;
      const newConversation = { id: result.id, title: result.title };
      setConversationId(newConversation.id);
      setConversations((current) => [
        newConversation,
        ...current.filter((conversation) => conversation.id !== newConversation.id),
      ]);
    } catch (createError) {
      if (operationId !== conversationRequestId.current) return;
      setError(
        createError instanceof Error
          ? createError.message
          : "Could not create a local conversation.",
      );
    } finally {
      if (operationId === conversationRequestId.current) {
        setConversationBusy(false);
      }
    }
  };

  const deleteCurrentConversation = async () => {
    if (!conversationId) return;
    conversationChangedByUser.current = true;
    const deletedId = conversationId;
    const operationId = ++conversationRequestId.current;
    requestId.current += 1;
    activeRequest.current?.abort();
    activeRequest.current = null;
    stopSpeech();
    cancelTranscription();
    setConversationBusy(true);
    setError(null);
    try {
      const response = await fetch(
        `/api/conversations/${encodeURIComponent(deletedId)}`,
        { method: "DELETE" },
      );
      if (!response.ok) {
        const result: unknown = await response.json();
        const detail =
          typeof result === "object" && result !== null && "detail" in result &&
          typeof result.detail === "string"
            ? result.detail
            : `Could not delete the conversation (${response.status}).`;
        throw new Error(detail);
      }
      if (operationId !== conversationRequestId.current) return;
      setConversations((current) =>
        current.filter((conversation) => conversation.id !== deletedId),
      );
      setConversationId(null);
      setMessages([]);
      setDraft("");
    } catch (deleteError) {
      if (operationId !== conversationRequestId.current) return;
      setError(
        deleteError instanceof Error
          ? deleteError.message
          : "Could not delete the local conversation.",
      );
    } finally {
      if (operationId === conversationRequestId.current) {
        setConversationBusy(false);
      }
    }
  };

  const sendMessage = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const content = draft.trim();
    if (!content || loading) return;

    conversationChangedByUser.current = true;
    conversationRequestId.current += 1;
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
        body: JSON.stringify({
          conversation_id: conversationId,
          messages: [{ role: "user", content }],
        }),
        signal: controller.signal,
      });

      const result: unknown = await response.json();
      if (!response.ok) {
        const errorDetail =
          typeof result === "object" && result !== null && "detail" in result &&
          typeof result.detail === "object" &&
          result.detail !== null
            ? result.detail
            : null;
        const detail =
          typeof result === "object" && result !== null && "detail" in result &&
          typeof result.detail === "string"
            ? result.detail
            : errorDetail !== null &&
                "message" in errorDetail &&
                typeof errorDetail.message === "string"
              ? errorDetail.message
              : `Chat request failed (${response.status}).`;
        if (
          currentRequestId === requestId.current &&
          errorDetail !== null &&
          "conversation_id" in errorDetail &&
          typeof errorDetail.conversation_id === "string"
        ) {
          const failedConversationId = errorDetail.conversation_id;
          const failedTitle = content.replace(/\s+/g, " ").slice(0, 80) ||
            "New conversation";
          setConversationId(failedConversationId);
          setConversations((current) => [
            { id: failedConversationId, title: failedTitle },
            ...current.filter((item) => item.id !== failedConversationId),
          ]);
        }
        throw new Error(detail);
      }
      if (
        typeof result !== "object" ||
        result === null ||
        !("message" in result) ||
        typeof result.message !== "string" ||
        !result.message.trim() ||
        !("conversation_id" in result) ||
        typeof result.conversation_id !== "string"
      ) {
        throw new Error("The chat service returned an invalid response.");
      }

      if (currentRequestId === requestId.current) {
        const savedConversationId = result.conversation_id;
        const savedTitle = content.replace(/\s+/g, " ").slice(0, 80) || "New conversation";
        setConversationId(savedConversationId);
        setConversations((current) => [
          {
            id: savedConversationId,
            title: current.find((item) => item.id === savedConversationId)?.title ===
              "New conversation"
              ? savedTitle
              : current.find((item) => item.id === savedConversationId)?.title ?? savedTitle,
          },
          ...current.filter((item) => item.id !== savedConversationId),
        ]);
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
          <button
            className="new-conversation"
            disabled={conversationBusy}
            onClick={() => void startNewConversation()}
            type="button"
          >
            {conversationBusy ? "Loading…" : "New conversation"}
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
          <div className="conversation-controls">
            <label htmlFor="saved-conversations">Conversation history</label>
            <select
              disabled={conversationBusy}
              id="saved-conversations"
              onChange={(event) => void selectConversation(event.target.value)}
              value={conversationId ?? ""}
            >
              <option value="">Current draft</option>
              {conversations.map((conversation) => (
                <option key={conversation.id} value={conversation.id}>
                  {conversation.title}
                </option>
              ))}
            </select>
            <button
              className="danger-button"
              disabled={conversationBusy || !conversationId}
              onClick={() => void deleteCurrentConversation()}
              type="button"
            >
              Delete conversation
            </button>
          </div>
          <div className="messages" role="log" aria-live="polite" aria-relevant="additions">
            {messages.length === 0 && conversationBusy ? (
              <p className="empty-state" role="status">Loading local conversation…</p>
            ) : messages.length === 0 ? (
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
              disabled={speechInputBusy || conversationBusy}
              maxLength={4000}
              onChange={(event) => setDraft(event.target.value)}
              placeholder="Write a message…"
              rows={2}
              value={draft}
            />
            <button
              disabled={loading || speechInputBusy || conversationBusy || !draft.trim()}
              type="submit"
            >
              {loading ? "Thinking…" : "Send"}
            </button>
          </form>
          <p className="chat-note">
            Conversations stay in local storage. Long-term memories are saved only
            when you approve them below.
          </p>
          <div className="memory-settings">
            <PersonalitySettings />
          </div>
          <MemorySettings conversationId={conversationId} />
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
