"""Check and clean an uploaded avatar photo.

The photo is decoded and saved again as a plain JPEG: this rejects anything that isn't really an
image, applies the camera's rotation, shrinks very large photos, and drops all metadata (camera
details, GPS location, dates), so none of it is kept on disk.
"""

from __future__ import annotations

import io
import warnings

from PIL import Image, ImageOps, UnidentifiedImageError

MAX_BYTES = 20 * 1024 * 1024
MAX_PIXELS = 60_000_000  # refuse "decompression bombs" before decoding them
MIN_SIDE = 256
MAX_SIDE = 1600
FORMATS = {"JPEG", "PNG", "WEBP"}


class PhotoError(ValueError):
    """The upload can't be used as an avatar photo; the message is shown to the user."""


def clean_photo(data: bytes) -> bytes:
    if not data:
        raise PhotoError("The photo is empty")
    if len(data) > MAX_BYTES:
        raise PhotoError("The photo is too large (20 MB at most)")
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("error", Image.DecompressionBombWarning)
            image = Image.open(io.BytesIO(data))
            if image.format not in FORMATS:
                raise PhotoError("Please use a JPEG, PNG or WebP photo")
            if image.width * image.height > MAX_PIXELS:
                raise PhotoError("The photo has too many pixels")
            image.load()
    except PhotoError:
        raise
    except (UnidentifiedImageError, OSError, Image.DecompressionBombError, Image.DecompressionBombWarning):
        raise PhotoError("That file isn't a photo Digital Me can read") from None

    image = ImageOps.exif_transpose(image)
    if min(image.size) < MIN_SIDE:
        raise PhotoError(f"The photo is too small ({MIN_SIDE} pixels on each side at least)")
    image = image.convert("RGB")
    image.thumbnail((MAX_SIDE, MAX_SIDE), Image.Resampling.LANCZOS)
    out = io.BytesIO()
    image.save(out, format="JPEG", quality=92)  # no exif= argument: metadata is not written
    return out.getvalue()
