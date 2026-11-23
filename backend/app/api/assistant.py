"""RaktDoot AI Assistant — chat endpoint.

POST /api/assistant/chat
Accepts a JSON body with the user's message and optional conversation history,
returns a helpful response about blood donation, blood banks, camps, and compatibility.
"""
import io
import logging
import re
from typing import Annotated

from fastapi import APIRouter, File, HTTPException, Query, UploadFile
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field, field_validator, model_validator

from ..services import assistant, stt, tts

log = logging.getLogger("raktdoot.api.assistant")

router = APIRouter(prefix="/api")

MAX_USER_MSG_LEN = 500
MAX_ASST_MSG_LEN = 3000


# ---------------------------------------------------------------- request / response models
class ChatMessage(BaseModel):
    role: str = Field(..., pattern=r"^(user|assistant)$", description="Message role: 'user' or 'assistant'")
    content: str = Field(..., min_length=1, max_length=MAX_ASST_MSG_LEN, description="Message content")

    @field_validator("content")
    @classmethod
    def clean_content(cls, v: str) -> str:
        """Remove control characters and trim."""
        cleaned = re.sub(r"[\x00-\x09\x0b-\x0c\x0e-\x1f\x7f]", "", (v or "").strip())
        if not cleaned:
            raise ValueError("Message content cannot be empty")
        return cleaned

    @model_validator(mode="after")
    def validate_role_length(self) -> "ChatMessage":
        if self.role == "user" and len(self.content) > MAX_USER_MSG_LEN:
            raise ValueError(f"User message must have at most {MAX_USER_MSG_LEN} characters")
        if self.role == "assistant" and len(self.content) > MAX_ASST_MSG_LEN:
            raise ValueError(f"Assistant message must have at most {MAX_ASST_MSG_LEN} characters")
        return self


class Location(BaseModel):
    lat: float = Field(..., ge=-90, le=90)
    lng: float = Field(..., ge=-180, le=180)


class ChatRequest(BaseModel):
    messages: list[ChatMessage] = Field(default_factory=list, description="Previous conversation history")
    message: str = Field(..., min_length=1, max_length=MAX_USER_MSG_LEN, description="Current user message")
    lang: str = Field(default="auto", description="Language preference: 'auto', 'en', 'hi', or 'hinglish'")
    location: Location | None = Field(default=None, description="Optional user location for proximity queries")

    @field_validator("lang")
    @classmethod
    def validate_lang(cls, v: str) -> str:
        v = (v or "auto").strip().lower()
        return v if v in ("auto", "en", "hi", "hinglish") else "auto"

    @field_validator("messages")
    @classmethod
    def truncate_messages(cls, v: list[ChatMessage]) -> list[ChatMessage]:
        """Keep only the last MAX_HISTORY messages to limit context size."""
        return v[-assistant.MAX_HISTORY:] if len(v) > assistant.MAX_HISTORY else v

    @field_validator("message")
    @classmethod
    def clean_message(cls, v: str) -> str:
        """Remove control characters."""
        cleaned = re.sub(r"[\x00-\x09\x0b-\x0c\x0e-\x1f\x7f]", "", (v or "").strip())
        if not cleaned:
            raise ValueError("Message cannot be empty")
        if len(cleaned) > MAX_USER_MSG_LEN:
            raise ValueError(f"User message must have at most {MAX_USER_MSG_LEN} characters")
        return cleaned


class ChatResponse(BaseModel):
    reply: str
    suggestions: list[str] = Field(default_factory=list)
    sources: list[dict] = Field(default_factory=list)
    detected_lang: str = Field(default="en", description="Detected language of query: 'hi', 'en', or 'hinglish'")


# ---------------------------------------------------------------- endpoint
@router.post("/assistant/chat", response_model=ChatResponse)
def assistant_chat(req: ChatRequest) -> ChatResponse:
    """Chat with the RaktDoot AI Assistant.

    Supports Hindi, English, and Hinglish. Returns guidance about blood
    donation, blood banks, blood camps, and compatibility information.
    """
    try:
        history = [{"role": m.role, "content": m.content} for m in req.messages]
        location = {"lat": req.location.lat, "lng": req.location.lng} if req.location else None

        result = assistant.chat(
            messages=history,
            user_message=req.message,
            lang=req.lang,
            location=location,
        )

        detected_lang = result.get("detected_lang", "en")
        return ChatResponse(
            reply=result.get("reply", assistant.FALLBACK_REPLIES.get(detected_lang, assistant.FALLBACK_REPLIES["en"])),
            suggestions=result.get("suggestions", assistant.DEFAULT_SUGGESTIONS.get(detected_lang, [])),
            sources=result.get("sources", []),
            detected_lang=detected_lang,
        )

    except Exception as e:
        log.error("Assistant chat error: %s", e, exc_info=True)
        # Return a safe fallback — never expose internal errors to the user
        return ChatResponse(
            reply=assistant.FALLBACK_REPLIES.get(req.lang, assistant.FALLBACK_REPLIES["en"]),
            suggestions=assistant.DEFAULT_SUGGESTIONS.get(req.lang, []),
            sources=[],
            detected_lang="en",
        )


