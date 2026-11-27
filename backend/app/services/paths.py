"""Where local model installs and private media live.

Models (LivePortrait, OpenVoice) are large, git-ignored installs under ``<repo>/models``, or
wherever ``DIGITAL_ME_MODELS_DIR`` points. Photos, recordings and rendered avatar frames are
private, so they live next to the SQLite database, outside the repository.
"""

import os
from pathlib import Path

from app.services.storage import get_database_path

REPO_ROOT = Path(__file__).resolve().parents[3]


def models_dir() -> Path:
    configured = os.environ.get("DIGITAL_ME_MODELS_DIR")
    return Path(configured).expanduser() if configured else REPO_ROOT / "models"


def private_media_dir(name: str) -> Path:
    """A private folder for avatar or voice files, next to the local database."""
    return get_database_path().parent / name
