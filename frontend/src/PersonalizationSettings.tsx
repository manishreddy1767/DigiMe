import { useEffect, useState } from "react";

type PersonalizationSettingsValue = {
  enabled: boolean;
  updated_at: string;
};

type TopicSummary = {
  topic: string;
  message_count: number;
  conversation_count: number;
  summary: string;
};

type ProactiveSuggestion = {
  topic: string;
  prompt: string;
  source: string;
};

type PersonalizationSettingsProps = {
  onSettingsChange: (enabled: boolean) => void;
  onUsePrompt: (prompt: string) => void;
};

async function readJson<T>(response: Response): Promise<T> {
  const result: unknown = await response.json();
  if (!response.ok) {
    const detail =
      typeof result === "object" &&
      result !== null &&
      "detail" in result &&
      typeof result.detail === "string"
        ? result.detail
        : `Request failed (${response.status}).`;
    throw new Error(detail);
  }
  return result as T;
}

function PersonalizationSettings({
  onSettingsChange,
  onUsePrompt,
}: PersonalizationSettingsProps) {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [topics, setTopics] = useState<TopicSummary[]>([]);
  const [suggestions, setSuggestions] = useState<ProactiveSuggestion[]>([]);
  const [suggestionsRequested, setSuggestionsRequested] = useState(false);
  const [saving, setSaving] = useState(false);
  const [loadingSuggestions, setLoadingSuggestions] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void fetch("/api/personalization/settings")
      .then(readJson<PersonalizationSettingsValue>)
      .then((result) => {
        if (!active) return;
        setEnabled(result.enabled);
        onSettingsChange(result.enabled);
        setError(null);
      })
      .catch((loadError: unknown) => {
        if (active) {
          setError(
            loadError instanceof Error
              ? loadError.message
              : "Could not load personalization settings.",
          );
        }
      });
    return () => {
      active = false;
    };
  }, [onSettingsChange]);

  useEffect(() => {
    if (enabled !== true) {
      setTopics([]);
      setSuggestions([]);
      return;
    }
    let active = true;
    void fetch("/api/personalization/topics")
      .then(readJson<TopicSummary[]>)
      .then((result) => {
        if (active) setTopics(result);
      })
      .catch((loadError: unknown) => {
        if (active) {
          setError(
            loadError instanceof Error
              ? loadError.message
              : "Could not load recurring topics.",
          );
        }
      });
    return () => {
      active = false;
    };
  }, [enabled]);

  const updateEnabled = async (value: boolean) => {
    setSaving(true);
    setError(null);
    setStatus(null);
    try {
      const response = await fetch("/api/personalization/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: value }),
      });
      const result = await readJson<PersonalizationSettingsValue>(response);
      setEnabled(result.enabled);
      onSettingsChange(result.enabled);
      setStatus(
        result.enabled
          ? "Personalization enabled locally."
          : "Personalization disabled; existing data remains available to review or delete.",
      );
    } catch (saveError) {
      setError(
        saveError instanceof Error
          ? saveError.message
          : "Could not update personalization settings.",
      );
    } finally {
      setSaving(false);
    }
  };

  const requestSuggestions = async () => {
    if (enabled !== true || suggestionsRequested || loadingSuggestions) return;
    setLoadingSuggestions(true);
    setError(null);
    setStatus(null);
    try {
      const response = await fetch("/api/personalization/proactive-suggestions");
      const result = await readJson<ProactiveSuggestion[]>(response);
      setSuggestions(result);
      setSuggestionsRequested(true);
      setStatus(
        result.length > 0
          ? "Optional ideas are ready. Choose one to place it in your draft."
          : "No optional ideas matched your approved memories or recurring topics.",
      );
    } catch (suggestionError) {
      setError(
        suggestionError instanceof Error
          ? suggestionError.message
          : "Could not load optional ideas.",
      );
    } finally {
      setLoadingSuggestions(false);
    }
  };

  return (
    <details className="settings-section">
      <summary>Personalization &amp; optional ideas</summary>
      <div className="settings-form personalization-panel">
        <p>
          Topic summaries are computed locally from a small allowlist of general
          interests and are not saved. Personality settings remain in effect.
          Suggestions are shown only when requested.
        </p>
        <label className="voice-setting">
          <input
            checked={enabled === true}
            disabled={enabled === null || saving}
            onChange={(event) => void updateEnabled(event.target.checked)}
            type="checkbox"
          />
          Enable personalization using the profile and approved memories
        </label>
        {enabled === true && (
          <>
            <section aria-label="Recurring topics" className="topic-summary">
              <h3>Recurring topics</h3>
              {topics.length === 0 ? (
                <p>No recurring general topics found in recent messages.</p>
              ) : (
                <ul>
                  {topics.map((topic) => (
                    <li key={topic.topic}>
                      {topic.summary}
                    </li>
                  ))}
                </ul>
              )}
            </section>
            <section aria-label="Proactive suggestions" className="topic-summary">
              <h3>Optional ideas</h3>
              <button
                disabled={loadingSuggestions || suggestionsRequested}
                onClick={() => void requestSuggestions()}
                type="button"
              >
                {loadingSuggestions
                  ? "Finding ideas…"
                  : suggestionsRequested
                    ? "Suggestions shown"
                    : "Show optional ideas"}
              </button>
              {suggestions.map((suggestion) => (
                <div className="personalization-suggestion" key={suggestion.topic}>
                  <p>
                    <strong>{suggestion.topic}</strong> · {suggestion.source}
                  </p>
                  <div className="memory-actions">
                    <button
                      onClick={() => onUsePrompt(suggestion.prompt)}
                      type="button"
                    >
                      Use in draft
                    </button>
                    <button
                      onClick={() =>
                        setSuggestions((current) =>
                          current.filter((item) => item.topic !== suggestion.topic),
                        )
                      }
                      type="button"
                    >
                      Dismiss
                    </button>
                  </div>
                </div>
              ))}
            </section>
          </>
        )}
        {error && <p className="settings-error" role="alert">{error}</p>}
        {status && <p className="settings-status" role="status">{status}</p>}
      </div>
    </details>
  );
}

export default PersonalizationSettings;
