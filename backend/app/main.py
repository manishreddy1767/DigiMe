import logging
from contextlib import asynccontextmanager
from datetime import datetime
from threading import Thread
from typing import AsyncIterator, Literal

from fastapi import FastAPI, HTTPException, Query, Request, Response
from fastapi.concurrency import run_in_threadpool
from pydantic import BaseModel, Field, field_validator, model_validator

from app.services.chat_context import (
    build_answerability_guidance,
    build_memory_search_query,
    find_conflicting_memory_ids,
    format_approved_memory_context,
)
from app.services.embeddings import EMBEDDING_MODEL, try_embed_text
from app.services.ollama import MODEL, REASONING_MODEL, OllamaService
from app.services.personalization import (
    build_proactive_suggestions,
    find_recurring_preference_suggestions,
    summarize_recurring_topics,
)
from app.services.speech import (
    get_kokoro_service,
    get_whisper_service,
    prepare_speech_text,
)
from app.services.storage import (
    AVAILABLE_VOICES,
    DEFAULT_PERSONALITY,
    DEFAULT_VOICE,
    Database,
)

logger = logging.getLogger(__name__)


def _warm_kokoro_service() -> None:
    try:
        service = get_kokoro_service()
        service.warm_up()
    except RuntimeError as error:
        logger.warning(
            "Local Kokoro warm-up failed; TTS may be slower or unavailable: %s",
            error,
        )
    else:
        logger.info("Local Kokoro TTS warmed on %s.", service.device)


@asynccontextmanager
async def lifespan(_: FastAPI) -> AsyncIterator[None]:
    Thread(
        target=_warm_kokoro_service,
        name="kokoro-warmup",
        daemon=True,
    ).start()
    yield


app = FastAPI(
    title="Digital Me",
    lifespan=lifespan,
    docs_url=None,
    redoc_url=None,
    openapi_url=None,
)

MAX_STT_AUDIO_BYTES = 20 * 1024 * 1024


