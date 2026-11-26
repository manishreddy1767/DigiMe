from typing import Literal

from fastapi import FastAPI, HTTPException, Query, Request, Response
from fastapi.concurrency import run_in_threadpool
from pydantic import BaseModel, Field, field_validator, model_validator

from app.services.ollama import OllamaService
from app.services.speech import get_kokoro_service, get_whisper_service
from app.services.storage import Database, RecordNotFoundError

app = FastAPI(
    title="Digital Me",
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


class MemoryRequest(BaseModel):
    content: str = Field(min_length=1, max_length=2_000)

    @field_validator("content")
    @classmethod
    def content_must_not_be_blank(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("Memory content must not be blank.")
        return value


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


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


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


@app.get("/api/memories")
def list_memories(
    query: str | None = Query(default=None, alias="q", max_length=500),
) -> list[dict[str, str]]:
    return Database().list_memories(query)


@app.post("/api/memories", status_code=201)
def create_memory(memory: MemoryRequest) -> dict[str, str]:
    return Database().create_memory(memory.content)


@app.put("/api/memories/{memory_id}")
def update_memory(memory_id: str, memory: MemoryRequest) -> dict[str, str]:
    try:
        return Database().update_memory(memory_id, memory.content)
    except RecordNotFoundError as error:
        raise HTTPException(status_code=404, detail=str(error)) from error


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
    profile = database.get_profile()
    context_sections = []
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

    relevant_memories = database.search_memories(latest_message.content)
    if relevant_memories:
        context_sections.append(
            "Explicitly approved long-term memories:\n"
            + "\n".join(f"- {memory['content']}" for memory in relevant_memories)
        )

    try:
        ollama = OllamaService()
        if context_sections:
            response = ollama.generate_chat_response(
                messages,
                "\n\n".join(context_sections),
            )
        else:
            response = ollama.generate_chat_response(messages)
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
    try:
        audio = get_kokoro_service().synthesize_to_wav(request.text)
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
