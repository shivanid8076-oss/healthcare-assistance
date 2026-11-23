"""Regression tests for Phase 5: Automatic Language Matching & Voice Experience Polish."""
from unittest.mock import MagicMock, patch

import pytest
from app.services import assistant, guide, tts


# ---------------------------------------------------------------- Task 1: Hinglish Action Handlers
def test_hinglish_compatibility_response():
    # Direct handler call
    res = assistant._handle_compatibility({"blood_group": "B+", "component": "prbc"}, lang="hinglish")
    assert res is not None
    assert "Blood group B+" in res["text"]
    assert "compatible donor groups" in res["text"]
    assert "Note: Final cross-match hamesha blood bank mein hota hai." in res["text"]


def test_hinglish_camps_response(fresh):
    # Empty state in Hinglish
    res_empty = assistant._handle_camps({"district": "NonexistentDistrict999"}, lang="hinglish")
    assert res_empty is not None
    assert "Filhaal koi upcoming blood donation camp nahi mila" in res_empty["text"]


def test_hinglish_banks_response(fresh):
    # Empty state in Hinglish
    res_empty = assistant._handle_banks({"district": "NonexistentDistrict999"}, lang="hinglish")
    assert res_empty is not None
    assert "Koi blood bank nahi mila. Kripya apna district ya city batayein." in res_empty["text"]


# ---------------------------------------------------------------- Task 2: Multi-turn Language Continuity
def test_multi_turn_hindi_followed_by_short_reply():
    # Hindi conversation history
    history = [
        {"role": "user", "content": "मुझे रक्तदान करना है"},
        {"role": "assistant", "content": "आपका ब्लड ग्रुप क्या है?"},
    ]
    # Ambiguous reply "B+" should stay in Hindi
    res = assistant.chat(history, "B+", lang="auto")
    assert res["detected_lang"] == "hi"
    assert "अनुकूल" in res["reply"] or "डोनर" in res["reply"] or "ब्लड ग्रुप" in res["reply"]


def test_multi_turn_hinglish_followed_by_short_reply():
    # Hinglish conversation history
    history = [
        {"role": "user", "content": "Mujhe blood donor chahiye urgent"},
        {"role": "assistant", "content": "Kaunse blood group ki zarurat hai?"},
    ]
    # Ambiguous reply "B+" should stay in Hinglish
    res = assistant.chat(history, "B+", lang="auto")
    assert res["detected_lang"] == "hinglish"
    assert "compatible donor groups" in res["reply"] or "blood bank" in res["reply"]


def test_multi_turn_explicit_switch_to_english():
    # Conversation began in Hindi
    history = [
        {"role": "user", "content": "रक्तदान के नियम क्या हैं?"},
        {"role": "assistant", "content": "आपकी आयु 18 से 65 वर्ष होनी चाहिए।"},
    ]
    mock_llm = {
        "reply": "You can donate blood if you are healthy, at least 18 years old.",
        "suggestions": ["Find camps"],
        "action": None,
    }
    with patch("app.services.llm.chat_json", return_value=mock_llm), \
         patch("app.config.settings.llm_api_key", "mock-key"):
        res = assistant.chat(history, "Can you explain in English please?", lang="auto")
        assert res["detected_lang"] == "en"
        assert "18" in res["reply"]


# ---------------------------------------------------------------- Task 3: TTS Emoji Sanitization
def test_tts_emoji_sanitization():
    raw_mixed = "🩸 **Blood bank:** 🏥 AIIMS 📍 New Delhi\n📞 011-26588500 🚨 Urgent 📅 25 Nov 2026 📚 [Details](https://link.com)"
    cleaned = tts.speakable(raw_mixed)
    # Ensure emojis are gone
    for emoji in ["🩸", "🏥", "📍", "📞", "🚨", "📅", "📚"]:
        assert emoji not in cleaned
    # Ensure useful content is preserved
    assert "Blood bank:" in cleaned
    assert "AIIMS" in cleaned
    assert "New Delhi" in cleaned
    assert "011-26588500" in cleaned
    assert "Urgent" in cleaned
    assert "25 Nov 2026" in cleaned
    assert "Details" in cleaned
    assert "https://" not in cleaned


def test_tts_emoji_sanitization_hindi():
    raw_hi = "🩸 रक्तदान शिविर: 📍 साकेत 🏥 अपोलो अस्पताल"
    cleaned = tts.speakable(raw_hi)
    assert "🩸" not in cleaned
    assert "📍" not in cleaned
    assert "🏥" not in cleaned
    assert "रक्तदान शिविर: साकेत अपोलो अस्पताल" in cleaned


# ---------------------------------------------------------------- Task 4: UI Fallback & Voice Propagation
def test_hindi_ui_with_ambiguous_short_queries(client):
    # User browsing in Hindi UI sends short ambiguous query "B+"
    r = client.post("/api/assistant/chat", json={"message": "B+", "lang": "hi"})
    assert r.status_code == 200
    data = r.json()
    assert data["detected_lang"] == "hi"
    assert ("अनुकूल" in data["reply"] or "डोनर" in data["reply"] or "ब्लड" in data["reply"])


def test_voice_transcription_language_propagation(client):
    # When voice transcription detects Hinglish
    mock_stt = {
        "text": "Mujhe blood chahiye",
        "engine": "sarvam:saaras:v4",
        "language": "hi",
    }
    with patch("app.services.stt.transcribe", return_value=mock_stt):
        files = {"file": ("audio.webm", b"mock-bytes", "audio/webm")}
        r = client.post("/api/assistant/transcribe?lang=auto", files=files)
        assert r.status_code == 200
        assert r.json()["language"] == "hinglish"

    # When ambiguous text transcribed with lang=hi
    mock_stt_hi = {
        "text": "AIIMS",
        "engine": "sarvam:saaras:v4",
        "language": "hi",
    }
    with patch("app.services.stt.transcribe", return_value=mock_stt_hi):
        files = {"file": ("audio.webm", b"mock-bytes", "audio/webm")}
        r = client.post("/api/assistant/transcribe?lang=hi", files=files)
        assert r.status_code == 200
        assert r.json()["language"] == "hi"


# ---------------------------------------------------------------- Task 5: Guide Hinglish Support
def test_guide_hinglish_refusal():
    # Out of domain query in Hinglish
    res = guide.answer("Aaj mausam kaisa hai", lang="hinglish")
    assert res["refused"] is True
    assert "blood centre ke doctor" in res["answer"].lower()
