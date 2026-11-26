import { FormEvent, useCallback, useEffect, useState } from "react";

type UserProfile = {
  name: string;
  about: string;
  preferences: string;
  updated_at: string;
};

type Memory = {
  id: string;
  content: string;
  importance: number;
  created_at: string;
  updated_at: string;
};

type SimilarMemory = Memory & {
  similarity: number;
  kind: "duplicate" | "similar";
};

type MemorySuggestion = {
  id: string;
  conversation_id: string;
  content: string;
  status: "pending";
  created_at: string;
  importance: number;
};

type MemorySuggestionRecord = Omit<MemorySuggestion, "importance">;

class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly detail: unknown,
  ) {
    super(message);
  }
}

async function readResponse<T>(response: Response): Promise<T> {
  const result: unknown = await response.json();
  if (!response.ok) {
    const rawDetail =
      typeof result === "object" &&
      result !== null &&
      "detail" in result &&
      result.detail !== undefined
        ? result.detail
        : null;
    const message =
      typeof rawDetail === "string"
        ? rawDetail
        : typeof rawDetail === "object" &&
            rawDetail !== null &&
            "message" in rawDetail &&
            typeof rawDetail.message === "string"
          ? rawDetail.message
          : `Request failed (${response.status}).`;
    throw new ApiError(message, response.status, rawDetail);
  }
  return result as T;
}

function getErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

function getSimilarMemories(error: unknown): SimilarMemory[] | null {
  if (
    !(error instanceof ApiError) ||
    typeof error.detail !== "object" ||
    error.detail === null ||
    !("similar_memories" in error.detail) ||
    !Array.isArray(error.detail.similar_memories)
  ) {
    return null;
  }
  return error.detail.similar_memories.filter(
    (item): item is SimilarMemory =>
      typeof item === "object" &&
      item !== null &&
      "id" in item &&
      typeof item.id === "string" &&
      "content" in item &&
      typeof item.content === "string" &&
      "importance" in item &&
      typeof item.importance === "number" &&
      "similarity" in item &&
      typeof item.similarity === "number" &&
      "kind" in item &&
      (item.kind === "duplicate" || item.kind === "similar"),
  );
}

