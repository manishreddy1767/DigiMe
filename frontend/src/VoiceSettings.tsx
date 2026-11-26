import { FormEvent, useEffect, useState } from "react";

export type VoiceSettingsValue = {
  auto_play_responses: boolean;
  continuous_conversation_enabled: boolean;
  updated_at: string;
};

export const DEFAULT_VOICE_SETTINGS: VoiceSettingsValue = {
  auto_play_responses: false,
  continuous_conversation_enabled: false,
  updated_at: "",
};

async function readVoiceSettings(response: Response): Promise<VoiceSettingsValue> {
  const result: unknown = await response.json();
  if (!response.ok) {
    const detail =
      typeof result === "object" &&
      result !== null &&
      "detail" in result &&
      typeof result.detail === "string"
        ? result.detail
        : `Voice settings request failed (${response.status}).`;
    throw new Error(detail);
  }
  if (
    typeof result !== "object" ||
    result === null ||
    !("auto_play_responses" in result) ||
    typeof result.auto_play_responses !== "boolean" ||
    !("continuous_conversation_enabled" in result) ||
    typeof result.continuous_conversation_enabled !== "boolean" ||
    !("updated_at" in result) ||
    typeof result.updated_at !== "string"
  ) {
    throw new Error("The voice settings service returned invalid settings.");
  }
  return {
    auto_play_responses: result.auto_play_responses,
    continuous_conversation_enabled: result.continuous_conversation_enabled,
    updated_at: result.updated_at,
  };
}

function messageFor(error: unknown): string {
  return error instanceof Error ? error.message : "Could not save voice settings.";
}

function VoiceSettings({
  onSettingsChange,
}: {
  onSettingsChange: (settings: VoiceSettingsValue) => void;
}) {
  const [settings, setSettings] = useState(DEFAULT_VOICE_SETTINGS);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let active = true;
    void fetch("/api/voice-settings")
      .then(readVoiceSettings)
      .then((saved) => {
        if (active) {
          setSettings(saved);
          onSettingsChange(saved);
          setError(null);
        }
      })
      .catch((loadError: unknown) => {
        if (active) setError(messageFor(loadError));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [onSettingsChange]);

  const save = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSaving(true);
    setError(null);
    setStatus(null);
    try {
      const response = await fetch("/api/voice-settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          auto_play_responses: settings.auto_play_responses,
          continuous_conversation_enabled: settings.continuous_conversation_enabled,
        }),
      });
      const saved = await readVoiceSettings(response);
      setSettings(saved);
      onSettingsChange(saved);
      setStatus("Voice settings saved locally.");
    } catch (saveError) {
      setError(messageFor(saveError));
    } finally {
      setSaving(false);
    }
  };

  return (
    <details className="settings-section">
      <summary>Voice settings</summary>
      <p className="settings-note">
        Voice preferences are stored locally. Continuous mode only starts
        listening after you explicitly start a voice conversation.
      </p>
      <form className="settings-form" onSubmit={save}>
        <label className="voice-setting">
          <input
            checked={settings.auto_play_responses}
            disabled={loading || saving}
            onChange={(event) =>
              setSettings({
                ...settings,
                auto_play_responses: event.target.checked,
              })
            }
            type="checkbox"
          />
          Automatically speak AI responses
        </label>
        <label className="voice-setting">
          <input
            checked={settings.continuous_conversation_enabled}
            disabled={loading || saving}
            onChange={(event) =>
              setSettings({
                ...settings,
                continuous_conversation_enabled: event.target.checked,
              })
            }
            type="checkbox"
          />
          Enable continuous voice conversation
        </label>
        <button disabled={loading || saving} type="submit">
          {loading ? "Loading voice settings…" : saving ? "Saving…" : "Save voice settings"}
        </button>
        {error && <p role="alert">{error}</p>}
      </form>
      {status && <p className="settings-status" role="status">{status}</p>}
    </details>
  );
}

export default VoiceSettings;
