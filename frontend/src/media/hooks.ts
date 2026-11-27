import { useCallback, useEffect, useState } from "react";

import type { AvatarState, MediaApi, MyVoiceState } from "./api";

export const AVATAR_POLL_MS = 1000;

/** Your photo avatar: its state from the server, polled while it is being created. */
export function useAvatar(
  api: Pick<MediaApi, "avatar" | "uploadAvatar" | "deleteAvatar">,
  pollMs = AVATAR_POLL_MS,
) {
  const [avatar, setAvatar] = useState<AvatarState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setAvatar(await api.avatar());
    } catch {
      setAvatar(null); // server without avatars, or not reachable yet
    }
  }, [api]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const rendering = avatar?.status === "rendering";
  useEffect(() => {
    if (!rendering) return;
    const timer = setInterval(() => void refresh(), pollMs);
    return () => clearInterval(timer);
  }, [rendering, refresh, pollMs]);

  const run = useCallback(
    async (action: () => Promise<unknown>, fallback: string) => {
      setBusy(true);
      setError(null);
      try {
        await action();
      } catch (e) {
        setError(e instanceof Error ? e.message : fallback);
      } finally {
        setBusy(false);
        await refresh();
      }
    },
    [refresh],
  );

  const upload = useCallback(
    (photo: Blob) => run(() => api.uploadAvatar(photo), "Could not upload the photo."),
    [api, run],
  );
  const remove = useCallback(
    () => run(() => api.deleteAvatar(), "Could not remove the avatar."),
    [api, run],
  );

  return { avatar, error, busy, upload, remove };
}

type VoiceApi = Pick<
  MediaApi,
  "myVoice" | "addVoiceSample" | "deleteVoiceSample" | "updateMyVoice" | "clearMyVoice"
>;

/** Your own voice: recordings, readiness and the on/off switch. */
export function useMyVoice(api: VoiceApi) {
  const [myVoice, setMyVoice] = useState<MyVoiceState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setMyVoice(await api.myVoice());
    } catch {
      setMyVoice(null); // server without this feature
    }
  }, [api]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const run = useCallback(
    async (action: () => Promise<MyVoiceState | void>, fallback: string) => {
      setBusy(true);
      setError(null);
      try {
        const state = await action();
        if (state) setMyVoice(state);
        else await refresh();
      } catch (e) {
        setError(e instanceof Error ? e.message : fallback);
      } finally {
        setBusy(false);
      }
    },
    [refresh],
  );

  /** Adds recordings one after another; stops at the first one that is refused. */
  const add = useCallback(
    (recordings: Blob[]) =>
      run(async () => {
        let state: MyVoiceState | undefined;
        for (const recording of recordings) state = await api.addVoiceSample(recording);
        return state;
      }, "Could not add the recording."),
    [api, run],
  );
  const remove = useCallback(
    (name: string) => run(() => api.deleteVoiceSample(name), "Could not remove it."),
    [api, run],
  );
  const setEnabled = useCallback(
    (enabled: boolean) => run(() => api.updateMyVoice({ enabled }), "Could not switch the voice."),
    [api, run],
  );
  const clear = useCallback(
    () => run(() => api.clearMyVoice(), "Could not remove the recordings."),
    [api, run],
  );

  return { myVoice, error, busy, add, remove, setEnabled, clear };
}
