import { Loader2, Volume2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { VOICE_OPTIONS, type VoiceId, type VoiceSettingsValue } from "../VoiceSettings";

type VoicePickerProps = {
  settings: VoiceSettingsValue;
  onSaved: (settings: VoiceSettingsValue) => void;
  preview: (voice: string) => Promise<Blob>;
};

function isVoiceId(value: string): value is VoiceId {
  return VOICE_OPTIONS.some((option) => option.id === value);
}

/** Choose the built-in voice replies are spoken with; it is saved as soon as it changes. */
function VoicePicker({ settings, onSaved, preview }: VoicePickerProps) {
  const [saving, setSaving] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const player = useRef<HTMLAudioElement | null>(null);

  useEffect(() => () => player.current?.pause(), []);

  const choose = async (voice: VoiceId) => {
    setSaving(true);
    setError(null);
    try {
      const response = await fetch("/api/voice-settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          auto_play_responses: settings.auto_play_responses,
          continuous_conversation_enabled: settings.continuous_conversation_enabled,
          voice,
        }),
      });
      if (!response.ok) throw new Error(`Could not save the voice (${response.status}).`);
      onSaved({ ...settings, voice });
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Could not save the voice.");
    } finally {
      setSaving(false);
    }
  };

  const play = async () => {
    setPreviewing(true);
    setError(null);
    try {
      const url = URL.createObjectURL(await preview(settings.voice));
      player.current?.pause();
      player.current = new Audio(url);
      await player.current.play();
    } catch (previewError) {
      setError(previewError instanceof Error ? previewError.message : "Could not play the preview.");
    } finally {
      setPreviewing(false);
    }
  };

  return (
    <div className="voice-choice">
      <label className="field" htmlFor="built-in-voice">
        <span>Built-in voice</span>
      </label>
      <div className="voice-picker">
        <select
          disabled={saving}
          id="built-in-voice"
          onChange={(event) => {
            const { value } = event.target;
            if (isVoiceId(value)) void choose(value);
          }}
          value={settings.voice}
        >
          {VOICE_OPTIONS.map((option) => (
            <option key={option.id} value={option.id}>
              {option.label}
            </option>
          ))}
        </select>
        <button
          className="preview-button"
          disabled={previewing}
          onClick={() => void play()}
          type="button"
        >
          {previewing ? (
            <Loader2 aria-hidden="true" className="spin" size={16} />
          ) : (
            <Volume2 aria-hidden="true" size={16} />
          )}
          Preview
        </button>
      </div>
      {error && (
        <p className="drawer__error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

export default VoicePicker;
