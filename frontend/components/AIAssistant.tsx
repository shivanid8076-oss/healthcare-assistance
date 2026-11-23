"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  api,
  fetchAssistantSpeech,
  upload,
  type AssistantChatRequest,
  type AssistantChatResponse,
  type AssistantMessage,
  type TranscribeResponse,
} from "@/lib/api";
import { useLang } from "@/lib/i18n";

type ChatItem = {
  id: string;
  role: "user" | "assistant";
  content: string;
  suggestions?: string[];
  sources?: { title: string; url: string }[];
  isError?: boolean;
  detected_lang?: "en" | "hi" | "hinglish";
};

const SESSION_STORAGE_KEY = "rd:assistant_history";

/** Helper to render simple markdown with bold and links safely without external libs */
function FormattedText({ text, isUser }: { text: string; isUser: boolean }) {
  const lines = text.split("\n");

  return (
    <div className="ai-assistant-formatted">
      {lines.map((line, lineIdx) => {
        const trimmed = line.trim();
        const isBullet = trimmed.startsWith("•") || trimmed.startsWith("- ") || trimmed.startsWith("* ");
        const contentToParse = isBullet ? trimmed.replace(/^[•\-\*]\s*/, "") : line;

        // Parse markdown links [label](url) and bold **text**
        const elements: (string | React.ReactNode)[] = [];
        const regex = /(\[([^\]]+)\]\((https?:\/\/[^\)]+)\))|(\*\*([^*]+)\*\*)/g;
        let lastIndex = 0;
        let match: RegExpExecArray | null;
        let key = 0;

        while ((match = regex.exec(contentToParse)) !== null) {
          if (match.index > lastIndex) {
            elements.push(contentToParse.substring(lastIndex, match.index));
          }
          if (match[1]) {
            elements.push(
              <a
                key={`lnk-${key++}`}
                href={match[3]}
                target="_blank"
                rel="noopener noreferrer"
                className="ai-assistant-link"
              >
                {match[2]}
              </a>
            );
          } else if (match[4]) {
            elements.push(<strong key={`bld-${key++}`}>{match[5]}</strong>);
          }
          lastIndex = regex.lastIndex;
        }

        if (lastIndex < contentToParse.length) {
          elements.push(contentToParse.substring(lastIndex));
        }

        if (isBullet) {
          return (
            <div key={`ln-${lineIdx}`} className="ai-assistant-list-item">
              <span className="ai-assistant-bullet">•</span>
              <span>{elements.length > 0 ? elements : "\u00A0"}</span>
            </div>
          );
        }

        return (
          <div key={`ln-${lineIdx}`} className="ai-assistant-line">
            {elements.length > 0 ? elements : "\u00A0"}
          </div>
        );
      })}
    </div>
  );
}

// Minimal Web Speech API interfaces for type safety
interface SpeechRecognitionEventLike {
  resultIndex: number;
  results: {
    length: number;
    [index: number]: {
      isFinal: boolean;
      [index: number]: {
        transcript: string;
      };
    };
  };
}

interface SpeechRecognitionErrorEventLike {
  error: string;
}

interface SpeechRecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  start: () => void;
  stop: () => void;
  abort: () => void;
  onstart: (() => void) | null;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onerror: ((event: SpeechRecognitionErrorEventLike) => void) | null;
  onend: (() => void) | null;
}

function getSpeechRecognitionClass(): (new () => SpeechRecognitionLike) | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as {
    SpeechRecognition?: new () => SpeechRecognitionLike;
    webkitSpeechRecognition?: new () => SpeechRecognitionLike;
  };
  return w.SpeechRecognition || w.webkitSpeechRecognition || null;
}

function getSupportedAudioMimeType(): string {
  if (typeof window === "undefined" || typeof MediaRecorder === "undefined") {
    return "audio/webm";
  }
  const candidates = [
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/ogg;codecs=opus",
    "audio/ogg",
    "audio/mp4",
    "audio/wav",
  ];
  for (const mime of candidates) {
    if (MediaRecorder.isTypeSupported(mime)) {
      return mime;
    }
  }
  return "";
}

function formatVoiceTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s < 10 ? "0" : ""}${s}`;
}

export function AIAssistant() {
  const { lang, t } = useLang();
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<ChatItem[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [failedQuery, setFailedQuery] = useState<string | null>(null);

  // Voice input states
  const [isListening, setIsListening] = useState(false); // Native SpeechRecognition active
  const [isRecording, setIsRecording] = useState(false); // MediaRecorder fallback active
  const [isTranscribing, setIsTranscribing] = useState(false); // Backend STT upload/transcribe active
  const [recordingDuration, setRecordingDuration] = useState(0); // Elapsed seconds
  const [voiceLang, setVoiceLang] = useState<"hi-IN" | "en-IN">(lang === "hi" ? "hi-IN" : "en-IN");
  const [voiceError, setVoiceError] = useState<string | null>(null);

  // TTS audio playback states
  const [playingMessageId, setPlayingMessageId] = useState<string | null>(null);
  const [playbackState, setPlaybackState] = useState<"idle" | "loading" | "playing" | "paused">("idle");
  const [playbackError, setPlaybackError] = useState<{ messageId: string; text: string } | null>(null);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const drawerRef = useRef<HTMLDivElement>(null);
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const recordTimerRef = useRef<NodeJS.Timeout | null>(null);
  const baseTextRef = useRef<string>("");
  const inputRef = useRef<string>(input);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const blobUrlCacheRef = useRef<Map<string, string>>(new Map());
  const lastTranscribedLangRef = useRef<string | null>(null);

  // Keep inputRef in sync
  useEffect(() => {
    inputRef.current = input;
  }, [input]);

  // Sync default speech recognition language when UI lang changes (only when idle)
  useEffect(() => {
    if (!isListening && !isRecording && !isTranscribing) {
      setVoiceLang(lang === "hi" ? "hi-IN" : "en-IN");
    }
  }, [lang, isListening, isRecording, isTranscribing]);

  const stopListening = useCallback(() => {
    if (recognitionRef.current) {
      try {
        recognitionRef.current.stop();
      } catch {
        // ignore
      }
    }
    setIsListening(false);
  }, []);

  const stopMediaRecording = useCallback(() => {
    if (recordTimerRef.current) {
      clearInterval(recordTimerRef.current);
      recordTimerRef.current = null;
    }
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== "inactive") {
      try {
        mediaRecorderRef.current.stop();
      } catch {
        // ignore
      }
    }
    if (mediaStreamRef.current) {
      try {
        mediaStreamRef.current.getTracks().forEach((track) => track.stop());
      } catch {
        // ignore
      }
      mediaStreamRef.current = null;
    }
    setIsRecording(false);
  }, []);

  const startMediaRecording = useCallback(
    async (targetLang: "hi-IN" | "en-IN") => {
      setVoiceError(null);
      setError(null);

      if (typeof navigator === "undefined" || !navigator.mediaDevices || typeof MediaRecorder === "undefined") {
        setVoiceError(t("voice_unsupported"));
        return;
      }

      const mimeType = getSupportedAudioMimeType();
      if (!mimeType) {
        setVoiceError(t("voice_unsupported"));
        return;
      }

      let stream: MediaStream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        mediaStreamRef.current = stream;
      } catch (err: unknown) {
        const errorName = (err as Error)?.name || "";
        if (errorName === "NotAllowedError" || errorName === "PermissionDeniedError") {
          setVoiceError(t("voice_denied"));
        } else if (errorName === "NotFoundError" || errorName === "DevicesNotFoundError") {
          setVoiceError(t("voice_none"));
        } else {
          setVoiceError(t("voice_denied"));
        }
        return;
      }

      try {
        const options: MediaRecorderOptions = { mimeType };
        const recorder = new MediaRecorder(stream, options);
        mediaRecorderRef.current = recorder;
        audioChunksRef.current = [];
        baseTextRef.current = inputRef.current;

        recorder.ondataavailable = (e: BlobEvent) => {
          if (e.data && e.data.size > 0) {
            audioChunksRef.current.push(e.data);
          }
        };

        recorder.onerror = () => {
          stopMediaRecording();
          setVoiceError(t("voice_none"));
        };

        recorder.onstop = async () => {
          // Release stream tracks immediately
          if (mediaStreamRef.current) {
            try {
              mediaStreamRef.current.getTracks().forEach((track) => track.stop());
            } catch {}
            mediaStreamRef.current = null;
          }

          const chunks = audioChunksRef.current;
          audioChunksRef.current = [];

          if (chunks.length === 0) {
            setVoiceError(t("voice_none"));
            return;
          }

          const recordedBlob = new Blob(chunks, { type: mimeType });
          if (recordedBlob.size === 0) {
            setVoiceError(t("voice_none"));
            return;
          }

          if (recordedBlob.size > 16 * 1024 * 1024) {
            setVoiceError(lang === "hi" ? "ऑडियो रिकॉर्डिंग 16 MB से अधिक है।" : "Recording exceeds 16 MB limit.");
            return;
          }

          // Upload to backend transcribe endpoint
          setIsTranscribing(true);
          setVoiceError(null);

          try {
            const ext = mimeType.includes("ogg")
              ? "ogg"
              : mimeType.includes("wav")
              ? "wav"
              : mimeType.includes("mp4")
              ? "mp4"
              : "webm";

            const formData = new FormData();
            formData.append("file", recordedBlob, `assistant-voice.${ext}`);

            const langParam = voiceLang === "hi-IN" ? "hi" : "auto";
            const res = await upload<TranscribeResponse>(
              `/api/assistant/transcribe?lang=${langParam}`,
              formData
            );

            if (res.error && !res.transcript) {
              setVoiceError(res.error || t("voice_none"));
            } else if (res.transcript) {
              if (res.language) {
                lastTranscribedLangRef.current = res.language;
              }
              const prefix = baseTextRef.current ? baseTextRef.current.trim() + " " : "";
              const combined = (prefix + res.transcript).trim();
              setInput(combined.slice(0, 500));
              setTimeout(() => {
                textareaRef.current?.focus();
              }, 100);
            } else {
              setVoiceError(t("voice_none"));
            }
          } catch (uploadErr) {
            setVoiceError((uploadErr as Error).message || t("voice_none"));
          } finally {
            setIsTranscribing(false);
          }
        };

        recorder.start(250);
        setIsRecording(true);
        setRecordingDuration(0);

        if (recordTimerRef.current) clearInterval(recordTimerRef.current);
        const startTime = Date.now();
        recordTimerRef.current = setInterval(() => {
          const elapsed = Math.floor((Date.now() - startTime) / 1000);
          setRecordingDuration(elapsed);
          if (elapsed >= 60) {
            stopMediaRecording();
          }
        }, 1000);
      } catch {
        stopMediaRecording();
        setVoiceError(t("voice_unsupported"));
      }
    },
    [lang, stopMediaRecording, t]
  );

  const startListeningWithLang = useCallback(
    (targetLang: "hi-IN" | "en-IN") => {
      setVoiceError(null);
      setError(null);

      const SpeechRecClass = getSpeechRecognitionClass();
      if (!SpeechRecClass) {
        // Fallback to MediaRecorder if called directly
        startMediaRecording(targetLang);
        return;
      }

      try {
        if (recognitionRef.current) {
          try {
            recognitionRef.current.abort();
          } catch {
            // ignore
          }
        }

        const rec = new SpeechRecClass();
        rec.lang = targetLang;
        rec.continuous = true;
        rec.interimResults = true;
        rec.maxAlternatives = 1;

        baseTextRef.current = inputRef.current;

        rec.onstart = () => {
          setIsListening(true);
          setVoiceError(null);
        };

        rec.onresult = (event: SpeechRecognitionEventLike) => {
          let fullTranscript = "";
          for (let i = 0; i < event.results.length; i++) {
            fullTranscript += event.results[i][0].transcript;
          }
          const prefix = baseTextRef.current ? baseTextRef.current.trim() + " " : "";
          const combined = (prefix + fullTranscript).trim();
          setInput(combined.slice(0, 500));
        };

        rec.onerror = (event: SpeechRecognitionErrorEventLike) => {
          if (event.error === "not-allowed" || event.error === "service-not-allowed") {
            setVoiceError(t("voice_denied"));
          } else if (event.error === "audio-capture") {
            setVoiceError(t("voice_denied"));
          } else if (event.error === "no-speech") {
            // harmless timeout when user is silent
          } else if (event.error !== "aborted") {
            setVoiceError(t("voice_none"));
          }
          setIsListening(false);
        };

        rec.onend = () => {
          setIsListening(false);
          setTimeout(() => {
            textareaRef.current?.focus();
          }, 100);
        };

        recognitionRef.current = rec;
        rec.start();
      } catch {
        // Fallback to MediaRecorder on native error
        startMediaRecording(targetLang);
      }
    },
    [startMediaRecording, t]
  );

  const isNativeSupported = typeof window !== "undefined" && Boolean(getSpeechRecognitionClass());
  const isVoiceActive = isListening || isRecording;

  const toggleVoiceInput = () => {
    if (isTranscribing) return;
    if (isVoiceActive) {
      if (isListening) stopListening();
      if (isRecording) stopMediaRecording();
    } else {
      if (isNativeSupported) {
        startListeningWithLang(voiceLang);
      } else {
        startMediaRecording(voiceLang);
      }
    }
  };

  const switchVoiceLang = (newLang: "hi-IN" | "en-IN") => {
    setVoiceLang(newLang);
    if (isListening) {
      if (recognitionRef.current) {
        try {
          recognitionRef.current.abort();
        } catch {}
      }
      setTimeout(() => {
        startListeningWithLang(newLang);
      }, 50);
    }
  };

  // Stop recording and speech when drawer closes
  useEffect(() => {
    if (!open) {
      if (isListening) stopListening();
      if (isRecording) stopMediaRecording();
      if (audioRef.current) {
        audioRef.current.pause();
        audioRef.current.currentTime = 0;
      }
      setPlayingMessageId(null);
      setPlaybackState("idle");
    }
  }, [open, isListening, isRecording, stopListening, stopMediaRecording]);

  // Clean up instances on unmount
  useEffect(() => {
    return () => {
      if (recognitionRef.current) {
        try {
          recognitionRef.current.abort();
        } catch {}
      }
      if (recordTimerRef.current) {
        clearInterval(recordTimerRef.current);
      }
      if (mediaStreamRef.current) {
        try {
          mediaStreamRef.current.getTracks().forEach((track) => track.stop());
        } catch {}
      }
      if (audioRef.current) {
        try {
          audioRef.current.pause();
          audioRef.current = null;
        } catch {}
      }
      blobUrlCacheRef.current.forEach((url) => {
        try {
          URL.revokeObjectURL(url);
        } catch {}
      });
      blobUrlCacheRef.current.clear();
    };
  }, []);

  const handleToggleSpeak = useCallback(
    async (item: ChatItem) => {
      setPlaybackError(null);

      // If this message is already the active audio
      if (playingMessageId === item.id) {
        if (playbackState === "playing") {
          audioRef.current?.pause();
          setPlaybackState("paused");
          return;
        }
        if (playbackState === "paused") {
          try {
            await audioRef.current?.play();
            setPlaybackState("playing");
          } catch {
            setPlaybackError({
              messageId: item.id,
              text: lang === "hi" ? "ऑडियो नहीं चल सका।" : "Could not resume audio.",
            });
            setPlaybackState("idle");
            setPlayingMessageId(null);
          }
          return;
        }
      }

      // If another audio was playing, stop it
      if (audioRef.current) {
        audioRef.current.pause();
        audioRef.current.currentTime = 0;
      }

      setPlayingMessageId(item.id);
      setPlaybackState("loading");

      try {
        let blobUrl = blobUrlCacheRef.current.get(item.id);
        if (!blobUrl) {
          const speechBlob = await fetchAssistantSpeech(item.content, item.detected_lang || "auto");
          blobUrl = URL.createObjectURL(speechBlob);
          blobUrlCacheRef.current.set(item.id, blobUrl);
        }

        let audio = audioRef.current;
        if (!audio) {
          audio = new Audio();
          audioRef.current = audio;
        }

        audio.src = blobUrl;
        audio.onplay = () => setPlaybackState("playing");
        audio.onpause = () => {
          if (audio && audio.currentTime < (audio.duration || 0)) {
            setPlaybackState("paused");
          }
        };
        audio.onended = () => {
          setPlaybackState("idle");
          setPlayingMessageId(null);
        };
        audio.onerror = () => {
          setPlaybackError({
            messageId: item.id,
            text: lang === "hi" ? "ऑडियो नहीं चल सका।" : "Audio playback failed.",
          });
          setPlaybackState("idle");
          setPlayingMessageId(null);
        };

        await audio.play();
        setPlaybackState("playing");
      } catch (err) {
        setPlaybackError({
          messageId: item.id,
          text: (err as Error)?.message || (lang === "hi" ? "आवाज़ लोड नहीं हो सकी।" : "Could not load audio."),
        });
        setPlaybackState("idle");
        setPlayingMessageId(null);
      }
    },
    [lang, playbackState, playingMessageId]
  );

  // Restore messages from session storage on mount
  useEffect(() => {
    try {
      const stored = sessionStorage.getItem(SESSION_STORAGE_KEY);
      if (stored) {
        const parsed = JSON.parse(stored);
        if (Array.isArray(parsed) && parsed.length > 0) {
          setMessages(parsed);
        }
      }
    } catch {
      // sessionStorage unavailable
    }
  }, []);

  // Save messages to session storage
  useEffect(() => {
    if (messages.length > 0) {
      try {
        sessionStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(messages));
      } catch {
        // storage quota or disabled
      }
    }
  }, [messages]);

  // Focus textarea when drawer opens
  useEffect(() => {
    if (open) {
      const timer = setTimeout(() => {
        textareaRef.current?.focus();
      }, 150);
      return () => clearTimeout(timer);
    } else {
      triggerRef.current?.focus();
    }
  }, [open]);

  // Close on Escape key
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape" && open) {
        setOpen(false);
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [open]);

  // Auto-scroll to bottom on new messages
  useEffect(() => {
    if (open) {
      messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
    }
  }, [messages, loading, open]);

  const sendQuery = async (userText: string, isRetry = false) => {
    const trimmed = userText.trim();
    if (!trimmed || loading) return;

    setError(null);
    setFailedQuery(null);
    if (!isRetry) {
      setInput("");
    }

    let currentHistory = messages;
    if (!isRetry) {
      const userMessage: ChatItem = {
        id: `usr-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
        role: "user",
        content: trimmed,
      };
      currentHistory = [...messages, userMessage];
      setMessages(currentHistory);
    }
    setLoading(true);

    try {
      // Prepare backend payload with defensive length bounding
      const pastMessages: AssistantMessage[] = currentHistory
        .filter((m) => !m.isError)
        .slice(-10)
        .slice(0, -1)
        .map((m) => ({
          role: m.role,
          content: m.role === "assistant" ? m.content.slice(0, 3000) : m.content.slice(0, 500),
        }));

      // Try reading location if available
      let location: { lat: number; lng: number } | null = null;
      if (typeof navigator !== "undefined" && "geolocation" in navigator) {
        try {
          const pos = await new Promise<GeolocationPosition | null>((resolve) => {
            navigator.geolocation.getCurrentPosition(
              (p) => resolve(p),
              () => resolve(null),
              { timeout: 2500, maximumAge: 60000 }
            );
          });
          if (pos) {
            location = { lat: pos.coords.latitude, lng: pos.coords.longitude };
          }
        } catch {
          // ignore location failure
        }
      }

      // Determine language hint: use transcription language if recently transcribed,
      // or active Hindi UI as fallback, otherwise 'auto'
      let langHint: "auto" | "en" | "hi" | "hinglish" = "auto";
      if (lastTranscribedLangRef.current && (lastTranscribedLangRef.current === "hi" || lastTranscribedLangRef.current === "hinglish")) {
        langHint = lastTranscribedLangRef.current as "hi" | "hinglish";
      } else if (lang === "hi") {
        langHint = "hi";
      }
      lastTranscribedLangRef.current = null;

      const reqBody: AssistantChatRequest = {
        messages: pastMessages,
        message: trimmed.slice(0, 500),
        lang: langHint,
        location,
      };

      const res = await api<AssistantChatResponse>("/api/assistant/chat", {
        method: "POST",
        body: JSON.stringify(reqBody),
      });

      const assistantMessage: ChatItem = {
        id: `asst-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
        role: "assistant",
        content: res.reply || t("assistant_error"),
        suggestions: res.suggestions && res.suggestions.length > 0 ? res.suggestions : undefined,
        sources: res.sources && res.sources.length > 0 ? res.sources : undefined,
        detected_lang: res.detected_lang,
      };

      setMessages((prev) => [...prev, assistantMessage]);
    } catch (err) {
      setError((err as Error).message || t("assistant_error"));
      setFailedQuery(trimmed);
    } finally {
      setLoading(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendQuery(input);
    }
  };

  const clearChat = () => {
    setMessages([]);
    setError(null);
    try {
      sessionStorage.removeItem(SESSION_STORAGE_KEY);
    } catch {
      // ignore
    }
  };

  const starterChips = [
    { label: t("assistant_chip_find"), query: lang === "hi" ? "मेरे नज़दीक खून कहाँ उपलब्ध है?" : "How can I find blood near me?" },
    { label: t("assistant_chip_compatibility"), query: lang === "hi" ? "ब्लड ग्रुप अनुकूलता के नियम क्या हैं?" : "What are the blood compatibility rules?" },
    { label: t("assistant_chip_eligibility"), query: lang === "hi" ? "रक्तदान करने की क्या पात्रता है?" : "What are the requirements to donate blood?" },
    { label: t("assistant_chip_camps"), query: lang === "hi" ? "आगामी रक्तदान शिविरों की जानकारी दें" : "Are there any upcoming blood donation camps?" },
  ];

  return (
    <>
      {/* Floating Trigger Button */}
      <button
        ref={triggerRef}
        type="button"
        className="ai-assistant-trigger"
        onClick={() => setOpen((prev) => !prev)}
        aria-label={t("assistant_button_label")}
        aria-expanded={open}
        aria-haspopup="dialog"
      >
        <span className="ai-assistant-trigger-badge">AI</span>
        <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M12 2v4" />
          <path d="M12 18v4" />
          <path d="m4.93 4.93 2.83 2.83" />
          <path d="m16.24 16.24 2.83 2.83" />
          <path d="M2 12h4" />
          <path d="M18 12h4" />
          <path d="m4.93 19.07 2.83-2.83" />
          <path d="m16.24 7.76 2.83-2.83" />
        </svg>
      </button>

      {/* Subtle Backdrop Overlay */}
      <div
        className={`ai-assistant-overlay ${open ? "open" : ""}`}
        onClick={() => setOpen(false)}
        aria-hidden={!open}
      />

      {/* Sliding Drawer */}
      <aside
        ref={drawerRef}
        className={`ai-assistant-drawer ${open ? "open" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-label={t("assistant_title")}
        aria-hidden={!open}
      >
        {/* Header */}
        <header className="ai-assistant-header">
          <div className="ai-assistant-header-info">
            <div className="ai-assistant-avatar" aria-hidden="true">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
                <path d="M12 2.69l5.66 5.66a8 8 0 1 1-11.31 0z" />
              </svg>
            </div>
            <div>
              <h2 className="ai-assistant-title">{t("assistant_title")}</h2>
              <span className="ai-assistant-pill">{t("assistant_badge")}</span>
            </div>
          </div>
          <div className="ai-assistant-actions">
            {messages.length > 0 && (
              <button
                type="button"
                className="ai-assistant-icon-btn"
                onClick={clearChat}
                title={t("assistant_clear")}
                aria-label={t("assistant_clear")}
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M3 6h18" />
                  <path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6" />
                  <path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" />
                </svg>
              </button>
            )}
            <button
              type="button"
              className="ai-assistant-icon-btn"
              onClick={() => setOpen(false)}
              aria-label={t("assistant_close")}
              title={t("assistant_close")}
            >
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          </div>
        </header>

        {/* Message History & Chat Body */}
        <div className="ai-assistant-body" tabIndex={0} role="region" aria-label="Conversation">
          {/* Welcome Card if empty */}
          {messages.length === 0 && (
            <div className="ai-assistant-welcome-card">
              <h3>🩸 {t("brand")}</h3>
              <p>{t("assistant_welcome")}</p>
              <div className="ai-assistant-chips" role="group" aria-label="Quick questions">
                {starterChips.map((chip, idx) => (
                  <button
                    key={idx}
                    type="button"
                    className="ai-assistant-chip"
                    onClick={() => sendQuery(chip.query)}
                    disabled={loading}
                  >
                    {chip.label}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Messages list */}
          {messages.map((item, idx) => (
            <div key={item.id} className={`ai-assistant-msg-row ${item.role}`}>
              <div className={`ai-assistant-bubble ${item.role}`}>
                <FormattedText text={item.content} isUser={item.role === "user"} />

                {/* Sources if present */}
                {item.sources && item.sources.length > 0 && (
                  <div className="ai-assistant-sources">
                    <span>{t("guide_sources")}: </span>
                    {item.sources.map((s, sIdx) => (
                      <span key={s.url}>
                        {sIdx > 0 && ", "}
                        <a href={s.url} target="_blank" rel="noopener noreferrer">
                          {s.title}
                        </a>
                      </span>
                    ))}
                  </div>
                )}

                {/* TTS Listen Button for Assistant Messages */}
                {item.role === "assistant" && !item.isError && (
                  <div className="ai-assistant-tts-bar">
                    <button
                      type="button"
                      className={`ai-assistant-tts-btn ${playingMessageId === item.id ? playbackState : ""}`}
                      onClick={() => handleToggleSpeak(item)}
                      disabled={playingMessageId === item.id && playbackState === "loading"}
                      aria-label={
                        playingMessageId === item.id && playbackState === "playing"
                          ? (lang === "hi" ? "आवाज़ रोकें" : "Pause audio")
                          : playingMessageId === item.id && playbackState === "paused"
                          ? (lang === "hi" ? "फिर से सुनें" : "Resume audio")
                          : (lang === "hi" ? "सुनें" : "Listen")
                      }
                      title={
                        playingMessageId === item.id && playbackState === "playing"
                          ? (lang === "hi" ? "रोकें" : "Pause")
                          : playingMessageId === item.id && playbackState === "paused"
                          ? (lang === "hi" ? "जारी रखें" : "Resume")
                          : (lang === "hi" ? "सुनें" : "Listen")
                      }
                    >
                      {playingMessageId === item.id && playbackState === "loading" ? (
                        <span className="ai-assistant-tts-spinner" aria-hidden="true" />
                      ) : playingMessageId === item.id && playbackState === "playing" ? (
                        <svg className="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                          <rect x="6" y="4" width="4" height="16" rx="1" />
                          <rect x="14" y="4" width="4" height="16" rx="1" />
                        </svg>
                      ) : (
                        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24" aria-hidden="true">
                          <path strokeLinecap="round" strokeLinejoin="round" d="M15.536 8.464a5 5 0 010 7.072M17.95 6.05a8 8 0 010 11.9M11 5L6 9H2v6h4l5 4V5z" />
                        </svg>
                      )}
                      <span className="ai-assistant-tts-label">
                        {playingMessageId === item.id && playbackState === "loading"
                          ? (lang === "hi" ? "लोड हो रहा है..." : "Loading...")
                          : playingMessageId === item.id && playbackState === "playing"
                          ? (lang === "hi" ? "रोकें" : "Pause")
                          : playingMessageId === item.id && playbackState === "paused"
                          ? (lang === "hi" ? "जारी रखें" : "Resume")
                          : (lang === "hi" ? "सुनें" : "Listen")}
                      </span>
                    </button>
                    {playbackError && playbackError.messageId === item.id && (
                      <span className="ai-assistant-tts-error" role="alert">
                        {playbackError.text}
                      </span>
                    )}
                  </div>
                )}
              </div>

              {/* Suggestions chips below assistant message */}
              {item.role === "assistant" && item.suggestions && item.suggestions.length > 0 && idx === messages.length - 1 && (
                <div className="ai-assistant-chips" role="group" aria-label="Suggested follow-up questions">
                  {item.suggestions.map((sug, sIdx) => (
                    <button
                      key={sIdx}
                      type="button"
                      className="ai-assistant-chip"
                      onClick={() => sendQuery(sug)}
                      disabled={loading}
                    >
                      {sug}
                    </button>
                  ))}
                </div>
              )}
            </div>
          ))}

          {/* Typing Loading Indicator */}
          {loading && (
            <div className="ai-assistant-typing" aria-label={t("assistant_thinking")}>
              <span className="ai-assistant-dot" />
              <span className="ai-assistant-dot" />
              <span className="ai-assistant-dot" />
            </div>
          )}

          {/* Error Banner with Retry & Edit */}
          {error && !loading && (
            <div className="ai-assistant-error-bubble" role="alert">
              <span className="ai-assistant-error-text">{error}</span>
              <div className="ai-assistant-error-actions">
                {failedQuery && (
                  <>
                    <button
                      type="button"
                      className="ai-assistant-error-btn-sec"
                      onClick={() => {
                        setInput(failedQuery);
                        setError(null);
                        setFailedQuery(null);
                        textareaRef.current?.focus();
                      }}
                      title={t("change")}
                    >
                      {t("change")}
                    </button>
                    <button
                      type="button"
                      className="ai-assistant-retry-btn"
                      onClick={() => sendQuery(failedQuery, true)}
                    >
                      {t("assistant_retry")}
                    </button>
                  </>
                )}
              </div>
            </div>
          )}

          <div ref={messagesEndRef} aria-hidden="true" />
        </div>

        {/* Footer / Input Area */}
        <footer className="ai-assistant-footer">
          {/* Voice error banner if any */}
          {voiceError && !isVoiceActive && !isTranscribing && (
            <div className="ai-assistant-voice-error" role="alert">
              <span>{voiceError}</span>
              <button
                type="button"
                className="ai-assistant-voice-err-close"
                onClick={() => setVoiceError(null)}
                aria-label={t("assistant_close")}
              >
                ×
              </button>
            </div>
          )}

          {/* Active voice input status bar (Native Listening, MediaRecorder Recording, or Transcribing) */}
          {(isVoiceActive || isTranscribing) && (
            <div className="ai-assistant-voice-bar" role="status" aria-live="polite">
              <div className="ai-assistant-voice-info">
                {isTranscribing ? (
                  <span className="ai-assistant-transcribing-spin" aria-hidden="true" />
                ) : (
                  <div className="ai-assistant-voice-pulse" aria-hidden="true">
                    <span className="ai-assistant-voice-wave" />
                    <span className="ai-assistant-voice-wave" />
                    <span className="ai-assistant-voice-wave" />
                  </div>
                )}
                <span className="ai-assistant-voice-text">
                  {isTranscribing
                    ? voiceLang === "hi-IN"
                      ? "आवाज़ को टेक्स्ट में बदल रहे हैं..."
                      : "Transcribing audio..."
                    : isRecording
                    ? voiceLang === "hi-IN"
                      ? "रिकॉर्ड हो रहा है... बोलिए"
                      : "Recording... Speak now"
                    : voiceLang === "hi-IN"
                    ? "सुन रहे हैं... बोलिए"
                    : "Listening... Speak now"}
                </span>
                {isRecording && !isTranscribing && (
                  <span className="ai-assistant-voice-timer" aria-label="Recording elapsed time">
                    {formatVoiceTime(recordingDuration)} / 1:00
                  </span>
                )}
              </div>

              {!isTranscribing && (
                <div className="ai-assistant-voice-lang-switch" role="group" aria-label="Speech language">
                  <button
                    type="button"
                    className={`ai-assistant-lang-pill ${voiceLang === "hi-IN" ? "active" : ""}`}
                    onClick={() => switchVoiceLang("hi-IN")}
                    aria-pressed={voiceLang === "hi-IN"}
                    title="हिंदी में बोलें"
                  >
                    हिन्दी
                  </button>
                  <button
                    type="button"
                    className={`ai-assistant-lang-pill ${voiceLang === "en-IN" ? "active" : ""}`}
                    onClick={() => switchVoiceLang("en-IN")}
                    aria-pressed={voiceLang === "en-IN"}
                    title="Speak in English"
                  >
                    English
                  </button>
                </div>
              )}

              {!isTranscribing && (
                <button
                  type="button"
                  className="ai-assistant-voice-done-btn"
                  onClick={() => {
                    if (isListening) stopListening();
                    if (isRecording) stopMediaRecording();
                  }}
                  aria-label={t("voice_stop")}
                >
                  {t("voice_stop")}
                </button>
              )}
            </div>
          )}

          <form
            className="ai-assistant-form"
            onSubmit={(e) => {
              e.preventDefault();
              if (isListening) stopListening();
              if (isRecording) stopMediaRecording();
              sendQuery(input);
            }}
          >
            <textarea
              ref={textareaRef}
              rows={1}
              className="ai-assistant-textarea"
              value={input}
              placeholder={
                isTranscribing
                  ? voiceLang === "hi-IN"
                    ? "आवाज़ को टेक्स्ट में बदल रहे हैं..."
                    : "Transcribing audio..."
                  : isVoiceActive
                  ? voiceLang === "hi-IN"
                    ? "बोलिए, सुन रहे हैं..."
                    : "Listening... speak now"
                  : t("assistant_input_placeholder")
              }
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              disabled={loading || isTranscribing}
              aria-label={t("assistant_input_placeholder")}
              maxLength={500}
            />
            <button
              type="button"
              className={`ai-assistant-mic-btn ${isVoiceActive ? "listening" : ""} ${isTranscribing ? "transcribing" : ""}`}
              onClick={toggleVoiceInput}
              disabled={loading || isTranscribing}
              aria-label={isVoiceActive ? t("voice_stop") : t("voice_start")}
              title={isVoiceActive ? t("voice_stop") : t("voice_start")}
            >
              {isTranscribing ? (
                <span className="ai-assistant-btn-spin" aria-hidden="true" />
              ) : isVoiceActive ? (
                <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
                  <rect x="6" y="6" width="12" height="12" rx="2" />
                </svg>
              ) : (
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" />
                  <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
                  <line x1="12" y1="19" x2="12" y2="22" />
                </svg>
              )}
            </button>
            <button
              type="submit"
              className="ai-assistant-send-btn"
              disabled={loading || !input.trim() || isTranscribing}
              aria-label={t("assistant_send")}
              title={t("assistant_send")}
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                <line x1="22" y1="2" x2="11" y2="13" />
                <polygon points="22 2 15 22 11 13 2 9 22 2" />
              </svg>
            </button>
          </form>
          <p className="ai-assistant-disclaimer">{t("assistant_disclaimer")}</p>
        </footer>
      </aside>
    </>
  );
}

