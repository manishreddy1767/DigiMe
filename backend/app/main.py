from typing import Literal

from fastapi import FastAPI, HTTPException, Response
from pydantic import BaseModel, Field, field_validator, model_validator

from app.services.ollama import OllamaService
from app.services.speech import get_kokoro_service

app = FastAPI(
    title="Digital Me",
    docs_url=None,
    redoc_url=None,
    openapi_url=None,
)


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
    messages: list[ChatMessage] = Field(min_length=1, max_length=40)

    @model_validator(mode="after")
    def latest_message_must_be_from_user(self) -> "ChatRequest":
        if self.messages[-1].role != "user":
            raise ValueError("The latest message must be from the user.")
        return self


class ChatResponse(BaseModel):
    message: str


class TTSRequest(BaseModel):
    text: str = Field(min_length=1, max_length=4_000)

    @field_validator("text")
    @classmethod
    def text_must_not_be_blank(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("Text must not be blank.")
        return value


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.post("/api/chat", response_model=ChatResponse)
def chat(request: ChatRequest) -> ChatResponse:
    messages = [message.model_dump() for message in request.messages]
    try:
        response = OllamaService().generate_chat_response(messages)
    except RuntimeError as error:
        raise HTTPException(status_code=502, detail=str(error)) from error

    return ChatResponse(message=response)


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
