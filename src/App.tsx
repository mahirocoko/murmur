import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { getCurrentWindow } from "@tauri-apps/api/window";
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
type View = "home" | "modes" | "vocabulary" | "settings" | "sound" | "models" | "history";

const navItems: Array<{ id: View; label: string; icon: string }> = [
  { id: "home", label: "Home", icon: "⌂" },
  { id: "modes", label: "Modes", icon: "✦" },
  { id: "vocabulary", label: "Vocabulary", icon: "▣" },
  { id: "settings", label: "Configuration", icon: "⚙" },
  { id: "sound", label: "Sound", icon: "◉" },
  { id: "models", label: "Models library", icon: "⬡" },
  { id: "history", label: "History", icon: "↺" },
];

function getSupportedMimeType() {
  const candidates = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus"];
  return candidates.find((candidate) => MediaRecorder.isTypeSupported(candidate)) ?? "";
}

function IndicatorWindow() {
  const [state, setState] = useState("recording");

  useEffect(() => {
    const normalize = (value: string) => setState(value.toLowerCase());
    const unlistenIndicator = listen<string>("indicator-state", (event) => normalize(event.payload));
    const unlistenDictation = listen<string>("dictation-state", (event) => normalize(event.payload));

    return () => {
      void unlistenIndicator.then((dispose) => dispose());
      void unlistenDictation.then((dispose) => dispose());
    };
  }, []);

  const copy: Record<string, { title: string; detail: string }> = {
    recording: { title: "Listening", detail: "Press ⌥ Space to stop" },
    transcribing: { title: "Transcribing", detail: "Converting speech to text" },
    pasting: { title: "Pasting", detail: "Sending text to the focused app" },
    done: { title: "Done", detail: "Text is ready" },
    error: { title: "Needs attention", detail: "Open Control Center" },
  };
  const current = copy[state] ?? copy.recording;

  return (
    <main className={`indicator-shell ${state}`}>
      <div className={`indicator-dot ${state}`} />
      <div className="indicator-copy">
        <strong>{current.title}</strong>
        <span>{current.detail}</span>
      </div>
      {state === "recording" ? (
        <div className="wave" aria-hidden="true"><i /><i /><i /><i /></div>
      ) : (
        <div className="spinner" aria-hidden="true" />
      )}
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


  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const stateRef = useRef<DictationState>("idle");

  function updateDictationState(nextState: DictationState) {
    stateRef.current = nextState;
    setDictationState(nextState);
  }

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

      if (outputMode === "paste") {
        await invoke("paste_clipboard");
      }

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
        setActiveView("models");
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

  const stateLabel: Record<DictationState, string> = {
    idle: "Ready",
    "requesting-mic": "Requesting mic",
    recording: "Recording",
    transcribing: "Transcribing",
    pasting: "Pasting",
    done: outputMode === "paste" ? "Copied and pasted" : "Copied",
    error: "Needs attention",
  };

  const statusReady = Boolean(whisperStatus?.available);
  const transcriptCount = history.length;

  return (
    <main className="app-frame">
      <aside className="sidebar">
        <div className="traffic-lights" aria-hidden="true"><span /><span /><span /></div>
        <nav>
          {navItems.map((item) => (
            <button
              key={item.id}
              type="button"
              className={activeView === item.id ? "nav-item active" : "nav-item"}
              onClick={() => setActiveView(item.id)}
            >
              <span>{item.icon}</span>
              {item.label}
            </button>
          ))}
        </nav>
        <div className="sidebar-footer">
          <strong>Mahiro Whisper</strong>
          <span>{statusReady ? "Local engine ready" : "Setup needed"}</span>
        </div>
      </aside>

      <section className="content-pane">
        <header className="topbar">
          <div>
            <span className="kicker">Control Center</span>
            <h1>{navItems.find((item) => item.id === activeView)?.label}</h1>
          </div>
          <div className="device-pill">Tray-first · ⌥ Space</div>
        </header>

        <section className="metrics-row">
          <article><strong>{transcriptCount}</strong><span>Transcripts</span></article>
          <article><strong>{statusReady ? "Ready" : "Setup"}</strong><span>Engine</span></article>
          <article><strong>{language}</strong><span>Language</span></article>
          <article><strong>{outputMode === "paste" ? "Paste" : "Copy"}</strong><span>Output</span></article>
        </section>

        {activeView === "home" ? (
          <section className="view-stack">
            <div className="record-card">
              <div>
                <span className={`status-dot ${dictationState}`} />
                <h2>{stateLabel[dictationState]}</h2>
                <p>Press ⌥ Space from any app. Mahiro Whisper records in the background and pastes back into the focused field.</p>
              </div>
              <button
                type="button"
                className={dictationState === "recording" ? "danger-action" : "primary-action"}
                onClick={toggleDictation}
                disabled={dictationState === "requesting-mic" || dictationState === "transcribing"}
              >
                {dictationState === "recording" ? "Stop & transcribe" : "Start recording"}
                <kbd>⌥ Space</kbd>
              </button>
            </div>

            {errorMessage ? <div className="notice error">{errorMessage}</div> : null}
            {lastShortcutEvent ? <div className="notice">Tray and shortcut controls are connected.</div> : null}

            {transcript ? (
              <div className="transcript-panel">
                <span className="kicker">Latest transcript</span>
                <p>{transcript}</p>
                <button type="button" onClick={() => writeText(transcript)}>Copy again</button>
              </div>
            ) : null}

          </section>
        ) : null}

        {activeView === "settings" ? (
          <section className="settings-panel">
            <label><span>Spoken language</span><select value={language} onChange={(event) => setLanguage(event.currentTarget.value)}><option value="mixed-th-en">Thai + English mixed</option><option value="th">Thai</option><option value="auto">Auto detect</option><option value="en">English</option><option value="ja">Japanese</option><option value="zh">Chinese</option></select></label>
            <label><span>Output behavior</span><select value={outputMode} onChange={(event) => setOutputMode(event.currentTarget.value as OutputMode)}><option value="paste">Copy and auto-paste</option><option value="copy">Copy to clipboard only</option></select></label>
            <label className="wide"><span>Model</span><select value={modelPath} onChange={(event) => setModelPath(event.currentTarget.value)}><option value="">Auto select multilingual model</option>{availableModels.map((model) => (<option key={model.path} value={model.path}>{model.name} · {model.multilingual ? "multilingual" : "English only"} · {model.source}</option>))}</select></label>
            <p className="hint">Thai + English mixed keeps Thai as the base language and preserves English product names or technical terms. Auto-paste may require Accessibility permission.</p>
          </section>
        ) : null}

        {activeView === "models" || activeView === "sound" ? (
          <section className="engine-panel">
            <div className="status-line"><strong>{isChecking ? "Checking..." : whisperStatus?.message}</strong><button type="button" onClick={checkWhisper}>Check again</button></div>
            <code>whisper: {whisperStatus?.binary_path ?? "not found"}</code>
            <code>selected model: {modelPath || whisperStatus?.model_path || "auto / not found"}</code>
            {availableModels.map((model) => (<code key={model.path}>{model.multilingual ? "multi" : "en"}: {model.name} — {model.source}</code>))}
            <code>ffmpeg: {whisperStatus?.ffmpeg_path ?? "not found"}</code>
            {whisperStatus?.version ? <small>{whisperStatus.version}</small> : null}
          </section>
        ) : null}

        {activeView === "history" ? (
          <section className="history-panel">
            {history.length === 0 ? <p className="empty">No transcripts yet.</p> : history.map((item, index) => (
              <button key={`${item}-${index}`} type="button" onClick={() => writeText(item)}>{item}</button>
            ))}
          </section>
        ) : null}

        {activeView === "modes" || activeView === "vocabulary" ? (
          <section className="placeholder-panel">
            <h2>{activeView === "modes" ? "Modes are next" : "Vocabulary is next"}</h2>
            <p>For now the app focuses on the core dictation loop. This section is ready for prompt transforms, custom words, names, and app-specific behavior.</p>
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
