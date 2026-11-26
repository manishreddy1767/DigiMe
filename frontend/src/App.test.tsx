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

const originalCreateObjectURL = URL.createObjectURL;
const originalRevokeObjectURL = URL.revokeObjectURL;

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
});
