import { describe, expect, it } from "vitest";
import {
  getAvatarAnimationFrame,
} from "./avatarAnimation";
import { createFallbackAvatar, disposeFallbackAvatar } from "./fallbackAvatar";
import * as THREE from "three";

describe("procedural avatar fallback", () => {
  it("builds a visible Three.js avatar without a VRM asset", () => {
    const avatar = createFallbackAvatar();
    let meshCount = 0;
    avatar.group.traverse((object) => {
      if (object instanceof THREE.Mesh) meshCount += 1;
    });

    expect(avatar.group.visible).toBe(true);
    expect(meshCount).toBeGreaterThan(10);
    expect(avatar.group.getObjectByName("fallback-head")).toBeTruthy();
    expect(avatar.group.getObjectByName("fallback-eye-left")).toBeTruthy();
    expect(avatar.group.getObjectByName("fallback-mouth")).toBeTruthy();
    disposeFallbackAvatar(avatar);
  });

  it("smoothly moves the face and opens the mouth from playback amplitude", () => {
    const avatar = createFallbackAvatar();
    const head = avatar.group.getObjectByName("fallback-head") as THREE.Group;
    const mouth = avatar.group.getObjectByName("fallback-mouth") as THREE.Mesh;
    const target = getAvatarAnimationFrame("speaking", 0.5, 0.4, "curious");

    avatar.update(target, 0.016);

    expect(head.rotation.z).toBeLessThan(0);
    expect(head.rotation.z).toBeGreaterThan(target.headRotation.z);
    expect(mouth.scale.y).toBeGreaterThan(0.025);
    expect(mouth.scale.y).toBeLessThan(0.025 + target.mouth.open * 0.16);
    disposeFallbackAvatar(avatar);
  });

  it("animates blinking and gaze on the model-free face", () => {
    const avatar = createFallbackAvatar();
    const eye = avatar.group.getObjectByName("fallback-eye-left") as THREE.Group;
    const gaze = eye.children[1] as THREE.Group;

    avatar.update(getAvatarAnimationFrame("idle", 0.09), 0.016);

    expect(eye.scale.y).toBeLessThan(1);
    expect(gaze.position.x).not.toBe(0);
    disposeFallbackAvatar(avatar);
  });
});
