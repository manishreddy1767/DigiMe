import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import AvatarView from "./AvatarView";
import * as THREE from "three";

const rendererState = vi.hoisted(() => ({
  renderScene: vi.fn(),
  loadVrm: vi.fn(),
}));

vi.mock("three", async (importOriginal) => {
  const actual = await importOriginal<typeof import("three")>();
  return {
    ...actual,
    WebGLRenderer: class {
      domElement = document.createElement("canvas");
      outputColorSpace = "";
      setClearColor = vi.fn();
      setPixelRatio = vi.fn();
      setSize = vi.fn();
      render(scene: THREE.Scene) {
        rendererState.renderScene(scene);
      }
      dispose = vi.fn();
    },
  };
});

vi.mock("three/addons/loaders/GLTFLoader.js", () => ({
  GLTFLoader: class {
    register() {}
    load() {
      rendererState.loadVrm();
    }
  },
}));

vi.mock("@pixiv/three-vrm", () => ({
  VRMLoaderPlugin: class {},
}));

class TestResizeObserver {
  observe() {}
  disconnect() {}
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  rendererState.renderScene.mockClear();
  rendererState.loadVrm.mockClear();
});

describe("AvatarView fallback", () => {
  it("renders the procedural avatar without requesting an optional VRM", () => {
    vi.stubGlobal("ResizeObserver", TestResizeObserver);
    vi.spyOn(window, "requestAnimationFrame").mockReturnValue(1);
    const onLoaded = vi.fn();
    const onError = vi.fn();

    render(
      <AvatarView
        emotion="neutral"
        getAudioAmplitude={() => null}
        onError={onError}
        onLoaded={onLoaded}
        state="idle"
      />,
    );

    const scene = rendererState.renderScene.mock.calls[0][0] as THREE.Scene;
    expect(scene.getObjectByName("Digital Me procedural avatar")?.visible).toBe(true);
    expect(screen.getByRole("img").getAttribute("data-avatar-state")).toBe("idle");
    expect(onLoaded).toHaveBeenCalledWith("procedural");
    expect(onError).not.toHaveBeenCalled();
    expect(rendererState.loadVrm).not.toHaveBeenCalled();
  });
});
