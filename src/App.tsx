import { invoke } from "@tauri-apps/api/core";
import { emit, listen } from "@tauri-apps/api/event";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { Effect, EffectState, getCurrentWindow } from "@tauri-apps/api/window";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ComponentType, SVGProps } from "react";
import IconSettings from "~icons/lucide/settings";
import "./App.css";

interface IWhisperStatus {
  available: boolean;
  binary_path: string | null;
  model_path: string | null;
  ffmpeg_path: string | null;
  version: string | null;
  message: string;
}

interface ITranscriptionResult {
  transcript: string;
  raw_audio_path: string;
  wav_path: string;
  model_path: string;
  whisper_binary_path: string;
}

interface IModelInfo {
  name: string;
  path: string;
  multilingual: boolean;
  source: string;
}

type DictationState = "idle" | "requesting-mic" | "recording" | "transcribing" | "pasting" | "done" | "error";
type OutputMode = "copy" | "paste";
type DictationMode = "quick" | "review" | "transform";
type SettingsSection = "general" | "history" | "engine" | "permissions";
type ToolTabId = "settings";

const HISTORY_STORAGE_KEY = "mahiro-whisper-history";

interface INativePreferencesPayload {
  language: string;
  model_path: string | null;
  output_mode: OutputMode;
}

const modeOptions: Array<{
  id: DictationMode;
  title: string;
  summary: string;
  detail: string;
  output: OutputMode;
}> = [
  {
    id: "quick",
    title: "Quick Dictation",
    summary: "Record, transcribe, paste.",
    detail: "For daily writing where the focused field should receive the transcript immediately.",
    output: "paste",
  },
  {
    id: "review",
    title: "Review First",
    summary: "Record, transcribe, copy.",
    detail: "For longer notes where you want the text in Mahiro Whisper before using it elsewhere.",
    output: "copy",
  },
  {
    id: "transform",
    title: "Transform",
    summary: "Capture now, rewrite later.",
    detail: "Reserved for cleanup, rewrite, translate, and app-specific prompt transforms.",
    output: "copy",
  },
];

function getSupportedMimeType() {
  const candidates = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus"];
  return candidates.find((candidate) => MediaRecorder.isTypeSupported(candidate)) ?? "";
}

