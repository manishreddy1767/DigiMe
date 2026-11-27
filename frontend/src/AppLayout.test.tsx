import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import App from "./App";

vi.mock("./avatar/AvatarView", () => ({
  default: () => <div data-testid="avatar" />,
}));

function jsonResponse(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

type Handler = (path: string, init?: RequestInit) => unknown;

function installFetch(overrides: Handler = () => undefined) {
  let voice = {
    auto_play_responses: false,
    continuous_conversation_enabled: false,
    voice: "af_heart",
    updated_at: "",
  };
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    const method = init?.method ?? "GET";
    const override = await overrides(path, init);
    if (override) return override;
    if (path === "/api/status") {
      return jsonResponse({
        assistant_name: "Nova",
        model: "llama3.2:3b",
        deep_reasoning: false,
        ollama_reachable: true,
        model_available: true,
      });
    }
    if (path === "/api/conversations" && method === "GET") {
      return jsonResponse([
        { id: "one", title: "First chat" },
        { id: "two", title: "Second chat" },
      ]);
    }
    if (path.startsWith("/api/conversations/") && method === "GET") {
      const id = path.split("/")[3];
      return jsonResponse({ id, title: id, messages: [] });
    }
    if (path.startsWith("/api/conversations/") && method === "DELETE") {
      return { ok: true, status: 204, json: async () => null };
    }
    if (path === "/api/profile") {
      return jsonResponse({ name: "", about: "", preferences: "", updated_at: "" });
    }
    if (path === "/api/personality") {
      return jsonResponse({
        name: "Nova",
        communication_style: "friendly",
        response_length: "balanced",
        custom_instructions: "",
        deep_reasoning: false,
        updated_at: "",
      });
    }
    if (path === "/api/voice-settings" && method === "PUT") {
      voice = { ...JSON.parse(init?.body as string), updated_at: "" };
      return jsonResponse(voice);
    }
    if (path === "/api/voice-settings") return jsonResponse(voice);
    if (path === "/api/personalization/settings") {
      return jsonResponse({ enabled: true, updated_at: "" });
    }
    if (path.startsWith("/api/personalization/") || path.startsWith("/api/memories")) {
      return jsonResponse([]);
    }
    if (path.endsWith("/memory-suggestions")) return jsonResponse([]);
    if (path === "/api/chat") {
      return jsonResponse({ message: "Here is what I know.", conversation_id: "two" });
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

describe("app layout", () => {
  it("shows the assistant name and the local model in the top bar", async () => {
    installFetch();
    render(<App />);

    expect(await screen.findByRole("heading", { name: "Nova", level: 1 })).toBeTruthy();
    await waitFor(() =>
      expect(screen.getByTestId("model-health").textContent).toBe("llama3.2:3b · on this PC"),
    );
    expect(document.title).toBe("Nova · Digital Me");
  });

  it("says it is an AI digital version when speaking as yourself", async () => {
    installFetch((path) =>
      path === "/api/status"
        ? jsonResponse({
            assistant_name: "Nova",
            model: "llama3.2:3b",
            deep_reasoning: false,
            speaking_as: "self",
            ollama_reachable: true,
            model_available: true,
          })
        : path === "/api/conversations"
          ? jsonResponse([])
          : undefined,
    );
    render(<App />);

    expect(await screen.findByText("AI digital version · not a live person")).toBeTruthy();
    expect(await screen.findByRole("button", { name: "Tell me a little about yourself." })).toBeTruthy();
  });

  it("reports when the local server cannot be reached", async () => {
    installFetch((path) => {
      if (path === "/api/status") throw new TypeError("Failed to fetch");
      return undefined;
    });
    render(<App />);

    await waitFor(() =>
      expect(screen.getByTestId("model-health").textContent).toBe("Server offline"),
    );
  });

  it("toggles spoken replies from the top bar and saves the setting", async () => {
    const fetchMock = installFetch();
    render(<App />);

    const toggle = await screen.findByRole("button", { name: "Speak replies aloud" });
    expect(toggle.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(toggle);

    const muted = await screen.findByRole("button", { name: "Mute spoken replies" });
    expect(muted.getAttribute("aria-pressed")).toBe("true");
    const put = fetchMock.mock.calls.find(
      ([path, init]) => path === "/api/voice-settings" && init?.method === "PUT",
    );
    expect(JSON.parse(put?.[1]?.body as string)).toEqual({
      auto_play_responses: true,
      continuous_conversation_enabled: false,
      voice: "af_heart",
    });
  });

  it("opens settings in drawers and closes them with Escape", async () => {
    installFetch();
    render(<App />);

    const context = screen.getByRole("complementary", { name: "Context", hidden: true });
    expect(context.hasAttribute("inert")).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Context" }));
    expect(context.hasAttribute("inert")).toBe(false);
    expect(within(context).getByText("Digital personality")).toBeTruthy();
    expect(within(context).getByText("User profile")).toBeTruthy();

    fireEvent.keyDown(window, { key: "Escape" });
    expect(context.hasAttribute("inert")).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "Open voice settings" }));
    const voice = screen.getByRole("complementary", { name: "Voice" });
    expect(within(voice).getByText("Voice settings")).toBeTruthy();
    fireEvent.click(within(voice).getByRole("button", { name: "Close voice" }));
    expect(voice.hasAttribute("inert")).toBe(true);
  });

  it("sends a suggestion chip as a message", async () => {
    const fetchMock = installFetch((path) =>
      path === "/api/conversations" ? jsonResponse([]) : undefined,
    );
    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: "What do you know about me?" }));

    expect(await screen.findByText("Here is what I know.")).toBeTruthy();
    const chat = fetchMock.mock.calls.find(([path]) => path === "/api/chat");
    expect(JSON.parse(chat?.[1]?.body as string).messages).toEqual([
      { role: "user", content: "What do you know about me?" },
    ]);
  });

  it("deletes a conversation from the history drawer after confirmation", async () => {
    const fetchMock = installFetch();
    render(<App />);

    fireEvent.click(screen.getByRole("button", { name: "Conversation history" }));
    const history = screen.getByRole("complementary", { name: "Conversations" });
    fireEvent.click(await within(history).findByRole("button", { name: "Delete Second chat" }));
    fireEvent.click(within(history).getByRole("button", { name: "Delete" }));

    await waitFor(() =>
      expect(within(history).queryByRole("button", { name: "Second chat" })).toBeNull(),
    );
    expect(within(history).getByRole("button", { name: "First chat" })).toBeTruthy();
    expect(
      fetchMock.mock.calls.some(
        ([path, init]) => path === "/api/conversations/two" && init?.method === "DELETE",
      ),
    ).toBe(true);
  });
});
