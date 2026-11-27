import {
  History,
  SlidersHorizontal,
  SquarePen,
  UserRound,
  Volume2,
  VolumeX,
} from "lucide-react";

export type AppStatus = {
  assistant_name: string;
  model: string;
  deep_reasoning: boolean;
  ollama_reachable: boolean;
  model_available: boolean;
};

export function initials(name: string): string {
  const letters = name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => word[0]?.toUpperCase() ?? "");
  return letters.join("") || "AI";
}

export function modelHealth(status: AppStatus | null, unreachable: boolean) {
  if (unreachable) return { level: "down", text: "Server offline" } as const;
  if (!status) return { level: "pending", text: "Checking…" } as const;
  if (!status.ollama_reachable) return { level: "down", text: "Ollama not running" } as const;
  if (!status.model_available) {
    return { level: "warn", text: `${status.model} not installed` } as const;
  }
  return {
    level: "ok",
    text: `${status.model}${status.deep_reasoning ? " · deep reasoning" : ""} · on this PC`,
  } as const;
}

type TopBarProps = {
  name: string;
  status: AppStatus | null;
  serverUnreachable: boolean;
  spokenReplies: boolean;
  newConversationDisabled: boolean;
  onToggleSpokenReplies: () => void;
  onOpenContext: () => void;
  onOpenVoice: () => void;
  onOpenHistory: () => void;
  onNewConversation: () => void;
};

function TopBar({
  name,
  status,
  serverUnreachable,
  spokenReplies,
  newConversationDisabled,
  onToggleSpokenReplies,
  onOpenContext,
  onOpenVoice,
  onOpenHistory,
  onNewConversation,
}: TopBarProps) {
  const health = modelHealth(status, serverUnreachable);
  return (
    <header className="topbar">
      <div className="identity">
        <div aria-hidden="true" className="identity__avatar">
          {initials(name)}
        </div>
        <div className="identity__text">
          <h1 className="identity__name">{name}</h1>
          <p className="identity__disclosure">AI assistant · runs on this computer</p>
        </div>
      </div>
      <div className="topbar__actions">
        <span className={`health health--${health.level}`} data-testid="model-health">
          <span aria-hidden="true" className="health__dot" />
          {health.text}
        </span>
        <button className="text-icon-button" onClick={onOpenContext} type="button">
          <UserRound aria-hidden="true" size={16} />
          Context
        </button>
        <button
          aria-label={spokenReplies ? "Mute spoken replies" : "Speak replies aloud"}
          aria-pressed={spokenReplies}
          className={`icon-button ${spokenReplies ? "" : "icon-button--off"}`}
          onClick={onToggleSpokenReplies}
          title={spokenReplies ? "Replies are spoken aloud" : "Replies are not spoken"}
          type="button"
        >
          {spokenReplies ? (
            <Volume2 aria-hidden="true" size={18} />
          ) : (
            <VolumeX aria-hidden="true" size={18} />
          )}
        </button>
        <button
          aria-label="Open voice settings"
          className="icon-button"
          onClick={onOpenVoice}
          title="Voice settings"
          type="button"
        >
          <SlidersHorizontal aria-hidden="true" size={18} />
        </button>
        <button
          aria-label="Conversation history"
          className="icon-button"
          onClick={onOpenHistory}
          title="Conversation history"
          type="button"
        >
          <History aria-hidden="true" size={18} />
        </button>
        <button
          aria-label="New conversation"
          className="icon-button"
          disabled={newConversationDisabled}
          onClick={onNewConversation}
          title="New conversation"
          type="button"
        >
          <SquarePen aria-hidden="true" size={18} />
        </button>
      </div>
    </header>
  );
}

export default TopBar;
