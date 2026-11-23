"""Tests for RaktDoot AI Assistant service and API."""
from unittest.mock import patch

from app.services import assistant


def test_emergency_detection():
    # English emergency
    res = assistant.chat([], "Emergency! My brother needs blood right now at AIIMS", lang="en")
    assert "112" in res["reply"]
    assert "Emergency" in res["reply"]

    # Hindi emergency
    res_hi = assistant.chat([], "तुरंत खून चाहिए इमरजेंसी है", lang="hi")
    assert "112" in res_hi["reply"]
    assert "आपातकाल" in res_hi["reply"]


def test_compatibility_fallback():
    # Without LLM key, rule-based fallback detects compatibility questions
    res = assistant.chat([], "Who can donate blood to B+ patient?", lang="en")
    assert "B+" in res["reply"]
    assert "Compatible donor groups" in res["reply"]


def test_welcome_on_empty():
    res = assistant.chat([], "", lang="en")
    assert "Welcome to Blood AI Assistant" in res["reply"]

    res_hi = assistant.chat([], "", lang="hi")
    assert "Blood AI Assistant में आपका स्वागत है" in res_hi["reply"]


def test_llm_chat_flow():
    mock_llm_response = {
        "reply": "You can donate blood if you are healthy, at least 18 years old, and weigh over 45 kg.",
        "suggestions": ["Find blood bank", "Check camps"],
        "action": None,
    }
    with patch("app.services.llm.chat_json", return_value=mock_llm_response), \
         patch("app.config.settings.llm_api_key", "mock-key"):
        res = assistant.chat([], "Can I donate blood?", lang="en")
        assert "at least 18 years old" in res["reply"]
        assert len(res["suggestions"]) == 2


def test_llm_with_compatibility_action():
    mock_llm_response = {
        "reply": "Here is the compatibility information for AB+:",
        "suggestions": ["Can AB+ donate to O+?"],
        "action": {"type": "compatibility", "blood_group": "AB+", "component": "prbc"},
    }
    with patch("app.services.llm.chat_json", return_value=mock_llm_response), \
         patch("app.config.settings.llm_api_key", "mock-key"):
        res = assistant.chat([], "Who can donate to AB+?", lang="en")
        assert "AB+" in res["reply"]
        assert "Compatible donor groups" in res["reply"]


def test_api_chat_endpoint(client):
    # Valid question
    r = client.post("/api/assistant/chat", json={"message": "Emergency help needed", "lang": "en"})
    assert r.status_code == 200
    data = r.json()
    assert "112" in data["reply"]
    assert "suggestions" in data

    # Input validation: empty string
    r = client.post("/api/assistant/chat", json={"message": "", "lang": "en"})
    assert r.status_code == 422

    # Input validation: missing message
    r = client.post("/api/assistant/chat", json={"lang": "en"})
    assert r.status_code == 422

    # Invalid role in history
    r = client.post("/api/assistant/chat", json={
        "messages": [{"role": "hacker", "content": "hello"}],
        "message": "hello",
    })
    assert r.status_code == 422


def test_user_message_over_500_rejected(client):
    r = client.post("/api/assistant/chat", json={"message": "A" * 501, "lang": "en"})
    assert r.status_code == 422


def test_user_history_over_500_rejected(client):
    r = client.post("/api/assistant/chat", json={
        "messages": [{"role": "user", "content": "A" * 501}],
        "message": "hello",
        "lang": "en",
    })
    assert r.status_code == 422


def test_assistant_history_over_500_accepted(client):
    # Assistant responses can be long (e.g. lists of blood banks). History up to 3000 chars should be accepted.
    r = client.post("/api/assistant/chat", json={
        "messages": [
            {"role": "user", "content": "Find blood near me"},
            {"role": "assistant", "content": "B" * 1200},
        ],
        "message": "thank you",
        "lang": "en",
    })
    assert r.status_code == 200
    data = r.json()
    assert "reply" in data


def test_assistant_history_over_3000_rejected(client):
    # Assistant responses beyond 3000 chars should be rejected
    r = client.post("/api/assistant/chat", json={
        "messages": [
            {"role": "user", "content": "Find blood near me"},
            {"role": "assistant", "content": "B" * 3001},
        ],
        "message": "thank you",
        "lang": "en",
    })
    assert r.status_code == 422


def test_multi_turn_conversation_flow(client):
    history = [
        {"role": "user", "content": "Hello"},
        {"role": "assistant", "content": "Hello! How can I help with blood donation today?"},
        {"role": "user", "content": "Who can donate to B+?"},
        {"role": "assistant", "content": "Patients with B+ can receive blood from B+, B-, O+, and O- donors."},
    ]
    r = client.post("/api/assistant/chat", json={
        "messages": history,
        "message": "What about O-?",
        "lang": "en",
    })
    assert r.status_code == 200
    data = r.json()
    assert "reply" in data


# ---------------------------------------------------------------- transcription endpoint tests
def test_transcribe_valid_audio(client):
    mock_result = {
        "text": "B positive blood chahiye AIIMS mein",
        "engine": "whisper-local",
        "language": "hi-en",
    }
    with patch("app.services.stt.transcribe", return_value=mock_result):
        files = {"file": ("recording.webm", b"mock-audio-bytes", "audio/webm")}
        r = client.post("/api/assistant/transcribe", files=files)
        assert r.status_code == 200
        data = r.json()
        assert data["transcript"] == "B positive blood chahiye AIIMS mein"
        assert data["engine"] == "whisper-local"
        assert data["error"] is None


