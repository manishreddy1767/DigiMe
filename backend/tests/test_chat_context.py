from app.services.chat_context import (
    MAX_MEMORY_SEARCH_QUERY_CHARS,
    build_answerability_guidance,
    build_memory_search_query,
    find_conflicting_memory_ids,
    format_approved_memory_context,
)


def test_memory_search_uses_recent_turns_for_follow_ups_only() -> None:
    messages = [
        {"role": "user", "content": "I work at a local library."},
        {"role": "assistant", "content": "You mentioned working at the library."},
        {"role": "user", "content": "What about that?"},
    ]

    follow_up_query = build_memory_search_query(messages)
    direct_query = build_memory_search_query(
        [{"role": "user", "content": "What is my favorite color?"}]
    )

    assert "What about that?" in follow_up_query
    assert "I work at a local library." in follow_up_query
    assert direct_query == "What is my favorite color?"


def test_memory_search_query_prioritizes_latest_message_and_stays_bounded() -> None:
    messages = [
        {"role": "user", "content": "Old detail " * 100},
        {"role": "assistant", "content": "Old response " * 100},
        {"role": "user", "content": "What about it? " + "x" * 100},
    ]

    query = build_memory_search_query(messages)

    assert len(query) <= MAX_MEMORY_SEARCH_QUERY_CHARS
    assert query.startswith(messages[-1]["content"])


def test_answerability_guidance_handles_unknown_personal_facts_and_ambiguous_references() -> None:
    guidance = build_answerability_guidance(
        [{"role": "user", "content": "What is my favorite color?"}],
        set(),
    )
    contracted_guidance = build_answerability_guidance(
        [{"role": "user", "content": "What's my favorite color?"}],
        set(),
    )
    ambiguous_guidance = build_answerability_guidance(
        [{"role": "user", "content": "What about that?"}],
        set(),
    )

    assert guidance is not None
    assert "If it is not stated, say you do not know rather than guessing." in guidance
    assert contracted_guidance is not None
    assert "say you do not know rather than guessing" in contracted_guidance
    assert ambiguous_guidance is not None
    assert "Do not invent the referent" in ambiguous_guidance


def test_conflicting_memories_are_marked_without_rewriting_the_saved_values() -> None:
    memories = [
        {"id": "seattle", "content": "I live in Seattle."},
        {"id": "portland", "content": "The user lives in Portland."},
        {"id": "hiking", "content": "I enjoy hiking."},
    ]

    conflicting_ids = find_conflicting_memory_ids(memories)
    context = format_approved_memory_context(memories, conflicting_ids)
    guidance = build_answerability_guidance(
        [{"role": "user", "content": "Where do I live?"}],
        conflicting_ids,
    )

    assert conflicting_ids == {"seattle", "portland"}
    assert context is not None
    assert "[potentially conflicting or outdated] I live in Seattle." in context
    assert "[potentially conflicting or outdated] The user lives in Portland." in context
    assert "I enjoy hiking." in context
    assert guidance is not None
    assert "Do not silently choose one as certain." in guidance
