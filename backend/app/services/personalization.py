import re
from collections import defaultdict

_SAFE_TOPICS: dict[str, re.Pattern[str]] = {
    "programming": re.compile(
        r"\b(?:programming|coding|software|python|javascript|typescript)\b",
        re.IGNORECASE,
    ),
    "technology": re.compile(
        r"\b(?:technology|tech|computer|computers|gadget|gadgets)\b",
        re.IGNORECASE,
    ),
    "cooking": re.compile(
        r"\b(?:cook|cooking|recipe|recipes|baking)\b",
        re.IGNORECASE,
    ),
    "travel": re.compile(
        r"\b(?:travel|trip|trips|destination|destinations|camping|hiking)\b",
        re.IGNORECASE,
    ),
    "books": re.compile(
        r"\b(?:book|books|reading|novel|novels|literature)\b",
        re.IGNORECASE,
    ),
    "music": re.compile(
        r"\b(?:music|song|songs|guitar|piano|instrument|instruments)\b",
        re.IGNORECASE,
    ),
    "sports": re.compile(
        r"\b(?:sport|sports|football|soccer|basketball|tennis|baseball)\b",
        re.IGNORECASE,
    ),
    "games": re.compile(
        r"\b(?:game|games|gaming|video game|video games)\b",
        re.IGNORECASE,
    ),
    "movies": re.compile(
        r"\b(?:movie|movies|film|films|cinema|television|tv shows)\b",
        re.IGNORECASE,
    ),
    "gardening": re.compile(
        r"\b(?:garden|gardening|plants|planting)\b",
        re.IGNORECASE,
    ),
    "art": re.compile(
        r"\b(?:art|drawing|painting|photography|sculpture)\b",
        re.IGNORECASE,
    ),
    "science": re.compile(
        r"\b(?:science|scientific|astronomy|space|physics|biology)\b",
        re.IGNORECASE,
    ),
    "learning": re.compile(
        r"\b(?:learning|learn|education|course|courses|study|studying)\b",
        re.IGNORECASE,
    ),
}
_TOPIC_PROMPTS = {
    "programming": "Give me a small programming example.",
    "technology": "Give me a practical technology tip.",
    "cooking": "Suggest a simple recipe or cooking technique.",
    "travel": "Help me plan or compare a travel idea.",
    "books": "Suggest a book or a reading discussion topic.",
    "music": "Suggest an artist, song, or instrument to explore.",
    "sports": "Give me an interesting sports overview or comparison.",
    "games": "Suggest a game or a strategy to explore.",
    "movies": "Suggest a film or a discussion about one.",
    "gardening": "Suggest a seasonal gardening idea.",
    "art": "Give me a creative prompt or art technique.",
    "science": "Explain an interesting science topic simply.",
    "learning": "Suggest a short lesson or learning exercise.",
}
_EXPLICIT_PREFERENCE = re.compile(
    r"\b(?:I\s+(?:really\s+)?(?:like|love|enjoy|prefer)|"
    r"I\s+(?:am|['’]m)\s+interested\s+in)\s+([^.!?;\n]{1,120})",
    re.IGNORECASE,
)
_SENSITIVE_CONTEXT = re.compile(
    r"\b(?:politic\w*|religio\w*|church|mosque|synagogue|temple|"
    r"health|medical|diagnos\w*|medication|disabilit\w*|ethnic\w*|"
    r"race|racial\w*|sexual\w*|gender\w*|transgender|immigra\w*|"
    r"nationalit\w*|citizenship|lawsuit|bankrupt\w*|debt|income|financial|finance|"
    r"mental health|"
    r"depression|anxiety|therapy)\b",
    re.IGNORECASE,
)
_STYLE_PREFERENCES = {
    "concise responses": (
        re.compile(
            r"\bI\s+(?:really\s+)?(?:like|love|prefer)\s+"
            r"(?:concise|brief|short)\s+(?:answers?|responses?|explanations?)\b",
            re.IGNORECASE,
        ),
        "I prefer concise responses.",
    ),
    "practical examples": (
        re.compile(
            r"\bI\s+(?:really\s+)?(?:like|love|prefer)\s+"
            r"(?:practical\s+)?examples\b",
            re.IGNORECASE,
        ),
        "I prefer practical examples.",
    ),
    "step-by-step explanations": (
        re.compile(
            r"\bI\s+(?:really\s+)?(?:like|love|prefer)\s+"
            r"step[- ]by[- ]step explanations?\b",
            re.IGNORECASE,
        ),
        "I prefer step-by-step explanations.",
    ),
}
_SUGGESTION_STATEMENTS = {
    **{topic: f"I enjoy {topic}." for topic in _SAFE_TOPICS},
    **{
        key: statement
        for key, (_, statement) in _STYLE_PREFERENCES.items()
    },
}
_MIN_RECURRING_MESSAGES = 2


