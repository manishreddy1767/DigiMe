"""The set of face poses rendered once from the uploaded photo.

The browser animates the avatar by switching between these pre-rendered frames, so talking
costs no GPU time while the language model is busy. Every combination of mouth, eyes and
expression is rendered, so a blink or a smile can happen while talking.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass

# Mouth shapes: closed, three openings for loudness, and two vowel shapes for variety.
MOUTHS: dict[str, dict[str, float]] = {
    "rest": {},
    "open1": {"lip_open": 0.12},
    "open2": {"lip_open": 0.25},
    "open3": {"lip_open": 0.4},
    "oo": {"lip_open": 0.18, "pout": 12.0},
    "ee": {"lip_open": 0.12, "grin": 8.0},
}

# Eye openness; None keeps the eyes as they are in the photo.
EYES: dict[str, float | None] = {"open": None, "half": 0.15, "closed": 0.0}

EXPRESSIONS: dict[str, dict[str, float]] = {
    "neutral": {},
    "happy": {"smile": 0.9},
    "surprised": {"eyebrow": 20.0},
    "concerned": {"eyebrow": -10.0},
}

# The six conversation emotions mapped onto the rendered expressions.
EMOTION_EXPRESSIONS = {
    "neutral": "neutral",
    "serious": "neutral",
    "happy": "happy",
    "surprised": "surprised",
    "sad": "concerned",
    "empathetic": "concerned",
}


@dataclass(frozen=True)
class Pose:
    mouth: str
    eyes: str
    expression: str

    @property
    def file(self) -> str:
        return f"{self.expression}-{self.eyes}-{self.mouth}.jpg"

    def controls(self) -> dict[str, float | None]:
        """LivePortrait controls for this pose (see the render script)."""
        return {**MOUTHS[self.mouth], **EXPRESSIONS[self.expression], "eye_open": EYES[self.eyes]}


def all_poses() -> list[Pose]:
    return [Pose(m, e, x) for x in EXPRESSIONS for e in EYES for m in MOUTHS]


def render_plan() -> list[dict]:
    """What the render script needs: one entry per frame."""
    return [{**asdict(p), "file": p.file, "controls": p.controls()} for p in all_poses()]