class ChatMessage(BaseModel):
    role: Literal["user", "assistant"]
    content: str = Field(min_length=1, max_length=4_000)

    @field_validator("content")
    @classmethod
    def content_must_not_be_blank(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("Message content must not be blank.")
        return value


class ChatRequest(BaseModel):
    conversation_id: str | None = None
    messages: list[ChatMessage] = Field(min_length=1, max_length=40)

    @model_validator(mode="after")
    def latest_message_must_be_from_user(self) -> "ChatRequest":
        if self.messages[-1].role != "user":
            raise ValueError("The latest message must be from the user.")
        return self


class ChatResponse(BaseModel):
    message: str
    conversation_id: str


class ProfileUpdate(BaseModel):
    name: str = Field(default="", max_length=100)
    about: str = Field(default="", max_length=1_000)
    preferences: str = Field(default="", max_length=1_000)

    @field_validator("name", "about", "preferences")
    @classmethod
    def strip_profile_fields(cls, value: str) -> str:
        return value.strip()


class PersonalityUpdate(BaseModel):
    name: str = Field(default=DEFAULT_PERSONALITY["name"], min_length=1, max_length=100)
    communication_style: Literal["friendly", "professional", "casual"] = Field(
        default=DEFAULT_PERSONALITY["communication_style"]
    )
    response_length: Literal["concise", "balanced", "detailed"] = Field(
        default=DEFAULT_PERSONALITY["response_length"]
    )
    custom_instructions: str = Field(default="", max_length=2_000)
    deep_reasoning: bool = DEFAULT_PERSONALITY["deep_reasoning"]

    @field_validator("name", "custom_instructions")
    @classmethod
    def strip_personality_fields(cls, value: str) -> str:
        return value.strip()

    @field_validator("name")
    @classmethod
    def personality_name_must_not_be_blank(cls, value: str) -> str:
        if not value:
            raise ValueError("Personality name must not be blank.")
        return value


class VoiceSettingsUpdate(BaseModel):
    auto_play_responses: bool
    continuous_conversation_enabled: bool
    voice: str = DEFAULT_VOICE

    @field_validator("voice")
    @classmethod
    def voice_must_be_available(cls, value: str) -> str:
        if value not in AVAILABLE_VOICES:
            raise ValueError(f"Choose one of: {', '.join(AVAILABLE_VOICES)}.")
        return value


class PersonalizationSettingsUpdate(BaseModel):
    enabled: bool


class MemoryRequest(BaseModel):
    content: str = Field(min_length=1, max_length=2_000)
    importance: int = Field(default=3, ge=1, le=5)
    confirm_similar: bool = False

    @field_validator("content")
    @classmethod
    def content_must_not_be_blank(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("Memory content must not be blank.")
        return value


class MemorySuggestionApproval(BaseModel):
    importance: int = Field(default=3, ge=1, le=5)
    confirm_similar: bool = False


class TTSRequest(BaseModel):
    text: str = Field(min_length=1, max_length=4_000)

    @field_validator("text")
    @classmethod
    def text_must_not_be_blank(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("Text must not be blank.")
        return value


class STTResponse(BaseModel):
    text: str


def _current_local_time() -> str:
    return datetime.now().astimezone().strftime("%A, %d %B %Y, %H:%M %Z")


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/api/status")
def get_status() -> dict[str, object]:
    personality = Database().get_personality()
    deep_reasoning = bool(personality["deep_reasoning"])
    model = REASONING_MODEL if deep_reasoning else MODEL
    installed = OllamaService().installed_models()
    return {
        "assistant_name": personality["name"],
        "model": model,
        "deep_reasoning": deep_reasoning,
        "ollama_reachable": installed is not None,
        "model_available": installed is not None and model in installed,
    }


@app.get("/api/conversations")
def list_conversations() -> list[dict[str, str]]:
    return Database().list_conversations()


@app.post("/api/conversations", status_code=201)
def create_conversation() -> dict[str, str]:
    return Database().create_conversation()


@app.get("/api/conversations/{conversation_id}")
def get_conversation(conversation_id: str) -> dict[str, object]:
    conversation = Database().get_conversation(conversation_id)
    if conversation is None:
        raise HTTPException(status_code=404, detail="Conversation not found.")
    return conversation


@app.delete("/api/conversations/{conversation_id}", status_code=204)
def delete_conversation(conversation_id: str) -> Response:
    if not Database().delete_conversation(conversation_id):
        raise HTTPException(status_code=404, detail="Conversation not found.")
    return Response(status_code=204)


@app.get("/api/profile")
def get_profile() -> dict[str, str]:
    return Database().get_profile()


@app.put("/api/profile")
def update_profile(profile: ProfileUpdate) -> dict[str, str]:
    return Database().update_profile(
        profile.name,
        profile.about,
        profile.preferences,
    )


@app.get("/api/personality")
def get_personality() -> dict[str, object]:
    return Database().get_personality()


@app.put("/api/personality")
def update_personality(personality: PersonalityUpdate) -> dict[str, object]:
    return Database().update_personality(
        name=personality.name,
        communication_style=personality.communication_style,
        response_length=personality.response_length,
        custom_instructions=personality.custom_instructions,
        deep_reasoning=personality.deep_reasoning,
    )


@app.post("/api/personality/reset")
def reset_personality() -> dict[str, object]:
    return Database().reset_personality()


@app.get("/api/voice-settings")
def get_voice_settings() -> dict[str, object]:
    return Database().get_voice_settings()


@app.put("/api/voice-settings")
def update_voice_settings(settings: VoiceSettingsUpdate) -> dict[str, object]:
    return Database().update_voice_settings(
        settings.auto_play_responses,
        settings.continuous_conversation_enabled,
        settings.voice,
    )


@app.get("/api/personalization/settings")
def get_personalization_settings() -> dict[str, object]:
    return Database().get_personalization_settings()


@app.put("/api/personalization/settings")
def update_personalization_settings(
    settings: PersonalizationSettingsUpdate,
) -> dict[str, object]:
    return Database().update_personalization_settings(settings.enabled)


@app.get("/api/personalization/topics")
def get_recurring_topics() -> list[dict[str, object]]:
    database = Database()
    if not database.get_personalization_settings()["enabled"]:
        return []
    return summarize_recurring_topics(database.get_recent_user_messages())


@app.get("/api/personalization/proactive-suggestions")
def get_proactive_suggestions() -> list[dict[str, str]]:
    database = Database()
    if not database.get_personalization_settings()["enabled"]:
        raise HTTPException(
            status_code=409,
            detail="Enable personalization to request suggestions.",
        )
    return build_proactive_suggestions(
        database.get_recent_user_messages(),
        database.get_recent_memories_for_personalization(),
    )


@app.get("/api/memories")
def list_memories(
    query: str | None = Query(default=None, alias="q", max_length=500),
) -> list[dict[str, object]]:
    return Database().list_memories(query)


@app.post("/api/memories", status_code=201)
def create_memory(memory: MemoryRequest) -> dict[str, object]:
    database = Database()
    embedding, warning = try_embed_text(memory.content)
    similar = database.find_similar_memories(
        memory.content,
        embedding,
        EMBEDDING_MODEL,
    )
    if similar and not memory.confirm_similar:
        raise HTTPException(
            status_code=409,
            detail={
                "message": "This looks similar to an existing memory. Review it before saving.",
                "similar_memories": similar,
            },
        )
    saved = database.create_memory(
        memory.content,
        importance=memory.importance,
        embedding=embedding,
        embedding_model=EMBEDDING_MODEL,
    )
    if warning:
        saved["embedding_warning"] = warning
    return saved


@app.put("/api/memories/{memory_id}")
def update_memory(memory_id: str, memory: MemoryRequest) -> dict[str, object]:
    database = Database()
    existing = database.get_memory(memory_id)
    if existing is None:
        raise HTTPException(status_code=404, detail="Memory not found.")

    embedding = None
    warning = None
    if existing["content"] != memory.content:
        embedding, warning = try_embed_text(memory.content)
        similar = database.find_similar_memories(
            memory.content,
            embedding,
            EMBEDDING_MODEL,
            exclude_id=memory_id,
        )
        if similar and not memory.confirm_similar:
            raise HTTPException(
                status_code=409,
                detail={
                    "message": "This looks similar to another memory. Review it before saving.",
                    "similar_memories": similar,
                },
            )
    updated = database.update_memory(
        memory_id,
        memory.content,
        importance=memory.importance,
        embedding=embedding,
        embedding_model=EMBEDDING_MODEL,
    )
    if warning:
        updated["embedding_warning"] = warning
    return updated


@app.get("/api/conversations/{conversation_id}/memory-suggestions")
def list_memory_suggestions(conversation_id: str) -> list[dict[str, str]]:
    database = Database()
    if database.get_conversation(conversation_id) is None:
        raise HTTPException(status_code=404, detail="Conversation not found.")
    return database.list_memory_suggestions(conversation_id)


@app.post("/api/conversations/{conversation_id}/memory-suggestions")
def suggest_memories(conversation_id: str) -> list[dict[str, str]]:
    database = Database()
    conversation = database.get_conversation(conversation_id)
    if conversation is None:
        raise HTTPException(status_code=404, detail="Conversation not found.")
    messages = [
        {"role": message["role"], "content": message["content"]}
        for message in conversation["messages"]
    ]
    if not any(message["role"] == "user" for message in messages):
        raise HTTPException(
            status_code=422,
            detail="Add a user message before suggesting memories.",
        )
    try:
        suggestions = OllamaService().generate_memory_suggestions(messages)
    except RuntimeError as error:
        raise HTTPException(status_code=502, detail=str(error)) from error
    return database.create_memory_suggestions(conversation_id, suggestions)


@app.post("/api/conversations/{conversation_id}/preference-suggestions")
def suggest_recurring_preferences(conversation_id: str) -> list[dict[str, str]]:
    database = Database()
    if not database.get_personalization_settings()["enabled"]:
        raise HTTPException(
            status_code=409,
            detail="Enable personalization to suggest recurring preferences.",
        )
    if database.get_conversation(conversation_id) is None:
        raise HTTPException(status_code=404, detail="Conversation not found.")
    suggestions = find_recurring_preference_suggestions(
        database.get_recent_user_messages()
    )
    return database.create_memory_suggestions(conversation_id, suggestions)


@app.post("/api/memory-suggestions/{suggestion_id}/approve", status_code=201)
def approve_memory_suggestion(
    suggestion_id: str,
    approval: MemorySuggestionApproval,
) -> dict[str, object]:
    database = Database()
    suggestion = database.get_memory_suggestion(suggestion_id)
    if suggestion is None:
        raise HTTPException(status_code=404, detail="Pending memory suggestion not found.")
    embedding, warning = try_embed_text(suggestion["content"])
    similar = database.find_similar_memories(
        suggestion["content"],
        embedding,
        EMBEDDING_MODEL,
    )
    if similar and not approval.confirm_similar:
        raise HTTPException(
            status_code=409,
            detail={
                "message": "This suggestion is similar to an existing memory. Review it before approval.",
                "similar_memories": similar,
            },
        )
    saved = database.approve_memory_suggestion(
        suggestion_id,
        approval.importance,
        embedding,
        EMBEDDING_MODEL,
    )
    if saved is None:
        raise HTTPException(status_code=404, detail="Pending memory suggestion not found.")
    if warning:
        saved["embedding_warning"] = warning
    return saved


@app.delete("/api/memory-suggestions/{suggestion_id}", status_code=204)
def dismiss_memory_suggestion(suggestion_id: str) -> Response:
    if not Database().dismiss_memory_suggestion(suggestion_id):
        raise HTTPException(status_code=404, detail="Pending memory suggestion not found.")
    return Response(status_code=204)


@app.delete("/api/memories/{memory_id}", status_code=204)
def delete_memory(memory_id: str) -> Response:
    if not Database().delete_memory(memory_id):
        raise HTTPException(status_code=404, detail="Memory not found.")
    return Response(status_code=204)


@app.post("/api/chat", response_model=ChatResponse)
def chat(request: ChatRequest) -> ChatResponse:
    database = Database()
    if request.conversation_id is None:
        conversation_id = database.create_conversation()["id"]
    else:
        conversation_id = request.conversation_id
        if database.get_conversation(conversation_id) is None:
            raise HTTPException(status_code=404, detail="Conversation not found.")

    latest_message = request.messages[-1]
    if request.conversation_id is None:
        for message in request.messages:
            database.add_message(conversation_id, message.role, message.content)
    else:
        database.add_message(conversation_id, latest_message.role, latest_message.content)

    conversation = database.get_conversation(conversation_id)
    messages = [
        {"role": message["role"], "content": message["content"]}
        for message in conversation["messages"]
    ]
    context_sections = []
    personalization_enabled = bool(database.get_personalization_settings()["enabled"])
    if personalization_enabled:
        profile = database.get_profile()
        profile_fields = [
            ("Name", profile["name"]),
            ("About", profile["about"]),
            ("Preferences", profile["preferences"]),
        ]
        filled_profile = [f"{label}: {value}" for label, value in profile_fields if value]
        if filled_profile:
            context_sections.append(
                "Editable user profile (provided by the user):\n"
                + "\n".join(filled_profile)
            )

        memories = database.list_memories()
        if memories:
            memory_query = build_memory_search_query(messages)
            query_embedding, _ = try_embed_text(memory_query)
            relevant_memories = database.search_memories_hybrid(
                memory_query,
                query_embedding,
                EMBEDDING_MODEL,
            )
        else:
            relevant_memories = []
    else:
        relevant_memories = []
    conflicting_memory_ids = find_conflicting_memory_ids(relevant_memories)
    if relevant_memories:
        memory_context = format_approved_memory_context(
            relevant_memories,
            conflicting_memory_ids,
        )
        if memory_context:
            context_sections.append(memory_context)
    chat_guidance = build_answerability_guidance(
        messages,
        conflicting_memory_ids,
    )

    try:
        response = OllamaService().generate_chat_response(
            messages,
            additional_context="\n\n".join(context_sections) or None,
            personality=database.get_personality(),
            chat_guidance=chat_guidance,
            current_time=_current_local_time(),
        )
    except RuntimeError as error:
        raise HTTPException(
            status_code=502,
            detail={
                "message": str(error),
                "conversation_id": conversation_id,
            },
        ) from error

    database.add_message(conversation_id, "assistant", response)
    return ChatResponse(message=response, conversation_id=conversation_id)


@app.post("/api/tts")
def text_to_speech(request: TTSRequest) -> Response:
    spoken_text = prepare_speech_text(request.text)
    if not spoken_text:
        raise HTTPException(status_code=422, detail="There is no speakable text.")
    voice = str(Database().get_voice_settings()["voice"])
    try:
        audio = get_kokoro_service().synthesize_to_wav(spoken_text, voice=voice)
    except RuntimeError as error:
        raise HTTPException(status_code=503, detail=str(error)) from error

    return Response(
        content=audio,
        media_type="audio/wav",
        headers={"Cache-Control": "no-store"},
    )


@app.post("/api/stt", response_model=STTResponse)
async def speech_to_text(request: Request, response: Response) -> STTResponse:
    content_type = request.headers.get("content-type", "").split(";", 1)[0].lower()
    if not content_type.startswith("audio/") and content_type != "application/octet-stream":
        raise HTTPException(
            status_code=415,
            detail="Send a recording with an audio content type.",
        )

    audio_data = bytearray()
    async for chunk in request.stream():
        if len(audio_data) + len(chunk) > MAX_STT_AUDIO_BYTES:
            raise HTTPException(
                status_code=413,
                detail="The recording is too large. Keep recordings under 20 MB.",
            )
        audio_data.extend(chunk)

    if not audio_data:
        raise HTTPException(status_code=422, detail="No audio was received.")

    try:
        service = await run_in_threadpool(get_whisper_service)
        result = await run_in_threadpool(service.transcribe_bytes, bytes(audio_data))
    except ValueError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error
    except RuntimeError as error:
        raise HTTPException(status_code=503, detail=str(error)) from error

    response.headers["Cache-Control"] = "no-store"
    return STTResponse(text=result.text)
