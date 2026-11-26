import { describe, expect, it } from "vitest";
import { getAvatarAnimationFrame } from "./avatarAnimation";

describe("VRM expression targets", () => {
  it("uses a neutral face with a smooth periodic blink while idle", () => {
    const frame = getAvatarAnimationFrame("idle", 0.09);

    expect(frame.expressionWeights.neutral).toBe(1);
    expect(frame.expressionWeights.happy).toBe(0);
    expect(frame.expressionWeights.blink).toBeCloseTo(1);
    expect(Math.abs(frame.bodyYaw)).toBeLessThanOrEqual(0.008);
  });

  it("keeps happy, thinking and speaking expressions distinct and subtle", () => {
    const happy = getAvatarAnimationFrame("happy", 1);
    const thinking = getAvatarAnimationFrame("thinking", 1);
    const speaking = getAvatarAnimationFrame("speaking", 1);

    expect(happy.expressionWeights.happy).toBe(0.28);
    expect(thinking.expressionWeights.relaxed).toBe(0.12);
    expect(thinking.expressionWeights.lookUp).toBe(0.14);
    expect(speaking.expressionWeights.aa).toBeGreaterThan(0);
    expect(speaking.expressionWeights.aa).toBeLessThan(0.14);
  });
});