function readTranscriptHistory() {
  try {
    const parsed = JSON.parse(localStorage.getItem(HISTORY_STORAGE_KEY) ?? "[]");
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function prependTranscriptHistory(items: string[], transcript: string) {
  const nextItems = [transcript, ...items].slice(0, 20);
  localStorage.setItem(HISTORY_STORAGE_KEY, JSON.stringify(nextItems));
  return nextItems;
}

function IndicatorWindow() {
  const [state, setState] = useState("recording");
  const [audioLevel, setAudioLevel] = useState(0);
  const [waveBars, setWaveBars] = useState(() => Array.from({ length: 78 }, () => 0));

  useEffect(() => {
    document.documentElement.dataset.window = "indicator";
    document.body.dataset.window = "indicator";

    const normalize = (value: string) => setState(value.toLowerCase());
    const unlistenIndicator = listen<string>("indicator-state", (event) => normalize(event.payload));
    const unlistenDictation = listen<string>("dictation-state", (event) => normalize(event.payload));
    const unlistenAudioLevel = listen<number>("audio-level", (event) => {
      const nextLevel = Number.isFinite(event.payload) ? Math.max(0, Math.min(event.payload, 1)) : 0;
      setAudioLevel((currentLevel) => {
        if (nextLevel > currentLevel) return currentLevel * 0.2 + nextLevel * 0.8;
        return currentLevel * 0.8 + nextLevel * 0.2;
      });
    });
    const unlistenAudioWaveform = listen<number[]>("audio-waveform", (event) => {
      if (!Array.isArray(event.payload)) return;

      setWaveBars((currentBars) => {
        const nextBars = event.payload.map((value) => (Number.isFinite(value) ? Math.max(0, Math.min(value, 1)) : 0));
        if (!nextBars.length) return currentBars;

        return Array.from({ length: 78 }, (_, index) => {
          const targetIndex = Math.round((index / 77) * (nextBars.length - 1));
          const target = nextBars[targetIndex] ?? 0;
          const current = currentBars[index] ?? 0;

          return target > current ? current * 0.18 + target * 0.82 : current * 0.78 + target * 0.22;
        });
      });
    });

    return () => {
      delete document.documentElement.dataset.window;
      delete document.body.dataset.window;
      void unlistenIndicator.then((dispose) => dispose());
      void unlistenDictation.then((dispose) => dispose());
      void unlistenAudioLevel.then((dispose) => dispose());
      void unlistenAudioWaveform.then((dispose) => dispose());
    };
  }, []);

  useEffect(() => {
    if (state === "recording") return;
    setWaveBars(Array.from({ length: 78 }, () => 0));
  }, [state]);

  const waveHeights = useMemo(() => {
    const level = state === "recording" ? Math.sqrt(audioLevel) : 0;
    const floor = 3;
    const max = 54;

    return waveBars.map((bar) => {
      const voice = Math.max(bar, level * 0.1);
      const height = floor + Math.pow(voice, 0.72) * max;

      return Math.max(floor, Math.min(max, height));
    });
  }, [audioLevel, state, waveBars]);

  const indicatorCopy: Record<string, { title: string; detail: string }> = {
    recording: { title: "Listening", detail: "Press ⌥ Space to stop" },
    transcribing: { title: "Transcribing", detail: "Turning speech into text" },
    pasting: { title: "Pasting", detail: "Sending text to the active app" },
    done: { title: "Done", detail: "Transcript copied" },
    error: { title: "Needs attention", detail: "Open Mahiro Whisper" },
  };
  const copy = indicatorCopy[state] ?? { title: "Working", detail: "Mahiro Whisper" };

  return (
    <main className={`indicator-shell ${state}`}>
      <div className="indicator-wave" aria-hidden="true">
        {state === "recording" ? (
          waveHeights.map((height, index) => (
            <i key={index} style={{ height: `${height}px`, opacity: 0.42 + Math.min(audioLevel * 1.25, 0.58) }} />
          ))
        ) : (
          <div className="spinner" />
        )}
      </div>
      <div className="indicator-footer">
        <div className="indicator-mode">
          <span className={`indicator-mic ${state}`} aria-hidden="true" />
          <strong>{copy.title}</strong>
          <span>{copy.detail}</span>
        </div>
        <div className="indicator-actions">
          <kbd>⌥</kbd>
          <kbd>Space</kbd>
          <span>toggle</span>
          <kbd>esc</kbd>
          <span>cancel</span>
        </div>
      </div>
    </main>
  );
}

function MainApp() {
  const [whisperStatus, setWhisperStatus] = useState<IWhisperStatus | null>(null);
  const [dictationState, setDictationState] = useState<DictationState>("idle");
  const [lastShortcutEvent, setLastShortcutEvent] = useState<string | null>(null);
  const [transcript, setTranscript] = useState("");
  const [, setHistory] = useState<string[]>(readTranscriptHistory);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [language, setLanguage] = useState(() => localStorage.getItem("mahiro-whisper-language") ?? "mixed-th-en");
  const [modelPath, setModelPath] = useState(() => localStorage.getItem("mahiro-whisper-model-path") ?? "");
  const [outputMode, setOutputMode] = useState<OutputMode>(() =>
    localStorage.getItem("mahiro-whisper-output-mode") === "copy" ? "copy" : "paste",
  );
  const [dictationMode, setDictationMode] = useState<DictationMode>(() =>
    (localStorage.getItem("mahiro-whisper-mode") as DictationMode | null) ?? "quick",
  );

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const stateRef = useRef<DictationState>("idle");

  function updateDictationState(nextState: DictationState) {
    stateRef.current = nextState;
    setDictationState(nextState);
  }

  useEffect(() => {
    void getCurrentWindow()
      .setEffects({
        effects: [Effect.WindowBackground],
        state: EffectState.FollowsWindowActiveState,
        radius: 14,
      })
      .catch(() => undefined);
  }, []);

  async function checkWhisper() {
    try {
      const status = await invoke<IWhisperStatus>("get_whisper_status");
      setWhisperStatus(status);
    } catch (error) {
      setWhisperStatus({
        available: false,
        binary_path: null,
        model_path: null,
        ffmpeg_path: null,
        version: null,
        message: error instanceof Error ? error.message : "ตรวจสอบ whisper.cpp ไม่สำเร็จ",
      });
    }
  }

  const stopRecording = useCallback(() => {
    const recorder = mediaRecorderRef.current;
    if (!recorder || recorder.state === "inactive") return;

    updateDictationState("transcribing");
    recorder.stop();
  }, []);

  const transcribeBlob = useCallback(async (blob: Blob) => {
    try {
      updateDictationState("transcribing");
      void invoke("show_indicator", { state: "Transcribing" });
      setErrorMessage(null);

      const buffer = await blob.arrayBuffer();
      const audio = Array.from(new Uint8Array(buffer));
      const result = await invoke<ITranscriptionResult>("transcribe_audio", {
        audio,
        mime_type: blob.type,
        language,
        model_path: modelPath.trim() || whisperStatus?.model_path || null,
      });

      setTranscript(result.transcript);
      setHistory((items) => prependTranscriptHistory(items, result.transcript));
      await writeText(result.transcript);

      if (outputMode === "paste") await invoke("paste_clipboard");

      updateDictationState("done");
      void invoke("hide_indicator");
      void checkWhisper();
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : String(error));
      updateDictationState("error");
      void invoke("hide_indicator");
    } finally {
      streamRef.current?.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
      mediaRecorderRef.current = null;
      chunksRef.current = [];
    }
  }, [language, modelPath, outputMode, whisperStatus?.model_path]);

  const startRecording = useCallback(async () => {
    try {
      updateDictationState("requesting-mic");
      setTranscript("");
      setErrorMessage(null);
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 },
      });
      const mimeType = getSupportedMimeType();
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);

      streamRef.current = stream;
      mediaRecorderRef.current = recorder;
      chunksRef.current = [];

      recorder.addEventListener("dataavailable", (event) => {
        if (event.data.size > 0) chunksRef.current.push(event.data);
      });

      recorder.addEventListener("stop", () => {
        const audioBlob = new Blob(chunksRef.current, { type: recorder.mimeType || mimeType || "audio/webm" });
        void transcribeBlob(audioBlob);
      });

      recorder.start();
      updateDictationState("recording");
      void invoke("show_indicator", { state: "Recording" });
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : String(error));
      updateDictationState("error");
      void invoke("hide_indicator");
      streamRef.current?.getTracks().forEach((track) => track.stop());
    }
  }, [transcribeBlob]);

  void stopRecording;
  void startRecording;

  const toggleDictation = useCallback(async () => {
    if (stateRef.current === "requesting-mic" || stateRef.current === "transcribing") return;

    try {
      setErrorMessage(null);
      await invoke("toggle_native_recording");
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : String(error));
      updateDictationState("error");
    }
  }, []);

  const selectMode = useCallback((mode: DictationMode) => {
    const option = modeOptions.find((item) => item.id === mode);
    if (!option) return;
    setDictationMode(mode);
    setOutputMode(option.output);
  }, []);

  useEffect(() => {
    localStorage.setItem("mahiro-whisper-output-mode", outputMode);
  }, [outputMode]);

  useEffect(() => {
    localStorage.setItem("mahiro-whisper-mode", dictationMode);
  }, [dictationMode]);

  useEffect(() => {
    const preferences: INativePreferencesPayload = {
      language,
      model_path: modelPath.trim() || null,
      output_mode: outputMode,
    };

    void invoke("set_native_preferences", {
      preferences,
    });
    void emit("preferences-updated", preferences);
  }, [language, modelPath, outputMode]);

  useEffect(() => {
    void checkWhisper();

    const unlistenShortcut = listen<string>("dictation-shortcut", (event) => {
      setLastShortcutEvent(event.payload);
    });
    const unlistenState = listen<DictationState>("dictation-state", (event) => {
      updateDictationState(event.payload);
    });
    const unlistenTranscript = listen<string>("transcript-ready", (event) => {
      setTranscript(event.payload);
      setHistory((items) => prependTranscriptHistory(items, event.payload));
    });
    const unlistenError = listen<string>("dictation-error", (event) => {
      setErrorMessage(event.payload);
      updateDictationState("error");
    });
    const unlistenTray = listen<string>("tray-action", (event) => {
      const action = event.payload;
      if (action === "history") void invoke("show_settings_window");
      if (action === "home") return;
    });
    const unlistenPreferences = listen<INativePreferencesPayload>("preferences-updated", (event) => {
      setLanguage(event.payload.language);
      setModelPath(event.payload.model_path ?? "");
      setOutputMode(event.payload.output_mode);
    });

    return () => {
      void unlistenShortcut.then((dispose) => dispose());
      void unlistenState.then((dispose) => dispose());
      void unlistenTranscript.then((dispose) => dispose());
      void unlistenError.then((dispose) => dispose());
      void unlistenTray.then((dispose) => dispose());
      void unlistenPreferences.then((dispose) => dispose());
      streamRef.current?.getTracks().forEach((track) => track.stop());
    };
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (stateRef.current !== "recording") return;
      event.preventDefault();
      void invoke("cancel_native_recording");
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const stateLabel: Record<DictationState, string> = {
    idle: "Ready",
    "requesting-mic": "Requesting microphone",
    recording: "Listening",
    transcribing: "Transcribing",
    pasting: "Pasting",
    done: outputMode === "paste" ? "Pasted" : "Copied",
    error: "Needs attention",
  };

  const stateDetail: Record<DictationState, string> = {
    idle: "Use ⌥ Space from any app. Mahiro Whisper records in the background and returns text to where you were working.",
    "requesting-mic": "Waiting for macOS microphone access.",
    recording: "Speak normally. Press ⌥ Space again when you are done.",
    transcribing: "Audio is being converted locally through whisper.cpp.",
    pasting: "The transcript is on the clipboard and is being sent to the active app.",
    done: outputMode === "paste" ? "Transcript was copied and pasted." : "Transcript was copied to the clipboard.",
    error: "Check permissions, model path, or the local whisper.cpp engine.",
  };

  const canToggle = dictationState !== "requesting-mic" && dictationState !== "transcribing" && dictationState !== "pasting";
  const primaryLabel = dictationState === "recording" ? "Stop" : dictationState === "done" ? "Record again" : "Record";
  const topTabs: Array<{ id: ToolTabId; label: string; icon: ComponentType<SVGProps<SVGSVGElement>> }> = [
    { id: "settings", label: "Settings", icon: IconSettings },
  ];


  return (
    <main className="compact-shell">
      <header className="compact-titlebar" data-tauri-drag-region>
        <button
          type="button"
          className="window-close"
          aria-label="Close Mahiro Whisper"
          title="Close"
          data-tauri-drag-region="false"
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            void invoke("hide_main_window").catch(() => getCurrentWindow().hide());
          }}
        />
        <nav className="top-tabs" aria-label="Mahiro Whisper sections" data-tauri-drag-region>
          {topTabs.map((item) => {
            const Icon = item.icon;
            return (
              <button
                key={item.id}
                type="button"
                data-tauri-drag-region="false"
                className="top-tab"
                onPointerDown={(event) => event.stopPropagation()}
                onClick={() => {
                  if (item.id === "settings") {
                    void invoke("show_settings_window");
                    return;
                  }
                }}
                aria-label={item.label}
                title={item.label}
              >
                <span><Icon aria-hidden="true" /></span>
              </button>
            );
          })}
        </nav>
      </header>

      <section className="compact-content">
        <section className="compact-stack">
          <div className="status-card">
            <div className="status-card-main">
              <span className={`status-mark ${dictationState}`} />
              <div>
                <h1>{stateLabel[dictationState]}</h1>
                <p>{stateDetail[dictationState]}</p>
              </div>
            </div>
            <button
              type="button"
              className={dictationState === "recording" ? "record-button stop" : "record-button"}
              onClick={toggleDictation}
              disabled={!canToggle}
            >
              {primaryLabel}
            </button>
          </div>

          {errorMessage ? <div className="notice error">{errorMessage}</div> : null}
          {lastShortcutEvent ? <div className="notice">Shortcut and tray are connected.</div> : null}

          <section className="capture-tabs" aria-label="Dictation mode">
            {modeOptions.map((mode) => (
              <button
                key={mode.id}
                type="button"
                className={dictationMode === mode.id ? "capture-tab active" : "capture-tab"}
                onClick={() => selectMode(mode.id)}
              >
                <strong>{mode.title.replace(" Dictation", "")}</strong>
                <span>{mode.output === "paste" ? "Paste" : "Copy"}</span>
              </button>
            ))}
          </section>

          <div className="compact-row">
            <span>Output</span>
            <strong>{outputMode === "paste" ? "Auto-paste" : "Copy only"}</strong>
          </div>
          <div className="compact-row">
            <span>Shortcut</span>
            <strong>⌥ Space</strong>
          </div>

          <section className="transcript-box">
            <div className="panel-heading">
              <h2>Latest transcript</h2>
              {transcript ? <button type="button" onClick={() => writeText(transcript)}>Copy</button> : null}
            </div>
            {transcript ? <p className="transcript-text">{transcript}</p> : <p>No transcript yet.</p>}
          </section>
        </section>
      </section>
    </main>
  );
}

