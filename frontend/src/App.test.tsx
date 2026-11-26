import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import App from "./App";

vi.mock("./avatar/AvatarView", () => ({
  default: () => <div aria-label="Avatar test placeholder" />,
}));

function jsonResponse(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("chat interface", () => {
  it("sends a message, shows the reply and includes it in follow-up context", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ message: "Hello from mocked Ollama." }))
      .mockResolvedValueOnce(jsonResponse({ message: "A contextual follow-up." }));
    vi.stubGlobal("fetch", fetchMock);
    render(<App />);

    const input = screen.getByRole("textbox", { name: "Message" });
    fireEvent.change(input, { target: { value: "Hello" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    expect(await screen.findByText("Hello from mocked Ollama.")).toBeTruthy();
    fireEvent.change(input, { target: { value: "Continue" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    expect(await screen.findByText("A contextual follow-up.")).toBeTruthy();
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
    fireEvent.click(screen.getByRole("button", { name: "New conversation" }));
    expect(screen.getByText("Send a message to start a conversation.")).toBeTruthy();

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
});
