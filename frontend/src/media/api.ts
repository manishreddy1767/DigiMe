/** The local avatar and own-voice API (see backend/app/media.py). */

export type AvatarManifest = {
  width: number;
  height: number;
  frames: string[];
  version: number;
};

export type AvatarState = {
  status: "none" | "rendering" | "ready" | "error";
  progress: { done: number; total: number } | null;
  error: string | null;
  /** Why avatars can't be created on this computer, if they can't. */
  unavailable: string | null;
  /** The current photo avatar; kept while a new one is being created. */
  avatar: AvatarManifest | null;
};

export type VoiceSample = {
  name: string;
  seconds: number;
};

export type MyVoiceState = {
  status: "none" | "collecting" | "ready";
  samples: VoiceSample[];
  seconds: number;
  min_seconds: number;
  recommended_seconds: number;
  max_samples: number;
  /** Replies are spoken in your own voice. */
  enabled: boolean;
  /** Why your voice can't be learnt on this computer, if it can't. */
  unavailable: string | null;
};

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init);
  if (!response.ok) {
    let detail = `Request failed (${response.status}).`;
    try {
      const body: unknown = await response.json();
      if (typeof body === "object" && body !== null && "detail" in body && typeof body.detail === "string") {
        detail = body.detail;
      }
    } catch {
      // keep the generic message
    }
    throw new Error(detail);
  }
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

export const mediaApi = {
  avatar: () => request<AvatarState>("/api/avatar"),
  uploadAvatar: (photo: Blob) =>
    request<AvatarState>("/api/avatar", {
      method: "PUT",
      headers: { "Content-Type": photo.type || "image/jpeg" },
      body: photo,
    }),
  deleteAvatar: () => request<void>("/api/avatar", { method: "DELETE" }),
  myVoice: () => request<MyVoiceState>("/api/my-voice"),
  addVoiceSample: (recording: Blob) =>
    request<MyVoiceState>("/api/my-voice/samples", {
      method: "POST",
      headers: { "Content-Type": recording.type || "audio/wav" },
      body: recording,
    }),
  deleteVoiceSample: (name: string) =>
    request<MyVoiceState>(`/api/my-voice/samples/${encodeURIComponent(name)}`, { method: "DELETE" }),
  updateMyVoice: (change: { enabled: boolean }) =>
    request<MyVoiceState>("/api/my-voice", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(change),
    }),
  clearMyVoice: () => request<void>("/api/my-voice", { method: "DELETE" }),
  previewVoice: async (voice: string, myVoice = false): Promise<Blob> => {
    const response = await fetch("/api/voice/preview", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ voice, my_voice: myVoice }),
    });
    if (!response.ok) throw new Error("Could not preview the voice.");
    return response.blob();
  },
};

export type MediaApi = typeof mediaApi;

export function avatarFrameUrl(name: string, version: number): string {
  return `/api/avatar/frames/${encodeURIComponent(name)}?v=${version}`;
}

export function voiceSampleUrl(name: string): string {
  return `/api/my-voice/samples/${encodeURIComponent(name)}`;
}