function SettingsWindow() {
  const [activeSection, setActiveSection] = useState<SettingsSection>("general");
  const [whisperStatus, setWhisperStatus] = useState<IWhisperStatus | null>(null);
  const [isChecking, setIsChecking] = useState(true);
  const [history, setHistory] = useState<string[]>(readTranscriptHistory);
  const [language, setLanguage] = useState(() => localStorage.getItem("mahiro-whisper-language") ?? "mixed-th-en");
  const [modelPath, setModelPath] = useState(() => localStorage.getItem("mahiro-whisper-model-path") ?? "");
  const [availableModels, setAvailableModels] = useState<IModelInfo[]>([]);
  const [outputMode, setOutputMode] = useState<OutputMode>(() =>
    localStorage.getItem("mahiro-whisper-output-mode") === "copy" ? "copy" : "paste",
  );

  useEffect(() => {
    document.documentElement.dataset.window = "settings";
    document.body.dataset.window = "settings";

    void getCurrentWindow()
      .setEffects({
        effects: [Effect.WindowBackground],
        state: EffectState.FollowsWindowActiveState,
        radius: 16,
      })
      .catch(() => undefined);

    return () => {
      delete document.documentElement.dataset.window;
      delete document.body.dataset.window;
    };
  }, []);

  const checkWhisper = useCallback(async () => {
    setIsChecking(true);

    try {
      const [status, models] = await Promise.all([
        invoke<IWhisperStatus>("get_whisper_status"),
        invoke<IModelInfo[]>("list_available_models"),
      ]);
      setWhisperStatus(status);
      setAvailableModels(models);
    } catch (error) {
      setWhisperStatus({
        available: false,
        binary_path: null,
        model_path: null,
        ffmpeg_path: null,
        version: null,
        message: error instanceof Error ? error.message : "ตรวจสอบ whisper.cpp ไม่สำเร็จ",
      });
    } finally {
      setIsChecking(false);
    }
  }, []);

  useEffect(() => {
    void checkWhisper();

    const unlistenSettings = listen<string>("settings-action", (event) => {
      if (event.payload === "status") void checkWhisper();
      if (event.payload === "history") setActiveSection("history");
    });
    const unlistenTranscript = listen<string>("transcript-ready", (event) => {
      setHistory((items) => prependTranscriptHistory(items, event.payload));
    });

    return () => {
      void unlistenSettings.then((dispose) => dispose());
      void unlistenTranscript.then((dispose) => dispose());
    };
  }, [checkWhisper]);

  useEffect(() => {
    localStorage.setItem("mahiro-whisper-language", language);
  }, [language]);

  useEffect(() => {
    localStorage.setItem("mahiro-whisper-model-path", modelPath);
  }, [modelPath]);

  useEffect(() => {
    localStorage.setItem("mahiro-whisper-output-mode", outputMode);
  }, [outputMode]);

  useEffect(() => {
    localStorage.setItem(HISTORY_STORAGE_KEY, JSON.stringify(history));
  }, [history]);

  useEffect(() => {
    const preferences: INativePreferencesPayload = {
      language,
      model_path: modelPath.trim() || null,
      output_mode: outputMode,
    };

    void invoke("set_native_preferences", {
      preferences,
    });
    void emit("preferences-updated", preferences);
  }, [language, modelPath, outputMode]);

  const statusReady = Boolean(whisperStatus?.available);

  return (
    <main className="settings-window-shell">
      <header className="settings-titlebar" data-tauri-drag-region>
        <button
          type="button"
          className="window-close"
          aria-label="Close Settings"
          title="Close"
          data-tauri-drag-region="false"
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            void invoke("hide_settings_window").catch(() => getCurrentWindow().hide());
          }}
        />
        <div>
          <strong>Settings</strong>
          <span>Mahiro Whisper</span>
        </div>
      </header>

      <section className="settings-window-body">
        <aside className="settings-sidebar">
          <div className="settings-sidebar-brand">
            <IconSettings aria-hidden="true" />
            <div>
              <strong>Settings</strong>
              <span>Dictation setup</span>
            </div>
          </div>
          <button type="button" className={activeSection === "general" ? "settings-sidebar-item active" : "settings-sidebar-item"} onClick={() => setActiveSection("general")}>General</button>
          <button type="button" className={activeSection === "history" ? "settings-sidebar-item active" : "settings-sidebar-item"} onClick={() => setActiveSection("history")}>History</button>
          <button type="button" className={activeSection === "engine" ? "settings-sidebar-item active" : "settings-sidebar-item"} onClick={() => setActiveSection("engine")}>Engine</button>
          <button type="button" className={activeSection === "permissions" ? "settings-sidebar-item active" : "settings-sidebar-item"} onClick={() => setActiveSection("permissions")}>Permissions</button>
        </aside>

        <section className="settings-main-panel">
          <div className="settings-window-heading">
            <h1>{activeSection === "general" ? "General Settings" : activeSection === "history" ? "History" : activeSection === "engine" ? "Engine" : "Permissions"}</h1>
            <p>{activeSection === "general" ? "Configure dictation behavior and output defaults." : activeSection === "history" ? "Review and copy recent transcripts." : activeSection === "engine" ? "Check local whisper.cpp and model detection." : "System permissions used by Mahiro Whisper."}</p>
          </div>

          {activeSection === "general" ? <div id="dictation" className="settings-section">
            <h2>Dictation</h2>
            <label><span>Language</span><select value={language} onChange={(event) => setLanguage(event.currentTarget.value)}><option value="mixed-th-en">Thai + English mixed</option><option value="th">Thai</option><option value="auto">Auto detect</option><option value="en">English</option><option value="ja">Japanese</option><option value="zh">Chinese</option></select></label>
            <label><span>Output</span><select value={outputMode} onChange={(event) => setOutputMode(event.currentTarget.value as OutputMode)}><option value="paste">Copy and auto-paste</option><option value="copy">Copy to clipboard only</option></select></label>
          </div> : null}

          {activeSection === "history" ? <div className="settings-section">
            <div className="panel-heading">
              <h2>Recent transcripts</h2>
              {history.length ? <button type="button" onClick={() => setHistory([])}>Clear</button> : null}
            </div>
            <div className="history-list">
              {history.length === 0 ? <p className="empty">No transcripts yet.</p> : history.map((item, index) => (
                <button key={`${item}-${index}`} type="button" onClick={() => writeText(item)}>{item}</button>
              ))}
            </div>
          </div> : null}

          {activeSection === "engine" ? <div id="engine" className="settings-section">
            <div className="panel-heading">
              <h2>Engine</h2>
              <button type="button" onClick={checkWhisper}>Check</button>
            </div>
            <div className={statusReady ? "engine-state ready" : "engine-state"}>{isChecking ? "Checking..." : whisperStatus?.message}</div>
            <label><span>Model</span><select value={modelPath} onChange={(event) => setModelPath(event.currentTarget.value)}><option value="">Auto select multilingual model</option>{availableModels.map((model) => (<option key={model.path} value={model.path}>{model.name} · {model.multilingual ? "multilingual" : "English only"} · {model.source}</option>))}</select></label>
          </div> : null}

          {activeSection === "permissions" ? <div id="permissions" className="settings-section">
            <h2>Permissions</h2>
            <div className="permission-item"><strong>Microphone</strong><span>Required for recording.</span></div>
            <div className="permission-item"><strong>Accessibility</strong><span>Required for auto-paste.</span></div>
            <div className="permission-item"><strong>Global shortcut</strong><span>Used by ⌥ Space.</span></div>
          </div> : null}
        </section>
      </section>
    </main>
  );
}

function App() {
  const windowLabel = getCurrentWindow().label;
  if (windowLabel === "indicator") return <IndicatorWindow />;
  if (windowLabel === "settings") return <SettingsWindow />;
  return <MainApp />;
}

export default App;
