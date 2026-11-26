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
  created_at: string;
  updated_at: string;
};

async function readResponse<T>(response: Response): Promise<T> {
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

function getErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

function MemorySettings() {
  const [profile, setProfile] = useState<UserProfile>({
    name: "",
    about: "",
    preferences: "",
    updated_at: "",
  });
  const [memories, setMemories] = useState<Memory[]>([]);
  const [memorySearch, setMemorySearch] = useState("");
  const [newMemory, setNewMemory] = useState("");
  const [profileError, setProfileError] = useState<string | null>(null);
  const [memoryError, setMemoryError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [profileSaving, setProfileSaving] = useState(false);
  const [memorySaving, setMemorySaving] = useState(false);

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

  const saveMemory = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const content = newMemory.trim();
    if (!content || memorySaving) return;
    setMemorySaving(true);
    setMemoryError(null);
    setStatus(null);
    try {
      const response = await fetch("/api/memories", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content }),
      });
      const saved = await readResponse<Memory>(response);
      setMemories((current) => [saved, ...current]);
      setNewMemory("");
      setStatus("Memory saved with your approval.");
    } catch (error) {
      setMemoryError(getErrorMessage(error, "Could not save the approved memory."));
    } finally {
      setMemorySaving(false);
    }
  };

  const updateMemory = async (memoryId: string, content: string) => {
    setMemoryError(null);
    setStatus(null);
    try {
      const response = await fetch(`/api/memories/${encodeURIComponent(memoryId)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content }),
      });
      const updated = await readResponse<Memory>(response);
      setMemories((current) =>
        current.map((memory) => memory.id === memoryId ? updated : memory),
      );
      setStatus("Memory updated.");
    } catch (error) {
      setMemoryError(getErrorMessage(error, "Could not update the memory."));
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
            onChange={(event) => setNewMemory(event.target.value)}
            placeholder="Enter a fact you want Digital Me to remember…"
            rows={2}
            value={newMemory}
          />
          <button disabled={memorySaving || !newMemory.trim()} type="submit">
            {memorySaving ? "Saving memory…" : "Save approved memory"}
          </button>
        </form>
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
                    setMemories((current) =>
                      current.map((item) =>
                        item.id === memory.id ? { ...item, content } : item,
                      ),
                    );
                  }}
                  rows={2}
                  value={memory.content}
                />
                <div className="memory-actions">
                  <button
                    disabled={!memory.content.trim()}
                    onClick={() => void updateMemory(memory.id, memory.content)}
                    type="button"
                  >
                    Save changes
                  </button>
                  <button
                    className="danger-button"
                    onClick={() => void deleteMemory(memory.id)}
                    type="button"
                  >
                    Delete
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </details>
      {status && <p className="settings-status" role="status">{status}</p>}
    </div>
  );
}

export default MemorySettings;
