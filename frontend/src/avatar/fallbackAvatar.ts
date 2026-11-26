import * as THREE from "three";
import type { AvatarAnimationFrame } from "./avatarAnimation";

export interface FallbackAvatar {
  group: THREE.Group;
  update: (frame: AvatarAnimationFrame, delta: number) => void;
}

function createMesh(
  geometry: THREE.BufferGeometry,
  material: THREE.Material,
): THREE.Mesh {
  return new THREE.Mesh(geometry, material);
}

function createEye(x: number, materials: {
  white: THREE.Material;
  iris: THREE.Material;
  pupil: THREE.Material;
}, name: string): { group: THREE.Group; gaze: THREE.Group } {
  const group = new THREE.Group();
  group.name = name;
  group.position.set(x, 0.06, 0.42);
  const white = createMesh(
    new THREE.SphereGeometry(0.105, 20, 14),
    materials.white,
  );
  white.scale.set(1, 0.68, 0.4);
  group.add(white);

  const gaze = new THREE.Group();
  const iris = createMesh(new THREE.SphereGeometry(0.047, 18, 12), materials.iris);
  iris.position.z = 0.035;
  const pupil = createMesh(new THREE.SphereGeometry(0.023, 14, 10), materials.pupil);
  pupil.position.z = 0.068;
  gaze.add(iris, pupil);
  group.add(gaze);
  return { group, gaze };
}