function MemorySettings({
  conversationId = null,
  personalizationEnabled = true,
}: {
  conversationId?: string | null;
  personalizationEnabled?: boolean;
}) {
  const [profile, setProfile] = useState<UserProfile>({
    name: "",
    about: "",
    preferences: "",
    updated_at: "",
  });
  const [memories, setMemories] = useState<Memory[]>([]);
  const [suggestions, setSuggestions] = useState<MemorySuggestion[]>([]);
  const [memorySearch, setMemorySearch] = useState("");
  const [newMemory, setNewMemory] = useState("");
  const [newImportance, setNewImportance] = useState(3);
  const [similarWarning, setSimilarWarning] = useState<{
    content: string;
    importance: number;
    matches: SimilarMemory[];
  } | null>(null);
  const [editSimilarWarning, setEditSimilarWarning] = useState<{
    memoryId: string;
    matches: SimilarMemory[];
  } | null>(null);
  const [suggestionWarnings, setSuggestionWarnings] =
    useState<Record<string, SimilarMemory[]>>({});
  const [profileError, setProfileError] = useState<string | null>(null);
  const [memoryError, setMemoryError] = useState<string | null>(null);
  const [suggestionError, setSuggestionError] = useState<string | null>(null);
  const [embeddingWarning, setEmbeddingWarning] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [profileSaving, setProfileSaving] = useState(false);
  const [memorySaving, setMemorySaving] = useState(false);
  const [suggestionBusy, setSuggestionBusy] = useState(false);

  const loadMemories = useCallback(async (query = "") => {
    const parameters = new URLSearchParams();
    if (query.trim()) parameters.set("q", query.trim());
    const suffix = parameters.size > 0 ? `?${parameters.toString()}` : "";
    const response = await fetch(`/api/memories${suffix}`);
    const result = await readResponse<Memory[]>(response);
    setMemories(result);
  }, []);

  useEffect(() => {
    void fetch("/api/profile")
      .then(readResponse<UserProfile>)
      .then((result) => {
        setProfile(result);
        setProfileError(null);
      })
      .catch((error: unknown) => {
        setProfileError(getErrorMessage(error, "Could not load the local profile."));
      });
    void loadMemories().catch((error: unknown) => {
      setMemoryError(getErrorMessage(error, "Could not load approved memories."));
    });
  }, [loadMemories]);

  useEffect(() => {
    setSuggestions([]);
    setSuggestionWarnings({});
    setSuggestionError(null);
    if (!conversationId) {
      return;
    }
    let active = true;
    void fetch(`/api/conversations/${encodeURIComponent(conversationId)}/memory-suggestions`)
      .then(readResponse<MemorySuggestionRecord[]>)
      .then((result) => {
        if (active) {
          setSuggestions(result.map((suggestion) => ({ ...suggestion, importance: 3 })));
          setSuggestionWarnings({});
          setSuggestionError(null);
        }
      })
      .catch((error: unknown) => {
        if (active) {
          setSuggestionError(
            getErrorMessage(error, "Could not load conversation memory suggestions."),
          );
        }
      });
    return () => {
      active = false;
    };
  }, [conversationId]);

  const saveProfile = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setProfileSaving(true);
    setProfileError(null);
    setStatus(null);
    try {
      const response = await fetch("/api/profile", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: profile.name,
          about: profile.about,
          preferences: profile.preferences,
        }),
      });
      setProfile(await readResponse<UserProfile>(response));
      setStatus("Profile saved locally.");
    } catch (error) {
      setProfileError(getErrorMessage(error, "Could not save the local profile."));
    } finally {
      setProfileSaving(false);
    }
  };

  const saveMemoryContent = async (
    content: string,
    importance: number,
    confirmSimilar = false,
  ) => {
    if (!content || memorySaving) return;
    setMemorySaving(true);
    setMemoryError(null);
    setSimilarWarning(null);
    setStatus(null);
    try {
      const response = await fetch("/api/memories", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content, importance, confirm_similar: confirmSimilar }),
      });
      const saved = await readResponse<Memory>(response);
      setMemories((current) => [saved, ...current]);
      setNewMemory("");
      setSimilarWarning(null);
      setEmbeddingWarning(
        "embedding_warning" in saved && typeof saved.embedding_warning === "string"
          ? saved.embedding_warning
          : null,
      );
      setStatus("Memory saved with your approval.");
    } catch (error) {
      const matches = getSimilarMemories(error);
      if (matches && !confirmSimilar) {
        setSimilarWarning({ content, importance, matches });
        setMemoryError(null);
      } else {
        setMemoryError(getErrorMessage(error, "Could not save the approved memory."));
      }
    } finally {
      setMemorySaving(false);
    }
  };

  const saveMemory = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    await saveMemoryContent(newMemory.trim(), newImportance);
  };

  const updateMemory = async (
    memoryId: string,
    content: string,
    importance: number,
    confirmSimilar = false,
  ) => {
    setMemoryError(null);
    setEditSimilarWarning(null);
    setStatus(null);
    try {
      const response = await fetch(`/api/memories/${encodeURIComponent(memoryId)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content, importance, confirm_similar: confirmSimilar }),
      });
      const updated = await readResponse<Memory>(response);
      setMemories((current) =>
        current.map((memory) => memory.id === memoryId ? updated : memory),
      );
      setEmbeddingWarning(
        "embedding_warning" in updated && typeof updated.embedding_warning === "string"
          ? updated.embedding_warning
          : null,
      );
      setStatus("Memory updated.");
    } catch (error) {
      const matches = getSimilarMemories(error);
      if (matches && !confirmSimilar) {
        setEditSimilarWarning({ memoryId, matches });
        setMemoryError(null);
      } else {
        setMemoryError(getErrorMessage(error, "Could not update the memory."));
      }
    }
  };

  const suggestFromConversation = async () => {
    if (!conversationId || suggestionBusy) return;
    setSuggestionBusy(true);
    setSuggestionError(null);
    setStatus(null);
    try {
      const response = await fetch(
        `/api/conversations/${encodeURIComponent(conversationId)}/memory-suggestions`,
        { method: "POST" },
      );
      const result = await readResponse<MemorySuggestionRecord[]>(response);
      setSuggestions(result.map((suggestion) => ({ ...suggestion, importance: 3 })));
      setSuggestionWarnings({});
      setStatus(
        result.length > 0
          ? "Review suggestions and approve each memory you want to save."
          : "No durable memory suggestions were found in this conversation.",
      );
    } catch (error) {
      setSuggestionError(
        getErrorMessage(error, "Could not suggest memories from this conversation."),
      );
    } finally {
      setSuggestionBusy(false);
    }
  };

  const suggestRecurringPreferences = async () => {
    if (!conversationId || !personalizationEnabled || suggestionBusy) return;
    setSuggestionBusy(true);
    setSuggestionError(null);
    setStatus(null);
    try {
      const response = await fetch(
        `/api/conversations/${encodeURIComponent(conversationId)}/preference-suggestions`,
        { method: "POST" },
      );
      const result = await readResponse<MemorySuggestionRecord[]>(response);
      setSuggestions(result.map((suggestion) => ({ ...suggestion, importance: 3 })));
      setSuggestionWarnings({});
      setStatus(
        result.length > 0
          ? "Review recurring-preference suggestions and explicitly approve any you want to save."
          : "No recurring explicit preferences were found in recent local messages.",
      );
    } catch (error) {
      setSuggestionError(
        getErrorMessage(error, "Could not suggest recurring preferences."),
      );
    } finally {
      setSuggestionBusy(false);
    }
  };

  const approveSuggestion = async (
    suggestion: MemorySuggestion,
    confirmSimilar = false,
  ) => {
    setSuggestionBusy(true);
    setSuggestionError(null);
    try {
      const response = await fetch(
        `/api/memory-suggestions/${encodeURIComponent(suggestion.id)}/approve`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            importance: suggestion.importance,
            confirm_similar: confirmSimilar,
          }),
        },
      );
      const saved = await readResponse<Memory>(response);
      setMemories((current) => [saved, ...current]);
      setSuggestions((current) =>
        current.filter((item) => item.id !== suggestion.id),
      );
      setSuggestionWarnings((current) => {
        const next = { ...current };
        delete next[suggestion.id];
        return next;
      });
      setEmbeddingWarning(
        "embedding_warning" in saved && typeof saved.embedding_warning === "string"
          ? saved.embedding_warning
          : null,
      );
      setStatus("Suggestion approved and saved as a memory.");
    } catch (error) {
      const matches = getSimilarMemories(error);
      if (matches && !confirmSimilar) {
        setSuggestionWarnings((current) => ({
          ...current,
          [suggestion.id]: matches,
        }));
      } else {
        setSuggestionError(
          getErrorMessage(error, "Could not approve this memory suggestion."),
        );
      }
    } finally {
      setSuggestionBusy(false);
    }
  };

  const dismissSuggestion = async (suggestionId: string) => {
    setSuggestionBusy(true);
    setSuggestionError(null);
    try {
      const response = await fetch(
        `/api/memory-suggestions/${encodeURIComponent(suggestionId)}`,
        { method: "DELETE" },
      );
      if (!response.ok) await readResponse<void>(response);
      setSuggestions((current) =>
        current.filter((suggestion) => suggestion.id !== suggestionId),
      );
    } catch (error) {
      setSuggestionError(
        getErrorMessage(error, "Could not dismiss this memory suggestion."),
      );
    } finally {
      setSuggestionBusy(false);
    }
  };

  const deleteMemory = async (memoryId: string) => {
    setMemoryError(null);
    setStatus(null);
    try {
      const response = await fetch(`/api/memories/${encodeURIComponent(memoryId)}`, {
        method: "DELETE",
      });
      if (!response.ok) await readResponse<void>(response);
      setMemories((current) => current.filter((memory) => memory.id !== memoryId));
      setStatus("Memory deleted.");
    } catch (error) {
      setMemoryError(getErrorMessage(error, "Could not delete the memory."));
    }
  };

  const searchMemories = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setMemoryError(null);
    try {
      await loadMemories(memorySearch);
    } catch (error) {
      setMemoryError(getErrorMessage(error, "Could not search approved memories."));
    }
  };

  return (
    <div className="memory-settings">
      <details className="settings-section">
        <summary>User profile</summary>
        <form className="settings-form" onSubmit={saveProfile}>
          <label>
            Name
            <input
              maxLength={100}
              onChange={(event) => setProfile({ ...profile, name: event.target.value })}
              value={profile.name}
            />
          </label>
          <label>
            About
            <textarea
              maxLength={1000}
              onChange={(event) => setProfile({ ...profile, about: event.target.value })}
              rows={2}
              value={profile.about}
            />
          </label>
          <label>
            Response preferences
            <textarea
              maxLength={1000}
              onChange={(event) =>
                setProfile({ ...profile, preferences: event.target.value })
              }
              rows={2}
              value={profile.preferences}
            />
          </label>
          <button disabled={profileSaving} type="submit">
            {profileSaving ? "Saving profile…" : "Save profile"}
          </button>
          {profileError && <p role="alert">{profileError}</p>}
        </form>
      </details>

      <details className="settings-section">
        <summary>Approved long-term memories ({memories.length})</summary>
        <p className="settings-note">
          Only save information you explicitly enter here. Chats are never turned
          into memories automatically.
        </p>
        <form className="settings-form" onSubmit={saveMemory}>
          <label htmlFor="new-memory">Memory to approve and save</label>
          <textarea
            id="new-memory"
            maxLength={2000}
            onChange={(event) => {
              setNewMemory(event.target.value);
              setSimilarWarning(null);
            }}
            placeholder="Enter a fact you want Digital Me to remember…"
            rows={2}
            value={newMemory}
          />
          <label>
            Importance
            <select
              aria-label="New memory importance"
              onChange={(event) => setNewImportance(Number(event.target.value))}
              value={newImportance}
            >
              <option value={1}>1 — Low</option>
              <option value={2}>2</option>
              <option value={3}>3 — Normal</option>
              <option value={4}>4</option>
              <option value={5}>5 — High</option>
            </select>
          </label>
          <button disabled={memorySaving || !newMemory.trim()} type="submit">
            {memorySaving ? "Saving memory…" : "Save approved memory"}
          </button>
        </form>
        {similarWarning && (
          <div className="similar-memory-warning" role="alert">
            <p>Similar approved memories found. Review before saving.</p>
            <ul>
              {similarWarning.matches.map((match) => (
                <li key={match.id}>{match.content}</li>
              ))}
            </ul>
            <div className="memory-actions">
              <button
                disabled={memorySaving}
                onClick={() =>
                  void saveMemoryContent(
                    similarWarning.content,
                    similarWarning.importance,
                    true,
                  )
                }
                type="button"
              >
                Save anyway
              </button>
              <button
                disabled={memorySaving}
                onClick={() => setSimilarWarning(null)}
                type="button"
              >
                Cancel
              </button>
            </div>
          </div>
        )}
        <form className="memory-search" onSubmit={searchMemories}>
          <label className="sr-only" htmlFor="memory-search">Search memories</label>
          <input
            id="memory-search"
            onChange={(event) => setMemorySearch(event.target.value)}
            placeholder="Search approved memories…"
            value={memorySearch}
          />
          <button type="submit">Search</button>
          <button
            onClick={() => {
              setMemorySearch("");
              void loadMemories().catch((error: unknown) => {
                setMemoryError(getErrorMessage(error, "Could not load approved memories."));
              });
            }}
            type="button"
          >
            Show all
          </button>
        </form>
        {memoryError && <p className="settings-error" role="alert">{memoryError}</p>}
        {embeddingWarning && (
          <p className="settings-error" role="status">
            Embeddings unavailable; FTS5 search remains active. {embeddingWarning}
          </p>
        )}
        {memories.length === 0 ? (
          <p className="settings-note">No approved memories found.</p>
        ) : (
          <ul className="memory-list">
            {memories.map((memory) => (
              <li key={memory.id}>
                <label className="sr-only" htmlFor={`memory-${memory.id}`}>
                  Edit memory
                </label>
                <textarea
                  id={`memory-${memory.id}`}
                  maxLength={2000}
                  onChange={(event) => {
                    const content = event.target.value;
                    if (editSimilarWarning?.memoryId === memory.id) {
                      setEditSimilarWarning(null);
                    }
                    setMemories((current) =>
                      current.map((item) =>
                        item.id === memory.id ? { ...item, content } : item,
                      ),
                    );
                  }}
                  rows={2}
                  value={memory.content}
                />
                <label className="importance-control">
                  Importance
                  <select
                    aria-label={`Importance for memory ${memory.id}`}
                    onChange={(event) => {
                      const importance = Number(event.target.value);
                      setMemories((current) =>
                        current.map((item) =>
                          item.id === memory.id ? { ...item, importance } : item,
                        ),
                      );
                    }}
                    value={memory.importance}
                  >
                    <option value={1}>1 — Low</option>
                    <option value={2}>2</option>
                    <option value={3}>3 — Normal</option>
                    <option value={4}>4</option>
                    <option value={5}>5 — High</option>
                  </select>
                </label>
                <div className="memory-actions">
                  <button
                    disabled={!memory.content.trim() || memorySaving}
                    onClick={() =>
                      void updateMemory(
                        memory.id,
                        memory.content,
                        memory.importance,
                        editSimilarWarning?.memoryId === memory.id,
                      )
                    }
                    type="button"
                  >
                    {editSimilarWarning?.memoryId === memory.id
                      ? "Save anyway"
                      : "Save changes"}
                  </button>
                  <button
                    className="danger-button"
                    onClick={() => void deleteMemory(memory.id)}
                    type="button"
                  >
                    Delete
                  </button>
                </div>
                {editSimilarWarning?.memoryId === memory.id && (
                  <div className="similar-memory-warning" role="alert">
                    <p>Similar approved memories found. Review before updating.</p>
                    <ul>
                      {editSimilarWarning.matches.map((match) => (
                        <li key={match.id}>{match.content}</li>
                      ))}
                    </ul>
                    <button
                      onClick={() => setEditSimilarWarning(null)}
                      type="button"
                    >
                      Cancel
                    </button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
        <div className="suggestion-panel">
          <h3>Pending suggestions</h3>
          <p className="settings-note">
            Recurring-preference suggestions come from repeated explicit
            statements. Suggestions are separate from personality settings and
            approved memories; nothing becomes a memory unless you approve it.
          </p>
          <button
            disabled={!conversationId || suggestionBusy}
            onClick={() => void suggestFromConversation()}
            type="button"
          >
            {suggestionBusy ? "Reviewing conversation…" : "Suggest from current conversation"}
          </button>
          <button
            disabled={!conversationId || !personalizationEnabled || suggestionBusy}
            onClick={() => void suggestRecurringPreferences()}
            type="button"
          >
            {suggestionBusy ? "Checking recent history…" : "Suggest recurring preferences"}
          </button>
          {!personalizationEnabled && (
            <p className="settings-note">
              Enable personalization to analyze recent messages for preferences.
            </p>
          )}
          {suggestionError && <p className="settings-error" role="alert">{suggestionError}</p>}
          {conversationId && suggestions.length === 0 && (
            <p className="settings-note">No pending suggestions.</p>
          )}
          {suggestions.map((suggestion) => (
            <div className="memory-suggestion" key={suggestion.id}>
              <p>{suggestion.content}</p>
              <label className="importance-control">
                Importance
                <select
                  aria-label={`Importance for suggestion ${suggestion.id}`}
                  onChange={(event) => {
                    const importance = Number(event.target.value);
                    setSuggestions((current) =>
                      current.map((item) =>
                        item.id === suggestion.id ? { ...item, importance } : item,
                      ),
                    );
                  }}
                  value={suggestion.importance}
                >
                  <option value={1}>1 — Low</option>
                  <option value={2}>2</option>
                  <option value={3}>3 — Normal</option>
                  <option value={4}>4</option>
                  <option value={5}>5 — High</option>
                </select>
              </label>
              <div className="memory-actions">
                <button
                  disabled={suggestionBusy}
                  onClick={() =>
                    void approveSuggestion(
                      suggestion,
                      Boolean(suggestionWarnings[suggestion.id]),
                    )
                  }
                  type="button"
                >
                  {suggestionWarnings[suggestion.id]
                    ? "Approve anyway"
                    : "Approve memory"}
                </button>
                <button
                  disabled={suggestionBusy}
                  onClick={() => void dismissSuggestion(suggestion.id)}
                  type="button"
                >
                  Dismiss
                </button>
              </div>
              {suggestionWarnings[suggestion.id] && (
                <div className="similar-memory-warning" role="alert">
                  <p>Similar approved memories found. Review before approval.</p>
                  <ul>
                    {suggestionWarnings[suggestion.id].map((match) => (
                      <li key={match.id}>{match.content}</li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          ))}
        </div>
      </details>
      {status && <p className="settings-status" role="status">{status}</p>}
    </div>
  );
}

export default MemorySettings;
