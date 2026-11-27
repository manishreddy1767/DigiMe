import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import PersonalitySettings from "./PersonalitySettings";

const defaultPersonality = {
  name: "Digital Me",
  communication_style: "friendly",
  response_length: "balanced",
  custom_instructions: "",
  updated_at: "",
};

function response(body: unknown, status = 200) {
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

describe("digital personality settings", () => {
  it("loads saved settings, edits them, and keeps them after remount", async () => {
    let saved = { ...defaultPersonality };
    const fetchMock = vi.fn(async (_input: string, init?: RequestInit) => {
      if (!init?.method || init.method === "GET") return response(saved);
      if (init.method === "PUT") {
        saved = {
          ...JSON.parse(init.body as string),
          updated_at: "2026-11-26T00:00:00+00:00",
        };
        return response(saved);
      }
      throw new Error(`Unexpected method ${init.method}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const firstRender = render(<PersonalitySettings />);
    fireEvent.click(await screen.findByText("Digital personality"));
    fireEvent.change(screen.getByRole("textbox", {
      name: "Personality name",
    }), { target: { value: "The Guide" } });
    fireEvent.change(screen.getByLabelText("Communication style"), {
      target: { value: "professional" },
    });
    fireEvent.change(screen.getByLabelText("Response length"), {
      target: { value: "detailed" },
    });
    fireEvent.change(screen.getByRole("textbox", {
      name: "Custom personality instructions",
    }), { target: { value: "Explain unfamiliar terms." } });
    fireEvent.click(screen.getByRole("button", { name: "Save personality" }));

    expect(await screen.findByText("Personality settings saved locally.")).toBeTruthy();
    expect(saved).toMatchObject({
      name: "The Guide",
      communication_style: "professional",
      response_length: "detailed",
      custom_instructions: "Explain unfamiliar terms.",
    });
    firstRender.unmount();
    render(<PersonalitySettings />);
    fireEvent.click(await screen.findByText("Digital personality"));
    expect(await screen.findByDisplayValue("The Guide")).toBeTruthy();
    expect(screen.getByLabelText("Communication style")).toHaveProperty(
      "value",
      "professional",
    );
    expect(screen.getByLabelText("Response length")).toHaveProperty(
      "value",
      "detailed",
    );
  });

  it("resets persisted settings to defaults", async () => {
    let saved = {
      ...defaultPersonality,
      name: "The Guide",
      communication_style: "casual",
      response_length: "concise",
      custom_instructions: "Use jokes.",
    };
    const fetchMock = vi.fn(async (input: string, init?: RequestInit) => {
      if (input === "/api/personality/reset" && init?.method === "POST") {
        saved = { ...defaultPersonality };
        return response(saved);
      }
      if (input === "/api/personality" && (!init?.method || init.method === "GET")) {
        return response(saved);
      }
      throw new Error(`Unexpected request: ${init?.method ?? "GET"} ${input}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<PersonalitySettings />);
    fireEvent.click(await screen.findByText("Digital personality"));

    fireEvent.click(screen.getByRole("button", { name: "Reset to defaults" }));

    expect(await screen.findByText("Personality reset to defaults.")).toBeTruthy();
    expect(saved).toEqual(defaultPersonality);
    expect(screen.getByDisplayValue("Digital Me")).toBeTruthy();
    expect(screen.getByLabelText("Communication style")).toHaveProperty(
      "value",
      "friendly",
    );
    expect(screen.getByLabelText("Response length")).toHaveProperty(
      "value",
      "balanced",
    );
  });

  it("saves deep reasoning and reports the assistant name", async () => {
    let saved = { ...defaultPersonality, name: "Nova" };
    const fetchMock = vi.fn(async (_input: string, init?: RequestInit) => {
      if (init?.method === "PUT") {
        saved = { ...JSON.parse(init.body as string), updated_at: "2026-11-27" };
      }
      return response(saved);
    });
    const onNameChange = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    render(<PersonalitySettings onNameChange={onNameChange} />);

    fireEvent.click(await screen.findByText("Digital personality"));
    const deepReasoning = await screen.findByRole("checkbox", {
      name: "Deep reasoning (slower, more careful answers)",
    });
    expect(await screen.findByDisplayValue("Nova")).toBeTruthy();
    expect((deepReasoning as HTMLInputElement).checked).toBe(false);
    expect(onNameChange).toHaveBeenCalledWith("Nova");

    fireEvent.click(deepReasoning);
    fireEvent.click(screen.getByRole("button", { name: "Save personality" }));

    expect(await screen.findByText("Personality settings saved locally.")).toBeTruthy();
    expect(saved).toMatchObject({ name: "Nova", deep_reasoning: true });
  });

  it("saves speaking as yourself, in the first person", async () => {
    let saved = { ...defaultPersonality, name: "Asha" };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: string, init?: RequestInit) => {
        if (init?.method === "PUT") {
          saved = { ...JSON.parse(init.body as string), updated_at: "2026-11-27" };
        }
        return response(saved);
      }),
    );
    render(<PersonalitySettings />);

    fireEvent.click(await screen.findByText("Digital personality"));
    await screen.findByDisplayValue("Asha");
    fireEvent.change(screen.getByLabelText("Speak as"), { target: { value: "self" } });
    expect(screen.getByRole("textbox", { name: "Your name" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Save personality" }));

    expect(await screen.findByText("Personality settings saved locally.")).toBeTruthy();
    expect(saved).toMatchObject({ name: "Asha", speaking_as: "self" });
  });
});
