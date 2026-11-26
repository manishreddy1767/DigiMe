import { describe, expect, it } from "vitest";
import {
  getAvatarAnimationFrame,
  inferAvatarEmotion,
} from "./avatarAnimation";

describe("avatar response emotion", () => {
  it("uses only clear response cues and otherwise stays neutral", () => {
    expect(inferAvatarEmotion("The answer is 42.")).toBe("neutral");
    expect(inferAvatarEmotion("Congratulations, that's wonderful news!")).toBe("happy");
    expect(inferAvatarEmotion("I'm sorry to hear about your loss.")).toBe("sad");
    expect(inferAvatarEmotion("What would you like to try next?")).toBe("curious");
    expect(inferAvatarEmotion("")).toBe("neutral");
  });

  it("prefers clear emotional cues over a conversational follow-up question", () => {
    expect(inferAvatarEmotion("I'm sorry to hear that. How can I help?")).toBe("sad");
    expect(inferAvatarEmotion("Congratulations! What would you like to do next?"))
      .toBe("happy");
  });
});

describe("avatar animation frames", () => {
  it("adds a natural blink, gaze drift and restrained idle movement", () => {
    const frame = getAvatarAnimationFrame("idle", 0.09);

    expect(frame.emotion).toBe("neutral");
    expect(frame.expressionWeights.neutral).toBe(1);
    expect(frame.expressionWeights.blink).toBeGreaterThan(0.95);
    expect(frame.eyeGaze.x).not.toBe(0);
    expect(Math.abs(frame.bodyYaw)).toBeLessThanOrEqual(0.012);
    expect(Math.abs(frame.shoulderRoll)).toBeLessThanOrEqual(0.009);
  });

  it("maps happy, sad, curious and thinking states to distinct expressions", () => {
    const happy = getAvatarAnimationFrame("happy", 1);
    const sad = getAvatarAnimationFrame("sad", 1);
    const curious = getAvatarAnimationFrame("curious", 1);
    const thinking = getAvatarAnimationFrame("thinking", 1, null, "happy");

    expect(happy.expressionWeights.happy).toBe(0.42);
    expect(sad.expressionWeights.sad).toBe(0.4);
    expect(curious.expressionWeights.surprised).toBe(0.18);
    expect(curious.headRotation.z).toBe(-0.075);
    expect(thinking.expressionWeights.relaxed).toBe(0.12);
    expect(thinking.expressionWeights.lookUp).toBe(0.14);
    expect(thinking.emotion).toBe("neutral");
    expect(thinking.expressionWeights.happy).toBe(0);
    expect(thinking.browTilt.left).toBeLessThan(0);
  });

  it("uses measured playback amplitude and leaves the mouth closed without audio data", () => {
    const speaking = getAvatarAnimationFrame("speaking", 1, 0.4, "happy");
    const quiet = getAvatarAnimationFrame("speaking", 1, 0.01);
    const unavailable = getAvatarAnimationFrame("speaking", 1, null);

    expect(speaking.emotion).toBe("happy");
    expect(speaking.expressionWeights.aa).toBeCloseTo(0.57);
    expect(speaking.mouth.open).toBeCloseTo(0.57);
    expect(quiet.mouth.open).toBe(0);
    expect(unavailable.mouth.open).toBe(0);
  });
});
