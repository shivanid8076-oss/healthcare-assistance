"""Tests for Assistant Text-to-Speech (TTS) integration (/api/assistant/speak)."""
import base64
from unittest.mock import MagicMock, patch

import pytest
from app.config import settings
from app.services import tts


# ---------------------------------------------------------------- speakable() unit tests
def test_speakable_markdown_and_links():
    raw = "Here is [RaktDoot Portal](https://raktdoot.in/camps) for **blood donation** and `eligibility` info."
    cleaned = tts.speakable(raw)
    assert "https://" not in cleaned
    assert "RaktDoot Portal" in cleaned
    assert "**" not in cleaned
    assert "`" not in cleaned
    assert "blood donation" in cleaned


def test_speakable_bullets_and_newlines():
    raw = "- Age 18-65\n- Weight 45kg+\n- Hemoglobin 12.5+"
    cleaned = tts.speakable(raw)
    assert not cleaned.startswith("-")
    assert "Age 18-65. Weight 45kg+. Hemoglobin 12.5+" in cleaned


def test_speakable_truncation():
    raw = "A" * 2000
    cleaned = tts.speakable(raw)
    assert len(cleaned) <= tts.MAX_CHARS


# ---------------------------------------------------------------- Sarvam bulbul:v3 format tests
def test_sarvam_tts_payload_format(monkeypatch):
    monkeypatch.setattr(settings, "stt_api_key", "test-sarvam-key")
    captured_payload = {}
    captured_headers = {}

    def mock_post(url, headers=None, json=None, timeout=None):
        nonlocal captured_payload, captured_headers
        captured_headers = headers or {}
        captured_payload = json or {}
        fake_b64 = base64.b64encode(b"RIFFdummywavdata").decode()
        mock_resp = MagicMock()
        mock_resp.status_code = 200
        mock_resp.raise_for_status = MagicMock()
        mock_resp.json = MagicMock(return_value={"audios": [fake_b64]})
        return mock_resp

    with patch("httpx.post", side_effect=mock_post):
        audio, mime = tts._sarvam("नमस्ते, रक्तदान करें", "hi")
        assert mime == "audio/wav"
        assert audio == b"RIFFdummywavdata"
        assert captured_headers.get("api-subscription-key") == "test-sarvam-key"
        assert captured_payload.get("model") == "bulbul:v3"
        assert captured_payload.get("speaker") == "kavya"
        assert captured_payload.get("inputs") == ["नमस्ते, रक्तदान करें"]
        assert captured_payload.get("target_language_code") == "hi-IN"

    with patch("httpx.post", side_effect=mock_post):
        tts._sarvam("Hello donor", "en")
        assert captured_payload.get("target_language_code") == "en-IN"


# ---------------------------------------------------------------- /api/assistant/speak endpoint tests
def test_speak_hindi_speech_generation(client, monkeypatch):
    monkeypatch.setattr(tts, "synthesize", lambda text, lang="en": (b"mock-hindi-audio", "audio/mpeg", "edge"))

    r = client.post("/api/assistant/speak", json={"text": "रक्तदान महादान है", "lang": "hi"})
    assert r.status_code == 200
    assert r.headers["content-type"] == "audio/mpeg"
    assert r.headers["x-tts-language"] == "hi"
    assert r.headers["x-tts-engine"] == "edge"
    assert r.content == b"mock-hindi-audio"


def test_speak_english_speech_generation(client, monkeypatch):
    monkeypatch.setattr(tts, "synthesize", lambda text, lang="en": (b"mock-english-audio", "audio/mpeg", "edge"))

    r = client.post("/api/assistant/speak", json={"text": "Blood donation saves lives.", "lang": "en"})
    assert r.status_code == 200
    assert r.headers["content-type"] == "audio/mpeg"
    assert r.headers["x-tts-language"] == "en"
    assert r.content == b"mock-english-audio"


def test_speak_hinglish_speech_generation(client, monkeypatch):
    synthesized_lang = None

    def mock_synth(text, lang="en"):
        nonlocal synthesized_lang
        synthesized_lang = lang
        return (b"mock-hinglish-audio", "audio/mpeg", "edge")

    monkeypatch.setattr(tts, "synthesize", mock_synth)

    r = client.post("/api/assistant/speak", json={"text": "Aap blood donate karne ke liye eligible hain.", "lang": "hinglish"})
    assert r.status_code == 200
    assert r.headers["x-tts-language"] == "hinglish"
    # Hinglish maps to Indian English voice ("en")
    assert synthesized_lang == "en"
    assert r.content == b"mock-hinglish-audio"


def test_speak_auto_language_detection(client, monkeypatch):
    captured_calls = []

    def mock_synth(text, lang="en"):
        captured_calls.append((text, lang))
        return (b"mock-audio", "audio/mpeg", "edge")

    monkeypatch.setattr(tts, "synthesize", mock_synth)

    # Devanagari should be detected as Hindi
    r1 = client.post("/api/assistant/speak", json={"text": "रक्तदान के लिए धन्यवाद।", "lang": "auto"})
    assert r1.status_code == 200
    assert r1.headers["x-tts-language"] == "hi"
    assert captured_calls[-1][1] == "hi"

    # Latin text should route to English voice
    r2 = client.post("/api/assistant/speak", json={"text": "Thank you for donating blood.", "lang": "auto"})
    assert r2.status_code == 200
    assert captured_calls[-1][1] == "en"


def test_speak_empty_text_rejected(client):
    # Empty in request schema
    r1 = client.post("/api/assistant/speak", json={"text": "", "lang": "en"})
    assert r1.status_code == 422

    # Only whitespace
    r2 = client.post("/api/assistant/speak", json={"text": "   ", "lang": "en"})
    assert r2.status_code == 422

    # Non-empty raw text that becomes empty after speakable sanitization (e.g. only a link)
    r3 = client.post("/api/assistant/speak", json={"text": "https://example.com/link", "lang": "en"})
    assert r3.status_code == 400
    assert "Text is empty or contains no speakable characters" in r3.json()["detail"]


def test_speak_invalid_language_falls_back(client, monkeypatch):
    monkeypatch.setattr(tts, "synthesize", lambda text, lang="en": (b"mock-audio", "audio/mpeg", "edge"))

    r = client.post("/api/assistant/speak", json={"text": "General blood donation advice.", "lang": "es"})
    assert r.status_code == 200


def test_speak_tts_failure_handled(client, monkeypatch):
    # Provider returns None
    monkeypatch.setattr(tts, "synthesize", lambda text, lang="en": None)
    r1 = client.post("/api/assistant/speak", json={"text": "Sample text", "lang": "en"})
    assert r1.status_code == 502
    assert "unavailable or failed to produce audio" in r1.json()["detail"]

    # Provider raises unexpected exception
    def failing_synth(text, lang="en"):
        raise RuntimeError("Service timeout")

    monkeypatch.setattr(tts, "synthesize", failing_synth)
    r2 = client.post("/api/assistant/speak", json={"text": "Sample text", "lang": "en"})
    assert r2.status_code == 502
    assert "Text-to-speech synthesis failed" in r2.json()["detail"]

