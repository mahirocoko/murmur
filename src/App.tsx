import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { Effect, EffectState, getCurrentWindow } from "@tauri-apps/api/window";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ComponentType, SVGProps } from "react";
import IconHistory from "~icons/lucide/history";
import IconLayers from "~icons/lucide/layers";
import IconMic from "~icons/lucide/mic";
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
type View = "home" | "modes" | "settings" | "history";

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

function IndicatorWindow() {
  const [state, setState] = useState("recording");
  const [audioLevel, setAudioLevel] = useState(0);
  const [waveTick, setWaveTick] = useState(0);

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

    return () => {
      delete document.documentElement.dataset.window;
      delete document.body.dataset.window;
      void unlistenIndicator.then((dispose) => dispose());
      void unlistenDictation.then((dispose) => dispose());
      void unlistenAudioLevel.then((dispose) => dispose());
    };
  }, []);


  useEffect(() => {
    if (state !== "recording") return;

    let frame = 0;
    let last = 0;
    const animate = (now: number) => {
      if (now - last > 70) {
        last = now;
        setWaveTick((tick) => tick + 1);
      }
      frame = requestAnimationFrame(animate);
    };

    frame = requestAnimationFrame(animate);
    return () => cancelAnimationFrame(frame);
  }, [state]);

  const waveHeights = useMemo(() => {
    const level = state === "recording" ? Math.max(0.1, Math.sqrt(audioLevel) * 1.35) : 0;
    const now = waveTick * 0.55;
    const floor = 3;
    const max = 54;

    return Array.from({ length: 78 }, (_, index) => {
      const position = index / 77;
      const center = 1 - Math.min(1, Math.abs(position - 0.45) * 2.25);
      const secondLobe = Math.max(0, 1 - Math.abs(position - 0.68) * 8);
      const leftLobe = Math.max(0, 1 - Math.abs(position - 0.24) * 7);
      const envelope = Math.max(0.06, center * 0.92 + secondLobe * 0.52 + leftLobe * 0.46);
      const ripple = 0.72 + Math.sin(now + index * 0.38) * 0.18 + Math.cos(now * 0.52 + index * 0.21) * 0.1;
      const breath = 0.75 + Math.sin(now * 0.72 + index * 0.17) * 0.25;
      const height = floor + level * max * envelope * ripple * breath;

      return Math.max(floor, Math.min(max, height));
    });
  }, [audioLevel, state, waveTick]);

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
  const [isChecking, setIsChecking] = useState(true);
  const [dictationState, setDictationState] = useState<DictationState>("idle");
  const [activeView, setActiveView] = useState<View>("home");
  const [lastShortcutEvent, setLastShortcutEvent] = useState<string | null>(null);
  const [transcript, setTranscript] = useState("");
  const [history, setHistory] = useState<string[]>([]);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [language, setLanguage] = useState(() => localStorage.getItem("mahiro-whisper-language") ?? "mixed-th-en");
  const [modelPath, setModelPath] = useState(() => localStorage.getItem("mahiro-whisper-model-path") ?? "");
  const [availableModels, setAvailableModels] = useState<IModelInfo[]>([]);
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
      setHistory((items) => [result.transcript, ...items].slice(0, 20));
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
      setActiveView("home");

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
    localStorage.setItem("mahiro-whisper-language", language);
  }, [language]);

  useEffect(() => {
    localStorage.setItem("mahiro-whisper-model-path", modelPath);
  }, [modelPath]);

  useEffect(() => {
    localStorage.setItem("mahiro-whisper-output-mode", outputMode);
  }, [outputMode]);

  useEffect(() => {
    localStorage.setItem("mahiro-whisper-mode", dictationMode);
  }, [dictationMode]);

  useEffect(() => {
    void invoke("set_native_preferences", {
      preferences: {
        language,
        model_path: modelPath.trim() || null,
        output_mode: outputMode,
      },
    });
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
      setHistory((items) => [event.payload, ...items].slice(0, 20));
    });
    const unlistenError = listen<string>("dictation-error", (event) => {
      setErrorMessage(event.payload);
      updateDictationState("error");
    });
    const unlistenTray = listen<string>("tray-action", (event) => {
      const action = event.payload;
      if (action === "settings") setActiveView("settings");
      if (action === "history") setActiveView("history");
      if (action === "status") {
        setActiveView("settings");
        void checkWhisper();
      }
      if (action === "home") setActiveView("home");
    });

    return () => {
      void unlistenShortcut.then((dispose) => dispose());
      void unlistenState.then((dispose) => dispose());
      void unlistenTranscript.then((dispose) => dispose());
      void unlistenError.then((dispose) => dispose());
      void unlistenTray.then((dispose) => dispose());
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

  const statusReady = Boolean(whisperStatus?.available);
  const selectedMode = modeOptions.find((mode) => mode.id === dictationMode) ?? modeOptions[0];
  const canToggle = dictationState !== "requesting-mic" && dictationState !== "transcribing" && dictationState !== "pasting";
  const primaryLabel = dictationState === "recording" ? "Stop" : dictationState === "done" ? "Record again" : "Record";
  const topTabs: Array<{ id: View; label: string; icon: ComponentType<SVGProps<SVGSVGElement>> }> = [
    { id: "home", label: "Dictate", icon: IconMic },
    { id: "modes", label: "Modes", icon: IconLayers },
    { id: "history", label: "History", icon: IconHistory },
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
                data-tauri-drag-region
                className={activeView === item.id ? "top-tab active" : "top-tab"}
                onClick={() => setActiveView(item.id)}
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
        {activeView === "home" ? (
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

            <div className="compact-row">
              <span>Mode</span>
              <button type="button" onClick={() => setActiveView("modes")}>{selectedMode.title}</button>
            </div>
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
        ) : null}

        {activeView === "modes" ? (
          <section className="compact-stack">
            <div className="section-header">
              <h1>Modes</h1>
              <p>Choose what happens after speech becomes text.</p>
            </div>
            <div className="mode-list">
              {modeOptions.map((mode) => (
                <button
                  key={mode.id}
                  type="button"
                  className={dictationMode === mode.id ? "mode-row selected" : "mode-row"}
                  onClick={() => selectMode(mode.id)}
                >
                  <div>
                    <strong>{mode.title}</strong>
                    <span>{mode.detail}</span>
                  </div>
                  <small>{mode.output === "paste" ? "Paste" : "Copy"}</small>
                </button>
              ))}
            </div>
          </section>
        ) : null}

        {activeView === "settings" ? (
          <section className="settings-page">
            <div className="section-header">
              <h1>Settings</h1>
              <p>Dictation, engine, and permissions.</p>
            </div>

            <div className="settings-section">
              <h2>Dictation</h2>
              <label><span>Language</span><select value={language} onChange={(event) => setLanguage(event.currentTarget.value)}><option value="mixed-th-en">Thai + English mixed</option><option value="th">Thai</option><option value="auto">Auto detect</option><option value="en">English</option><option value="ja">Japanese</option><option value="zh">Chinese</option></select></label>
              <label><span>Output</span><select value={outputMode} onChange={(event) => setOutputMode(event.currentTarget.value as OutputMode)}><option value="paste">Copy and auto-paste</option><option value="copy">Copy to clipboard only</option></select></label>
            </div>

            <div className="settings-section">
              <div className="panel-heading">
                <h2>Engine</h2>
                <button type="button" onClick={checkWhisper}>Check</button>
              </div>
              <div className={statusReady ? "engine-state ready" : "engine-state"}>{isChecking ? "Checking..." : whisperStatus?.message}</div>
              <label><span>Model</span><select value={modelPath} onChange={(event) => setModelPath(event.currentTarget.value)}><option value="">Auto select multilingual model</option>{availableModels.map((model) => (<option key={model.path} value={model.path}>{model.name} · {model.multilingual ? "multilingual" : "English only"} · {model.source}</option>))}</select></label>
            </div>

            <div className="settings-section">
              <h2>Permissions</h2>
              <div className="permission-item"><strong>Microphone</strong><span>Required for recording.</span></div>
              <div className="permission-item"><strong>Accessibility</strong><span>Required for auto-paste.</span></div>
              <div className="permission-item"><strong>Global shortcut</strong><span>Used by ⌥ Space.</span></div>
            </div>
          </section>
        ) : null}

        {activeView === "history" ? (
          <section className="compact-stack">
            <div className="section-header">
              <h1>History</h1>
              <p>Click any item to copy it again.</p>
            </div>
            <div className="history-list">
              {history.length === 0 ? <p className="empty">No transcripts yet.</p> : history.map((item, index) => (
                <button key={`${item}-${index}`} type="button" onClick={() => writeText(item)}>{item}</button>
              ))}
            </div>
          </section>
        ) : null}
      </section>
    </main>
  );
}

function App() {
  const windowLabel = getCurrentWindow().label;
  return windowLabel === "indicator" ? <IndicatorWindow /> : <MainApp />;
}

export default App;
