import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App";

vi.mock("./avatar/AvatarView", () => ({
  default: ({ state }: { state: string }) => (
    <div aria-label="Avatar test placeholder" data-avatar-state={state} data-testid="avatar" />
  ),
}));

function jsonResponse(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

function audioResponse() {
  return {
    ok: true,
    status: 200,
    blob: async () => new Blob(["mock speech"], { type: "audio/wav" }),
  };
}

function mockMicrophone(
  recording = new Blob(["captured speech"], { type: "audio/webm" }),
  permissionError?: Error,
) {
  const track = { stop: vi.fn() };
  const stream = { getTracks: () => [track] };
  const getUserMedia = permissionError
    ? vi.fn().mockRejectedValue(permissionError)
    : vi.fn().mockResolvedValue(stream);
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: { getUserMedia },
  });

  let recorder: MockMediaRecorder | null = null;
  class MockMediaRecorder {
    state: RecordingState = "inactive";
    mimeType = "audio/webm;codecs=opus";
    ondataavailable: ((event: BlobEvent) => void) | null = null;
    onstop: ((event: Event) => void) | null = null;
    onerror: ((event: Event) => void) | null = null;

    constructor() {
      recorder = this;
    }

    start() {
      this.state = "recording";
    }

    stop() {
      if (this.state === "inactive") return;
      this.state = "inactive";
      this.ondataavailable?.({ data: recording } as BlobEvent);
      this.onstop?.(new Event("stop"));
    }
  }
  vi.stubGlobal("MediaRecorder", MockMediaRecorder);

  return { getUserMedia, track, getRecorder: () => recorder };
}

const originalCreateObjectURL = URL.createObjectURL;
const originalRevokeObjectURL = URL.revokeObjectURL;
const originalMediaDevices = Object.getOwnPropertyDescriptor(navigator, "mediaDevices");

beforeEach(() => {
  Object.defineProperty(URL, "createObjectURL", {
    configurable: true,
    value: vi.fn(() => "blob:mock-speech"),
  });
  Object.defineProperty(URL, "revokeObjectURL", {
    configurable: true,
    value: vi.fn(),
  });
  vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => undefined);
  vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(function (
    this: HTMLMediaElement,
  ) {
    Object.defineProperty(this, "paused", { configurable: true, value: false });
    fireEvent.play(this);
    return Promise.resolve();
  });
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(function (
    this: HTMLMediaElement,
  ) {
    Object.defineProperty(this, "paused", { configurable: true, value: true });
    fireEvent.pause(this);
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  if (originalCreateObjectURL) {
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      value: originalCreateObjectURL,
    });
  } else {
    Reflect.deleteProperty(URL, "createObjectURL");
  }
  if (originalRevokeObjectURL) {
    Object.defineProperty(URL, "revokeObjectURL", {
      configurable: true,
      value: originalRevokeObjectURL,
    });
  } else {
    Reflect.deleteProperty(URL, "revokeObjectURL");
  }
  if (originalMediaDevices) {
    Object.defineProperty(navigator, "mediaDevices", originalMediaDevices);
  } else {
    Reflect.deleteProperty(navigator, "mediaDevices");
  }
});

