import { useEffect, useRef } from "react";
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { VRMLoaderPlugin } from "@pixiv/three-vrm";

interface AvatarViewProps {
  onLoaded: () => void;
  onError: (message: string) => void;
}

const MODEL_URL = "/models/avatar.vrm";

function AvatarView({ onLoaded, onError }: AvatarViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let disposed = false;
    let animationFrame = 0;
    let loadedVrm: { update: (delta: number) => void; scene: THREE.Object3D } | null = null;
    const scene = new THREE.Scene();
    scene.background = new THREE.Color("#151c2a");

    const camera = new THREE.PerspectiveCamera(32, 1, 0.1, 100);
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    container.appendChild(renderer.domElement);

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

    const loader = new GLTFLoader();
    loader.register((parser) => new VRMLoaderPlugin(parser));
    loader.load(
      MODEL_URL,
      (gltf) => {
        if (disposed) return;
        const vrm = gltf.userData.vrm;
        if (!vrm) {
          onError("The local file loaded, but it does not contain a compatible VRM model.");
          return;
        }
        loadedVrm = vrm;
        scene.add(vrm.scene);
        const bounds = new THREE.Box3().setFromObject(vrm.scene);
        const size = bounds.getSize(new THREE.Vector3());
        const center = bounds.getCenter(new THREE.Vector3());
        vrm.scene.rotation.y = Math.PI;
        camera.position.set(
          center.x,
          center.y + size.y * 0.08,
          center.z + Math.max(size.y * 1.35, 1.5),
        );
        camera.lookAt(center.x, center.y + size.y * 0.08, center.z);
        onLoaded();
      },
      undefined,
      () => {
        if (!disposed) {
          onError(
            "No compatible local VRM found. Place one at frontend/public/models/avatar.vrm.",
          );
        }
      },
    );

    const clock = new THREE.Clock();
    const animate = () => {
      if (disposed) return;
      animationFrame = window.requestAnimationFrame(animate);
      loadedVrm?.update(clock.getDelta());
      renderer.render(scene, camera);
    };
    animate();

    return () => {
      disposed = true;
      window.cancelAnimationFrame(animationFrame);
      resizeObserver.disconnect();
      renderer.dispose();
      renderer.domElement.remove();
    };
  }, [onError, onLoaded]);

  return <div className="avatar-canvas" ref={containerRef} />;
}

export default AvatarView;
