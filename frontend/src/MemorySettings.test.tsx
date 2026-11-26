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
  created_at: "2026-01-01T00:00:00+00:00",
  updated_at: "2026-01-01T00:00:00+00:00",
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
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    expect(await screen.findByText("Memory updated.")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(await screen.findByText("Memory deleted.")).toBeTruthy();
    expect(screen.getByText("No approved memories found.")).toBeTruthy();
  });
});