export function createFallbackAvatar(): FallbackAvatar {
  const group = new THREE.Group();
  group.name = "Digital Me procedural avatar";

  const skin = new THREE.MeshStandardMaterial({ color: "#d9a985", roughness: 0.82 });
  const hair = new THREE.MeshStandardMaterial({ color: "#392b2c", roughness: 0.9 });
  const clothing = new THREE.MeshStandardMaterial({ color: "#344c70", roughness: 0.94 });
  const eyeWhite = new THREE.MeshStandardMaterial({ color: "#f6eee7", roughness: 0.62 });
  const iris = new THREE.MeshStandardMaterial({ color: "#536c78", roughness: 0.48 });
  const pupil = new THREE.MeshStandardMaterial({ color: "#1d242a", roughness: 0.4 });
  const brow = new THREE.MeshStandardMaterial({ color: "#493337", roughness: 0.86 });
  const mouthMaterial = new THREE.MeshStandardMaterial({
    color: "#753f45",
    roughness: 0.68,
  });

  const body = new THREE.Group();
  body.name = "fallback-body";
  const torso = createMesh(new THREE.SphereGeometry(1, 32, 24), clothing);
  torso.position.y = 0.36;
  torso.scale.set(0.74, 0.8, 0.44);
  body.add(torso);

  const shoulderGeometry = new THREE.SphereGeometry(1, 24, 18);
  for (const side of [-1, 1]) {
    const shoulder = createMesh(shoulderGeometry, clothing);
    shoulder.position.set(side * 0.48, 0.57, 0);
    shoulder.scale.set(0.46, 0.28, 0.38);
    body.add(shoulder);
  }
  group.add(body);

  const neck = createMesh(
    new THREE.CylinderGeometry(0.22, 0.27, 0.42, 24),
    skin,
  );
  neck.position.y = 1.05;
  group.add(neck);

  const head = new THREE.Group();
  head.name = "fallback-head";
  head.position.y = 1.58;
  const face = createMesh(new THREE.SphereGeometry(1, 36, 28), skin);
  face.scale.set(0.56, 0.66, 0.48);
  head.add(face);

  const hairCap = createMesh(new THREE.SphereGeometry(1, 32, 20), hair);
  hairCap.position.set(0, 0.28, -0.015);
  hairCap.scale.set(0.57, 0.43, 0.49);
  head.add(hairCap);
  for (const side of [-1, 1]) {
    const lock = createMesh(new THREE.SphereGeometry(1, 20, 16), hair);
    lock.position.set(side * 0.43, 0.04, 0.01);
    lock.scale.set(0.15, 0.42, 0.39);
    head.add(lock);

    const ear = createMesh(new THREE.SphereGeometry(0.13, 16, 12), skin);
    ear.position.set(side * 0.54, -0.06, 0);
    ear.scale.set(0.75, 1, 0.55);
    head.add(ear);
  }

  const eyes = [
    createEye(-0.2, { white: eyeWhite, iris, pupil }, "fallback-eye-left"),
    createEye(0.2, { white: eyeWhite, iris, pupil }, "fallback-eye-right"),
  ];
  head.add(...eyes.map((eye) => eye.group));

  const browPivots = [-0.2, 0.2].map((x) => {
    const pivot = new THREE.Group();
    pivot.position.set(x, 0.23, 0.47);
    const eyebrow = createMesh(new THREE.SphereGeometry(1, 18, 12), brow);
    eyebrow.scale.set(0.16, 0.035, 0.035);
    pivot.add(eyebrow);
    head.add(pivot);
    return pivot;
  });

  const nose = createMesh(new THREE.SphereGeometry(1, 16, 12), skin);
  nose.position.set(0, -0.12, 0.47);
  nose.scale.set(0.045, 0.075, 0.06);
  head.add(nose);

  const mouth = createMesh(new THREE.SphereGeometry(1, 20, 14), mouthMaterial);
  mouth.name = "fallback-mouth";
  mouth.position.set(0, -0.29, 0.45);
  mouth.scale.set(0.18, 0.025, 0.025);
  head.add(mouth);
  group.add(head);

  const damp = (current: number, target: number, rate: number, delta: number) =>
    THREE.MathUtils.damp(current, target, rate, delta);

  return {
    group,
    update(frame, delta) {
      head.rotation.x = damp(head.rotation.x, frame.headRotation.x, 6, delta);
      head.rotation.y = damp(head.rotation.y, frame.headRotation.y, 6, delta);
      head.rotation.z = damp(head.rotation.z, frame.headRotation.z, 6, delta);
      group.rotation.y = damp(group.rotation.y, frame.bodyYaw, 4, delta);
      body.rotation.z = damp(body.rotation.z, frame.shoulderRoll, 4, delta);

      const eyeScaleY = Math.max(0.1, 1 - frame.expressionWeights.blink * 0.9);
      for (const eye of eyes) {
        eye.group.scale.y = damp(eye.group.scale.y, eyeScaleY, 24, delta);
        eye.gaze.position.x = damp(eye.gaze.position.x, frame.eyeGaze.x, 7, delta);
        eye.gaze.position.y = damp(eye.gaze.position.y, frame.eyeGaze.y, 7, delta);
      }

      for (let index = 0; index < browPivots.length; index += 1) {
        const pivot = browPivots[index];
        const targetRotation = index === 0
          ? frame.browTilt.left
          : frame.browTilt.right;
        pivot.rotation.z = damp(pivot.rotation.z, targetRotation, 7, delta);
        pivot.position.y = damp(
          pivot.position.y,
          0.23 + frame.browLift,
          7,
          delta,
        );
      }

      mouth.scale.x = damp(mouth.scale.x, 0.18 * frame.mouth.width, 9, delta);
      mouth.scale.y = damp(mouth.scale.y, 0.025 + frame.mouth.open * 0.16, 18, delta);
      mouth.position.y = damp(mouth.position.y, -0.29 + frame.mouth.smile, 7, delta);
    },
  };
}

export function disposeFallbackAvatar(fallback: FallbackAvatar): void {
  const geometries = new Set<THREE.BufferGeometry>();
  const materials = new Set<THREE.Material>();
  fallback.group.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    geometries.add(object.geometry);
    if (Array.isArray(object.material)) {
      object.material.forEach((material) => materials.add(material));
    } else {
      materials.add(object.material);
    }
  });
  geometries.forEach((geometry) => geometry.dispose());
  materials.forEach((material) => material.dispose());
}