describe("chat interface", () => {
  it("sends a message, shows the reply and includes it in follow-up context", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ message: "Hello from mocked Ollama." }))
      .mockResolvedValueOnce(jsonResponse({ message: "A contextual follow-up." }));
    vi.stubGlobal("fetch", fetchMock);
    render(<App />);

    expect(screen.getByTestId("avatar").getAttribute("data-avatar-state")).toBe("idle");
    const input = screen.getByRole("textbox", { name: "Message" });
    fireEvent.change(input, { target: { value: "Hello" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    expect(screen.getByTestId("avatar").getAttribute("data-avatar-state")).toBe("thinking");
    expect(await screen.findByText("Hello from mocked Ollama.")).toBeTruthy();
    expect(screen.getByTestId("avatar").getAttribute("data-avatar-state")).toBe("idle");
    fireEvent.change(input, { target: { value: "Continue" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    expect(await screen.findByText("A contextual follow-up.")).toBeTruthy();
    expect(screen.getByTestId("avatar").getAttribute("data-avatar-state")).toBe("idle");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const secondRequest = JSON.parse(fetchMock.mock.calls[1][1].body as string);
    expect(secondRequest.messages).toEqual([
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Hello from mocked Ollama." },
      { role: "user", content: "Continue" },
    ]);
  });

  it("shows loading state, and a new conversation ignores an in-flight reply", async () => {
    let resolveRequest!: (response: ReturnType<typeof jsonResponse>) => void;
    const fetchMock = vi.fn().mockReturnValue(
      new Promise<ReturnType<typeof jsonResponse>>((resolve) => {
        resolveRequest = resolve;
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    render(<App />);

    fireEvent.change(screen.getByRole("textbox", { name: "Message" }), {
      target: { value: "Pending question" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    expect(screen.getByText("Digital Me is thinking…")).toBeTruthy();
    expect(screen.getByTestId("avatar").getAttribute("data-avatar-state")).toBe("thinking");
    fireEvent.click(screen.getByRole("button", { name: "New conversation" }));
    expect(screen.getByText("Send a message to start a conversation.")).toBeTruthy();
    expect(screen.getByTestId("avatar").getAttribute("data-avatar-state")).toBe("idle");

    await act(async () => {
      resolveRequest(jsonResponse({ message: "Stale response" }));
    });
    expect(screen.queryByText("Stale response")).toBeNull();
  });

  it("shows backend errors without losing the user's message", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({ detail: "Ollama is not available." }, 502),
    );
    vi.stubGlobal("fetch", fetchMock);
    render(<App />);

    fireEvent.change(screen.getByRole("textbox", { name: "Message" }), {
      target: { value: "Are you there?" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    expect(await screen.findByRole("alert")).toHaveProperty(
      "textContent",
      "Ollama is not available.",
    );
    expect(screen.getByText("Are you there?")).toBeTruthy();
  });

  it("generates local speech and maps playback controls to avatar state", async () => {
    let resolveSpeech!: (response: ReturnType<typeof audioResponse>) => void;
    const pendingSpeech = new Promise<ReturnType<typeof audioResponse>>((resolve) => {
      resolveSpeech = resolve;
    });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ message: "A local spoken reply." }))
      .mockReturnValueOnce(pendingSpeech);
    vi.stubGlobal("fetch", fetchMock);
    render(<App />);

    fireEvent.change(screen.getByRole("textbox", { name: "Message" }), {
      target: { value: "Say hello" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await screen.findByText("A local spoken reply.");
    expect(screen.getByTestId("avatar").getAttribute("data-avatar-state")).toBe("idle");

    fireEvent.click(screen.getByRole("button", { name: "Generate audio" }));
    expect(screen.getByText("Generating speech locally…")).toBeTruthy();
    await act(async () => {
      resolveSpeech(audioResponse());
    });
    expect(await screen.findByText("Audio ready.")).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(JSON.parse(fetchMock.mock.calls[1][1].body as string)).toEqual({
      text: "A local spoken reply.",
    });
    expect(document.querySelectorAll("audio")).toHaveLength(1);

    fireEvent.click(screen.getByRole("button", { name: "Play audio" }));
    expect(await screen.findByText("Playing audio.")).toBeTruthy();
    expect(screen.getByTestId("avatar").getAttribute("data-avatar-state")).toBe("speaking");

    fireEvent.click(screen.getByRole("button", { name: "Pause audio" }));
    expect(await screen.findByText("Audio paused.")).toBeTruthy();
    expect(screen.getByTestId("avatar").getAttribute("data-avatar-state")).toBe("idle");

    fireEvent.click(screen.getByRole("button", { name: "Resume audio" }));
    expect(await screen.findByText("Playing audio.")).toBeTruthy();
    expect(screen.getByTestId("avatar").getAttribute("data-avatar-state")).toBe("speaking");

    fireEvent.click(screen.getByRole("button", { name: "Stop audio" }));
    expect(screen.queryByText("Playing audio.")).toBeNull();
    expect(screen.getByTestId("avatar").getAttribute("data-avatar-state")).toBe("idle");
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:mock-speech");
  });

  it("shows a local TTS error without breaking the chat response", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ message: "Text remains available." }))
      .mockResolvedValueOnce(jsonResponse({ detail: "Kokoro is unavailable." }, 503));
    vi.stubGlobal("fetch", fetchMock);
    render(<App />);

    fireEvent.change(screen.getByRole("textbox", { name: "Message" }), {
      target: { value: "Keep the text" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(await screen.findByText("Text remains available.")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Generate audio" }));
    expect(await screen.findByRole("alert")).toHaveProperty(
      "textContent",
      "Kokoro is unavailable.",
    );
    expect(screen.getByText("Text remains available.")).toBeTruthy();
    expect(screen.getByTestId("avatar").getAttribute("data-avatar-state")).toBe("idle");
  });

  it("stops active playback when starting a new conversation", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ message: "Speech to stop." }))
      .mockResolvedValueOnce(audioResponse());
    vi.stubGlobal("fetch", fetchMock);
    render(<App />);

    fireEvent.change(screen.getByRole("textbox", { name: "Message" }), {
      target: { value: "Start" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await screen.findByText("Speech to stop.");
    fireEvent.click(screen.getByRole("button", { name: "Generate audio" }));
    await screen.findByText("Audio ready.");
    fireEvent.click(screen.getByRole("button", { name: "Play audio" }));
    await screen.findByText("Playing audio.");

    fireEvent.click(screen.getByRole("button", { name: "New conversation" }));

    expect(screen.getByText("Send a message to start a conversation.")).toBeTruthy();
    expect(screen.getByTestId("avatar").getAttribute("data-avatar-state")).toBe("idle");
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:mock-speech");
    expect(document.querySelector("audio")?.getAttribute("src")).toBeNull();
  });

  it("transcribes a push-to-talk recording and sends the edited text through chat", async () => {
    const microphone = mockMicrophone();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ text: "Recognized words." }))
      .mockResolvedValueOnce(jsonResponse({ message: "I received the edited text." }));
    vi.stubGlobal("fetch", fetchMock);
    render(<App />);

    expect(microphone.getUserMedia).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Start recording" }));
    expect(await screen.findByText("Recording locally. Stop to transcribe.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Stop recording" }));

    expect(await screen.findByText("Review or edit the transcription before sending."))
      .toBeTruthy();
    const input = screen.getByRole("textbox", { name: "Message" }) as HTMLTextAreaElement;
    expect(input.value).toBe("Recognized words.");
    fireEvent.change(input, { target: { value: "Edited recognized words." } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    expect(await screen.findByText("I received the edited text.")).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0][0]).toBe("/api/stt");
    expect(fetchMock.mock.calls[0][1].body).toBeInstanceOf(Blob);
    expect(fetchMock.mock.calls[0][1].headers["Content-Type"]).toBe(
      "audio/webm;codecs=opus",
    );
    expect(JSON.parse(fetchMock.mock.calls[1][1].body as string).messages).toEqual([
      { role: "user", content: "Edited recognized words." },
    ]);
    expect(microphone.track.stop).toHaveBeenCalledOnce();
  });

  it("lets the user discard a transcript and handles denied microphone permission", async () => {
    const microphone = mockMicrophone();
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({ text: "Transcribed words." }),
    );
    vi.stubGlobal("fetch", fetchMock);
    render(<App />);
    const input = screen.getByRole("textbox", { name: "Message" });
    fireEvent.change(input, { target: { value: "Keep my typed text" } });
    fireEvent.click(screen.getByRole("button", { name: "Start recording" }));
    await screen.findByText("Recording locally. Stop to transcribe.");
    fireEvent.click(screen.getByRole("button", { name: "Stop recording" }));
    await screen.findByText("Review or edit the transcription before sending.");

    expect((input as HTMLTextAreaElement).value).toBe("Keep my typed text Transcribed words.");
    fireEvent.click(screen.getByRole("button", { name: "Discard transcription" }));
    expect((input as HTMLTextAreaElement).value).toBe("Keep my typed text");

    cleanup();
    const deniedMicrophone = mockMicrophone(
      undefined,
      new DOMException("Permission denied.", "NotAllowedError"),
    );
    const deniedFetch = vi.fn();
    vi.stubGlobal("fetch", deniedFetch);
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: "Start recording" }));
    expect(await screen.findByRole("alert")).toHaveProperty(
      "textContent",
      "Microphone permission was denied. Allow microphone access and try again.",
    );
    expect(deniedMicrophone.getUserMedia).toHaveBeenCalledOnce();
    expect(deniedFetch).not.toHaveBeenCalled();
  });

  it("reports empty recordings and local transcription failures", async () => {
    mockMicrophone(new Blob([], { type: "audio/webm" }));
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    render(<App />);

    fireEvent.click(screen.getByRole("button", { name: "Start recording" }));
    await screen.findByText("Recording locally. Stop to transcribe.");
    fireEvent.click(screen.getByRole("button", { name: "Stop recording" }));
    expect(await screen.findByRole("alert")).toHaveProperty(
      "textContent",
      "No audio was captured. Record a short message and try again.",
    );
    expect(fetchMock).not.toHaveBeenCalled();

    cleanup();
    mockMicrophone();
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ detail: "Could not load faster-whisper." }, 503),
    );
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: "Start recording" }));
    await screen.findByText("Recording locally. Stop to transcribe.");
    fireEvent.click(screen.getByRole("button", { name: "Stop recording" }));
    expect(await screen.findByRole("alert")).toHaveProperty(
      "textContent",
      "Could not load faster-whisper.",
    );
  });
});
