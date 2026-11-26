import { useCallback, useState } from "react";
import AvatarView from "./avatar/AvatarView";

function App() {
  const [avatarLoaded, setAvatarLoaded] = useState(false);
  const [avatarError, setAvatarError] = useState<string | null>(null);

  const handleAvatarLoaded = useCallback(() => {
    setAvatarLoaded(true);
    setAvatarError(null);
  }, []);

  const handleAvatarError = useCallback((message: string) => {
    setAvatarLoaded(false);
    setAvatarError(message);
  }, []);

  return (
    <main className="shell">
      <header className="header">
        <div>
          <p className="eyebrow">LOCAL FEASIBILITY CHECK</p>
          <h1>Digital Me</h1>
        </div>
        <span className="privacy-badge">Local-only foundation</span>
      </header>

      <section className="workspace" aria-label="Avatar rendering check">
        <div className="avatar-panel">
          <AvatarView
            onLoaded={handleAvatarLoaded}
            onError={handleAvatarError}
          />
          <div className="avatar-status" role="status">
            <span className={`status-dot ${avatarLoaded ? "ready" : ""}`} />
            {avatarError ?? (avatarLoaded ? "VRM loaded locally" : "Loading local VRM…")}
          </div>
        </div>

        <aside className="details">
          <p className="eyebrow">FOUNDATION MILESTONE</p>
          <h2>Hardware checks, one component at a time.</h2>
          <p>
            This page verifies local VRM rendering. Run the separate backend
            commands to measure Qwen3 4B generation and CPU speech processing.
          </p>
          <ul>
            <li><span className={avatarLoaded ? "check ready" : "check"} />VRM renderer</li>
            <li><span className="check" />Ollama / Qwen3 4B — run backend check</li>
            <li><span className="check" />CPU STT and TTS — run backend checks</li>
          </ul>
          <p className="scope-note">
            No microphone, chat, identity data, or conversation memory is active.
          </p>
        </aside>
      </section>
    </main>
  );
}

export default App;
