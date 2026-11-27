import { useEffect, useMemo, useRef, useState } from "react";

import type { AvatarEmotion } from "../avatar/avatarAnimation";
import type { AvatarManifest } from "./api";
import { FaceAnimator, frameName, pickFrame } from "./face";

type PhotoAvatarProps = {
  manifest: AvatarManifest;
  frameUrl: (name: string, version: number) => string;
  name: string;
  speaking: boolean;
  listening: boolean;
  emotion: AvatarEmotion;
  /** Loudness of the voice being played, 0..1, or null when it can't be measured. */
  level?: () => number | null;
};

const FIRST = frameName({ expression: "neutral", eyes: "open", mouth: "rest" });

const reducedMotion = () =>
  typeof window !== "undefined" &&
  window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

/**
 * Your photo avatar. Every pose was rendered once from the photo, so animating it only swaps
 * pre-loaded images: no GPU work while the language model is busy.
 */
function PhotoAvatar({
  manifest,
  frameUrl,
  name,
  speaking,
  listening,
  emotion,
  level,
}: PhotoAvatarProps) {
  const img = useRef<HTMLImageElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const [loaded, setLoaded] = useState<ReadonlySet<string>>(new Set());
  const url = (frame: string) => frameUrl(frame, manifest.version);

  // Preload every frame; the neutral face first so something shows straight away.
  useEffect(() => {
    let cancelled = false;
    const done = new Set<string>();
    setLoaded(new Set());
    const order = [FIRST, ...manifest.frames.filter((frame) => frame !== FIRST)].filter((frame) =>
      manifest.frames.includes(frame),
    );
    for (const frame of order) {
      const image = new Image();
      image.onload = () => {
        if (cancelled) return;
        done.add(frame);
        setLoaded(new Set(done));
      };
      image.src = url(frame);
    }
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reload only for a new avatar
  }, [manifest]);

  const inputs = useRef({ speaking, listening, emotion, level, loaded });
  inputs.current = { speaking, listening, emotion, level, loaded };
  const animator = useMemo(() => new FaceAnimator(), []);

  useEffect(() => {
    const still = reducedMotion();
    let frame = 0;
    let shown = "";
    const tick = (now: number) => {
      const current = inputs.current;
      const loudness = current.speaking && current.level ? (current.level() ?? 0) : 0;
      const pose = animator.step(now, {
        speaking: current.speaking,
        level: Math.min(1, loudness / 0.65),
        emotion: current.emotion,
      });
      const next = pickFrame(pose, current.loaded);
      if (next && next !== shown && img.current) {
        img.current.src = url(next);
        shown = next;
      }
      if (body.current && !still) {
        // slow breathing and a slight sway, so the face never looks frozen
        const s = now / 1000;
        const lean = current.listening ? 1.012 : 1;
        body.current.style.transform =
          `translate(${(Math.sin(s * 0.5) * 2).toFixed(2)}px, ${(Math.sin(s * 1.3) * 1.5).toFixed(2)}px) ` +
          `rotate(${(Math.sin(s * 0.37) * 0.4).toFixed(3)}deg) scale(${(lean + Math.sin(s * 1.3) * 0.004).toFixed(4)})`;
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- url depends only on the manifest
  }, [animator, manifest]);

  return (
    <div className="photo-avatar" data-ready={loaded.has(FIRST)} data-testid="photo-avatar">
      <div className="photo-avatar__body" ref={body}>
        <img
          alt={`${name}'s avatar`}
          className="photo-avatar__face"
          draggable={false}
          height={manifest.height}
          ref={img}
          src={loaded.has(FIRST) ? url(FIRST) : undefined}
          width={manifest.width}
        />
      </div>
    </div>
  );
}

export default PhotoAvatar;
