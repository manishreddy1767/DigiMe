import re
from collections import defaultdict

MAX_MEMORY_SEARCH_QUERY_CHARS = 2_400
_FOLLOW_UP_REFERENCE = re.compile(
    r"\b(?:it|that|this|they|them|those|these|there|one|same|former|latter)\b"
    r"|\b(?:what about|how about|tell me more|more about|explain further|continue from)\b"
    r"|\b(?:and|also|but|then)\s+(?:the|same|previous|earlier)\b",
    re.IGNORECASE,
)
_PERSONAL_FACT_QUESTION = re.compile(
    r"\b(?:what|where|when|who|which)(?:\s+(?:is|are|was|were)|['’]s)\s+my\b"
    r"|\bwhat\s+do\s+i\s+(?:like|prefer|enjoy|usually|normally)\b"
    r"|\bwhere\s+do\s+i\b",
    re.IGNORECASE,
)
_SELF_FACT_QUESTION = re.compile(
    r"\b(?:what|where|when|who|which|how)(?:\s+(?:is|are|was|were|do|did)|['’]s)\s+your\b"
    r"|\bdo\s+you\s+(?:like|prefer|enjoy|study|work|live|have|know)\b"
    r"|\bwhere\s+(?:do|did)\s+you\b"
    r"|\b(?:about|describe)\s+yourself\b",
    re.IGNORECASE,
)
_MEMORY_ASSERTIONS = (
    (
        "residence",
        re.compile(
            r"^(?:i|the user)\s+(?:currently\s+)?"
            r"(?:live|lives|reside|resides)\s+(?:in|at)\s+(.+)$",
            re.IGNORECASE,
        ),
    ),
    (
        "employer",
        re.compile(
            r"^(?:i|the user)\s+(?:currently\s+)?"
            r"work(?:s)?\s+(?:at|for)\s+(.+)$",
            re.IGNORECASE,
        ),
    ),
    (
        "favorite",
        re.compile(
            r"^(?:my|the user['’]s)\s+favorite\s+([\w -]+?)\s+(?:is|are)\s+(.+)$",
            re.IGNORECASE,
        ),
    ),
)


def build_memory_search_query(messages: list[dict[str, str]]) -> str:
    latest = messages[-1]["content"].strip()
    if not _FOLLOW_UP_REFERENCE.search(latest):
        return latest[:MAX_MEMORY_SEARCH_QUERY_CHARS]

    query = latest
    remaining = MAX_MEMORY_SEARCH_QUERY_CHARS - len(query)
    if remaining <= 0:
        return query[:MAX_MEMORY_SEARCH_QUERY_CHARS]

    previous_turns = messages[-5:-1]
    context_excerpts: list[str] = []
    for message in reversed(previous_turns):
        content = message["content"].strip()
        if not content or remaining <= 0:
            continue
        excerpt = content[-min(500, remaining):]
        context_excerpts.append(excerpt)
        remaining -= len(excerpt) + 1
    if context_excerpts:
        query += "\n" + "\n".join(context_excerpts)
    return query[:MAX_MEMORY_SEARCH_QUERY_CHARS]


def find_conflicting_memory_ids(memories: list[dict[str, object]]) -> set[str]:
    assertions: dict[tuple[str, str], dict[str, set[str]]] = defaultdict(
        lambda: defaultdict(set)
    )
    for memory in memories:
        content = memory.get("content")
        memory_id = memory.get("id")
        if not isinstance(content, str) or not isinstance(memory_id, str):
            continue
        normalized = " ".join(content.casefold().split())
        for assertion_type, pattern in _MEMORY_ASSERTIONS:
            match = pattern.match(normalized)
            if not match:
                continue
            if assertion_type == "favorite":
                attribute = " ".join(match.group(1).split())
                value = match.group(2)
            else:
                attribute = assertion_type
                value = match.group(1)
            normalized_value = re.sub(r"[^\w]+", " ", value).strip()
            if normalized_value:
                assertions[(assertion_type, attribute)][normalized_value].add(memory_id)
            break

    conflicts: set[str] = set()
    for values in assertions.values():
        if len(values) > 1:
            for memory_ids in values.values():
                conflicts.update(memory_ids)
    return conflicts


def format_approved_memory_context(
    memories: list[dict[str, object]],
    conflicting_ids: set[str],
    heading: str = "Explicitly approved long-term memories",
) -> str | None:
    lines: list[str] = []
    for memory in memories:
        content = memory.get("content")
        memory_id = memory.get("id")
        if not isinstance(content, str) or not content.strip():
            continue
        marker = (
            "[potentially conflicting or outdated] "
            if isinstance(memory_id, str) and memory_id in conflicting_ids
            else ""
        )
        lines.append(f"- {marker}{content.strip()}")
    if not lines:
        return None
    return f"{heading}:\n" + "\n".join(lines)


def build_answerability_guidance(
    messages: list[dict[str, str]],
    conflicting_memory_ids: set[str],
    speaking_as_self: bool = False,
) -> str | None:
    latest = messages[-1]["content"].strip()
    guidance: list[str] = []
    if _FOLLOW_UP_REFERENCE.search(latest):
        if len(messages) > 1:
            guidance.append(
                "Resolve references from the recent conversation. If the "
                "referent remains ambiguous, ask one focused clarification "
                "instead of guessing."
            )
        else:
            guidance.append(
                "This message appears to refer to earlier context that is not "
                "available. Do not invent the referent; ask one concise "
                "clarifying question."
            )
    if _PERSONAL_FACT_QUESTION.search(latest):
        guidance.append(
            "Check prior user turns and relevant profile or approved memories "
            "for this personal fact. If it is not stated, say you do not know "
            "rather than guessing."
        )
    if speaking_as_self and _SELF_FACT_QUESTION.search(latest):
        guidance.append(
            "This asks about you. Check whether the answer is written in your profile, "
            "your approved memories or this conversation. If it is, answer in the first "
            "person using only that. If it is not, say only that you haven't shared that "
            "yet (for example: \"Hmm, I haven't actually shared that yet.\"), and do not "
            "name any example, preference, opinion, experience or guess."
        )
    if conflicting_memory_ids:
        guidance.append(
            "Some retrieved approved memories are marked as potentially "
            "conflicting or outdated. Do not silently choose one as certain. "
            "Use the user's current explicit correction when available; "
            "otherwise mention the conflict or ask which is current only "
            "when it materially affects the answer."
        )
    return "\n".join(guidance) or None
