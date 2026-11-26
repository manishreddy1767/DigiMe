from typing import Literal

from fastapi import FastAPI, HTTPException, Request, Response
from fastapi.concurrency import run_in_threadpool
from pydantic import BaseModel, Field, field_validator, model_validator

from app.services.ollama import OllamaService
from app.services.speech import get_kokoro_service, get_whisper_service
from app.services.storage import Database

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
    try:
        response = OllamaService().generate_chat_response(messages)
    except RuntimeError as error:
        raise HTTPException(status_code=502, detail=str(error)) from error

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