def _matched_topics(text: str) -> set[str]:
    if _SENSITIVE_CONTEXT.search(text):
        return set()
    return {
        topic
        for topic, pattern in _SAFE_TOPICS.items()
        if pattern.search(text)
    }


def summarize_recurring_topics(
    messages: list[dict[str, str]],
) -> list[dict[str, object]]:
    message_counts: dict[str, int] = defaultdict(int)
    conversation_ids: dict[str, set[str]] = defaultdict(set)
    for message in messages:
        if message.get("role") != "user":
            continue
        content = message.get("content", "")
        if _SENSITIVE_CONTEXT.search(content):
            continue
        conversation_id = message.get("conversation_id")
        for topic in _matched_topics(content):
            message_counts[topic] += 1
            if conversation_id:
                conversation_ids[topic].add(conversation_id)

    summaries = []
    for topic, count in message_counts.items():
        if count < _MIN_RECURRING_MESSAGES:
            continue
        conversation_count = len(conversation_ids[topic])
        conversation_label = "conversation" if conversation_count == 1 else "conversations"
        summaries.append({
            "topic": topic,
            "message_count": count,
            "conversation_count": conversation_count,
            "summary": (
                f"{topic.title()} appeared in {count} recent user messages "
                f"across {conversation_count} {conversation_label}."
            ),
        })
    return sorted(
        summaries,
        key=lambda item: (-int(item["message_count"]), str(item["topic"])),
    )[:10]


def find_recurring_preference_suggestions(
    messages: list[dict[str, str]],
) -> list[str]:
    occurrences: dict[str, set[int]] = defaultdict(set)
    message_index = 0
    for message in messages:
        if message.get("role") != "user":
            continue
        message_index += 1
        content = message.get("content", "")
        if _SENSITIVE_CONTEXT.search(content):
            continue
        preferences: set[str] = set()
        for match in _EXPLICIT_PREFERENCE.finditer(content):
            statement = match.group(1).strip()
            if re.match(r"(?:not|never|no)\b", statement, re.IGNORECASE):
                continue
            preferences.update(_matched_topics(statement))
        for key, (pattern, _) in _STYLE_PREFERENCES.items():
            if pattern.search(content):
                preferences.add(key)
        for preference in preferences:
            occurrences[preference].add(message_index)

    recurring = [
        preference
        for preference, message_ids in occurrences.items()
        if len(message_ids) >= _MIN_RECURRING_MESSAGES
    ]
    return [
        _SUGGESTION_STATEMENTS[preference]
        for preference in sorted(recurring)
    ][:5]


def build_proactive_suggestions(
    messages: list[dict[str, str]],
    approved_memories: list[dict[str, object]],
) -> list[dict[str, str]]:
    topic_summaries = summarize_recurring_topics(messages)
    recurring_topics = {str(topic["topic"]) for topic in topic_summaries}
    memory_topics: set[str] = set()
    for memory in approved_memories:
        content = memory.get("content")
        if isinstance(content, str):
            memory_topics.update(_matched_topics(content))

    ranked_topics = [str(topic["topic"]) for topic in topic_summaries]
    ranked_topics.extend(sorted(memory_topics - set(ranked_topics)))
    suggestions: list[dict[str, str]] = []
    for topic in ranked_topics:
        from_memory = topic in memory_topics
        from_history = topic in recurring_topics
        source = (
            "approved memory and recurring topic"
            if from_memory and from_history
            else "approved memory"
            if from_memory
            else "recurring topic"
        )
        suggestions.append(
            {
                "topic": topic,
                "prompt": _TOPIC_PROMPTS[topic],
                "source": source,
            }
        )
        if len(suggestions) == 3:
            break
    return suggestions
