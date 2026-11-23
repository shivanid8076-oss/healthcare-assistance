"""Tests for Sarvam Saaras v4 STT integration, Faster-Whisper model resolution,
and slip vs conversational transcription separation.
"""
from unittest.mock import MagicMock, call, patch

import httpx
import pytest

from app.config import Settings
from app.services import stt


def test_config_reads_sarvam_api_key_or_stt_api_key(monkeypatch):
    # Case 1: SARVAM_API_KEY is set
    monkeypatch.setenv("SARVAM_API_KEY", "mock-sarvam-key")
    monkeypatch.delenv("STT_API_KEY", raising=False)
    s1 = Settings()
    assert s1.stt_api_key == "mock-sarvam-key"

    # Case 2: Only STT_API_KEY is set
    monkeypatch.delenv("SARVAM_API_KEY", raising=False)
    monkeypatch.setenv("STT_API_KEY", "mock-stt-key")
    s2 = Settings()
    assert s2.stt_api_key == "mock-stt-key"


# ---------------------------------------------------------------- Model configuration tests
def test_whisper_model_name_resolution_with_sarvam_model():
    # When cloud model 'saaras:v4' is set, Faster-Whisper must resolve to 'base'
    with patch("app.services.stt.settings.stt_model", "saaras:v4"):
        assert stt._local_whisper_model_name() == "base"

    # When cloud model 'whisper-1' is set, Faster-Whisper must resolve to 'base'
    with patch("app.services.stt.settings.stt_model", "whisper-1"):
        assert stt._local_whisper_model_name() == "base"

    # When empty or whitespace, defaults to 'base'
    with patch("app.services.stt.settings.stt_model", ""):
        assert stt._local_whisper_model_name() == "base"


def test_whisper_model_name_resolution_with_valid_whisper_models():
    # Valid Whisper model sizes must be preserved
    for name in ("tiny", "base", "small", "medium", "large-v3", "turbo"):
        with patch("app.services.stt.settings.stt_model", name):
            assert stt._local_whisper_model_name() == name


def test_sarvam_model_selection_ignores_whisper_models():
    # If a user sets stt_model="base" or "small", Sarvam should still default to saaras:v4
    mock_response = MagicMock(status_code=200)
    mock_response.json.return_value = {"transcript": "test", "language_code": "en-IN"}
    mock_response.raise_for_status = MagicMock()

    captured_call = {}

    def mock_post(url, headers, files, data, timeout):
        captured_call["data"] = data
        return mock_response

    with patch("app.services.stt.settings.stt_provider", "sarvam"), \
         patch("app.services.stt.settings.stt_api_key", "mock-key"), \
         patch("app.services.stt.settings.stt_model", "base"), \
         patch("httpx.post", side_effect=mock_post):
        res = stt._sarvam(b"fake", "audio/webm")
        assert captured_call["data"]["model"] == "saaras:v4"
        assert res["engine"] == "sarvam:saaras:v4"


# ---------------------------------------------------------------- Sarvam API & fallback tests
def test_sarvam_saaras_v4_success():
    mock_response = MagicMock(status_code=200)
    mock_response.json.return_value = {
        "transcript": "Mujhe B positive blood chahiye Safdarjung hospital mein",
        "language_code": "hi-IN",
    }
    mock_response.raise_for_status = MagicMock()

    captured_call = {}

    def mock_post(url, headers, files, data, timeout):
        captured_call["url"] = url
        captured_call["headers"] = headers
        captured_call["data"] = data
        captured_call["timeout"] = timeout
        return mock_response

    with patch("app.services.stt.settings.stt_provider", "sarvam"), \
         patch("app.services.stt.settings.stt_api_key", "test-sarvam-key"), \
         patch("app.services.stt.settings.stt_model", "saaras:v4"), \
         patch("httpx.post", side_effect=mock_post):

        res = stt.transcribe(b"fake-audio-bytes-12345", "audio/webm")
        assert res["text"] == "Mujhe B positive blood chahiye Safdarjung hospital mein"
        assert res["engine"] == "sarvam:saaras:v4"
        assert res["language"] == "hi-IN"
        assert captured_call["url"] == "https://api.sarvam.ai/speech-to-text"
        assert captured_call["data"]["model"] == "saaras:v4"
        assert captured_call["data"]["mode"] == "codemix"
        assert captured_call["data"]["language_code"] == "unknown"
        assert captured_call["timeout"] == 20.0


