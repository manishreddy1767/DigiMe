import { FormEvent, useEffect, useState } from "react";

type Personality = {
  name: string;
  communication_style: "friendly" | "professional" | "casual";
  response_length: "concise" | "balanced" | "detailed";
  custom_instructions: string;
  deep_reasoning: boolean;
  updated_at: string;
};

const DEFAULT_PERSONALITY: Personality = {
  name: "Digital Me",
  communication_style: "friendly",
  response_length: "balanced",
  custom_instructions: "",
  deep_reasoning: false,
  updated_at: "",
};

function isCommunicationStyle(value: unknown): value is Personality["communication_style"] {
  return value === "friendly" || value === "professional" || value === "casual";
}

function isResponseLength(value: unknown): value is Personality["response_length"] {
  return value === "concise" || value === "balanced" || value === "detailed";
}

async function readPersonality(response: Response): Promise<Personality> {
  const result: unknown = await response.json();
  if (!response.ok) {
    const detail =
      typeof result === "object" &&
      result !== null &&
      "detail" in result &&
      typeof result.detail === "string"
        ? result.detail
        : `Personality request failed (${response.status}).`;
    throw new Error(detail);
  }
  if (
    typeof result !== "object" ||
    result === null ||
    !("name" in result) ||
    typeof result.name !== "string" ||
    !("communication_style" in result) ||
    !isCommunicationStyle(result.communication_style) ||
    !("response_length" in result) ||
    !isResponseLength(result.response_length) ||
    !("custom_instructions" in result) ||
    typeof result.custom_instructions !== "string" ||
    !("updated_at" in result) ||
    typeof result.updated_at !== "string" ||
    ("deep_reasoning" in result && typeof result.deep_reasoning !== "boolean")
  ) {
    throw new Error("The personality service returned invalid settings.");
  }
  return {
    name: result.name,
    communication_style: result.communication_style,
    response_length: result.response_length,
    custom_instructions: result.custom_instructions,
    deep_reasoning: "deep_reasoning" in result && result.deep_reasoning === true,
    updated_at: result.updated_at,
  };
}

function messageFor(error: unknown): string {
  return error instanceof Error ? error.message : "Could not save personality settings.";
}

function PersonalitySettings({
  onNameChange,
}: {
  onNameChange?: (name: string) => void;
} = {}) {
  const [personality, setPersonality] = useState(DEFAULT_PERSONALITY);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    void fetch("/api/personality")
      .then(readPersonality)
      .then((saved) => {
        setPersonality(saved);
        onNameChange?.(saved.name);
        setError(null);
      })
      .catch((loadError: unknown) => setError(messageFor(loadError)));
  }, [onNameChange]);

  const save = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSaving(true);
    setError(null);
    setStatus(null);
    try {
      const response = await fetch("/api/personality", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: personality.name,
          communication_style: personality.communication_style,
          response_length: personality.response_length,
          custom_instructions: personality.custom_instructions,
          deep_reasoning: personality.deep_reasoning,
        }),
      });
      const saved = await readPersonality(response);
      setPersonality(saved);
      onNameChange?.(saved.name);
      setStatus("Personality settings saved locally.");
    } catch (saveError) {
      setError(messageFor(saveError));
    } finally {
      setSaving(false);
    }
  };

  const reset = async () => {
    setSaving(true);
    setError(null);
    setStatus(null);
    try {
      const response = await fetch("/api/personality/reset", { method: "POST" });
      const saved = await readPersonality(response);
      setPersonality(saved);
      onNameChange?.(saved.name);
      setStatus("Personality reset to defaults.");
    } catch (resetError) {
      setError(messageFor(resetError));
    } finally {
      setSaving(false);
    }
  };

  return (
    <details className="settings-section">
      <summary>Digital personality</summary>
      <p className="settings-note">
        These saved settings shape replies in every conversation. Chat messages
        never change them.
      </p>
      <form className="settings-form" onSubmit={save}>
        <label>
          Personality name
          <input
            maxLength={100}
            onChange={(event) =>
              setPersonality({ ...personality, name: event.target.value })
            }
            required
            value={personality.name}
          />
        </label>
        <label>
          Communication style
          <select
            onChange={(event) => {
              const { value } = event.target;
              if (isCommunicationStyle(value)) {
                setPersonality({ ...personality, communication_style: value });
              }
            }}
            value={personality.communication_style}
          >
            <option value="friendly">Friendly</option>
            <option value="professional">Professional</option>
            <option value="casual">Casual</option>
          </select>
        </label>
        <label>
          Response length
          <select
            onChange={(event) => {
              const { value } = event.target;
              if (isResponseLength(value)) {
                setPersonality({ ...personality, response_length: value });
              }
            }}
            value={personality.response_length}
          >
            <option value="concise">Concise</option>
            <option value="balanced">Balanced</option>
            <option value="detailed">Detailed</option>
          </select>
        </label>
        <label>
          Custom personality instructions
          <textarea
            maxLength={2000}
            onChange={(event) =>
              setPersonality({
                ...personality,
                custom_instructions: event.target.value,
              })
            }
            placeholder="Optional instructions for how Digital Me should communicate…"
            rows={3}
            value={personality.custom_instructions}
          />
        </label>
        <label className="voice-setting">
          <input
            checked={personality.deep_reasoning}
            onChange={(event) =>
              setPersonality({ ...personality, deep_reasoning: event.target.checked })
            }
            type="checkbox"
          />
          Deep reasoning (slower, more careful answers)
        </label>
        <div className="personality-actions">
          <button disabled={saving} type="submit">
            {saving ? "Saving…" : "Save personality"}
          </button>
          <button
            disabled={saving}
            onClick={() => void reset()}
            type="button"
          >
            Reset to defaults
          </button>
        </div>
        {error && <p role="alert">{error}</p>}
      </form>
      {status && <p className="settings-status" role="status">{status}</p>}
    </details>
  );
}

export default PersonalitySettings;
