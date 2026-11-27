import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowUp,
  AudioLines,
  Brain,
  Ear,
  MessagesSquare,
  Mic,
  Pause,
  Play,
  Sparkles,
  Square,
  Trash2,
  Volume2,
} from "lucide-react";
import AvatarView from "./avatar/AvatarView";
import {
  inferAvatarEmotion,
  type AvatarAnimationState,
  type AvatarEmotion,
} from "./avatar/avatarAnimation";
import Drawer from "./components/Drawer";
import TopBar, { type AppStatus } from "./components/TopBar";
import { startRecording as startSampleRecording } from "./audio/recorder";
import { avatarFrameUrl, mediaApi, voiceSampleUrl } from "./media/api";
import AvatarSettings from "./media/AvatarSettings";
import { useAvatar, useMyVoice } from "./media/hooks";
import MyVoiceSettings from "./media/MyVoiceSettings";
import PhotoAvatar from "./media/PhotoAvatar";
import VoicePicker from "./media/VoicePicker";
import MemorySettings from "./MemorySettings";
import MessageContent from "./MessageContent";
import PersonalizationSettings from "./PersonalizationSettings";
import PersonalitySettings from "./PersonalitySettings";
import VoiceSettings, {
  DEFAULT_VOICE_SETTINGS,
  type VoiceSettingsValue,
} from "./VoiceSettings";

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

type RecordingMode = "push-to-talk" | "continuous";

type VoiceActivityMonitor = {
  context: AudioContext;
  source: MediaStreamAudioSourceNode;
  frameId: number;
};

const IDLE_SPEECH_STATE: SpeechState = {
  status: "idle",
  messageIndex: null,
  error: null,
};

const MAX_RECORDING_BYTES = 20 * 1024 * 1024;
const MAX_SPOKEN_RESPONSE_CHARACTERS = 4_000;
const VOICE_SILENCE_THRESHOLD = 0.018;
const VOICE_SILENCE_DURATION_MS = 900;
const MIN_VOICE_DURATION_MS = 350;
const STATUS_REFRESH_MS = 30_000;

const SUGGESTIONS = [
  "What do you know about me?",
  "Help me plan my week.",
  "Explain something I am learning, simply.",
];

const STAGE_HUES: Record<AvatarEmotion, string> = {
  neutral: "#8ea2c8",
  happy: "#f2c27b",
  sad: "#7fa7d9",
  curious: "#b89cff",
};

type StageState = "idle" | "listening" | "thinking" | "speaking";

const STAGE_LABELS: Record<StageState, string> = {
  idle: "Ready",
  listening: "Listening",
  thinking: "Thinking",
  speaking: "Speaking",
};

const STAGE_ICONS = {
  idle: Sparkles,
  listening: Ear,
  thinking: Brain,
  speaking: Volume2,
} as const;

type DrawerName = "history" | "voice" | "context";

function stopStream(stream: MediaStream | null) {
  stream?.getTracks().forEach((track) => track.stop());
}