def test_sarvam_fallback_to_local_on_http_error():
    mock_error_response = MagicMock(status_code=500)
    http_err = httpx.HTTPStatusError("Internal Server Error", request=MagicMock(), response=mock_error_response)

    mock_local_result = {
        "text": "Fallback local transcript",
        "engine": "whisper-local",
        "language": "hi-en",
    }

    with patch("app.services.stt.settings.stt_provider", "sarvam"), \
         patch("app.services.stt.settings.stt_api_key", "test-sarvam-key"), \
         patch("httpx.post", side_effect=http_err), \
         patch("app.services.stt._local", return_value=mock_local_result) as mock_local:

        res = stt.transcribe(b"fake-audio-bytes-12345", "audio/webm", extract_slip=False)
        assert res["text"] == "Fallback local transcript"
        assert res["engine"] == "whisper-local"
        mock_local.assert_called_once_with(b"fake-audio-bytes-12345", "audio/webm", extract_slip=False)


def test_sarvam_fallback_to_local_on_timeout():
    mock_local_result = {
        "text": "Local transcript after timeout",
        "engine": "whisper-local",
        "language": "hi-en",
    }

    with patch("app.services.stt.settings.stt_provider", "sarvam"), \
         patch("app.services.stt.settings.stt_api_key", "test-sarvam-key"), \
         patch("httpx.post", side_effect=httpx.TimeoutException("Connection timed out")), \
         patch("app.services.stt._local", return_value=mock_local_result) as mock_local:

        res = stt.transcribe(b"fake-audio-bytes-12345", "audio/webm", extract_slip=True)
        assert res["text"] == "Local transcript after timeout"
        assert res["engine"] == "whisper-local"
        mock_local.assert_called_once_with(b"fake-audio-bytes-12345", "audio/webm", extract_slip=True)


def test_sarvam_missing_api_key_fallback():
    mock_local_result = {
        "text": "Local transcript when key missing",
        "engine": "whisper-local",
        "language": "hi-en",
    }

    with patch("app.services.stt.settings.stt_provider", "sarvam"), \
         patch("app.services.stt.settings.stt_api_key", ""), \
         patch("app.services.stt._local", return_value=mock_local_result) as mock_local, \
         patch("httpx.post") as mock_post:

        res = stt.transcribe(b"fake-audio-bytes-12345", "audio/webm", extract_slip=False)
        assert res["text"] == "Local transcript when key missing"
        assert res["engine"] == "whisper-local"
        mock_local.assert_called_once_with(b"fake-audio-bytes-12345", "audio/webm", extract_slip=False)
        mock_post.assert_not_called()


def test_sarvam_both_providers_fail():
    with patch("app.services.stt.settings.stt_provider", "sarvam"), \
         patch("app.services.stt.settings.stt_api_key", "test-sarvam-key"), \
         patch("httpx.post", side_effect=RuntimeError("Sarvam unreachable")), \
         patch("app.services.stt._local", side_effect=RuntimeError("Whisper crashed")):

        res = stt.transcribe(b"fake-audio-bytes-12345", "audio/webm")
        assert res["text"] == ""
        assert res["engine"] == "error"
        assert "Both Sarvam AI and local transcription failed" in res["error"]


