export type AvatarEmotion = "neutral" | "happy" | "sad" | "curious";

export type AvatarAnimationState =
  | "idle"
  | "thinking"
  | "speaking"
  | AvatarEmotion;

export interface AvatarAnimationFrame {
  emotion: AvatarEmotion;
  expressionWeights: {
    neutral: number;
    happy: number;
    sad: number;
    surprised: number;
    relaxed: number;
    lookUp: number;
    aa: number;
    blink: number;
  };
  eyeGaze: {
    x: number;
    y: number;
  };
  browLift: number;
  browTilt: {
    left: number;
    right: number;
  };
  mouth: {
    open: number;
    width: number;
    smile: number;
  };
  headRotation: {
    x: number;
    y: number;
    z: number;
  };
  bodyYaw: number;
  shoulderRoll: number;
}

const SAD_RESPONSE_CUES =
  /\b(?:i'm sorry to hear|i am sorry to hear|sorry for your loss|my condolences|that's heartbreaking|that is heartbreaking|heartbroken|that sounds painful|that sounds difficult|must be difficult|sorry you're going through)\b/i;
const HAPPY_RESPONSE_CUES =
  /\b(?:congratulations|congrats|that's fantastic|that is fantastic|wonderful news|great news|i'm glad|i am glad|happy for you|well done|you did it|exciting milestone)\b/i;

export function inferAvatarEmotion(text: string): AvatarEmotion {
  const response = text.trim();
  if (!response) return "neutral";
  if (SAD_RESPONSE_CUES.test(response)) return "sad";
  if (HAPPY_RESPONSE_CUES.test(response)) return "happy";
  if (/\?\s*(?:["'”’)\]]*)\s*$/.test(response)) return "curious";
  return "neutral";
}

function getBlink(elapsedSeconds: number): number {
  const period = 5.6;
  const duration = 0.16;
  const cycleTime = elapsedSeconds % period;
  let blink = 0;
  for (const start of [0, 2.7, 4.8]) {
    const phase = cycleTime - start;
    if (phase >= 0 && phase < duration) {
      blink = Math.max(blink, Math.sin((Math.PI * phase) / duration));
    }
  }
  return blink;
}

function resolveEmotion(
  state: AvatarAnimationState,
  emotion: AvatarEmotion,
): AvatarEmotion {
  if (state === "thinking") return "neutral";
  if (
    state === "neutral" ||
    state === "happy" ||
    state === "sad" ||
    state === "curious"
  ) {
    return state;
  }
  return emotion;
}

export function getAvatarAnimationFrame(
  state: AvatarAnimationState,
  elapsedSeconds: number,
  audioAmplitude: number | null = null,
  emotion: AvatarEmotion = "neutral",
): AvatarAnimationFrame {
  const currentEmotion = resolveEmotion(state, emotion);
  const thinking = state === "thinking";
  const speaking = state === "speaking";
  const blink = getBlink(elapsedSeconds);
  const amplitude = audioAmplitude === null
    ? 0
    : Math.max(0, Math.min((audioAmplitude - 0.02) * 1.5, 0.65));
  const idleGazeX =
    Math.sin(elapsedSeconds * 0.37) * 0.055 +
    Math.sin(elapsedSeconds * 0.83) * 0.018;
  const idleGazeY = Math.sin(elapsedSeconds * 0.23) * 0.035;

  return {
    emotion: currentEmotion,
    expressionWeights: {
      neutral: currentEmotion === "neutral" && !thinking ? 1 : 0,
      happy: currentEmotion === "happy" ? 0.42 : 0,
      sad: currentEmotion === "sad" ? 0.4 : 0,
      surprised: currentEmotion === "curious" ? 0.18 : 0,
      relaxed: thinking ? 0.12 : 0,
      lookUp: thinking ? 0.14 : currentEmotion === "curious" ? 0.08 : 0,
      aa: speaking ? amplitude : 0,
      blink,
    },
    eyeGaze: {
      x: thinking ? 0.1 : idleGazeX,
      y: thinking || currentEmotion === "curious" ? 0.055 + idleGazeY : idleGazeY,
    },
    browLift: thinking
      ? 0.015
      : currentEmotion === "happy"
        ? 0.025
        : currentEmotion === "sad"
          ? -0.035
          : currentEmotion === "curious"
            ? 0.04
            : 0,
    browTilt: {
      left: thinking ? -0.08 : currentEmotion === "sad" ? 0.16 : currentEmotion === "curious" ? 0.06 : 0,
      right: thinking ? 0.08 : currentEmotion === "sad" ? -0.16 : currentEmotion === "curious" ? -0.12 : 0,
    },
    mouth: {
      open: speaking ? amplitude : currentEmotion === "curious" ? 0.08 : 0,
      width: currentEmotion === "happy" ? 1.18 : currentEmotion === "sad" ? 0.88 : 1,
      smile: currentEmotion === "happy" ? 0.035 : currentEmotion === "sad" ? -0.025 : 0,
    },
    headRotation: {
      x: Math.sin(elapsedSeconds * 0.48) * 0.012 + (thinking ? -0.035 : 0),
      y: Math.sin(elapsedSeconds * 0.31) * 0.025,
      z: currentEmotion === "curious" ? -0.075 : currentEmotion === "sad" ? 0.025 : 0,
    },
    bodyYaw: Math.sin(elapsedSeconds * 0.24) * 0.012,
    shoulderRoll: Math.sin(elapsedSeconds * 0.52) * 0.009,
  };
}
