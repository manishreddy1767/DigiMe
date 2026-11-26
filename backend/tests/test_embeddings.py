import struct
from types import SimpleNamespace
from unittest.mock import Mock, patch

import pytest

from app.services.embeddings import (
    EMBEDDING_DIMENSIONS,
    EMBEDDING_MODEL,
    MemoryEmbeddingService,
    try_embed_text,
)


def test_embedding_model_is_loaded_once_on_cpu_and_vectors_are_normalized() -> None:
    vector = [0.0] * EMBEDDING_DIMENSIONS
    vector[0] = 1.0
    fake_model = SimpleNamespace(
        encode=Mock(return_value=SimpleNamespace(tolist=lambda: vector))
    )
    model_factory = Mock(return_value=fake_model)
    service = MemoryEmbeddingService()

    with patch.dict(
        "sys.modules",
        {"sentence_transformers": SimpleNamespace(SentenceTransformer=model_factory)},
    ):
        first = service.embed("Mountain hiking")
        second = service.embed("Coastal walking")

    assert len(first) == EMBEDDING_DIMENSIONS * 4
    assert struct.unpack("<384f", first)[0] == 1.0
    assert second == first
    model_factory.assert_called_once_with(
        EMBEDDING_MODEL,
        device="cpu",
        local_files_only=True,
    )
    assert fake_model.encode.call_count == 2
    assert fake_model.encode.call_args.kwargs["normalize_embeddings"] is True


def test_embedding_failure_uses_explicit_fts_fallback(caplog) -> None:
    with patch(
        "app.services.embeddings.get_memory_embedding_service",
        return_value=SimpleNamespace(
            embed=Mock(side_effect=RuntimeError("Weights are unavailable."))
        ),
    ):
        vector, warning = try_embed_text("A local memory.")

    assert vector is None
    assert warning == "Weights are unavailable."
    assert "using FTS5 fallback" in caplog.text


def test_invalid_embedding_dimensions_are_rejected() -> None:
    fake_model = SimpleNamespace(
        encode=lambda *args, **kwargs: SimpleNamespace(tolist=lambda: [0.0])
    )
    service = MemoryEmbeddingService()
    service._model = fake_model

    with pytest.raises(RuntimeError, match="invalid vector"):
        service.embed("A local memory.")