function App() {
  const [avatarLoaded, setAvatarLoaded] = useState(false);
  const [avatarSource, setAvatarSource] = useState<"procedural" | "vrm">("procedural");
  const [avatarError, setAvatarError] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [conversationBusy, setConversationBusy] = useState(false);
  const [draft, setDraft] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [speech, setSpeech] = useState<SpeechState>(IDLE_SPEECH_STATE);
  const [voiceSettings, setVoiceSettings] = useState(DEFAULT_VOICE_SETTINGS);
  const [assistantName, setAssistantName] = useState("Digital Me");
  const [drawer, setDrawer] = useState<DrawerName | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState<string | null>(null);
  const [voiceSettingsKey, setVoiceSettingsKey] = useState(0);
  const [appStatus, setAppStatus] = useState<AppStatus | null>(null);
  const [statusUnreachable, setStatusUnreachable] = useState(false);
  const photoAvatar = useAvatar(mediaApi);
  const myVoice = useMyVoice(mediaApi);
  const photoManifest = photoAvatar.avatar?.avatar ?? null;
  const [personalizationEnabled, setPersonalizationEnabled] = useState(true);
  const [voiceSessionActive, setVoiceSessionActive] = useState(false);
  const [voiceRuntimeError, setVoiceRuntimeError] = useState<string | null>(null);
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
  const audioContextRef = useRef<AudioContext | null>(null);
  const audioSourceRef = useRef<MediaElementAudioSourceNode | null>(null);
  const audioAnalyserRef = useRef<AnalyserNode | null>(null);
  const audioAmplitudeBufferRef = useRef<Uint8Array<ArrayBuffer> | null>(null);
  const transcriptionRequestId = useRef(0);
  const conversationRequestId = useRef(0);
  const conversationChangedByUser = useRef(false);
  const transcriptionController = useRef<AbortController | null>(null);
  const mediaRecorder = useRef<MediaRecorder | null>(null);
  const recordingStream = useRef<MediaStream | null>(null);
  const recordingChunks = useRef<Blob[]>([]);
  const recordingBytes = useRef(0);
  const recordingTooLarge = useRef(false);
  const recordingOperationActiveRef = useRef(false);
  const interruptingRef = useRef(false);
  const draftBeforeRecording = useRef("");
  const voiceSessionActiveRef = useRef(false);
  const voiceActivityMonitorRef = useRef<VoiceActivityMonitor | null>(null);
  const avatarEmotion = useMemo<AvatarEmotion>(() => {
    const lastAssistantMessage = [...messages]
      .reverse()
      .find((message) => message.role === "assistant");
    return lastAssistantMessage
      ? inferAvatarEmotion(lastAssistantMessage.content)
      : "neutral";
  }, [messages]);
  const displayedAvatarEmotion = loading ? "neutral" : avatarEmotion;
  const avatarState: AvatarAnimationState = loading
    ? "thinking"
    : speech.status === "playing"
      ? "speaking"
      : displayedAvatarEmotion === "neutral"
        ? "idle"
        : displayedAvatarEmotion;
  const stageState: StageState = transcriptionStatus === "recording"
    ? "listening"
    : loading
      ? "thinking"
      : speech.status === "playing"
        ? "speaking"
        : "idle";
  const StageIcon = STAGE_ICONS[stageState];
  const speechInputBusy = ["requesting", "recording", "transcribing"].includes(
    transcriptionStatus,
  );

  const stopVoiceActivityMonitor = () => {
    const monitor = voiceActivityMonitorRef.current;
    if (!monitor) return;
    voiceActivityMonitorRef.current = null;
    window.cancelAnimationFrame(monitor.frameId);
    monitor.source.disconnect();
    void monitor.context.close().catch((closeError: unknown) => {
      console.warn("Could not close the microphone audio analyzer.", closeError);
    });
  };

  useEffect(() => () => {
    voiceSessionActiveRef.current = false;
    stopVoiceActivityMonitor();
    speechRequestId.current += 1;
    speechController.current?.abort();
    audioRef.current?.pause();
    if (audioUrl.current !== null) {
      URL.revokeObjectURL(audioUrl.current);
    }
    transcriptionRequestId.current += 1;
    recordingOperationActiveRef.current = false;
    transcriptionController.current?.abort();
    const recorder = mediaRecorder.current;
    if (recorder && recorder.state !== "inactive") {
      recorder.ondataavailable = null;
      recorder.onstop = null;
      recorder.onerror = null;
      recorder.stop();
    }
    stopStream(recordingStream.current);
    audioSourceRef.current?.disconnect();
    audioAnalyserRef.current?.disconnect();
    const audioContext = audioContextRef.current;
    if (audioContext) {
      audioContextRef.current = null;
      void audioContext.close().catch((closeError: unknown) => {
        console.warn("Could not close the audio playback analyzer.", closeError);
      });
    }
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

  const handleAvatarLoaded = useCallback((source: "procedural" | "vrm") => {
    setAvatarLoaded(true);
    setAvatarSource(source);
    setAvatarError(null);
  }, []);

  const handleAvatarError = useCallback((message: string) => {
    setAvatarError(message);
  }, []);

  const handleVoiceSettingsChange = useCallback((settings: VoiceSettingsValue) => {
    setVoiceSettings(settings);
  }, []);

  const handlePersonalizationSettingsChange = useCallback((enabled: boolean) => {
    setPersonalizationEnabled(enabled);
  }, []);

  const usePersonalizationPrompt = useCallback((prompt: string) => {
    setDraft(prompt);
    setDrawer(null);
  }, []);

  const closeDrawer = useCallback(() => {
    setDrawer(null);
    setConfirmingDelete(null);
  }, []);

  const refreshStatus = useCallback(async () => {
    try {
      const response = await fetch("/api/status");
      if (!response.ok) throw new Error(`Status request failed (${response.status}).`);
      const result: unknown = await response.json();
      if (
        typeof result !== "object" ||
        result === null ||
        !("model" in result) ||
        typeof result.model !== "string" ||
        !("ollama_reachable" in result) ||
        !("model_available" in result)
      ) {
        throw new Error("The status service returned an invalid response.");
      }
      setAppStatus(result as AppStatus);
      setStatusUnreachable(false);
    } catch {
      setAppStatus(null);
      setStatusUnreachable(true);
    }
  }, []);

  useEffect(() => {
    void refreshStatus();
    const timer = window.setInterval(() => void refreshStatus(), STATUS_REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [refreshStatus]);

  const handleAssistantNameChange = useCallback((name: string) => {
    setAssistantName(name);
    void refreshStatus();
  }, [refreshStatus]);

  useEffect(() => {
    document.title = `${assistantName} · Digital Me`;
  }, [assistantName]);

  const getAudioAmplitude = useCallback((): number | null => {
    const analyser = audioAnalyserRef.current;
    const buffer = audioAmplitudeBufferRef.current;
    if (!analyser || !buffer) return null;
    if (audioRef.current?.paused) return 0;
    analyser.getByteTimeDomainData(buffer);
    let squaredSum = 0;
    for (const sample of buffer) {
      const amplitude = (sample - 128) / 128;
      squaredSum += amplitude * amplitude;
    }
    return Math.min(Math.sqrt(squaredSum / buffer.length) * 3, 0.65);
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

  const preparePlaybackAnalyser = async (audio: HTMLAudioElement) => {
    if (audioSourceRef.current) {
      if (audioContextRef.current?.state === "suspended") {
        try {
          await audioContextRef.current.resume();
        } catch (resumeError) {
          setVoiceRuntimeError(
            resumeError instanceof Error
              ? `Audio playback analyzer could not resume: ${resumeError.message}`
              : "Audio playback analyzer could not resume.",
          );
          throw resumeError;
        }
      }
      return;
    }

    if (typeof window.AudioContext === "undefined") {
      setVoiceRuntimeError(
        "Audio level analysis is unavailable; speech can still play without amplitude-based mouth movement.",
      );
      return;
    }

    let context: AudioContext | null = null;
    let source: MediaElementAudioSourceNode | null = null;
    try {
      context = new window.AudioContext();
      await context.resume();
      source = context.createMediaElementSource(audio);
      const analyser = context.createAnalyser();
      analyser.fftSize = 256;
      source.connect(analyser);
      analyser.connect(context.destination);
      audioContextRef.current = context;
      audioSourceRef.current = source;
      audioAnalyserRef.current = analyser;
      audioAmplitudeBufferRef.current = new Uint8Array(analyser.fftSize);
      setVoiceRuntimeError(null);
    } catch (analysisError) {
      if (source && context) {
        source.disconnect();
        try {
          source.connect(context.destination);
          audioContextRef.current = context;
          audioSourceRef.current = source;
        } catch (connectionError) {
          console.warn("Could not preserve audio output after analyzer setup failed.", connectionError);
        }
      }
      if (context && !source) {
        void context.close().catch((closeError: unknown) => {
          console.warn("Could not close the unused playback analyzer.", closeError);
        });
      }
      setVoiceRuntimeError(
        analysisError instanceof Error
          ? `Audio level analysis unavailable: ${analysisError.message}`
          : "Audio level analysis unavailable; speech can still play.",
      );
    }
  };

  const stopSpeech = () => {
    speechRequestId.current += 1;
    speechController.current?.abort();
    speechController.current = null;
    clearAudio();
    setSpeech(IDLE_SPEECH_STATE);
  };

  const deactivateVoiceSession = () => {
    voiceSessionActiveRef.current = false;
    setVoiceSessionActive(false);
  };

  const transcribeRecording = async (
    recording: Blob,
    operationId: number,
    mode: RecordingMode,
  ) => {
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
        if (mode === "continuous") deactivateVoiceSession();
        return;
      }

      if (mode === "continuous" && voiceSessionActiveRef.current) {
        if (loading || activeRequest.current !== null) {
          setDraft(text);
          setTranscriptionStatus("transcribed");
          setTranscriptionError(
            "The transcript was kept in the message box because another chat request is still active.",
          );
          deactivateVoiceSession();
          return;
        }
        setTranscriptionStatus("idle");
        setTranscriptionError(null);
        await sendMessage(undefined, text);
      } else {
        const previousDraft = draftBeforeRecording.current.trim();
        setDraft(previousDraft ? `${previousDraft} ${text}` : text);
        setTranscriptionStatus("transcribed");
        setTranscriptionError(null);
      }
    } catch (requestError) {
      if (controller.signal.aborted || operationId !== transcriptionRequestId.current) return;
      setTranscriptionStatus("error");
      setTranscriptionError(
        requestError instanceof Error
          ? requestError.message
          : "Local transcription failed. Please try again.",
      );
      if (mode === "continuous") deactivateVoiceSession();
    } finally {
      if (operationId === transcriptionRequestId.current) {
        transcriptionController.current = null;
      }
    }
  };

  const startVoiceActivityMonitor = async (
    stream: MediaStream,
    recorder: MediaRecorder,
    operationId: number,
  ): Promise<boolean> => {
    if (typeof window.AudioContext === "undefined") {
      setVoiceRuntimeError(
        "Automatic silence detection is unavailable; stop the recording manually.",
      );
      return false;
    }

    let context: AudioContext | null = null;
    let source: MediaStreamAudioSourceNode | null = null;
    try {
      context = new window.AudioContext();
      await context.resume();
      const analyser = context.createAnalyser();
      analyser.fftSize = 512;
      source = context.createMediaStreamSource(stream);
      source.connect(analyser);
      const samples = new Uint8Array(analyser.fftSize);
      const startedAt = performance.now();
      let heardSpeech = false;
      let lastSoundAt = startedAt;
      const monitor = () => {
        if (
          operationId !== transcriptionRequestId.current ||
          recorder.state !== "recording"
        ) {
          stopVoiceActivityMonitor();
          return;
        }
        analyser.getByteTimeDomainData(samples);
        let sum = 0;
        for (const sample of samples) {
          const amplitude = (sample - 128) / 128;
          sum += amplitude * amplitude;
        }
        const now = performance.now();
        const rms = Math.sqrt(sum / samples.length);
        if (rms >= VOICE_SILENCE_THRESHOLD) {
          heardSpeech = true;
          lastSoundAt = now;
        }
        if (
          heardSpeech &&
          now - lastSoundAt >= VOICE_SILENCE_DURATION_MS &&
          now - startedAt >= MIN_VOICE_DURATION_MS
        ) {
          recorder.stop();
          return;
        }
        const currentMonitor = voiceActivityMonitorRef.current;
        if (currentMonitor) {
          currentMonitor.frameId = window.requestAnimationFrame(monitor);
        }
      };
      voiceActivityMonitorRef.current = { context, source, frameId: 0 };
      voiceActivityMonitorRef.current.frameId = window.requestAnimationFrame(monitor);
      setVoiceRuntimeError(null);
      return true;
    } catch (monitorError) {
      source?.disconnect();
      if (context) {
        void context.close().catch((closeError: unknown) => {
          console.warn("Could not close the microphone audio monitor.", closeError);
        });
      }
      setVoiceRuntimeError(
        monitorError instanceof Error
          ? `Automatic silence detection unavailable: ${monitorError.message}`
          : "Automatic silence detection is unavailable; stop the recording manually.",
      );
      return false;
    }
  };

  const startRecording = async (mode: RecordingMode = "push-to-talk") => {
    if (
      transcriptionStatus === "requesting" ||
      transcriptionStatus === "recording" ||
      transcriptionStatus === "transcribing" ||
      recordingOperationActiveRef.current ||
      mediaRecorder.current !== null ||
      transcriptionController.current !== null
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
      if (mode === "continuous") deactivateVoiceSession();
      return;
    }

    const operationId = ++transcriptionRequestId.current;
    recordingOperationActiveRef.current = true;
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
        stopVoiceActivityMonitor();
        stopStream(recordingStream.current);
        recordingStream.current = null;
        if (mediaRecorder.current === recorder) mediaRecorder.current = null;
        if (operationId === transcriptionRequestId.current) {
          recordingOperationActiveRef.current = false;
        }
        if (operationId !== transcriptionRequestId.current) return;
        if (recordingTooLarge.current) {
          recordingChunks.current = [];
          setTranscriptionStatus("error");
          setTranscriptionError("Recording exceeded the 20 MB limit. Record a shorter clip.");
          if (mode === "continuous") deactivateVoiceSession();
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
          if (mode === "continuous") deactivateVoiceSession();
          return;
        }
        void transcribeRecording(recording, operationId, mode);
      };
      recorder.onerror = () => {
        if (operationId !== transcriptionRequestId.current) return;
        transcriptionRequestId.current += 1;
        recordingOperationActiveRef.current = false;
        stopVoiceActivityMonitor();
        recordingChunks.current = [];
        recordingBytes.current = 0;
        stopStream(recordingStream.current);
        recordingStream.current = null;
        mediaRecorder.current = null;
        setTranscriptionStatus("error");
        setTranscriptionError("Microphone recording failed. Check the microphone and try again.");
        if (mode === "continuous") deactivateVoiceSession();
      };
      recorder.start(1_000);
      setTranscriptionStatus("recording");
      if (mode === "continuous") {
        void startVoiceActivityMonitor(stream, recorder, operationId);
      }
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
      if (operationId === transcriptionRequestId.current) {
        recordingOperationActiveRef.current = false;
      }
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
      if (mode === "continuous") deactivateVoiceSession();
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
    recordingOperationActiveRef.current = false;
    transcriptionController.current?.abort();
    transcriptionController.current = null;
    stopVoiceActivityMonitor();
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

  const startVoiceConversation = async () => {
    if (!voiceSettings.continuous_conversation_enabled || voiceSessionActiveRef.current) {
      return;
    }
    stopSpeech();
    setTranscriptionError(null);
    setVoiceRuntimeError(null);
    voiceSessionActiveRef.current = true;
    setVoiceSessionActive(true);
    await startRecording("continuous");
  };

  const stopVoiceConversation = () => {
    deactivateVoiceSession();
    cancelTranscription();
    stopSpeech();
  };

  useEffect(() => {
    if (!voiceSettings.continuous_conversation_enabled && voiceSessionActiveRef.current) {
      stopVoiceConversation();
    }
  }, [voiceSettings.continuous_conversation_enabled]);

  const interruptAndListen = async () => {
    if (interruptingRef.current) return;
    interruptingRef.current = true;
    const mode = voiceSessionActiveRef.current ? "continuous" : "push-to-talk";
    stopSpeech();
    cancelTranscription();
    setVoiceRuntimeError(null);
    try {
      await startRecording(mode);
    } finally {
      interruptingRef.current = false;
    }
  };

  const discardTranscription = () => {
    setDraft(draftBeforeRecording.current);
    setTranscriptionStatus("idle");
    setTranscriptionError(null);
  };

  const generateSpeech = async (
    messageIndex: number,
    text: string,
    autoPlay = false,
  ) => {
    stopSpeech();
    if (text.length > MAX_SPOKEN_RESPONSE_CHARACTERS) {
      const lengthError =
        `Speech is limited to ${MAX_SPOKEN_RESPONSE_CHARACTERS.toLocaleString()} characters per reply. ` +
        "The complete response remains available as text.";
      setSpeech({ status: "error", messageIndex, error: lengthError });
      if (autoPlay && voiceSessionActiveRef.current) deactivateVoiceSession();
      return;
    }

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
      if (autoPlay) await playSpeech(messageIndex);
    } catch (requestError) {
      if (controller.signal.aborted || currentRequestId !== speechRequestId.current) return;
      setSpeech({
        status: "error",
        messageIndex,
        error: requestError instanceof Error
          ? requestError.message
          : "Local speech generation failed. Please try again.",
      });
      if (autoPlay && voiceSessionActiveRef.current) deactivateVoiceSession();
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
      await preparePlaybackAnalyser(audio);
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
      if (voiceSessionActiveRef.current) deactivateVoiceSession();
    }
  };

  const selectConversation = async (selectedId: string) => {
    if (!selectedId || selectedId === conversationId) return;
    conversationChangedByUser.current = true;
    const operationId = ++conversationRequestId.current;
    requestId.current += 1;
    activeRequest.current?.abort();
    activeRequest.current = null;
    stopVoiceConversation();
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
    stopVoiceConversation();
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
    stopVoiceConversation();
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

  const deleteConversation = async (targetId: string) => {
    if (targetId === conversationId) {
      await deleteCurrentConversation();
      return;
    }
    setError(null);
    try {
      const response = await fetch(
        `/api/conversations/${encodeURIComponent(targetId)}`,
        { method: "DELETE" },
      );
      if (!response.ok) {
        throw new Error(`Could not delete the conversation (${response.status}).`);
      }
      setConversations((current) =>
        current.filter((conversation) => conversation.id !== targetId),
      );
    } catch (deleteError) {
      setError(
        deleteError instanceof Error
          ? deleteError.message
          : "Could not delete the local conversation.",
      );
    }
  };

  const toggleSpokenReplies = async () => {
    const enabled = !voiceSettings.auto_play_responses;
    try {
      const response = await fetch("/api/voice-settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          auto_play_responses: enabled,
          continuous_conversation_enabled: voiceSettings.continuous_conversation_enabled,
          voice: voiceSettings.voice,
        }),
      });
      if (!response.ok) {
        throw new Error(`Could not save voice settings (${response.status}).`);
      }
      setVoiceSettings((current) => ({ ...current, auto_play_responses: enabled }));
      setVoiceSettingsKey((key) => key + 1);
    } catch (toggleError) {
      setError(
        toggleError instanceof Error ? toggleError.message : "Could not save voice settings.",
      );
    }
  };

  const sendMessage = async (
    event?: FormEvent<HTMLFormElement>,
    submittedText?: string,
  ) => {
    event?.preventDefault();
    const content = (submittedText ?? draft).trim();
    if (!content || loading || activeRequest.current !== null) return;

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
        if (voiceSettings.auto_play_responses || voiceSessionActiveRef.current) {
          void generateSpeech(nextMessages.length, result.message, true);
        }
      }
    } catch (requestError) {
      if (controller.signal.aborted || currentRequestId !== requestId.current) return;
      setError(
        requestError instanceof Error
          ? requestError.message
          : "The chat request failed. Please try again.",
      );
      if (voiceSessionActiveRef.current) deactivateVoiceSession();
    } finally {
      if (currentRequestId === requestId.current) {
        activeRequest.current = null;
        setLoading(false);
      }
    }
  };

  return (
    <div className="app">
      <TopBar
        name={assistantName}
        newConversationDisabled={conversationBusy}
        onNewConversation={() => void startNewConversation()}
        onOpenContext={() => setDrawer("context")}
        onOpenHistory={() => setDrawer("history")}
        onOpenVoice={() => setDrawer("voice")}
        onToggleSpokenReplies={() => void toggleSpokenReplies()}
        serverUnreachable={statusUnreachable}
        spokenReplies={voiceSettings.auto_play_responses}
        status={appStatus}
      />

      <main className="layout">
        <section
          aria-label="Digital human"
          className="stage"
          style={{ ["--stage-hue" as string]: STAGE_HUES[displayedAvatarEmotion] }}
        >
          <div aria-hidden="true" className="stage__light" />
          <div aria-hidden="true" className="stage__floor" />
          <div className="stage__status">
            <div className={`status-pill status-pill--${stageState}`}>
              <span aria-hidden="true" className="status-pill__dot" />
              <StageIcon aria-hidden="true" size={14} />
              <span>{STAGE_LABELS[stageState]}</span>
            </div>
          </div>
          {photoManifest ? (
            <div className="stage__avatar stage__avatar--photo">
              <PhotoAvatar
                emotion={displayedAvatarEmotion}
                frameUrl={avatarFrameUrl}
                level={getAudioAmplitude}
                listening={stageState === "listening"}
                manifest={photoManifest}
                name={assistantName}
                speaking={stageState === "speaking"}
              />
            </div>
          ) : (
            <div className="stage__avatar">
              <AvatarView
                state={avatarState}
                emotion={displayedAvatarEmotion}
                onLoaded={handleAvatarLoaded}
                onError={handleAvatarError}
                getAudioAmplitude={getAudioAmplitude}
              />
            </div>
          )}
          <div className="avatar-status" role="status">
            <span className={`status-dot ${photoManifest || avatarLoaded ? "ready" : ""}`} />
            {photoManifest
              ? photoAvatar.avatar?.status === "rendering"
                ? "Creating your new avatar…"
                : "Your photo avatar"
              : avatarError ??
                (avatarLoaded
                  ? avatarSource === "vrm"
                    ? "Local VRM loaded"
                    : "Default 3D avatar"
                  : "Loading avatar…")}
          </div>
        </section>

        <section
          aria-label="Conversation"
          className="chat"
          data-conversation-id={conversationId ?? ""}
        >
          <div className="chat__list messages" role="log" aria-live="polite" aria-relevant="additions">
            {messages.length === 0 && conversationBusy ? (
              <p className="empty-state" role="status">Loading local conversation…</p>
            ) : messages.length === 0 ? (
              <div className="chat__empty">
                <p className="chat__empty-title">Start a conversation with {assistantName}</p>
                <p className="chat__empty-hint empty-state">
                  Send a message to start a conversation.
                </p>
                <div className="chips">
                  {SUGGESTIONS.map((suggestion) => (
                    <button
                      className="chip"
                      disabled={loading || conversationBusy || voiceSessionActive}
                      key={suggestion}
                      onClick={() => void sendMessage(undefined, suggestion)}
                      type="button"
                    >
                      {suggestion}
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              messages.map((message, index) => (
                <article className={`message ${message.role}`} key={`${index}-${message.role}`}>
                  <span className="sr-only">
                    {message.role === "user" ? "You" : assistantName}
                  </span>
                  <div className="message__bubble">
                    <MessageContent content={message.content} role={message.role} />
                  </div>
                  {message.role === "assistant" && (
                    <div className="speech-controls">
                      {speech.messageIndex === index && speech.status === "generating" ? (
                        <>
                          <button className="speech-button" disabled type="button">
                            <AudioLines aria-hidden="true" size={14} />
                            Generating audio…
                          </button>
                          {!voiceSessionActive && (
                            <button className="speech-button" onClick={stopSpeech} type="button">
                              <Square aria-hidden="true" size={12} />
                              Stop audio
                            </button>
                          )}
                        </>
                      ) : speech.messageIndex === index && audioUrl.current !== null ? (
                        <>
                          {speech.status === "playing" ? (
                            <button
                              className="speech-button"
                              onClick={() => audioRef.current?.pause()}
                              type="button"
                            >
                              <Pause aria-hidden="true" size={14} />
                              Pause audio
                            </button>
                          ) : speech.status === "paused" ? (
                            <button
                              className="speech-button"
                              onClick={() => void playSpeech(index, true)}
                              type="button"
                            >
                              <Play aria-hidden="true" size={14} />
                              Resume audio
                            </button>
                          ) : (
                            <button
                              className="speech-button"
                              onClick={() => void playSpeech(index)}
                              type="button"
                            >
                              <Play aria-hidden="true" size={14} />
                              {speech.status === "ready" ? "Play audio" : "Retry playback"}
                            </button>
                          )}
                          {!voiceSessionActive && (
                            <button className="speech-button" onClick={stopSpeech} type="button">
                              <Square aria-hidden="true" size={12} />
                              Stop audio
                            </button>
                          )}
                        </>
                      ) : (
                        <button
                          className="speech-button"
                          disabled={
                            speech.status === "generating" ||
                            voiceSessionActive ||
                            message.content.length > MAX_SPOKEN_RESPONSE_CHARACTERS
                          }
                          onClick={() => void generateSpeech(index, message.content)}
                          type="button"
                        >
                          <Volume2 aria-hidden="true" size={14} />
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
                      {message.content.length > MAX_SPOKEN_RESPONSE_CHARACTERS && (
                        <p className="speech-error" role="status">
                          Replies over {MAX_SPOKEN_RESPONSE_CHARACTERS.toLocaleString()} characters
                          are kept as text and are not sent for speech synthesis.
                        </p>
                      )}
                    </div>
                  )}
                </article>
              ))
            )}
            {loading && (
              <div className="thinking" role="status">
                <span aria-hidden="true" />
                <span aria-hidden="true" />
                <span aria-hidden="true" />
                <span className="sr-only">{assistantName} is thinking…</span>
              </div>
            )}
            {error && <p className="error-message" role="alert">{error}</p>}
          </div>

          <div className="chat__composer">
            <div className="recording-controls">
              {voiceSettings.continuous_conversation_enabled && !voiceSessionActive && (
                <button
                  className="pill-button"
                  disabled={loading || speechInputBusy || conversationBusy}
                  onClick={() => void startVoiceConversation()}
                  type="button"
                >
                  <AudioLines aria-hidden="true" size={14} />
                  Start voice conversation
                </button>
              )}
              {voiceSessionActive && (
                <button className="pill-button pill-button--on" onClick={stopVoiceConversation} type="button">
                  <Square aria-hidden="true" size={12} />
                  Stop voice conversation
                </button>
              )}
              {(speech.status === "generating" ||
                speech.status === "playing" ||
                (voiceSessionActive && speech.status === "paused")) && (
                <button className="pill-button" onClick={interruptAndListen} type="button">
                  <Mic aria-hidden="true" size={14} />
                  Interrupt and listen
                </button>
              )}
              {transcriptionStatus === "transcribed" && (
                <button className="pill-button" onClick={discardTranscription} type="button">
                  Discard transcription
                </button>
              )}
              {transcriptionStatus === "recording" && (
                <p role="status">
                  {voiceSessionActive
                    ? "Listening locally. Pause to finish the utterance, or stop recording."
                    : "Recording locally. Stop to transcribe."}
                </p>
              )}
              {transcriptionStatus === "transcribing" && (
                <p role="status">Transcribing locally…</p>
              )}
              {transcriptionStatus === "transcribed" && (
                <p role="status">Review or edit the transcription before sending.</p>
              )}
              {transcriptionError && <p role="alert">{transcriptionError}</p>}
              {voiceSessionActive && (
                <p className="voice-status" role="status">
                  {transcriptionStatus === "requesting"
                    ? "Requesting microphone permission…"
                    : transcriptionStatus === "recording"
                      ? "Listening for your voice."
                      : transcriptionStatus === "transcribing"
                        ? "Processing your speech locally…"
                        : loading
                          ? "Processing your request locally…"
                          : speech.status === "generating"
                            ? "Preparing the spoken response…"
                            : speech.status === "playing"
                              ? "Speaking. Use Interrupt and listen to barge in."
                              : speech.status === "paused"
                                ? "Speech is paused."
                                : "Voice conversation is active."}
                </p>
              )}
              {voiceRuntimeError && (
                <p className="voice-runtime-note" role="status">{voiceRuntimeError}</p>
              )}
            </div>
            <form className="composer" onSubmit={sendMessage}>
              <label className="sr-only" htmlFor="chat-message">Message</label>
              <textarea
                className="composer__input"
                id="chat-message"
                disabled={speechInputBusy || conversationBusy || voiceSessionActive}
                maxLength={4000}
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (
                    event.key === "Enter" &&
                    !event.shiftKey &&
                    !event.nativeEvent.isComposing
                  ) {
                    event.preventDefault();
                    void sendMessage();
                  }
                }}
                placeholder={`Message ${assistantName}…`}
                rows={1}
                value={draft}
              />
              <div className="composer__side">
                {transcriptionStatus === "recording" ? (
                  <button
                    aria-label="Stop recording"
                    className="mic-button mic-button--on"
                    onClick={stopRecording}
                    title="Stop recording"
                    type="button"
                  >
                    <Square aria-hidden="true" fill="currentColor" size={12} />
                  </button>
                ) : (
                  <button
                    aria-label={
                      transcriptionStatus === "requesting"
                        ? "Requesting microphone…"
                        : transcriptionStatus === "transcribing"
                          ? "Transcribing…"
                          : "Start recording"
                    }
                    className="mic-button"
                    disabled={
                      loading ||
                      voiceSessionActive ||
                      transcriptionStatus === "requesting" ||
                      transcriptionStatus === "transcribing"
                    }
                    onClick={() => void startRecording()}
                    title="Talk instead of typing"
                    type="button"
                  >
                    <Mic aria-hidden="true" size={18} />
                  </button>
                )}
                <button
                  aria-label="Send"
                  className="send-button"
                  disabled={
                    loading ||
                    speechInputBusy ||
                    conversationBusy ||
                    voiceSessionActive ||
                    !draft.trim()
                  }
                  title="Send"
                  type="submit"
                >
                  <ArrowUp aria-hidden="true" size={18} />
                </button>
              </div>
            </form>
            <p className="chat__hint">
              <kbd>Enter</kbd> to send · <kbd>Shift</kbd>+<kbd>Enter</kbd> new line ·
              everything stays on this computer
            </p>
          </div>
          <audio
            aria-hidden="true"
            hidden
            onEnded={() => {
              setSpeech((current) => current.status === "playing"
                ? { ...current, status: "ready" }
                : current);
              if (voiceSessionActiveRef.current) {
                void startRecording("continuous");
              }
            }}
            onError={() => {
              if (audioMessageIndex.current !== null) {
                setSpeech({
                  status: "error",
                  messageIndex: audioMessageIndex.current,
                  error: "Could not play the generated audio.",
                });
              }
              if (voiceSessionActiveRef.current) deactivateVoiceSession();
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
      </main>

      <Drawer onClose={closeDrawer} open={drawer === "history"} title="Conversations">
        {conversations.length === 0 ? (
          <div className="drawer__empty">
            <MessagesSquare aria-hidden="true" size={28} />
            <p>No saved conversations yet.</p>
          </div>
        ) : (
          <ul className="drawer__list">
            {conversations.map((conversation) => (
              <li
                className={`history-item ${
                  conversation.id === conversationId ? "history-item--current" : ""
                }`}
                key={conversation.id}
              >
                <button
                  aria-current={conversation.id === conversationId ? "true" : undefined}
                  className="history-item__open"
                  disabled={conversationBusy}
                  onClick={() => {
                    closeDrawer();
                    void selectConversation(conversation.id);
                  }}
                  type="button"
                >
                  <span className="history-item__title">{conversation.title}</span>
                </button>
                {confirmingDelete === conversation.id ? (
                  <span className="history-item__confirm">
                    <button
                      className="text-button text-button--danger"
                      onClick={() => {
                        setConfirmingDelete(null);
                        void deleteConversation(conversation.id);
                      }}
                      type="button"
                    >
                      Delete
                    </button>
                    <button
                      className="text-button"
                      onClick={() => setConfirmingDelete(null)}
                      type="button"
                    >
                      Keep
                    </button>
                  </span>
                ) : (
                  <button
                    aria-label={`Delete ${conversation.title}`}
                    className="icon-button icon-button--subtle"
                    disabled={conversationBusy}
                    onClick={() => setConfirmingDelete(conversation.id)}
                    type="button"
                  >
                    <Trash2 aria-hidden="true" size={16} />
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </Drawer>

      <Drawer onClose={closeDrawer} open={drawer === "voice"} title="Voice">
        <div className="drawer__sections">
          <VoiceSettings
            key={voiceSettingsKey}
            onSettingsChange={handleVoiceSettingsChange}
          />
        </div>
      </Drawer>

      <Drawer onClose={closeDrawer} open={drawer === "context"} title="Context" wide>
        <p className="drawer__intro">
          How {assistantName} looks, sounds and talks, and what it knows about you. Everything
          here stays on this computer and applies from your next message.
        </p>
        <div className="drawer__sections">
          <AvatarSettings
            avatar={photoAvatar.avatar}
            busy={photoAvatar.busy}
            error={photoAvatar.error}
            frameUrl={avatarFrameUrl}
            onRemove={() => void photoAvatar.remove()}
            onUpload={(photo) => void photoAvatar.upload(photo)}
          />
          <section aria-label="Your voice" className="voice-panel__section">
            <h3>Your voice</h3>
            <p className="voice-panel__note">
              Pick the built-in voice you like, or teach {assistantName} to speak in your own
              voice below.
            </p>
            <VoicePicker
              onSaved={(saved) => {
                setVoiceSettings(saved);
                setVoiceSettingsKey((key) => key + 1);
              }}
              preview={(voice) => mediaApi.previewVoice(voice)}
              settings={voiceSettings}
            />
            <MyVoiceSettings
              beforeRecording={() => {
                stopSpeech();
                if (transcriptionStatus === "recording") stopRecording();
              }}
              busy={myVoice.busy}
              error={myVoice.error}
              myVoice={myVoice.myVoice}
              onAdd={(recordings) => void myVoice.add(recordings)}
              onClear={() => void myVoice.clear()}
              onEnable={(enabled) => void myVoice.setEnabled(enabled)}
              onPreview={() => mediaApi.previewVoice(voiceSettings.voice, true)}
              onRemove={(name) => void myVoice.remove(name)}
              sampleUrl={voiceSampleUrl}
              startRecording={startSampleRecording}
            />
          </section>
          <MemorySettings
            conversationId={conversationId}
            personalizationEnabled={personalizationEnabled}
          />
          <PersonalitySettings onNameChange={handleAssistantNameChange} />
          <PersonalizationSettings
            onSettingsChange={handlePersonalizationSettingsChange}
            onUsePrompt={usePersonalizationPrompt}
          />
        </div>
      </Drawer>
    </div>
  );
}

export default App;
