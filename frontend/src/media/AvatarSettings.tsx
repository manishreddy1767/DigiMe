import { ImagePlus, Loader2, Trash2, UserRound } from "lucide-react";
import { useRef, useState } from "react";

import type { AvatarState } from "./api";

type AvatarSettingsProps = {
  avatar: AvatarState | null;
  error: string | null;
  busy: boolean;
  frameUrl: (name: string, version: number) => string;
  onUpload: (photo: File) => void;
  onRemove: () => void;
};

const PREVIEW = "neutral-open-rest.jpg";

/** The "Your avatar" section of the Context drawer. The 3D avatar is the default. */
function AvatarSettings({ avatar, error, busy, frameUrl, onUpload, onRemove }: AvatarSettingsProps) {
  const input = useRef<HTMLInputElement>(null);
  const [confirming, setConfirming] = useState(false);
  if (!avatar) return null; // this server has no avatar support

  const rendering = avatar.status === "rendering";
  const current = avatar.avatar;
  const message = error ?? (avatar.status === "error" ? avatar.error : null);
  const choose = () => input.current?.click();

  return (
    <section aria-label="Your avatar" className="avatar-settings">
      <h3>Your avatar</h3>
      <div className="avatar-settings__row">
        <div className="avatar-settings__preview">
          {current && current.frames.includes(PREVIEW) ? (
            <img alt="Current avatar" src={frameUrl(PREVIEW, current.version)} />
          ) : (
            <UserRound aria-hidden="true" size={22} />
          )}
        </div>
        <div className="avatar-settings__body">
          <p className="voice-panel__note">
            {current
              ? "Your photo is the avatar."
              : "Using the default 3D avatar. Add a photo to use your own face instead."}
          </p>
          {rendering ? (
            <Progress done={avatar.progress?.done ?? 0} total={avatar.progress?.total ?? 1} />
          ) : avatar.unavailable ? (
            <p className="voice-panel__note">{avatar.unavailable}</p>
          ) : (
            <div className="avatar-settings__actions">
              <button className="preview-button" disabled={busy} onClick={choose} type="button">
                {busy ? (
                  <Loader2 aria-hidden="true" className="spin" size={16} />
                ) : (
                  <ImagePlus aria-hidden="true" size={16} />
                )}
                {current ? "Change photo" : "Add your photo"}
              </button>
              {current &&
                (confirming ? (
                  <button
                    className="danger-button"
                    onClick={() => {
                      setConfirming(false);
                      onRemove();
                    }}
                    type="button"
                  >
                    Use the default avatar?
                  </button>
                ) : (
                  <button
                    aria-label="Remove photo avatar"
                    className="icon-button icon-button--subtle"
                    onClick={() => setConfirming(true)}
                    title="Go back to the default avatar"
                    type="button"
                  >
                    <Trash2 aria-hidden="true" size={16} />
                  </button>
                ))}
            </div>
          )}
        </div>
      </div>
      {message && (
        <p className="drawer__error" role="alert">
          {message}
        </p>
      )}
      {!current && !rendering && !avatar.unavailable && (
        <p className="voice-panel__note">
          Use one clear photo facing the camera, in good light, with your face fairly large in the
          frame. It stays on this computer and is saved without its location or camera details.
        </p>
      )}
      {rendering && (
        <p className="voice-panel__note">
          This takes about a minute. Replies may be slower until it is done.
        </p>
      )}
      <input
        accept="image/jpeg,image/png,image/webp"
        aria-label="Avatar photo"
        hidden
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = ""; // choosing the same file again still triggers a change
          if (file) onUpload(file);
        }}
        ref={input}
        type="file"
      />
    </section>
  );
}

function Progress({ done, total }: { done: number; total: number }) {
  const percent = Math.round((100 * done) / Math.max(total, 1));
  return (
    <div className="avatar-settings__progress">
      <span>Creating your avatar… {percent}%</span>
      <div
        aria-label="Creating your avatar"
        aria-valuemax={100}
        aria-valuemin={0}
        aria-valuenow={percent}
        role="progressbar"
      >
        <div style={{ width: `${percent}%` }} />
      </div>
    </div>
  );
}

export default AvatarSettings;
