import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import VoiceSettings from "./VoiceSettings";

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

describe("voice settings", () => {
  it("loads saved settings and persists changes locally", async () => {
    const savedSettings = {
      auto_play_responses: false,
      continuous_conversation_enabled: false,
      updated_at: "2026-01-01T00:00:00+00:00",
    };
    const fetchMock = vi.fn(async (_input: string, init?: RequestInit) => {
      if (!init?.method) return jsonResponse(savedSettings);
      return jsonResponse({
        ...JSON.parse(init.body as string),
        updated_at: "2026-01-02T00:00:00+00:00",
      });
    });
    const onSettingsChange = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    render(<VoiceSettings onSettingsChange={onSettingsChange} />);

    fireEvent.click(screen.getByText("Voice settings"));
    const autoPlay = await screen.findByRole("checkbox", {
      name: "Automatically speak AI responses",
    });
    const continuousMode = screen.getByRole("checkbox", {
      name: "Enable continuous voice conversation",
    });
    expect((autoPlay as HTMLInputElement).checked).toBe(false);
    expect(onSettingsChange).toHaveBeenCalledWith(savedSettings);

    fireEvent.click(autoPlay);
    fireEvent.click(continuousMode);
    fireEvent.click(screen.getByRole("button", { name: "Save voice settings" }));

    expect(await screen.findByText("Voice settings saved locally.")).toBeTruthy();
    expect(fetchMock.mock.calls[1][0]).toBe("/api/voice-settings");
    expect(JSON.parse(fetchMock.mock.calls[1][1]?.body as string)).toEqual({
      auto_play_responses: true,
      continuous_conversation_enabled: true,
    });
    expect(onSettingsChange).toHaveBeenLastCalledWith({
      auto_play_responses: true,
      continuous_conversation_enabled: true,
      updated_at: "2026-01-02T00:00:00+00:00",
    });
  });

  it("reports local settings load and save errors", async () => {
    const fetchMock = vi.fn(async (_input: string, init?: RequestInit) =>
      init?.method
        ? jsonResponse({ detail: "Could not persist settings." }, 500)
        : jsonResponse({ detail: "Could not load settings." }, 500),
    );
    vi.stubGlobal("fetch", fetchMock);
    render(<VoiceSettings onSettingsChange={vi.fn()} />);

    fireEvent.click(screen.getByText("Voice settings"));
    expect(await screen.findByText("Could not load settings.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Save voice settings" }));
    expect(await screen.findByText("Could not persist settings.")).toBeTruthy();
  });
});