# ---------------------------------------------------------------- transcribe endpoint
class TranscribeResponse(BaseModel):
    transcript: str = Field(default="", description="Transcribed speech text")
    engine: str = Field(default="", description="STT engine used")
    language: str | None = Field(default=None, description="Detected language: 'hi', 'en', or 'hinglish'")
    error: str | None = Field(default=None, description="Error message if transcription failed")


ALLOWED_AUDIO_MIMES = {
    "audio/webm",
    "audio/ogg",
    "audio/wav",
    "audio/x-wav",
    "audio/mpeg",
    "audio/mp3",
    "audio/mp4",
    "audio/m4a",
    "audio/x-m4a",
    "audio/aac",
    "audio/amr",
}


@router.post("/assistant/transcribe", response_model=TranscribeResponse)
async def assistant_transcribe(
    file: UploadFile = File(..., description="Audio file to transcribe"),
    lang: str = Query("auto", description="Audio language: 'auto', 'en', 'hi', etc."),
) -> TranscribeResponse:
    """Transcribe recorded speech to text for the AI Assistant.

    Accepts WebM, OGG, WAV, MP3, etc. up to 16 MB.
    Returns transcript without auto-sending to chat.
    """
    raw_content_type = file.content_type or ""
    mime_base = raw_content_type.split(";")[0].strip().lower()

    if not mime_base or mime_base not in ALLOWED_AUDIO_MIMES:
        raise HTTPException(
            status_code=415,
            detail=f"Unsupported audio format '{raw_content_type}'. Supported formats: {', '.join(sorted(ALLOWED_AUDIO_MIMES))}",
        )

    try:
        data = await file.read(stt.MAX_BYTES + 1)
    except Exception as e:
        log.error("Failed to read uploaded audio file: %s", e)
        raise HTTPException(status_code=400, detail="Failed to read uploaded audio file") from e

    if not data:
        raise HTTPException(status_code=400, detail="Audio file is empty")

    if len(data) > stt.MAX_BYTES:
        raise HTTPException(
            status_code=413,
            detail=f"Audio file exceeds maximum size of {stt.MAX_BYTES // (1024 * 1024)} MB",
        )

    try:
        heard = await run_in_threadpool(stt.transcribe, data, mime_base, extract_slip=False)
        del data

        transcript = heard.get("text", "")
        engine = heard.get("engine", "")
        err = heard.get("error")
        detected_lang = assistant.detect_language(transcript) if transcript else None
        if detected_lang == "en" and lang == "hi" and transcript and assistant._is_ambiguous_short(transcript):
            detected_lang = "hi"

        return TranscribeResponse(
            transcript=transcript,
            engine=engine,
            language=detected_lang,
            error=err,
        )
    except Exception as e:
        log.error("Assistant transcription error: %s", e, exc_info=True)
        return TranscribeResponse(
            transcript="",
            engine="error",
            language=None,
            error="Transcription failed. Please try again or type your message.",
        )


# ---------------------------------------------------------------- speak endpoint
class SpeakRequest(BaseModel):
    text: str = Field(..., min_length=1, max_length=MAX_ASST_MSG_LEN, description="Text to speak aloud")
    lang: str = Field(default="auto", description="Language preference: 'auto', 'en', 'hi', or 'hinglish'")

    @field_validator("text")
    @classmethod
    def clean_text(cls, v: str) -> str:
        cleaned = re.sub(r"[\x00-\x09\x0b-\x0c\x0e-\x1f\x7f]", "", (v or "").strip())
        if not cleaned:
            raise ValueError("Text cannot be empty")
        return cleaned

    @field_validator("lang")
    @classmethod
    def validate_lang(cls, v: str) -> str:
        v = (v or "auto").strip().lower()
        return v if v in ("auto", "en", "hi", "hinglish") else "auto"


@router.post("/assistant/speak")
async def assistant_speak(req: SpeakRequest):
    """Synthesize speech audio for the AI Assistant response.

    Returns audio/mpeg as a streamable response.
    """
    clean = tts.speakable(req.text)
    if not clean:
        raise HTTPException(status_code=400, detail="Text is empty or contains no speakable characters")

    # Determine effective language
    effective_lang = req.lang
    if effective_lang == "auto":
        effective_lang = assistant.detect_language(clean)

    # Map to 'hi' or 'en' for TTS voice engines (Hinglish uses en-IN Indian voice)
    voice_lang = "hi" if effective_lang == "hi" else "en"

    try:
        synth = await run_in_threadpool(tts.synthesize, clean, voice_lang)
    except Exception as e:
        log.error("TTS synthesis error: %s", e, exc_info=True)
        raise HTTPException(status_code=502, detail="Text-to-speech synthesis failed") from e

    if not synth:
        raise HTTPException(status_code=502, detail="Text-to-speech provider unavailable or failed to produce audio")

    data, mime, engine = synth
    return StreamingResponse(
        io.BytesIO(data),
        media_type=mime or "audio/mpeg",
        headers={
            "Content-Disposition": "inline",
            "X-TTS-Engine": engine,
            "X-TTS-Language": effective_lang,
            "Cache-Control": "public, max-age=3600",
        },
    )


