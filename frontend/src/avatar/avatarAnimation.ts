export type AvatarAnimationState = "idle" | "happy" | "thinking" | "speaking";

export const SPEAKING_DISPLAY_DURATION_MS = 1_200;

export interface AvatarAnimationFrame {
  expressionWeights: {
    neutral: number;
    happy: number;
    relaxed: number;
    lookUp: number;
    aa: number;
    blink: number;
  };
  headRotation: {
    x: number;
    y: number;
    z: number;
  };
  bodyYaw: number;
}

export function getAvatarAnimationFrame(
  state: AvatarAnimationState,
  elapsedSeconds: number,
): AvatarAnimationFrame {
  const blinkPeriod = 4.2;
  const blinkDuration = 0.18;
  const blinkPhase = elapsedSeconds % blinkPeriod;
  const blink = blinkPhase < blinkDuration
    ? Math.sin((Math.PI * blinkPhase) / blinkDuration)
    : 0;

  return {
    expressionWeights: {
      neutral: state === "idle" ? 1 : 0,
      happy: state === "happy" ? 0.28 : 0,
      relaxed: state === "thinking" ? 0.12 : 0,
      lookUp: state === "thinking" ? 0.14 : 0,
      aa: state === "speaking" ? 0.08 + 0.05 * Math.sin(elapsedSeconds * 8) : 0,
      blink,
    },
    headRotation: {
      x: Math.sin(elapsedSeconds * 0.65) * 0.008,
      y: Math.sin(elapsedSeconds * 0.4) * 0.012,
      z: state === "thinking" ? -0.045 : 0,
    },
    bodyYaw: Math.sin(elapsedSeconds * 0.3) * 0.008,
  };
}
