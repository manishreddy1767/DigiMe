"""Render the avatar's face poses from one photo with LivePortrait.

This script runs in LivePortrait's own Python environment (which has a CUDA build of PyTorch),
not in the backend's, so it must not import digital_me. It reads a JSON plan of poses, writes
one JPEG per pose plus manifest.json, and reports progress on stdout as "progress <done> <total>".

    python lp_render.py --liveportrait DIR --photo PHOTO --plan PLAN.json --out DIR

The expression controls copy LivePortrait's own image-editing code (src/gradio_pipeline.py).
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

MAX_SIDE = 720  # output frames are at most this many pixels on the long side
FRAME_QUALITY = 88


class NoFaceError(Exception):
    pass


def apply_controls(exp, controls: dict) -> None:
    """Shift LivePortrait's expression keypoints in place (values from gradio_pipeline.py)."""
    smile = controls.get("smile", 0.0)
    if smile:
        for (k, axis), weight in {
            (20, 1): -0.01, (14, 1): -0.02, (17, 1): 0.0065, (17, 2): 0.003,
            (13, 1): -0.00275, (16, 1): -0.00275, (3, 1): -0.0035, (7, 1): -0.0035,
        }.items():
            exp[0, k, axis] += smile * weight
    pout = controls.get("pout", 0.0)
    if pout:
        for (k, axis), weight in {(14, 1): 0.001, (3, 1): -0.0005, (7, 1): -0.0005, (17, 2): -0.0005}.items():
            exp[0, k, axis] += pout * weight
    grin = controls.get("grin", 0.0)
    if grin:
        for (k, axis), weight in {(19, 1): 0.001, (19, 2): 0.0001, (17, 1): -0.0001}.items():
            exp[0, k, axis] += grin * weight
    eyebrow = controls.get("eyebrow", 0.0)
    if eyebrow > 0:
        exp[0, 1, 1] += eyebrow * 0.001
        exp[0, 2, 1] += eyebrow * -0.001
    elif eyebrow < 0:
        exp[0, 1, 0] += eyebrow * -0.001
        exp[0, 2, 0] += eyebrow * 0.001
        exp[0, 1, 1] += eyebrow * 0.0003
        exp[0, 2, 1] += eyebrow * -0.0003


def face_box(m_c2o, width: int, height: int, aspect: float = 0.8, margin: float = 1.15) -> tuple[int, int, int, int]:
    """Region of the photo to show: the face crop enlarged a little, as a portrait rectangle."""
    import numpy as np

    corners = np.array([[0, 0, 1], [512, 0, 1], [0, 512, 1], [512, 512, 1]], dtype=float)
    points = corners @ np.asarray(m_c2o)[:2].T
    cx, cy = points.mean(axis=0)
    side = (points.max(axis=0) - points.min(axis=0)).max() * margin
    h = min(side / aspect, height)
    w = min(h * aspect, width)
    h = w / aspect
    x0 = int(round(min(max(cx - w / 2, 0), width - w)))
    y0 = int(round(min(max(cy - h / 2, 0), height - h)))
    return x0, y0, int(w), int(h)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--liveportrait", required=True, type=Path)
    parser.add_argument("--photo", required=True, type=Path)
    parser.add_argument("--plan", required=True, type=Path)
    parser.add_argument("--out", required=True, type=Path)
    args = parser.parse_args(argv)

    sys.path.insert(0, str(args.liveportrait))
    import os

    os.chdir(args.liveportrait)  # LivePortrait finds its weights relative to its folder
    import cv2
    import torch
    from src.config.crop_config import CropConfig
    from src.config.inference_config import InferenceConfig
    from src.live_portrait_pipeline import LivePortraitPipeline
    from src.utils.crop import paste_back, prepare_paste_back
    from src.utils.io import load_image_rgb

    plan = json.loads(args.plan.read_text(encoding="utf-8"))
    args.out.mkdir(parents=True, exist_ok=True)
    pipeline = LivePortraitPipeline(InferenceConfig(), CropConfig())
    wrapper, cropper = pipeline.live_portrait_wrapper, pipeline.cropper

    image = load_image_rgb(str(args.photo))
    crop = cropper.crop_source_image(image, cropper.crop_cfg)
    if crop is None:
        raise NoFaceError("No face found in the photo")
    source = wrapper.prepare_source(crop["img_crop_256x256"])
    info = wrapper.get_kp_info(source)
    feature = wrapper.extract_feature_3d(source)
    keypoints = wrapper.transform_keypoint(info)
    landmarks = crop["lmk_crop"]
    mask = prepare_paste_back(wrapper.inference_cfg.mask_crop, crop["M_c2o"], dsize=(image.shape[1], image.shape[0]))
    x0, y0, w, h = face_box(crop["M_c2o"], image.shape[1], image.shape[0])
    scale = min(1.0, MAX_SIDE / max(w, h))
    size = (max(1, round(w * scale)), max(1, round(h * scale)))

    print(f"progress 0 {len(plan)}", flush=True)
    for done, pose in enumerate(plan, start=1):
        controls = pose["controls"]
        with torch.no_grad():
            exp = info["exp"].clone()
            apply_controls(exp, controls)
            driving = info["scale"] * (info["kp"] + exp) + info["t"]
            if controls.get("eye_open") is not None:
                ratio = wrapper.calc_combined_eye_ratio([[controls["eye_open"]]], landmarks)
                driving = driving + wrapper.retarget_eye(keypoints, ratio)
            if controls.get("lip_open") is not None:
                ratio = wrapper.calc_combined_lip_ratio([[controls["lip_open"]]], landmarks)
                driving = driving + wrapper.retarget_lip(keypoints, ratio)
            driving = wrapper.stitching(keypoints, driving)
            face = wrapper.parse_output(wrapper.warp_decode(feature, keypoints, driving)["out"])[0]
        frame = paste_back(face, crop["M_c2o"], image, mask)[y0:y0 + h, x0:x0 + w]
        frame = cv2.resize(frame, size, interpolation=cv2.INTER_AREA)
        cv2.imwrite(str(args.out / pose["file"]), cv2.cvtColor(frame, cv2.COLOR_RGB2BGR),
                    [cv2.IMWRITE_JPEG_QUALITY, FRAME_QUALITY])
        print(f"progress {done} {len(plan)}", flush=True)

    manifest = {"width": size[0], "height": size[1], "frames": [p["file"] for p in plan]}
    (args.out / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except NoFaceError as exc:
        print(f"error {exc}", flush=True)
        sys.exit(3)
