import logging
import math
import struct
from functools import lru_cache

EMBEDDING_MODEL = "sentence-transformers/all-MiniLM-L6-v2"
EMBEDDING_DIMENSIONS = 384
_VECTOR_FORMAT = f"<{EMBEDDING_DIMENSIONS}f"
_LOGGER = logging.getLogger(__name__)


class MemoryEmbeddingService:
    def __init__(self) -> None:
        self._model = None
        self._load_error: str | None = None

    def embed(self, text: str) -> bytes:
        if not text.strip():
            raise ValueError("Cannot create an embedding for blank text.")
        if self._load_error:
            raise RuntimeError(self._load_error)

        if self._model is None:
            try:
                from sentence_transformers import SentenceTransformer
            except ImportError as error:
                self._load_error = (
                    'Install local memory dependencies with: '
                    'python -m pip install -e ".[memory]".'
                )
                raise RuntimeError(self._load_error) from error

            try:
                self._model = SentenceTransformer(
                    EMBEDDING_MODEL,
                    device="cpu",
                    local_files_only=True,
                )
            except (OSError, RuntimeError, ValueError) as error:
                self._load_error = (
                    f"Could not load the local {EMBEDDING_MODEL} model. "
                    "Install the memory extra and download its weights once."
                )
                raise RuntimeError(self._load_error) from error

        try:
            vector = self._model.encode(
                text,
                normalize_embeddings=True,
                convert_to_numpy=True,
                show_progress_bar=False,
            )
            values = [float(value) for value in vector.tolist()]
        except (OSError, RuntimeError, ValueError) as error:
            raise RuntimeError("Could not generate a local memory embedding.") from error

        if len(values) != EMBEDDING_DIMENSIONS or not all(
            math.isfinite(value) for value in values
        ):
            raise RuntimeError("The local embedding model returned an invalid vector.")

        return struct.pack(_VECTOR_FORMAT, *values)


@lru_cache(maxsize=1)
def get_memory_embedding_service() -> MemoryEmbeddingService:
    return MemoryEmbeddingService()


def try_embed_text(text: str) -> tuple[bytes | None, str | None]:
    try:
        return get_memory_embedding_service().embed(text), None
    except RuntimeError as error:
        _LOGGER.warning("Memory embeddings unavailable; using FTS5 fallback: %s", error)
        return None, str(error)
