import { Loader2, Mic, Play, Square, Trash2, Upload, Volume2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import type { Recording, StartRecording } from "../audio/recorder";
import type { MyVoiceState } from "./api";

/** Lines to read aloud: varied sounds, then free talk. */
export const PROMPTS = [
  "Hi! It's really nice to meet you. How has your day been so far?",
  "I enjoy learning new things, especially when they're a little bit challenging.",
  "Honestly, I think the best ideas come when you're relaxed and not trying too hard.",
  "Wait, are you serious? That's amazing news!",
  "Let me think about that for a second before I answer.",
  "The weather today is perfect for a long walk and a cup of tea.",
  "Could you send me the notes from yesterday's class, please?",
  "Machine learning models learn patterns from data instead of following fixed rules.",
  "Now talk freely for about twenty seconds about your day or a hobby.",
];

type MyVoiceSettingsProps = {
  myVoice: MyVoiceState | null;
  error: string | null;
  busy: boolean;
  sampleUrl: (name: string) => string;
  startRecording: StartRecording;
  /** Called just before recording, e.g. to stop the chat microphone. */
  beforeRecording?: () => void;
  onAdd: (recordings: Blob[]) => void;
  onRemove: (name: string) => void;
  onEnable: (enabled: boolean) => void;
  onClear: () => void;
  onPreview: () => Promise<Blob>;
};

/** "Your own voice": record or upload samples, then switch replies to your voice. */
function MyVoiceSettings({
  myVoice,
  error,
  busy,
  sampleUrl,
  startRecording,
  beforeRecording,
  onAdd,
  onRemove,
  onEnable,
  onClear,
  onPreview,
}: MyVoiceSettingsProps) {
  const [recording, setRecording] = useState<Recording | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [prompt, setPrompt] = useState(0);
  const [localError, setLocalError] = useState<string | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const player = useRef<HTMLAudioElement | null>(null);
  const files = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!recording) return;
    const started = Date.now();
    const timer = setInterval(() => setElapsed(Math.floor((Date.now() - started) / 1000)), 250);
    return () => clearInterval(timer);
  }, [recording]);

  useEffect(
    () => () => {
      recording?.cancel();
      player.current?.pause();
    },
    [recording],
  );

  if (!myVoice) return null; // this server has no own-voice support

  const play = (src: string) => {
    player.current?.pause();
    player.current = new Audio(src);
    void player.current.play().catch(() => setLocalError("Could not play it."));
  };

  const record = async () => {
    setLocalError(null);
    beforeRecording?.();
    try {
      setElapsed(0);
      setRecording(await startRecording());
    } catch {
      setLocalError("Microphone not available. Allow microphone access in the browser and try again.");
    }
  };

  const stop = async () => {
    if (!recording) return;
    const current = recording;
    setRecording(null);
    const blob = await current.stop();
    onAdd([blob]);
    setPrompt((p) => (p + 1) % PROMPTS.length);
  };

  const preview = async () => {
    setPreviewing(true);
    setLocalError(null);
    try {
      play(URL.createObjectURL(await onPreview()));
    } catch (e) {
      setLocalError(e instanceof Error ? e.message : "Preview failed.");
    } finally {
      setPreviewing(false);
    }
  };

  const ready = myVoice.status === "ready";
  const percent = Math.min(100, Math.round((100 * myVoice.seconds) / myVoice.recommended_seconds));
  const message = localError ?? error;

  return (
    <section aria-label="Your own voice" className="my-voice">
      <h3>Your own voice</h3>
      {myVoice.unavailable ? (
        <p className="voice-panel__note">{myVoice.unavailable}</p>
      ) : (
        <>
          <p className="voice-panel__note">
            Record yourself reading these lines in a quiet room, or upload recordings from your
            phone. Digital Me learns your voice from them on this computer only, and every reply in
            your voice carries an inaudible AI watermark. Only record your own voice.
          </p>

          <div aria-live="polite" className="my-voice__prompt">
            <span className="my-voice__count">
              {prompt + 1} / {PROMPTS.length}
            </span>
            <p>{PROMPTS[prompt]}</p>
          </div>

          <div className="my-voice__actions">
            {recording ? (
              <button
                className="danger-button my-voice__record"
                onClick={() => void stop()}
                type="button"
              >
                <Square aria-hidden="true" size={14} /> Stop ({elapsed}s)
              </button>
            ) : (
              <button
                className="preview-button my-voice__record"
                disabled={busy || myVoice.samples.length >= myVoice.max_samples}
                onClick={() => void record()}
                type="button"
              >
                {busy ? (
                  <Loader2 aria-hidden="true" className="spin" size={16} />
                ) : (
                  <Mic aria-hidden="true" size={16} />
                )}
                {busy ? "Learning…" : "Record this line"}
              </button>
            )}
            <button
              aria-label="Skip to the next line"
              className="icon-button"
              disabled={!!recording}
              onClick={() => setPrompt((p) => (p + 1) % PROMPTS.length)}
              title="Next line"
              type="button"
            >
              ›
            </button>
            <button
              aria-label="Upload recordings"
              className="icon-button"
              disabled={busy || !!recording}
              onClick={() => files.current?.click()}
              title="Upload recordings"
              type="button"
            >
              <Upload aria-hidden="true" size={16} />
            </button>
          </div>

          <div className="my-voice__progress">
            <span>
              {myVoice.seconds.toFixed(0)}s recorded ·{" "}
              {ready
                ? `more makes it closer (${myVoice.recommended_seconds}s is good)`
                : `${myVoice.min_seconds}s needed`}
            </span>
            <div
              aria-label="Recorded speech"
              aria-valuemax={100}
              aria-valuemin={0}
              aria-valuenow={percent}
              role="progressbar"
            >
              <div style={{ width: `${percent}%` }} />
            </div>
          </div>

          {myVoice.samples.length > 0 && (
            <ul aria-label="Your recordings" className="my-voice__samples">
              {myVoice.samples.map((sample, i) => (
                <li key={sample.name}>
                  <button
                    aria-label={`Play recording ${i + 1}`}
                    className="icon-button icon-button--subtle"
                    onClick={() => play(sampleUrl(sample.name))}
                    type="button"
                  >
                    <Play aria-hidden="true" size={14} />
                  </button>
                  <span>
                    Recording {i + 1} · {sample.seconds}s
                  </span>
                  <button
                    aria-label={`Remove recording ${i + 1}`}
                    className="icon-button icon-button--subtle"
                    disabled={busy}
                    onClick={() => onRemove(sample.name)}
                    type="button"
                  >
                    <Trash2 aria-hidden="true" size={14} />
                  </button>
                </li>
              ))}
            </ul>
          )}

          <label className="switch-row">
            <span>
              <span className="switch-row__title">Speak in my voice</span>
              <span className="switch-row__hint">
                {ready
                  ? "Replies are spoken in your voice instead of the built-in one"
                  : "Record a little more first"}
              </span>
            </span>
            <input
              checked={myVoice.enabled}
              className="switch"
              disabled={!ready || busy}
              onChange={(event) => onEnable(event.target.checked)}
              role="switch"
              type="checkbox"
            />
          </label>

          <div className="my-voice__actions">
            <button
              className="preview-button"
              disabled={!ready || previewing}
              onClick={() => void preview()}
              type="button"
            >
              {previewing ? (
                <Loader2 aria-hidden="true" className="spin" size={16} />
              ) : (
                <Volume2 aria-hidden="true" size={16} />
              )}
              Hear my voice
            </button>
            {myVoice.samples.length > 0 &&
              (confirming ? (
                <button
                  className="danger-button"
                  onClick={() => {
                    setConfirming(false);
                    onClear();
                  }}
                  type="button"
                >
                  Delete all recordings?
                </button>
              ) : (
                <button
                  aria-label="Delete all recordings"
                  className="icon-button icon-button--subtle"
                  onClick={() => setConfirming(true)}
                  type="button"
                >
                  <Trash2 aria-hidden="true" size={16} />
                </button>
              ))}
          </div>
        </>
      )}
      {message && (
        <p className="drawer__error" role="alert">
          {message}
        </p>
      )}
      <input
        accept="audio/*,.m4a,.mp3,.wav,.ogg,.webm,.flac"
        aria-label="Voice recordings"
        hidden
        multiple
        onChange={(event) => {
          const chosen = [...(event.target.files ?? [])];
          event.target.value = "";
          if (chosen.length) onAdd(chosen);
        }}
        ref={files}
        type="file"
      />
    </section>
  );
}

export default MyVoiceSettings;
