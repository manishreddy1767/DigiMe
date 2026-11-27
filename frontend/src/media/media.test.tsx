import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import App from "../App";
import type { AvatarState, MyVoiceState } from "./api";
import AvatarSettings from "./AvatarSettings";
import { FaceAnimator, frameName, pickFrame } from "./face";
import MyVoiceSettings from "./MyVoiceSettings";
import VoicePicker from "./VoicePicker";

vi.mock("../avatar/AvatarView", () => ({
  default: () => <div data-testid="default-avatar" />,
}));

function jsonResponse(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

const NO_AVATAR: AvatarState = {
  status: "none",
  progress: null,
  error: null,
  unavailable: null,
  avatar: null,
};

const PHOTO_AVATAR: AvatarState = {
  ...NO_AVATAR,
  status: "ready",
  avatar: { width: 8, height: 10, frames: ["neutral-open-rest.jpg"], version: 7 },
};

function myVoiceState(overrides: Partial<MyVoiceState> = {}): MyVoiceState {
  return {
    status: "none",
    samples: [],
    seconds: 0,
    min_seconds: 10,
    recommended_seconds: 60,
    max_samples: 40,
    enabled: false,
    unavailable: null,
    ...overrides,
  };
}

function installAppFetch(avatar: AvatarState) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    const method = init?.method ?? "GET";
    if (path === "/api/avatar") return jsonResponse(avatar);
    if (path === "/api/my-voice") return jsonResponse(myVoiceState());
    if (path === "/api/status") {
      return jsonResponse({
        assistant_name: "Digital Me",
        model: "llama3.2:3b",
        deep_reasoning: false,
        ollama_reachable: true,
        model_available: true,
      });
    }
    if (path === "/api/conversations" && method === "GET") return jsonResponse([]);
    if (path === "/api/profile") {
      return jsonResponse({ name: "", about: "", preferences: "", updated_at: "" });
    }
    if (path === "/api/personality") {
      return jsonResponse({
        name: "Digital Me",
        communication_style: "friendly",
        response_length: "balanced",
        custom_instructions: "",
        deep_reasoning: false,
        updated_at: "",
      });
    }
    if (path === "/api/voice-settings") {
      return jsonResponse({
        auto_play_responses: false,
        continuous_conversation_enabled: false,
        voice: "af_heart",
        updated_at: "",
      });
    }
    if (path === "/api/personalization/settings") {
      return jsonResponse({ enabled: true, updated_at: "" });
    }
    if (path.startsWith("/api/personalization/") || path.startsWith("/api/memories")) {
      return jsonResponse([]);
    }
    throw new Error(`Unexpected request: ${method} ${path}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("which avatar is shown", () => {
  it("keeps the default 3D avatar until a photo avatar exists", async () => {
    installAppFetch(NO_AVATAR);
    render(<App />);

    expect(screen.getByTestId("default-avatar")).toBeTruthy();
    await waitFor(() => expect(screen.queryByTestId("photo-avatar")).toBeNull());
  });

  it("shows your photo avatar once it has been created", async () => {
    installAppFetch(PHOTO_AVATAR);
    render(<App />);

    expect(await screen.findByTestId("photo-avatar")).toBeTruthy();
    expect(screen.queryByTestId("default-avatar")).toBeNull();
    expect(screen.getByText("Your photo avatar")).toBeTruthy();
  });

  it("puts your avatar and your voice in the Context drawer", async () => {
    installAppFetch(NO_AVATAR);
    render(<App />);

    fireEvent.click(screen.getByRole("button", { name: "Context" }));
    const context = screen.getByRole("complementary", { name: "Context" });

    expect(await within(context).findByRole("region", { name: "Your avatar" })).toBeTruthy();
    expect(within(context).getByRole("region", { name: "Your voice" })).toBeTruthy();
    expect(within(context).getByRole("combobox", { name: "Built-in voice" })).toBeTruthy();
    expect(await within(context).findByRole("region", { name: "Your own voice" })).toBeTruthy();
  });
});

describe("your avatar settings", () => {
  const frameUrl = (name: string, version: number) => `/frames/${name}?v=${version}`;

  it("adds a photo, and going back to the default needs confirmation", () => {
    const onUpload = vi.fn();
    const onRemove = vi.fn();
    const { rerender } = render(
      <AvatarSettings
        avatar={NO_AVATAR}
        busy={false}
        error={null}
        frameUrl={frameUrl}
        onRemove={onRemove}
        onUpload={onUpload}
      />,
    );

    expect(screen.getByText(/Using the default 3D avatar/)).toBeTruthy();
    const photo = new File(["jpeg"], "me.jpg", { type: "image/jpeg" });
    fireEvent.change(screen.getByLabelText("Avatar photo"), { target: { files: [photo] } });
    expect(onUpload).toHaveBeenCalledWith(photo);

    rerender(
      <AvatarSettings
        avatar={PHOTO_AVATAR}
        busy={false}
        error={null}
        frameUrl={frameUrl}
        onRemove={onRemove}
        onUpload={onUpload}
      />,
    );
    expect(screen.getByRole("img", { name: "Current avatar" }).getAttribute("src")).toBe(
      "/frames/neutral-open-rest.jpg?v=7",
    );
    fireEvent.click(screen.getByRole("button", { name: "Remove photo avatar" }));
    expect(onRemove).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Use the default avatar?" }));
    expect(onRemove).toHaveBeenCalledTimes(1);
  });

  it("shows progress while the avatar is being created and explains a missing install", () => {
    const props = { busy: false, error: null, frameUrl, onRemove: vi.fn(), onUpload: vi.fn() };
    const { rerender } = render(
      <AvatarSettings
        {...props}
        avatar={{ ...NO_AVATAR, status: "rendering", progress: { done: 36, total: 72 } }}
      />,
    );
    expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe("50");

    rerender(
      <AvatarSettings {...props} avatar={{ ...NO_AVATAR, unavailable: "LivePortrait is not installed" }} />,
    );
    expect(screen.getByText("LivePortrait is not installed")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Add your photo" })).toBeNull();
  });
});

describe("choosing a voice", () => {
  it("saves the chosen built-in voice and previews it", async () => {
    const fetchMock = vi.fn(async (_path: string, _init?: RequestInit) => jsonResponse({}));
    vi.stubGlobal("fetch", fetchMock);
    const play = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal(
      "Audio",
      class {
        play = play;
        pause = vi.fn();
      },
    );
    vi.stubGlobal("URL", { ...URL, createObjectURL: vi.fn(() => "blob:preview") });
    const onSaved = vi.fn();
    const preview = vi.fn().mockResolvedValue(new Blob(["wav"]));
    const settings = {
      auto_play_responses: true,
      continuous_conversation_enabled: false,
      voice: "af_heart" as const,
      updated_at: "",
    };
    render(<VoicePicker onSaved={onSaved} preview={preview} settings={settings} />);

    fireEvent.change(screen.getByRole("combobox", { name: "Built-in voice" }), {
      target: { value: "am_michael" },
    });
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith({ ...settings, voice: "am_michael" }));
    expect(JSON.parse(fetchMock.mock.calls[0][1]?.body as string)).toEqual({
      auto_play_responses: true,
      continuous_conversation_enabled: false,
      voice: "am_michael",
    });

    fireEvent.click(screen.getByRole("button", { name: "Preview" }));
    await waitFor(() => expect(play).toHaveBeenCalled());
    expect(preview).toHaveBeenCalledWith("af_heart");
  });
});

describe("your own voice", () => {
  const baseProps = {
    busy: false,
    error: null,
    sampleUrl: (name: string) => `/samples/${name}`,
    onAdd: vi.fn(),
    onRemove: vi.fn(),
    onEnable: vi.fn(),
    onClear: vi.fn(),
    onPreview: vi.fn(),
  };

  it("records a line and sends it to be learnt", async () => {
    const recording = new Blob(["speech"], { type: "audio/webm" });
    const stop = vi.fn().mockResolvedValue(recording);
    const startRecording = vi.fn().mockResolvedValue({ stop, cancel: vi.fn() });
    const onAdd = vi.fn();
    render(
      <MyVoiceSettings
        {...baseProps}
        myVoice={myVoiceState()}
        onAdd={onAdd}
        startRecording={startRecording}
      />,
    );

    expect(screen.getByRole("switch", { name: /Speak in my voice/ })).toHaveProperty("disabled", true);
    fireEvent.click(screen.getByRole("button", { name: "Record this line" }));
    fireEvent.click(await screen.findByRole("button", { name: /Stop/ }));

    await waitFor(() => expect(onAdd).toHaveBeenCalledWith([recording]));
    expect(screen.getByText("2 / 9")).toBeTruthy();
  });

  it("switches replies to your voice once it is ready", () => {
    const onEnable = vi.fn();
    render(
      <MyVoiceSettings
        {...baseProps}
        myVoice={myVoiceState({
          status: "ready",
          seconds: 12,
          samples: [
            { name: "001.wav", seconds: 6 },
            { name: "002.wav", seconds: 6 },
          ],
        })}
        onEnable={onEnable}
        startRecording={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("switch", { name: /Speak in my voice/ }));

    expect(onEnable).toHaveBeenCalledWith(true);
    expect(screen.getByText("Recording 2 · 6s")).toBeTruthy();
  });

  it("explains when voice cloning is not installed", () => {
    render(
      <MyVoiceSettings
        {...baseProps}
        myVoice={myVoiceState({ unavailable: "OpenVoice is not installed" })}
        startRecording={vi.fn()}
      />,
    );

    expect(screen.getByText("OpenVoice is not installed")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Record this line" })).toBeNull();
  });
});

describe("face animator", () => {
  it("maps reply emotions to rendered expressions and opens the mouth with loudness", () => {
    const face = new FaceAnimator(() => 0.99);

    expect(face.step(0, { speaking: false, level: 0, emotion: "sad" }).expression).toBe("concerned");
    expect(face.step(100, { speaking: false, level: 0, emotion: "curious" }).expression).toBe(
      "surprised",
    );
    expect(face.step(200, { speaking: true, level: 0.9, emotion: "happy" }).mouth).not.toBe("rest");
  });

  it("falls back to the closest frame the avatar has", () => {
    const available = new Set([frameName({ expression: "neutral", eyes: "open", mouth: "open2" })]);

    expect(pickFrame({ expression: "happy", eyes: "closed", mouth: "open2" }, available)).toBe(
      "neutral-open-open2.jpg",
    );
  });
});
