"""Text to speech for voice replies (WhatsApp voice notes for donors and families who prefer audio).

Providers (TTS_PROVIDER):
- sarvam: Sarvam AI bulbul (Indian voices, Hindi + English), uses STT_API_KEY (the same Sarvam key)
- edge:   Microsoft Edge neural voices via the free edge-tts service (hi-IN-SwaraNeural, en-IN-NeerjaNeural); no key
- openai: any OpenAI-compatible /audio/speech, uses LLM_API_KEY
- off
auto = sarvam if STT_API_KEY is set, else edge if the edge-tts package is installed, else off.
Never raises: a failed voice reply just means the text message stands alone."""
import asyncio
import base64
import concurrent.futures
import importlib.util
import logging
import re

import httpx

from ..config import settings

log = logging.getLogger("raktdoot.tts")
MAX_CHARS = 900

EMOJI_PATTERN = re.compile(
    r"[\U00010000-\U0010ffff"  # Supplemental symbols, pictographs, emojis (e.g. 🩸, 🏥, 📍, 📅, 🚨)
    r"\u2600-\u27bf"          # Misc symbols & dingbats (e.g. ☎, 📞, ❄, ⚡)
    r"\u2300-\u23ff"          # Misc technical symbols
    r"\u2b50\ufe0f\u200d"     # Star, variation selector, zero-width joiner
    r"]+",
    flags=re.UNICODE,
)


def provider() -> str:
    p = settings.tts_provider.lower()
    if p != "auto":
        return p
    if settings.stt_api_key:
        return "sarvam"
    if importlib.util.find_spec("edge_tts"):
        return "edge"
    return "off"


def speakable(text: str) -> str:
    """Drop links, phone-number punctuation noise and button hints; voice notes stay short."""
    t = re.sub(r"https?://\S+", "", text or "")
    t = re.sub(r"\[([^\]]+)\]\([^\)]+\)", r"\1", t)  # strip markdown links [label](url) -> label
    t = re.sub(r"[*_~`#]", "", t)  # strip markdown formatting bold **, italics *, code `
    t = EMOJI_PATTERN.sub("", t)  # strip emojis and decorative symbols
    t = re.sub(r"^[•\-\*]\s*", "", t, flags=re.MULTILINE)  # strip bullet points
    t = re.sub(r"\n+", ". ", t)
    t = re.sub(r"\s+", " ", t).strip()
    t = re.sub(r"\s+([.,])", r"\1", t)
    t = re.sub(r"\.{2,}", ".", t)
    return t[:MAX_CHARS]


def _edge(text: str, lang: str) -> tuple[bytes, str]:
    import edge_tts

    async def run() -> bytes:
        voice = settings.tts_voice_hi if lang == "hi" else settings.tts_voice_en
        buf = bytearray()
        async with asyncio.timeout(20):
            async for chunk in edge_tts.Communicate(text, voice).stream():
                if chunk["type"] == "audio":
                    buf += chunk["data"]
        return bytes(buf)

    with concurrent.futures.ThreadPoolExecutor(1) as ex:  # works whether or not a loop is running here
        return ex.submit(asyncio.run, run()).result(timeout=25), "audio/mpeg"


def _sarvam(text: str, lang: str) -> tuple[bytes, str]:
    r = httpx.post(
        "https://api.sarvam.ai/text-to-speech",
        headers={"api-subscription-key": settings.stt_api_key},
        timeout=25,
        json={
            "inputs": [text[:1500]],
            "target_language_code": "hi-IN" if lang == "hi" else "en-IN",
            "model": "bulbul:v3",
            "speaker": "kavya",
        },
    )
    r.raise_for_status()
    return base64.b64decode("".join(r.json()["audios"])), "audio/wav"


def _openai(text: str, lang: str) -> tuple[bytes, str]:
    r = httpx.post(f"{settings.llm_base_url.rstrip('/')}/audio/speech", headers={"Authorization": f"Bearer {settings.llm_api_key}"},
                   json={"model": "gpt-4o-mini-tts", "voice": "alloy", "input": text, "response_format": "mp3"}, timeout=25)
    r.raise_for_status()
    return r.content, "audio/mpeg"


def synthesize(text: str, lang: str = "en") -> tuple[bytes, str, str] | None:
    """(audio bytes, mime, engine) or None."""
    p = provider()
    text = speakable(text)
    if p == "off" or not text:
        return None
    try:
        data, mime = {"edge": _edge, "sarvam": _sarvam, "openai": _openai}[p](text, lang)
        return (data, mime, p) if data else None
    except Exception as e:  # noqa: BLE001
        log.warning("tts %s failed: %s", p, e)
        return None
