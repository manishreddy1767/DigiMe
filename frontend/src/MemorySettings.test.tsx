import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import MemorySettings from "./MemorySettings";

const profile = {
  name: "Alex",
  about: "A local profile.",
  preferences: "Concise answers.",
  updated_at: "2026-01-01T00:00:00+00:00",
};

const savedMemory = {
  id: "memory-1",
  content: "I enjoy mountain hikes.",
  importance: 3,
  created_at: "2026-01-01T00:00:00+00:00",
  updated_at: "2026-01-01T00:00:00+00:00",
};

const similarMemory = {
  ...savedMemory,
  similarity: 0.94,
  kind: "similar" as const,
};

const suggestion = {
  id: "suggestion-1",
  conversation_id: "conversation-1",
  content: "I prefer hiking in the morning.",
  status: "pending" as const,
  created_at: "2026-01-01T00:00:00+00:00",
};

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

describe("local profile and approved memories", () => {
  it("edits the profile and saves a memory only after explicit submission", async () => {
    const fetchMock = vi.fn(async (input: string, init?: RequestInit) => {
      if (input === "/api/profile" && !init?.method) {
        return jsonResponse(profile);
      }
      if (input === "/api/memories" && !init?.method) {
        return jsonResponse([]);
      }
      if (input === "/api/profile" && init?.method === "PUT") {
        return jsonResponse({ ...profile, name: "Jordan" });
      }
      if (input === "/api/memories" && init?.method === "POST") {
        return jsonResponse({
          ...savedMemory,
          content: JSON.parse(init.body as string).content,
        }, 201);
      }
      throw new Error(`Unexpected request: ${init?.method ?? "GET"} ${input}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<MemorySettings />);

    expect(await screen.findByDisplayValue("Alex")).toBeTruthy();
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === "POST")).toBe(false);
    fireEvent.click(screen.getByText("User profile"));
    fireEvent.click(screen.getByRole("button", { name: "Save profile" }));
    await screen.findByText("Profile saved locally.");

    fireEvent.click(screen.getByText(/Approved long-term memories/));
    const memoryInput = screen.getByRole("textbox", {
      name: "Memory to approve and save",
    });
    fireEvent.change(memoryInput, { target: { value: "I enjoy mountain hikes." } });
    fireEvent.click(screen.getByRole("button", { name: "Save approved memory" }));

    expect(await screen.findByText("Memory saved with your approval.")).toBeTruthy();
    expect(screen.getByDisplayValue("I enjoy mountain hikes.")).toBeTruthy();
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === "POST")).toBe(true);
  });

  it("searches, edits, and deletes approved memories", async () => {
    const fetchMock = vi.fn(async (input: string, init?: RequestInit) => {
      if (input === "/api/profile" && !init?.method) {
        return jsonResponse(profile);
      }
      if (input === "/api/memories" && !init?.method) {
        return jsonResponse([savedMemory]);
      }
      if (input === "/api/memories?q=mountain" && !init?.method) {
        return jsonResponse([savedMemory]);
      }
      if (input === "/api/memories/memory-1" && init?.method === "PUT") {
        return jsonResponse({
          ...savedMemory,
          content: JSON.parse(init.body as string).content,
        });
      }
      if (input === "/api/memories/memory-1" && init?.method === "DELETE") {
        return { ok: true, status: 204, json: async () => ({}) };
      }
      throw new Error(`Unexpected request: ${init?.method ?? "GET"} ${input}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<MemorySettings />);

    fireEvent.click(await screen.findByText(/Approved long-term memories/));
    const memoryInput = await screen.findByDisplayValue("I enjoy mountain hikes.");
    fireEvent.change(screen.getByRole("textbox", { name: "Search memories" }), {
      target: { value: "mountain" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    await waitFor(() => {
      expect(fetchMock.mock.calls.some(([input]) => input === "/api/memories?q=mountain"))
        .toBe(true);
    });

    fireEvent.change(memoryInput, { target: { value: "I enjoy coastal walks." } });
    fireEvent.change(screen.getByRole("combobox", { name: "Importance for memory memory-1" }), {
      target: { value: "5" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    expect(await screen.findByText("Memory updated.")).toBeTruthy();
    expect(JSON.parse(
      fetchMock.mock.calls.find(([, init]) => init?.method === "PUT")?.[1]?.body as string,
    )).toMatchObject({ content: "I enjoy coastal walks.", importance: 5 });

    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(await screen.findByText("Memory deleted.")).toBeTruthy();
    expect(screen.getByText("No approved memories found.")).toBeTruthy();
  });

  it("warns about similar memories and requires explicit confirmation to save", async () => {
    const fetchMock = vi.fn(async (input: string, init?: RequestInit) => {
      if (input === "/api/profile") return jsonResponse(profile);
      if (input === "/api/memories" && !init?.method) return jsonResponse([]);
      if (input === "/api/memories" && init?.method === "POST") {
        const body = JSON.parse(init.body as string) as {
          content: string;
          importance: number;
          confirm_similar: boolean;
        };
        if (!body.confirm_similar) {
          return jsonResponse({
            detail: {
              message: "Similar memory exists.",
              similar_memories: [similarMemory],
            },
          }, 409);
        }
        return jsonResponse({ ...savedMemory, ...body }, 201);
      }
      throw new Error(`Unexpected request: ${init?.method ?? "GET"} ${input}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<MemorySettings />);

    fireEvent.click(await screen.findByText(/Approved long-term memories/));
    fireEvent.change(screen.getByRole("textbox", {
      name: "Memory to approve and save",
    }), { target: { value: "I prefer hiking in the morning." } });
    fireEvent.change(screen.getByRole("combobox", { name: "New memory importance" }), {
      target: { value: "4" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save approved memory" }));

    expect(await screen.findByText("Similar approved memories found. Review before saving."))
      .toBeTruthy();
    expect(screen.getByText("I enjoy mountain hikes.")).toBeTruthy();
    fireEvent.change(screen.getByRole("textbox", {
      name: "Memory to approve and save",
    }), { target: { value: "I hike on weekends." } });
    expect(screen.queryByText("Similar approved memories found. Review before saving."))
      .toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Save approved memory" }));
    expect(await screen.findByText("Similar approved memories found. Review before saving."))
      .toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Save anyway" }));

    expect(await screen.findByText("Memory saved with your approval.")).toBeTruthy();
    const createCalls = fetchMock.mock.calls.filter(
      ([input, init]) => input === "/api/memories" && init?.method === "POST",
    );
    expect(createCalls).toHaveLength(3);
    expect(JSON.parse(createCalls[0][1]?.body as string)).toMatchObject({
      importance: 4,
      confirm_similar: false,
    });
    expect(JSON.parse(createCalls[1][1]?.body as string)).toMatchObject({
      content: "I hike on weekends.",
      importance: 4,
      confirm_similar: false,
    });
    expect(JSON.parse(createCalls[2][1]?.body as string)).toMatchObject({
      content: "I hike on weekends.",
      importance: 4,
      confirm_similar: true,
    });
  });

  it("loads conversation suggestions and saves only explicitly approved suggestions", async () => {
    let approvalAttempt = 0;
    const fetchMock = vi.fn(async (input: string, init?: RequestInit) => {
      if (input === "/api/profile") return jsonResponse(profile);
      if (input === "/api/memories" && !init?.method) return jsonResponse([]);
      if (input === "/api/conversations/conversation-1/memory-suggestions") {
        return jsonResponse(init?.method === "POST" ? [suggestion] : []);
      }
      if (input === "/api/memory-suggestions/suggestion-1/approve") {
        approvalAttempt += 1;
        if (approvalAttempt === 1) {
          return jsonResponse({
            detail: {
              message: "Similar memory exists.",
              similar_memories: [similarMemory],
            },
          }, 409);
        }
        return jsonResponse({ ...savedMemory, content: suggestion.content }, 201);
      }
      if (input === "/api/memory-suggestions/suggestion-1" && init?.method === "DELETE") {
        return { ok: true, status: 204, json: async () => ({}) };
      }
      throw new Error(`Unexpected request: ${init?.method ?? "GET"} ${input}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<MemorySettings conversationId="conversation-1" />);

    fireEvent.click(await screen.findByText(/Approved long-term memories/));
    fireEvent.click(screen.getByRole("button", { name: "Suggest from current conversation" }));
    expect(await screen.findByText(suggestion.content)).toBeTruthy();
    expect(fetchMock.mock.calls.some(
      ([input, init]) => input.includes("/approve") && init?.method === "POST",
    )).toBe(false);

    fireEvent.change(screen.getByRole("combobox", {
      name: "Importance for suggestion suggestion-1",
    }), { target: { value: "5" } });
    fireEvent.click(screen.getByRole("button", { name: "Approve memory" }));
    expect(await screen.findByText("Similar approved memories found. Review before approval."))
      .toBeTruthy();
    expect(screen.getByRole("button", { name: "Approve anyway" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Approve anyway" }));
    expect(await screen.findByText("Suggestion approved and saved as a memory.")).toBeTruthy();
    const approvalCalls = fetchMock.mock.calls.filter(
      ([input]) => input === "/api/memory-suggestions/suggestion-1/approve",
    );
    expect(approvalCalls).toHaveLength(2);
    expect(JSON.parse(approvalCalls[0][1]?.body as string)).toMatchObject({
      importance: 5,
      confirm_similar: false,
    });
    expect(JSON.parse(approvalCalls[1][1]?.body as string)).toMatchObject({
      importance: 5,
      confirm_similar: true,
    });
  });

  it("lets users dismiss pending suggestions without approving them", async () => {
    const fetchMock = vi.fn(async (input: string, init?: RequestInit) => {
      if (input === "/api/profile") return jsonResponse(profile);
      if (input === "/api/memories" && !init?.method) return jsonResponse([]);
      if (input === "/api/conversations/conversation-1/memory-suggestions") {
        return jsonResponse(init?.method === "POST" ? [suggestion] : []);
      }
      if (input === "/api/memory-suggestions/suggestion-1" && init?.method === "DELETE") {
        return { ok: true, status: 204, json: async () => ({}) };
      }
      throw new Error(`Unexpected request: ${init?.method ?? "GET"} ${input}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<MemorySettings conversationId="conversation-1" />);

    fireEvent.click(await screen.findByText(/Approved long-term memories/));
    fireEvent.click(screen.getByRole("button", { name: "Suggest from current conversation" }));
    expect(await screen.findByText(suggestion.content)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    await waitFor(() => expect(screen.queryByText(suggestion.content)).toBeNull());
    expect(fetchMock.mock.calls.some(
      ([input, init]) => input.includes("/approve") && init?.method === "POST",
    )).toBe(false);
  });

  it("keeps recurring-preference suggestions pending until explicitly approved", async () => {
    const fetchMock = vi.fn(async (input: string, init?: RequestInit) => {
      if (input === "/api/profile") return jsonResponse(profile);
      if (input === "/api/memories" && !init?.method) return jsonResponse([]);
      if (input === "/api/conversations/conversation-1/memory-suggestions") {
        return jsonResponse(
          init?.method === "POST" ? [suggestion] : [],
        );
      }
      if (input === "/api/conversations/conversation-1/preference-suggestions") {
        return jsonResponse([suggestion]);
      }
      if (input === "/api/memory-suggestions/suggestion-1/approve") {
        return jsonResponse(
          { ...savedMemory, content: suggestion.content },
          201,
        );
      }
      throw new Error(`Unexpected request: ${init?.method ?? "GET"} ${input}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    render(
      <MemorySettings
        conversationId="conversation-1"
        personalizationEnabled
      />,
    );

    fireEvent.click(await screen.findByText(/Approved long-term memories/));
    fireEvent.click(
      screen.getByRole("button", { name: "Suggest recurring preferences" }),
    );
    expect(await screen.findByText(suggestion.content)).toBeTruthy();
    expect(fetchMock.mock.calls.some(
      ([input, init]) => input === "/api/memories" && init?.method === "POST",
    )).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: "Approve memory" }));
    expect(await screen.findByText("Suggestion approved and saved as a memory."))
      .toBeTruthy();
    expect(fetchMock.mock.calls.some(
      ([input, init]) =>
        input === "/api/memory-suggestions/suggestion-1/approve" &&
        init?.method === "POST",
    )).toBe(true);
  });

  it("does not allow recurring-preference analysis when personalization is disabled", async () => {
    const fetchMock = vi.fn(async (input: string, init?: RequestInit) => {
      if (input === "/api/profile") return jsonResponse(profile);
      if (input === "/api/memories" && !init?.method) return jsonResponse([]);
      if (input === "/api/conversations/conversation-1/memory-suggestions") {
        return jsonResponse([]);
      }
      throw new Error(`Unexpected request: ${init?.method ?? "GET"} ${input}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    render(
      <MemorySettings
        conversationId="conversation-1"
        personalizationEnabled={false}
      />,
    );

    fireEvent.click(await screen.findByText(/Approved long-term memories/));
    expect(
      (
        screen.getByRole("button", {
          name: "Suggest recurring preferences",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    expect(fetchMock.mock.calls.some(([input]) =>
      input.endsWith("/preference-suggestions"),
    )).toBe(false);
  });
});
