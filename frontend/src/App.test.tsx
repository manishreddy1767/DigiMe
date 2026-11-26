import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App";

vi.mock("./avatar/AvatarView", () => ({
  default: ({ state, emotion }: { state: string; emotion: string }) => (
    <div
      aria-label="Avatar test placeholder"
      data-avatar-emotion={emotion}
      data-avatar-state={state}
      data-testid="avatar"
    />
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

type TestResponse = {
  ok: boolean;
  status: number;
  json?: () => Promise<unknown>;
  blob?: () => Promise<Blob>;
};

type AppFetchHandler = (
  path: string,
  init?: RequestInit,
) => Promise<TestResponse | undefined>;

function installAppFetch(handler: AppFetchHandler) {
  let newConversationId = 0;
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    const customResponse = await handler(path, init);
    if (customResponse) {
      if (path === "/api/chat" && customResponse.ok && customResponse.json) {
        const body = await customResponse.json();
        if (typeof body === "object" && body !== null && "message" in body) {
          return jsonResponse({
            ...body,
            conversation_id:
              "conversation_id" in body && typeof body.conversation_id === "string"
                ? body.conversation_id
                : "conversation-from-chat",
          });
        }
      }
      return customResponse;
    }

    if (path === "/api/conversations" && (!init?.method || init.method === "GET")) {
      return jsonResponse([]);
    }
    if (path === "/api/conversations" && init?.method === "POST") {
      newConversationId += 1;
      return jsonResponse({
        id: `created-conversation-${newConversationId}`,
        title: "New conversation",
      });
    }
    if (path === "/api/profile" && (!init?.method || init.method === "GET")) {
      return jsonResponse({
        name: "",
        about: "",
        preferences: "",
        updated_at: "",
      });
    }
    if (path === "/api/personality" && (!init?.method || init.method === "GET")) {
      return jsonResponse({
        name: "Digital Me",
        communication_style: "friendly",
        response_length: "balanced",
        custom_instructions: "",
        updated_at: "",
      });
    }
    if (path === "/api/voice-settings" && (!init?.method || init.method === "GET")) {
      return jsonResponse({
        auto_play_responses: false,
        continuous_conversation_enabled: false,
        updated_at: "",
      });
    }
    if (path === "/api/voice-settings" && init?.method === "PUT") {
      return jsonResponse({
        ...JSON.parse(init.body as string),
        updated_at: "",
      });
    }
    if (
      path.startsWith("/api/conversations/") &&
      path.endsWith("/memory-suggestions") &&
      (!init?.method || init.method === "GET")
    ) {
      return jsonResponse([]);
    }
    if (path.startsWith("/api/memories") && (!init?.method || init.method === "GET")) {
      return jsonResponse([]);
    }
    throw new Error(`Unexpected request: ${init?.method ?? "GET"} ${path}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function callsFor(fetchMock: ReturnType<typeof installAppFetch>, path: string) {
  return fetchMock.mock.calls.filter(([input]) => String(input) === path);
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
  it("restores the latest saved conversation and lets the user switch histories", async () => {
    const fetchMock = installAppFetch((path) => {
      if (path === "/api/conversations") {
        return Promise.resolve(jsonResponse([
          { id: "latest", title: "Latest chat" },
          { id: "older", title: "Older chat" },
        ]));
      }
      if (path === "/api/conversations/latest") {
        return Promise.resolve(jsonResponse({
          id: "latest",
          title: "Latest chat",
          messages: [
            { id: 1, role: "user", content: "Latest question" },
            { id: 2, role: "assistant", content: "Latest answer" },
          ],
        }));
      }
      if (path === "/api/conversations/older") {
        return Promise.resolve(jsonResponse({
          id: "older",
          title: "Older chat",
          messages: [{ id: 3, role: "user", content: "Older question" }],
        }));
      }
      return Promise.resolve(undefined);
    });
    render(<App />);

    expect(await screen.findByText("Latest question")).toBeTruthy();
    expect(screen.getByText("Latest answer")).toBeTruthy();
    fireEvent.change(screen.getByRole("combobox", { name: "Conversation history" }), {
      target: { value: "older" },
    });

    expect(await screen.findByText("Older question")).toBeTruthy();
    expect(screen.queryByText("Latest question")).toBeNull();
    expect(callsFor(fetchMock, "/api/conversations/latest")).toHaveLength(1);
    expect(callsFor(fetchMock, "/api/conversations/older")).toHaveLength(1);
  });

  it("sends a message, shows the reply and includes it in follow-up context", async () => {
    const responses = [
      jsonResponse({ message: "Hello from mocked Ollama." }),
      jsonResponse({ message: "A contextual follow-up." }),
    ];
    const fetchMock = installAppFetch((path) =>
      Promise.resolve(path === "/api/chat" ? responses.shift() : undefined),
    );
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
    const chatCalls = callsFor(fetchMock, "/api/chat");
    expect(chatCalls).toHaveLength(2);
    const secondRequest = JSON.parse(chatCalls[1][1]?.body as string);
    expect(secondRequest.conversation_id).toBe("conversation-from-chat");
    expect(secondRequest.messages).toEqual([
      { role: "user", content: "Continue" },
    ]);
  });

  it.each([
    ["Congratulations, that's wonderful news!", "happy"],
    ["I'm sorry to hear about your loss.", "sad"],
    ["What would you like to try next?", "curious"],
    ["The answer is 42.", "neutral"],
  ])("selects a grounded %s response expression", async (reply, emotion) => {
    const fetchMock = installAppFetch((path) =>
      Promise.resolve(
        path === "/api/chat"
          ? jsonResponse({ message: reply })
          : undefined,
      ),
    );
    render(<App />);

    fireEvent.change(screen.getByRole("textbox", { name: "Message" }), {
      target: { value: "Please respond." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    expect(await screen.findByText(reply)).toBeTruthy();
    const avatar = screen.getByTestId("avatar");
    expect(avatar.getAttribute("data-avatar-emotion")).toBe(emotion);
    expect(avatar.getAttribute("data-avatar-state")).toBe(
      emotion === "neutral" ? "idle" : emotion,
    );
    expect(callsFor(fetchMock, "/api/chat")).toHaveLength(1);
  });

  it("does not submit the same chat message twice while a request is pending", async () => {
    let resolveChat!: (response: ReturnType<typeof jsonResponse>) => void;
    const pendingChat = new Promise<ReturnType<typeof jsonResponse>>((resolve) => {
      resolveChat = resolve;
    });
    const fetchMock = installAppFetch((path) =>
      Promise.resolve(path === "/api/chat" ? pendingChat : undefined),
    );
    render(<App />);

    fireEvent.change(screen.getByRole("textbox", { name: "Message" }), {
      target: { value: "Only send once." },
    });
    const form = document.querySelector(".composer") as HTMLFormElement;
    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "Send" }));
      fireEvent.submit(form);
    });
    expect(callsFor(fetchMock, "/api/chat")).toHaveLength(1);

    await act(async () => {
      resolveChat(jsonResponse({ message: "Received once." }));
    });
    expect(await screen.findByText("Received once.")).toBeTruthy();
  });

  it("shows loading state, and a new conversation ignores an in-flight reply", async () => {
    let resolveRequest!: (response: ReturnType<typeof jsonResponse>) => void;
    const fetchMock = installAppFetch((path) =>
      path === "/api/chat"
        ? new Promise<ReturnType<typeof jsonResponse>>((resolve) => {
            resolveRequest = resolve;
          })
        : Promise.resolve(undefined),
    );
    render(<App />);

    fireEvent.change(screen.getByRole("textbox", { name: "Message" }), {
      target: { value: "Pending question" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    expect(screen.getByText("Digital Me is thinking…")).toBeTruthy();
    expect(screen.getByTestId("avatar").getAttribute("data-avatar-state")).toBe("thinking");
    fireEvent.click(screen.getByRole("button", { name: "New conversation" }));
    expect(await screen.findByText("Send a message to start a conversation.")).toBeTruthy();
    expect(screen.getByTestId("avatar").getAttribute("data-avatar-state")).toBe("idle");

    await act(async () => {
      resolveRequest(jsonResponse({ message: "Stale response" }));
    });
    expect(screen.queryByText("Stale response")).toBeNull();
  });

  it("shows backend errors without losing the user's message", async () => {
    const fetchMock = installAppFetch((path) =>
      Promise.resolve(
        path === "/api/chat"
          ? jsonResponse({
              detail: {
                message: "Ollama is not available.",
                conversation_id: "failed-conversation",
              },
            }, 502)
          : undefined,
      ),
    );
    render(<App />);

    fireEvent.change(screen.getByRole("textbox", { name: "Message" }), {
      target: { value: "Are you there?" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    expect(await screen.findByRole("alert")).toHaveProperty(
      "textContent",
      "Ollama is not available.",
    );
    expect(document.querySelector(".message.user p")?.textContent).toBe("Are you there?");
    expect(
      (screen.getByRole("combobox", { name: "Conversation history" }) as HTMLSelectElement)
        .value,
    ).toBe("failed-conversation");
  });

  it("generates local speech and maps playback controls to avatar state", async () => {
    let resolveSpeech!: (response: ReturnType<typeof audioResponse>) => void;
    const pendingSpeech = new Promise<ReturnType<typeof audioResponse>>((resolve) => {
      resolveSpeech = resolve;
    });
    let chatResponseUsed = false;
    const fetchMock = installAppFetch((path) => {
      if (path === "/api/chat" && !chatResponseUsed) {
        chatResponseUsed = true;
        return Promise.resolve(jsonResponse({
          message: "Congratulations! A local spoken reply.",
        }));
      }
      if (path === "/api/tts") return pendingSpeech;
      return Promise.resolve(undefined);
    });
    render(<App />);

    fireEvent.change(screen.getByRole("textbox", { name: "Message" }), {
      target: { value: "Say hello" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await screen.findByText("Congratulations! A local spoken reply.");
    expect(screen.getByTestId("avatar").getAttribute("data-avatar-state")).toBe("happy");

    fireEvent.click(screen.getByRole("button", { name: "Generate audio" }));
    expect(screen.getByText("Generating speech locally…")).toBeTruthy();
    await act(async () => {
      resolveSpeech(audioResponse());
    });
    expect(await screen.findByText("Audio ready.")).toBeTruthy();
    expect(callsFor(fetchMock, "/api/chat")).toHaveLength(1);
    expect(JSON.parse(callsFor(fetchMock, "/api/tts")[0][1]?.body as string)).toEqual({
      text: "Congratulations! A local spoken reply.",
    });
    expect(document.querySelectorAll("audio")).toHaveLength(1);

    fireEvent.click(screen.getByRole("button", { name: "Play audio" }));
    expect(await screen.findByText("Playing audio.")).toBeTruthy();
    expect(screen.getByTestId("avatar").getAttribute("data-avatar-state")).toBe("speaking");
    expect(screen.getByTestId("avatar").getAttribute("data-avatar-emotion")).toBe("happy");

    fireEvent.click(screen.getByRole("button", { name: "Pause audio" }));
    expect(await screen.findByText("Audio paused.")).toBeTruthy();
    expect(screen.getByTestId("avatar").getAttribute("data-avatar-state")).toBe("happy");

    fireEvent.click(screen.getByRole("button", { name: "Resume audio" }));
    expect(await screen.findByText("Playing audio.")).toBeTruthy();
    expect(screen.getByTestId("avatar").getAttribute("data-avatar-state")).toBe("speaking");

    fireEvent.click(screen.getByRole("button", { name: "Stop audio" }));
    expect(screen.queryByText("Playing audio.")).toBeNull();
    expect(screen.getByTestId("avatar").getAttribute("data-avatar-state")).toBe("happy");
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:mock-speech");
  });

  it("shows a local TTS error without breaking the chat response", async () => {
    const fetchMock = installAppFetch((path) => {
      if (path === "/api/chat") {
        return Promise.resolve(jsonResponse({ message: "Text remains available." }));
      }
      if (path === "/api/tts") {
        return Promise.resolve(jsonResponse({ detail: "Kokoro is unavailable." }, 503));
      }
      return Promise.resolve(undefined);
    });
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

  it("automatically synthesizes and plays responses when the setting is enabled", async () => {
    const fetchMock = installAppFetch((path) => {
      if (path === "/api/voice-settings") {
        return Promise.resolve(jsonResponse({
          auto_play_responses: true,
          continuous_conversation_enabled: false,
          updated_at: "",
        }));
      }
      if (path === "/api/chat") {
        return Promise.resolve(jsonResponse({ message: "Automatically spoken reply." }));
      }
      if (path === "/api/tts") return Promise.resolve(audioResponse());
      return Promise.resolve(undefined);
    });
    render(<App />);

    fireEvent.click(screen.getByText("Voice settings"));
    const autoPlay = await screen.findByRole("checkbox", {
      name: "Automatically speak AI responses",
    });
    expect((autoPlay as HTMLInputElement).checked).toBe(true);
    fireEvent.change(screen.getByRole("textbox", { name: "Message" }), {
      target: { value: "Please speak this." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    expect(await screen.findByText("Automatically spoken reply.")).toBeTruthy();
    expect(await screen.findByText("Playing audio.")).toBeTruthy();
    expect(callsFor(fetchMock, "/api/tts")).toHaveLength(1);
    expect(JSON.parse(callsFor(fetchMock, "/api/tts")[0][1]?.body as string)).toEqual({
      text: "Automatically spoken reply.",
    });
  });

  it("caps speech synthesis for long replies while preserving the complete text", async () => {
    const longReply = "x".repeat(4_001);
    const fetchMock = installAppFetch((path) => {
      if (path === "/api/voice-settings") {
        return Promise.resolve(jsonResponse({
          auto_play_responses: true,
          continuous_conversation_enabled: false,
          updated_at: "",
        }));
      }
      if (path === "/api/chat") {
        return Promise.resolve(jsonResponse({ message: longReply }));
      }
      return Promise.resolve(undefined);
    });
    render(<App />);

    fireEvent.click(screen.getByText("Voice settings"));
    expect(await screen.findByRole("checkbox", {
      name: "Automatically speak AI responses",
    })).toBeTruthy();
    fireEvent.change(screen.getByRole("textbox", { name: "Message" }), {
      target: { value: "Give me a long answer." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    expect(await screen.findByText(longReply)).toBeTruthy();
    expect(await screen.findByText(/Replies over 4,000 characters are kept as text/))
      .toBeTruthy();
    expect(callsFor(fetchMock, "/api/tts")).toHaveLength(0);
  });

  it("keeps a continuous conversation local and resumes listening after playback", async () => {
    const microphone = mockMicrophone();
    const fetchMock = installAppFetch((path) => {
      if (path === "/api/voice-settings") {
        return Promise.resolve(jsonResponse({
          auto_play_responses: false,
          continuous_conversation_enabled: true,
          updated_at: "",
        }));
      }
      if (path === "/api/stt") {
        return Promise.resolve(jsonResponse({ text: "What is the weather?" }));
      }
      if (path === "/api/chat") {
        return Promise.resolve(jsonResponse({ message: "A voice reply." }));
      }
      if (path === "/api/tts") return Promise.resolve(audioResponse());
      return Promise.resolve(undefined);
    });
    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: "Start voice conversation" }));
    expect(await screen.findByText("Listening for your voice.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Stop recording" }));

    expect(await screen.findByText("A voice reply.")).toBeTruthy();
    expect(await screen.findByText("Playing audio.")).toBeTruthy();
    expect(callsFor(fetchMock, "/api/chat")).toHaveLength(1);
    fireEvent.ended(document.querySelector("audio") as HTMLAudioElement);
    await waitFor(() => expect(microphone.getUserMedia).toHaveBeenCalledTimes(2));

    fireEvent.click(screen.getByRole("button", { name: "Stop voice conversation" }));
    expect(screen.queryByText("Listening for your voice.")).toBeNull();
    expect(callsFor(fetchMock, "/api/chat")).toHaveLength(1);
    expect(microphone.track.stop).toHaveBeenCalled();
  });

  it("interrupts playback before opening the microphone and avoids a second chat submit", async () => {
    const microphone = mockMicrophone();
    const fetchMock = installAppFetch((path) => {
      if (path === "/api/chat") {
        return Promise.resolve(jsonResponse({ message: "A reply to interrupt." }));
      }
      if (path === "/api/tts") return Promise.resolve(audioResponse());
      return Promise.resolve(undefined);
    });
    render(<App />);

    fireEvent.change(screen.getByRole("textbox", { name: "Message" }), {
      target: { value: "Start speaking." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(await screen.findByText("A reply to interrupt.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Generate audio" }));
    expect(await screen.findByText("Audio ready.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Play audio" }));
    expect(await screen.findByText("Playing audio.")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Interrupt and listen" }));
    expect(await screen.findByText("Recording locally. Stop to transcribe.")).toBeTruthy();
    expect(document.querySelector("audio")?.getAttribute("src")).toBeNull();
    expect(microphone.getUserMedia).toHaveBeenCalledOnce();
    expect(callsFor(fetchMock, "/api/chat")).toHaveLength(1);
  });

  it("stops active playback when starting a new conversation", async () => {
    const fetchMock = installAppFetch((path) => {
      if (path === "/api/chat") return Promise.resolve(jsonResponse({ message: "Speech to stop." }));
      if (path === "/api/tts") return Promise.resolve(audioResponse());
      return Promise.resolve(undefined);
    });
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

    expect(await screen.findByText("Send a message to start a conversation.")).toBeTruthy();
    expect(screen.getByTestId("avatar").getAttribute("data-avatar-state")).toBe("idle");
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:mock-speech");
    expect(document.querySelector("audio")?.getAttribute("src")).toBeNull();
  });

  it("transcribes a push-to-talk recording and sends the edited text through chat", async () => {
    const microphone = mockMicrophone();
    const fetchMock = installAppFetch((path) => {
      if (path === "/api/stt") return Promise.resolve(jsonResponse({ text: "Recognized words." }));
      if (path === "/api/chat") {
        return Promise.resolve(jsonResponse({ message: "I received the edited text." }));
      }
      return Promise.resolve(undefined);
    });
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
    const sttCall = callsFor(fetchMock, "/api/stt")[0];
    const chatCall = callsFor(fetchMock, "/api/chat")[0];
    expect(sttCall[1]?.body).toBeInstanceOf(Blob);
    expect(new Headers(sttCall[1]?.headers).get("Content-Type")).toBe(
      "audio/webm;codecs=opus",
    );
    expect(JSON.parse(chatCall[1]?.body as string).messages).toEqual([
      { role: "user", content: "Edited recognized words." },
    ]);
    expect(JSON.parse(chatCall[1]?.body as string).conversation_id).toBeNull();
    expect(microphone.track.stop).toHaveBeenCalledOnce();
  });

  it("lets the user discard a transcript and handles denied microphone permission", async () => {
    const microphone = mockMicrophone();
    installAppFetch((path) =>
      Promise.resolve(
        path === "/api/stt" ? jsonResponse({ text: "Transcribed words." }) : undefined,
      ),
    );
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
    const deniedFetch = installAppFetch(() => Promise.resolve(undefined));
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: "Start recording" }));
    expect(await screen.findByRole("alert")).toHaveProperty(
      "textContent",
      "Microphone permission was denied. Allow microphone access and try again.",
    );
    expect(deniedMicrophone.getUserMedia).toHaveBeenCalledOnce();
    expect(callsFor(deniedFetch, "/api/stt")).toHaveLength(0);
    expect(callsFor(deniedFetch, "/api/chat")).toHaveLength(0);
  });

  it("reports empty recordings and local transcription failures", async () => {
    mockMicrophone(new Blob([], { type: "audio/webm" }));
    const fetchMock = installAppFetch(() => Promise.resolve(undefined));
    render(<App />);

    fireEvent.click(screen.getByRole("button", { name: "Start recording" }));
    await screen.findByText("Recording locally. Stop to transcribe.");
    fireEvent.click(screen.getByRole("button", { name: "Stop recording" }));
    expect(await screen.findByRole("alert")).toHaveProperty(
      "textContent",
      "No audio was captured. Record a short message and try again.",
    );
    expect(callsFor(fetchMock, "/api/stt")).toHaveLength(0);

    cleanup();
    mockMicrophone();
    const failedFetch = installAppFetch((path) =>
      Promise.resolve(
        path === "/api/stt"
          ? jsonResponse({ detail: "Could not load faster-whisper." }, 503)
          : undefined,
      ),
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
