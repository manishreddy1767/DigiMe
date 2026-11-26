import { useEffect, useRef } from "react";
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { VRMLoaderPlugin, type VRM } from "@pixiv/three-vrm";
import {
  getAvatarAnimationFrame,
  type AvatarAnimationState,
  type AvatarEmotion,
} from "./avatarAnimation";
import { createFallbackAvatar, disposeFallbackAvatar } from "./fallbackAvatar";

interface AvatarViewProps {
  state: AvatarAnimationState;
  emotion: AvatarEmotion;
  onLoaded: (source: "procedural" | "vrm") => void;
  onError: (message: string) => void;
  getAudioAmplitude: () => number | null;
}

const MODEL_URL = "/models/avatar.vrm";
const EXPRESSION_NAMES = [
  "neutral",
  "happy",
  "sad",
  "surprised",
  "relaxed",
  "lookUp",
  "aa",
  "blink",
] as const;

function AvatarView({
  state,
  emotion,
  onLoaded,
  onError,
  getAudioAmplitude,
}: AvatarViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const stateRef = useRef(state);
  const emotionRef = useRef(emotion);
  stateRef.current = state;
  emotionRef.current = emotion;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let disposed = false;
    let animationFrame = 0;
    let loadedVrm: VRM | null = null;
    const fallback = createFallbackAvatar();
    let head: THREE.Object3D | null = null;
    let headRestRotation: THREE.Euler | null = null;
    let bodyRestRotation: THREE.Euler | null = null;
    let elapsedSeconds = 0;
    const currentExpressionWeights: Record<(typeof EXPRESSION_NAMES)[number], number> = {
      neutral: 1,
      happy: 0,
      sad: 0,
      surprised: 0,
      relaxed: 0,
      lookUp: 0,
      aa: 0,
      blink: 0,
    };
    const scene = new THREE.Scene();
    scene.background = new THREE.Color("#151c2a");

    const camera = new THREE.PerspectiveCamera(32, 1, 0.1, 100);
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    container.appendChild(renderer.domElement);
    scene.add(fallback.group);

    scene.add(new THREE.HemisphereLight(0xc9dcff, 0x5c4a43, 2.1));
    const keyLight = new THREE.DirectionalLight(0xffffff, 2.2);
    keyLight.position.set(-2, 4, 4);
    scene.add(keyLight);

    const resize = () => {
      if (!container || disposed) return;
      const width = Math.max(container.clientWidth, 1);
      const height = Math.max(container.clientHeight, 1);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
      renderer.setSize(width, height, false);
    };
    const resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(container);
    resize();

    camera.position.set(0, 1.42, 4.7);
    camera.lookAt(0, 1.2, 0);
    onLoaded("procedural");

    const loader = new GLTFLoader();
    loader.register((parser) => new VRMLoaderPlugin(parser));
    if (import.meta.env.VITE_ENABLE_LOCAL_VRM === "true") {
      loader.load(
        MODEL_URL,
        (gltf) => {
          if (disposed) return;
          const vrm = gltf.userData.vrm;
          if (!vrm) {
            onError("The optional local VRM is incompatible; the procedural avatar remains active.");
            return;
          }
          loadedVrm = vrm;
          fallback.group.visible = false;
          scene.add(vrm.scene);
          const bounds = new THREE.Box3().setFromObject(vrm.scene);
          const size = bounds.getSize(new THREE.Vector3());
          const center = bounds.getCenter(new THREE.Vector3());
          vrm.scene.rotation.y = Math.PI;
          bodyRestRotation = vrm.scene.rotation.clone();
          head = vrm.humanoid.getNormalizedBoneNode("head");
          headRestRotation = head?.rotation.clone() ?? null;
          camera.position.set(
            center.x,
            center.y + size.y * 0.08,
            center.z + Math.max(size.y * 1.35, 1.5),
          );
          camera.lookAt(center.x, center.y + size.y * 0.08, center.z);
          onLoaded("vrm");
        },
        undefined,
        () => {
          if (!disposed) {
            onError("Could not load the optional local VRM; the procedural avatar remains active.");
          }
        },
      );
    }

    const clock = new THREE.Clock();
    const animate = () => {
      if (disposed) return;
      animationFrame = window.requestAnimationFrame(animate);
      const delta = clock.getDelta();
      elapsedSeconds += delta;
      const currentState = stateRef.current;
      const audioAmplitude = currentState === "speaking"
        ? getAudioAmplitude()
        : null;
      const frame = getAvatarAnimationFrame(
        currentState,
        elapsedSeconds,
        audioAmplitude,
        emotionRef.current,
      );
      if (!loadedVrm) fallback.update(frame, delta);
      if (loadedVrm) {
        const expressionManager = loadedVrm.expressionManager;
        if (expressionManager) {
          for (const name of EXPRESSION_NAMES) {
            currentExpressionWeights[name] = THREE.MathUtils.damp(
              currentExpressionWeights[name],
              frame.expressionWeights[name],
              7,
              delta,
            );
            expressionManager.setValue(name, currentExpressionWeights[name]);
          }
        }
        if (head && headRestRotation) {
          head.rotation.x = THREE.MathUtils.damp(
            head.rotation.x,
            headRestRotation.x + frame.headRotation.x,
            5,
            delta,
          );
          head.rotation.y = THREE.MathUtils.damp(
            head.rotation.y,
            headRestRotation.y + frame.headRotation.y,
            5,
            delta,
          );
          head.rotation.z = THREE.MathUtils.damp(
            head.rotation.z,
            headRestRotation.z + frame.headRotation.z,
            5,
            delta,
          );
        }
        if (bodyRestRotation) {
          loadedVrm.scene.rotation.set(
            bodyRestRotation.x,
            bodyRestRotation.y + frame.bodyYaw,
            bodyRestRotation.z,
            bodyRestRotation.order,
          );
        }
        loadedVrm.update(delta);
      }
      renderer.render(scene, camera);
    };
    animate();

    return () => {
      disposed = true;
      window.cancelAnimationFrame(animationFrame);
      resizeObserver.disconnect();
      disposeFallbackAvatar(fallback);
      renderer.dispose();
      renderer.domElement.remove();
    };
  }, [getAudioAmplitude, onError, onLoaded]);

  return (
    <div
      aria-label={`Digital human avatar, ${emotion} emotion, ${state} state`}
      className="avatar-canvas"
      data-avatar-state={state}
      data-avatar-emotion={emotion}
      ref={containerRef}
      role="img"
    />
  );
}

export default AvatarView;
