import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import PersonalizationSettings from "./PersonalizationSettings";

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

describe("personalization controls", () => {
  it("loads topic summaries and requests optional suggestions only on demand", async () => {
    const fetchMock = vi.fn(async (input: string) => {
      if (input === "/api/personalization/settings") {
        return jsonResponse({ enabled: true, updated_at: "" });
      }
      if (input === "/api/personalization/topics") {
        return jsonResponse([
          {
            topic: "programming",
            message_count: 3,
            conversation_count: 2,
            summary: "Programming appeared in 3 recent user messages across 2 conversations.",
          },
        ]);
      }
      if (input === "/api/personalization/proactive-suggestions") {
        return jsonResponse([
          {
            topic: "programming",
            prompt: "Give me a small programming example.",
            source: "recurring topic",
          },
        ]);
      }
      throw new Error(`Unexpected request: ${input}`);
    });
    const onSettingsChange = vi.fn();
    const onUsePrompt = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    render(
      <PersonalizationSettings
        onSettingsChange={onSettingsChange}
        onUsePrompt={onUsePrompt}
      />,
    );

    fireEvent.click(screen.getByText("Personalization & optional ideas"));
    expect(await screen.findByText(/Programming appeared in 3/)).toBeTruthy();
    expect(fetchMock.mock.calls.some(
      ([input]) => input === "/api/personalization/proactive-suggestions",
    )).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: "Show optional ideas" }));
    expect(await screen.findByText(/recurring topic/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Use in draft" }));
    expect(onUsePrompt).toHaveBeenCalledWith(
      "Give me a small programming example.",
    );
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    await waitFor(() => expect(screen.queryByText(/recurring topic/)).toBeNull());
    expect(onSettingsChange).toHaveBeenCalledWith(true);
  });

  it("persists enable and disable changes and hides derived data when disabled", async () => {
    const fetchMock = vi.fn(async (input: string, init?: RequestInit) => {
      if (input === "/api/personalization/settings" && !init?.method) {
        return jsonResponse({ enabled: false, updated_at: "" });
      }
      if (input === "/api/personalization/settings" && init?.method === "PUT") {
        return jsonResponse({
          ...JSON.parse(init.body as string),
          updated_at: "",
        });
      }
      if (input === "/api/personalization/topics") {
        return jsonResponse([
          {
            topic: "books",
            message_count: 2,
            conversation_count: 1,
            summary: "Books appeared in 2 recent user messages across 1 conversation.",
          },
        ]);
      }
      throw new Error(`Unexpected request: ${init?.method ?? "GET"} ${input}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    render(
      <PersonalizationSettings
        onSettingsChange={vi.fn()}
        onUsePrompt={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByText("Personalization & optional ideas"));

    const toggle = await screen.findByRole("checkbox") as HTMLInputElement;
    expect(toggle.checked).toBe(false);
    expect(fetchMock.mock.calls.some(
      ([input]) => input === "/api/personalization/topics",
    )).toBe(false);

    fireEvent.click(toggle);
    expect(await screen.findByText(/Books appeared in 2/)).toBeTruthy();
    fireEvent.click(screen.getByRole("checkbox"));
    expect(
      await screen.findByText(/Personalization disabled; existing data remains available/),
    ).toBeTruthy();
    expect(screen.queryByText(/Books appeared in 2/)).toBeNull();
    expect(fetchMock.mock.calls.filter(
      ([input, init]) =>
        input === "/api/personalization/settings" && init?.method === "PUT",
    )).toHaveLength(2);
  });
});