# ---------------------------------------------------------------- Separation of Assistant vs Slip Tests
def test_assistant_transcription_single_pass_no_slip_extraction():
    """Assistant transcription (extract_slip=False) must execute only one local pass,
    skipping rule_extract and skipping the second Hindi transcription pass entirely.
    """
    mock_segment = MagicMock(text="Can a diabetic donate blood?")
    mock_model = MagicMock()
    mock_model.transcribe.return_value = ([mock_segment], MagicMock())

    with patch("app.services.stt._local_model", mock_model), \
         patch("app.services.stt.decode_16k", return_value=MagicMock()), \
         patch("app.services.stt.provider", return_value="local"), \
         patch("app.services.extraction.rule_extract") as mock_rule_extract:

        res = stt.transcribe(b"audio-data", "audio/webm", extract_slip=False)

        assert res["text"] == "Can a diabetic donate blood?"
        assert res["engine"] == "whisper-local"
        # Only Pass 1 (language="en") was called
        assert mock_model.transcribe.call_count == 1
        assert mock_model.transcribe.call_args[1]["language"] == "en"
        # rule_extract was never invoked
        mock_rule_extract.assert_not_called()


def test_emergency_transcription_recovers_all_fields_when_pass1_finds_zero():
    """Emergency slip transcription (extract_slip=True):
    When Pass 1 extracts 0 fields, Pass 2 must still run in Hindi (Devanagari)
    and recover hospital, patient group, and units.
    """
    pass1_seg = MagicMock(text="hospital me khoon chahiye")  # Pass 1 gives vague text with 0 fields
    pass2_seg = MagicMock(text="एम्स अस्पताल में दो यूनिट बी पॉजिटिव रक्त चाहिए")  # Pass 2 gives full details

    mock_model = MagicMock()
    # First call returns pass1_seg, second call returns pass2_seg
    mock_model.transcribe.side_effect = [
        ([pass1_seg], MagicMock()),
        ([pass2_seg], MagicMock()),
    ]

    with patch("app.services.stt._local_model", mock_model), \
         patch("app.services.stt.decode_16k", return_value=MagicMock()), \
         patch("app.services.stt.provider", return_value="local"):

        res = stt.transcribe(b"audio-data", "audio/ogg", extract_slip=True)

        # Both passes ran
        assert mock_model.transcribe.call_count == 2
        assert mock_model.transcribe.call_args_list[0][1]["language"] == "en"
        assert mock_model.transcribe.call_args_list[1][1]["language"] == "hi"

        # The combined text contains both
        assert "hospital me khoon chahiye" in res["text"]
        assert "एम्स अस्पताल में दो यूनिट बी पॉजिटिव रक्त चाहिए" in res["text"]

        # Extraction on combined text successfully recovers all fields
        from app.services.extraction import rule_extract
        fields = rule_extract(res["text"])
        assert fields["patient_group"] == "B+"
        assert fields["units"] == 2
        assert fields["hospital"] == "AIIMS"


def test_emergency_transcription_recovers_partial_missing_fields():
    """Emergency slip transcription (extract_slip=True):
    Pass 1 finds only hospital ('Safdarjung hospital'), missing group and units.
    Pass 2 runs and recovers group ('ए पॉजिटिव') and units ('3 यूनिट').
    """
    pass1_seg = MagicMock(text="Need blood at Safdarjung hospital")  # Has hospital, missing group & units
    pass2_seg = MagicMock(text="तीन यूनिट ए पॉजिटिव चाहिए")  # Has group & units

    mock_model = MagicMock()
    mock_model.transcribe.side_effect = [
        ([pass1_seg], MagicMock()),
        ([pass2_seg], MagicMock()),
    ]

    with patch("app.services.stt._local_model", mock_model), \
         patch("app.services.stt.decode_16k", return_value=MagicMock()), \
         patch("app.services.stt.provider", return_value="local"):

        res = stt.transcribe(b"audio-data", "audio/ogg", extract_slip=True)

        assert mock_model.transcribe.call_count == 2
        assert "Safdarjung hospital" in res["text"]
        assert "तीन यूनिट ए पॉजिटिव चाहिए" in res["text"]

        from app.services.extraction import rule_extract
        fields = rule_extract(res["text"])
        assert fields["patient_group"] == "A+"
        assert fields["units"] == 3
        assert "Safdarjung" in fields["hospital"]