def test_transcribe_with_lang_query(client):
    mock_result = {
        "text": "मुझे रक्तदान करना है",
        "engine": "sarvam:saaras:v3",
        "language": "hi",
    }
    with patch("app.services.stt.transcribe", return_value=mock_result):
        files = {"file": ("recording.ogg", b"mock-audio-bytes", "audio/ogg")}
        r = client.post("/api/assistant/transcribe?lang=hi", files=files)
        assert r.status_code == 200
        data = r.json()
        assert data["transcript"] == "मुझे रक्तदान करना है"
        assert data["engine"] == "sarvam:saaras:v3"


def test_transcribe_empty_audio_rejected(client):
    files = {"file": ("empty.webm", b"", "audio/webm")}
    r = client.post("/api/assistant/transcribe", files=files)
    assert r.status_code == 400
    assert "empty" in r.json()["detail"].lower()


def test_transcribe_oversized_audio_rejected(client):
    oversized = b"x" * (16 * 1024 * 1024 + 1)
    files = {"file": ("huge.webm", oversized, "audio/webm")}
    r = client.post("/api/assistant/transcribe", files=files)
    assert r.status_code == 413
    assert "exceeds" in r.json()["detail"].lower()


def test_transcribe_unsupported_mime_rejected(client):
    files = {"file": ("test.txt", b"plain text is not audio", "text/plain")}
    r = client.post("/api/assistant/transcribe", files=files)
    assert r.status_code == 415
    assert "unsupported" in r.json()["detail"].lower()


def test_transcribe_stt_failure_handled(client):
    mock_failure = {
        "text": "",
        "engine": "whisper-local",
        "error": "Audio corrupted",
    }
    with patch("app.services.stt.transcribe", return_value=mock_failure):
        files = {"file": ("corrupt.wav", b"corrupt-data", "audio/wav")}
        r = client.post("/api/assistant/transcribe", files=files)
        assert r.status_code == 200
        data = r.json()
        assert data["transcript"] == ""
        assert data["error"] == "Audio corrupted"


def test_transcribe_exception_handled_safely(client):
    with patch("app.services.stt.transcribe", side_effect=RuntimeError("Whisper CUDA internal fault /opt/secret/path")):
        files = {"file": ("test.webm", b"sample-audio", "audio/webm")}
        r = client.post("/api/assistant/transcribe", files=files)
        assert r.status_code == 200
        data = r.json()
        assert data["transcript"] == ""
        assert data["engine"] == "error"
        assert "Transcription failed" in data["error"]
        assert "/opt/secret" not in data["error"]


# ---------------------------------------------------------------- language detection tests
def test_detect_language_hindi():
    assert assistant.detect_language("मुझे रक्तदान करना है") == "hi"
    assert assistant.detect_language("तुरंत खून चाहिए इमरजेंसी है") == "hi"
    assert assistant.detect_language("रक्तदाता कहाँ मिलेगा?") == "hi"


def test_detect_language_english():
    assert assistant.detect_language("Who can donate blood to A+?") == "en"
    assert assistant.detect_language("Find nearby blood banks") == "en"
    assert assistant.detect_language("Can diabetics donate blood?") == "en"


def test_detect_language_hinglish():
    assert assistant.detect_language("Mujhe B positive blood chahiye Safdarjung hospital mein") == "hinglish"
    assert assistant.detect_language("Emergency! AIIMS hospital me blood arrange karo please") == "hinglish"
    assert assistant.detect_language("Khoon kaise donate kare") == "hinglish"
    assert assistant.detect_language("Aapko blood donor chahiye kya?") == "hinglish"


def test_detect_language_ambiguous_or_short():
    assert assistant.detect_language("B+") == "en"
    assert assistant.detect_language("OK") == "en"
    assert assistant.detect_language("123") == "en"
    assert assistant.detect_language("") == "en"


def test_chat_auto_language_detection():
    # Hindi query with lang="auto" returns detected_lang="hi"
    res_hi = assistant.chat([], "मुझे रक्तदान करना है", lang="auto")
    assert res_hi["detected_lang"] == "hi"

    # Hinglish query with lang="auto" returns detected_lang="hinglish"
    res_hinglish = assistant.chat([], "Mujhe B positive blood chahiye", lang="auto")
    assert res_hinglish["detected_lang"] == "hinglish"

    # English query with lang="auto" returns detected_lang="en"
    res_en = assistant.chat([], "Who can donate blood to A+?", lang="auto")
    assert res_en["detected_lang"] == "en"


def test_hinglish_emergency_detection():
    res = assistant.chat([], "Emergency! Jaldi blood chahiye AIIMS me", lang="auto")
    assert res["detected_lang"] == "hinglish"
    assert "112" in res["reply"]
    assert "Emergency" in res["reply"] or "Apatkalin" in res["reply"] or "turant" in res["reply"]


def test_api_chat_auto_language_detection(client):
    r = client.post("/api/assistant/chat", json={"message": "Mujhe blood chahiye please", "lang": "auto"})
    assert r.status_code == 200
    data = r.json()
    assert data["detected_lang"] == "hinglish"
    assert "reply" in data

    r_hi = client.post("/api/assistant/chat", json={"message": "रक्तदान कैसे करें", "lang": "auto"})
    assert r_hi.status_code == 200
    assert r_hi.json()["detected_lang"] == "hi"


def test_transcribe_returns_detected_language(client):
    mock_result = {
        "text": "Mujhe blood donor chahiye",
        "engine": "whisper-local",
        "language": "hi",
    }
    with patch("app.services.stt.transcribe", return_value=mock_result):
        files = {"file": ("recording.webm", b"mock-audio-bytes", "audio/webm")}
        r = client.post("/api/assistant/transcribe?lang=auto", files=files)
        assert r.status_code == 200
        data = r.json()
        assert data["transcript"] == "Mujhe blood donor chahiye"
        assert data["language"] == "hinglish"
        assert data["engine"] == "whisper-local"



