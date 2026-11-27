import type { AvatarEmotion } from "../avatar/avatarAnimation";

// Mirrors backend/app/services/avatar/poses.py: the frames rendered from the photo.
export const MOUTHS = ["rest", "open1", "open2", "open3", "oo", "ee"] as const;
export const EYES = ["open", "half", "closed"] as const;
export const EXPRESSIONS = ["neutral", "happy", "surprised", "concerned"] as const;

export type Mouth = (typeof MOUTHS)[number];
export type Eyes = (typeof EYES)[number];
export type Expression = (typeof EXPRESSIONS)[number];

/** Digital Me's reply emotions mapped onto the rendered expressions. */
export const EMOTION_EXPRESSIONS: Record<AvatarEmotion, Expression> = {
  neutral: "neutral",
  happy: "happy",
  sad: "concerned",
  curious: "surprised",
};

export interface Pose {
  expression: Expression;
  eyes: Eyes;
  mouth: Mouth;
}

export const frameName = ({ expression, eyes, mouth }: Pose) => `${expression}-${eyes}-${mouth}.jpg`;

/** The frame to show, or the closest one the avatar has if some poses are missing. */
export function pickFrame(pose: Pose, available: ReadonlySet<string>): string | null {
  const candidates = [
    pose,
    { ...pose, eyes: "open" as const },
    { ...pose, expression: "neutral" as const },
    { ...pose, expression: "neutral" as const, eyes: "open" as const },
    { expression: "neutral" as const, eyes: "open" as const, mouth: "rest" as const },
  ];
  for (const candidate of candidates) {
    const name = frameName(candidate);
    if (available.has(name)) return name;
  }
  return available.values().next().value ?? null;
}

export interface FaceInput {
  speaking: boolean;
  /** Loudness of the voice, 0..1. */
  level: number;
  emotion: AvatarEmotion;
}

export const MOUTH_HOLD_MS = 70; // shortest time a mouth shape is shown, so it doesn't flicker
const BLINK: { until: number; eyes: Eyes }[] = [
  { until: 50, eyes: "half" },
  { until: 120, eyes: "closed" },
  { until: 180, eyes: "half" },
];
const BLINK_DURATION = 180;

/** Decides, frame by frame, which face to show. Pure apart from the random source. */
export class FaceAnimator {
  private smoothed = 0;
  private mouth: Mouth = "rest";
  private mouthSince = -Infinity;
  private blinkAt: number | null = null;
  private nextBlink: number | null = null;

  constructor(private readonly random: () => number = Math.random) {}

  step(now: number, { speaking, level, emotion }: FaceInput): Pose {
    return {
      expression: EMOTION_EXPRESSIONS[emotion],
      eyes: this.eyes(now),
      mouth: this.mouthAt(now, speaking ? level : 0),
    };
  }

  private mouthAt(now: number, level: number): Mouth {
    // fast attack, slower release, like a VU meter
    this.smoothed += (level - this.smoothed) * (level > this.smoothed ? 0.6 : 0.3);
    if (now - this.mouthSince < MOUTH_HOLD_MS) return this.mouth;
    const loud = this.smoothed;
    let next: Mouth = loud < 0.08 ? "rest" : loud < 0.25 ? "open1" : loud < 0.5 ? "open2" : "open3";
    // A new syllable sometimes gets a rounded or wide vowel, so speech doesn't look like a
    // mouth that only opens and shuts.
    const opening =
      (this.mouth === "rest" || this.mouth === "open1") && (next === "open2" || next === "open3");
    if (opening) {
      const r = this.random();
      if (r < 0.2) next = "oo";
      else if (r < 0.4) next = "ee";
    } else if ((this.mouth === "oo" || this.mouth === "ee") && next !== "rest" && next !== "open1") {
      next = this.mouth; // hold the vowel for the rest of the syllable
    }
    if (next !== this.mouth) {
      this.mouth = next;
      this.mouthSince = now;
    }
    return this.mouth;
  }

  private eyes(now: number): Eyes {
    this.nextBlink ??= now + this.blinkGap();
    if (this.blinkAt === null && now >= this.nextBlink) {
      this.blinkAt = now;
      // sometimes a quick double blink, like people do
      this.nextBlink =
        now + (this.random() < 0.15 ? BLINK_DURATION + 120 : BLINK_DURATION + this.blinkGap());
    }
    if (this.blinkAt === null) return "open";
    const t = now - this.blinkAt;
    const phase = BLINK.find((p) => t < p.until);
    if (!phase) {
      this.blinkAt = null;
      return "open";
    }
    return phase.eyes;
  }

  private blinkGap(): number {
    return 2500 + this.random() * 3500;
  }
}
