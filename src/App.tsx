import { invoke } from "@tauri-apps/api/core";
import { emit, listen } from "@tauri-apps/api/event";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { Effect, EffectState, getCurrentWindow } from "@tauri-apps/api/window";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ComponentType, SVGProps } from "react";
import IconCheckCircle from "~icons/lucide/check-circle";
import IconCloud from "~icons/lucide/cloud";
import IconDownload from "~icons/lucide/download";
import IconHardDrive from "~icons/lucide/hard-drive";
import IconHistory from "~icons/lucide/history";
import IconLibraryBig from "~icons/lucide/library-big";
import IconPanelLeftClose from "~icons/lucide/panel-left-close";
import IconPanelLeftOpen from "~icons/lucide/panel-left-open";
import IconSettings from "~icons/lucide/settings";
import IconShieldCheck from "~icons/lucide/shield-check";
import IconSlidersHorizontal from "~icons/lucide/sliders-horizontal";
import IconTrash2 from "~icons/lucide/trash-2";
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

interface IModelCatalogItem {
  id: string;
  name: string;
  file_name: string;
  multilingual: boolean;
  size_mb: number;
  quality: string;
  speed: string;
  url: string;
  installed_path: string | null;
  installed_source: string | null;
}

interface IModelDownloadProgress {
  model_id: string;
  downloaded_bytes: number;
  total_bytes: number | null;
  percent: number | null;
  state: string;
}

type DictationState = "idle" | "requesting-mic" | "recording" | "transcribing" | "pasting" | "done" | "error";
type OutputMode = "copy" | "paste";
type SettingsSection = "general" | "history" | "models" | "permissions";

const APP_NAME = "Murmur";
const HISTORY_STORAGE_KEY = "murmur-history";
const LEGACY_HISTORY_STORAGE_KEY = "mahiro-whisper-history";
const STORAGE_KEYS = {
  language: "murmur-language",
  modelPath: "murmur-model-path",
  outputMode: "murmur-output-mode",
} as const;
const LEGACY_STORAGE_KEYS = {
  language: "mahiro-whisper-language",
  modelPath: "mahiro-whisper-model-path",
  outputMode: "mahiro-whisper-output-mode",
} as const;

const settingsSidebarItems: Array<{ id: SettingsSection; label: string; icon: ComponentType<SVGProps<SVGSVGElement>> }> = [
  { id: "general", label: "General", icon: IconSlidersHorizontal },
  { id: "history", label: "History", icon: IconHistory },
  { id: "models", label: "Models Library", icon: IconLibraryBig },
  { id: "permissions", label: "Permissions", icon: IconShieldCheck },
];

interface INativePreferencesPayload {
  language: string;
  model_path: string | null;
  output_mode: OutputMode;
}

const languageOptions = [
  { value: "mixed-th-en", label: "Thai + English", detail: "ถอดไทยเป็นหลัก และคงคำอังกฤษ/technical terms ไว้" },
  { value: "th", label: "Thai", detail: "บังคับใช้ภาษาไทย" },
  { value: "auto", label: "Auto detect", detail: "ให้ whisper.cpp ตรวจภาษาเอง" },
  { value: "en", label: "English", detail: "สำหรับงานอังกฤษ หรือ model ตระกูล .en" },
  { value: "ja", label: "Japanese", detail: "สำหรับงานภาษาญี่ปุ่น" },
  { value: "zh", label: "Chinese", detail: "สำหรับงานภาษาจีน" },
];

const outputOptions: Array<{ value: OutputMode; label: string; detail: string }> = [
  { value: "paste", label: "Copy and auto-paste", detail: "คัดลอก transcript แล้ววางกลับไปยังแอปเดิม" },
  { value: "copy", label: "Copy only", detail: "เก็บไว้ใน clipboard ก่อน แล้วค่อยวางเอง" },
];

function getSupportedMimeType() {
  const candidates = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus"];
  return candidates.find((candidate) => MediaRecorder.isTypeSupported(candidate)) ?? "";
}

function readTranscriptHistory() {
  try {
    const parsed = JSON.parse(localStorage.getItem(HISTORY_STORAGE_KEY) ?? localStorage.getItem(LEGACY_HISTORY_STORAGE_KEY) ?? "[]");
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function readStoredPreference(key: keyof typeof STORAGE_KEYS, fallback = "") {
  return localStorage.getItem(STORAGE_KEYS[key]) ?? localStorage.getItem(LEGACY_STORAGE_KEYS[key]) ?? fallback;
}

function prependTranscriptHistory(items: string[], transcript: string) {
  const nextItems = [transcript, ...items].slice(0, 20);
  localStorage.setItem(HISTORY_STORAGE_KEY, JSON.stringify(nextItems));
  return nextItems;
}

function formatBytes(bytes: number) {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${Math.round(bytes / 1024 / 1024)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`;
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
    error: { title: "Needs attention", detail: `Open ${APP_NAME}` },
  };
  const copy = indicatorCopy[state] ?? { title: "Working", detail: APP_NAME };

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
  const [transcript, setTranscript] = useState("");
  const [, setHistory] = useState<string[]>(readTranscriptHistory);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [language, setLanguage] = useState(() => readStoredPreference("language", "mixed-th-en"));
  const [modelPath, setModelPath] = useState(() => readStoredPreference("modelPath"));
  const [outputMode, setOutputMode] = useState<OutputMode>(() =>
    readStoredPreference("outputMode") === "copy" ? "copy" : "paste",
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
        effects: [Effect.HudWindow],
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

  useEffect(() => {
    localStorage.setItem(STORAGE_KEYS.outputMode, outputMode);
  }, [outputMode]);

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
    idle: `Press ⌥ Space from any app, or record here. Output: ${outputMode === "paste" ? "auto-paste" : "copy only"}.`,
    "requesting-mic": "Waiting for macOS microphone access.",
    recording: "Speak normally. Press ⌥ Space again when you are done.",
    transcribing: "Audio is being converted locally through whisper.cpp.",
    pasting: "The transcript is on the clipboard and is being sent to the active app.",
    done: outputMode === "paste" ? "Transcript was copied and pasted." : "Transcript was copied to the clipboard.",
    error: "Check permissions, selected model, or local whisper.cpp setup.",
  };

  const canToggle = dictationState !== "requesting-mic" && dictationState !== "transcribing" && dictationState !== "pasting";
  const primaryLabel = dictationState === "recording" ? "Stop" : dictationState === "done" ? "Record again" : "Record";

  return (
    <main className="compact-shell">
      <header className="compact-titlebar" data-tauri-drag-region>
        <button
          type="button"
          className="window-close"
          aria-label={`Close ${APP_NAME}`}
          title="Close"
          data-tauri-drag-region="false"
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            void invoke("hide_main_window").catch(() => getCurrentWindow().hide());
          }}
        />
        <div className="app-brand" aria-label={APP_NAME} data-tauri-drag-region>
          <img src="/murmur-logo-cute-borderless-trimmed.png" alt="" />
          <span>{APP_NAME}</span>
        </div>
        <nav className="top-tabs" aria-label={`${APP_NAME} sections`} data-tauri-drag-region>
          <button
            type="button"
            data-tauri-drag-region="false"
            className="top-tab"
            onPointerDown={(event) => event.stopPropagation()}
            onClick={() => void invoke("show_settings_window")}
            aria-label="Settings"
            title="Settings"
          >
            <span><IconSettings aria-hidden="true" /></span>
          </button>
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
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(false);
  const [whisperStatus, setWhisperStatus] = useState<IWhisperStatus | null>(null);
  const [isChecking, setIsChecking] = useState(true);
  const [history, setHistory] = useState<string[]>(readTranscriptHistory);
  const [language, setLanguage] = useState(() => readStoredPreference("language", "mixed-th-en"));
  const [modelPath, setModelPath] = useState(() => readStoredPreference("modelPath"));
  const [availableModels, setAvailableModels] = useState<IModelInfo[]>([]);
  const [modelCatalog, setModelCatalog] = useState<IModelCatalogItem[]>([]);
  const [downloadingModelId, setDownloadingModelId] = useState<string | null>(null);
  const [downloadProgress, setDownloadProgress] = useState<Record<string, IModelDownloadProgress>>({});
  const [uninstallingModelId, setUninstallingModelId] = useState<string | null>(null);
  const [outputMode, setOutputMode] = useState<OutputMode>(() =>
    readStoredPreference("outputMode") === "copy" ? "copy" : "paste",
  );

  useEffect(() => {
    document.documentElement.dataset.window = "settings";
    document.body.dataset.window = "settings";

    void getCurrentWindow()
      .setEffects({
        effects: [Effect.HudWindow],
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
      const [status, models, catalog] = await Promise.all([
        invoke<IWhisperStatus>("get_whisper_status"),
        invoke<IModelInfo[]>("list_available_models"),
        invoke<IModelCatalogItem[]>("list_model_catalog"),
      ]);
      setWhisperStatus(status);
      setAvailableModels(models);
      setModelCatalog(catalog);
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

  const downloadModel = useCallback(async (modelId: string) => {
    setDownloadingModelId(modelId);

    try {
      const path = await invoke<string>("download_model", { modelId });
      setModelPath(path);
      await checkWhisper();
    } catch (error) {
      setWhisperStatus({
        available: false,
        binary_path: null,
        model_path: null,
        ffmpeg_path: null,
        version: null,
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setDownloadingModelId(null);
      window.setTimeout(() => {
        setDownloadProgress((items) => {
          const nextItems = { ...items };
          delete nextItems[modelId];
          return nextItems;
        });
      }, 900);
    }
  }, [checkWhisper]);

  const uninstallModel = useCallback(async (modelId: string, installedPath: string) => {
    setUninstallingModelId(modelId);

    try {
      await invoke("uninstall_model", { modelId });
      if (modelPath === installedPath) setModelPath("");
      await checkWhisper();
    } catch (error) {
      setWhisperStatus({
        available: false,
        binary_path: null,
        model_path: null,
        ffmpeg_path: null,
        version: null,
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setUninstallingModelId(null);
    }
  }, [checkWhisper, modelPath]);

  useEffect(() => {
    void checkWhisper();

    const unlistenSettings = listen<string>("settings-action", (event) => {
      if (event.payload === "status") void checkWhisper();
      if (event.payload === "history") setActiveSection("history");
    });
    const unlistenTranscript = listen<string>("transcript-ready", (event) => {
      setHistory((items) => prependTranscriptHistory(items, event.payload));
    });
    const unlistenModelDownloadProgress = listen<IModelDownloadProgress>("model-download-progress", (event) => {
      setDownloadProgress((items) => ({ ...items, [event.payload.model_id]: event.payload }));
    });

    return () => {
      void unlistenSettings.then((dispose) => dispose());
      void unlistenTranscript.then((dispose) => dispose());
      void unlistenModelDownloadProgress.then((dispose) => dispose());
    };
  }, [checkWhisper]);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEYS.language, language);
  }, [language]);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEYS.modelPath, modelPath);
  }, [modelPath]);

  useEffect(() => {
    if (!modelPath || !availableModels.length) return;
    if (!availableModels.some((model) => model.path === modelPath)) setModelPath("");
  }, [availableModels, modelPath]);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEYS.outputMode, outputMode);
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
  const multilingualCatalog = modelCatalog.filter((model) => model.multilingual);
  const englishCatalog = modelCatalog.filter((model) => !model.multilingual);
  const appDataExtraModels = availableModels.filter((model) => !modelCatalog.some((item) => item.file_name === model.name));
  const multilingualExtraModels = appDataExtraModels.filter((model) => model.multilingual);
  const englishExtraModels = appDataExtraModels.filter((model) => !model.multilingual);

  const renderCatalogModel = (model: IModelCatalogItem) => {
    const installedPath = model.installed_path;
    const installedSource = model.installed_source;
    const canUninstall = Boolean(installedPath && installedSource === "Murmur");
    const isSelected = Boolean(installedPath && modelPath === installedPath);
    const isDownloading = downloadingModelId === model.id;
    const isUninstalling = uninstallingModelId === model.id;
    const progress = downloadProgress[model.id];
    const percent = progress?.percent ?? null;
    const progressLabel = progress
      ? percent !== null
        ? `${Math.round(percent)}% · ${formatBytes(progress.downloaded_bytes)}`
        : formatBytes(progress.downloaded_bytes)
      : null;

    return (
      <div key={model.id} className={isSelected ? "model-row selected" : "model-row"}>
        <button type="button" className="model-pick" onClick={() => installedPath ? setModelPath(installedPath) : undefined} disabled={!installedPath}>
          <span className="model-icon">{installedPath ? <IconHardDrive aria-hidden="true" /> : <IconCloud aria-hidden="true" />}</span>
          <span className="model-main"><strong>{model.name}</strong><small>{installedPath ?? `${model.file_name} · ${model.multilingual ? "Multilingual" : "English only"} · about ${model.size_mb} MB`}</small></span>
          <span className="model-meta">{installedPath ? installedSource : `${model.speed} / ${model.quality}`}</span>
        </button>
        {canUninstall && installedPath ? (
          <button type="button" className="model-uninstall" onClick={() => uninstallModel(model.id, installedPath)} disabled={Boolean(uninstallingModelId)}>
            <IconTrash2 aria-hidden="true" />
            {isUninstalling ? "Removing" : "Uninstall"}
          </button>
        ) : installedPath ? (
          <span className="model-local-source">App data</span>
        ) : (
          <button type="button" className="model-download" onClick={() => downloadModel(model.id)} disabled={Boolean(downloadingModelId)}>
            <IconDownload aria-hidden="true" />
            {isDownloading ? progressLabel ?? "Downloading" : "Download"}
          </button>
        )}
        {isDownloading ? <span className="model-progress"><span style={{ width: `${percent ?? 12}%` }} /></span> : null}
      </div>
    );
  };

  const renderExtraModel = (model: IModelInfo) => (
    <button key={model.path} type="button" className={modelPath === model.path ? "model-row selected" : "model-row"} onClick={() => setModelPath(model.path)}>
      <span className="model-icon"><IconHardDrive aria-hidden="true" /></span>
      <span className="model-main"><strong>{model.name}</strong><small>{model.path}</small></span>
      <span className="model-meta">App data</span>
    </button>
  );

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
          <span>{APP_NAME}</span>
        </div>
      </header>

      <section className={isSidebarCollapsed ? "settings-window-body sidebar-collapsed" : "settings-window-body"}>
        <aside className="settings-sidebar">
          <button
            type="button"
            className="settings-sidebar-toggle"
            onClick={() => setIsSidebarCollapsed((value) => !value)}
            aria-label={isSidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
            aria-expanded={!isSidebarCollapsed}
            title={isSidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
          >
            {isSidebarCollapsed ? <IconPanelLeftOpen aria-hidden="true" /> : <IconPanelLeftClose aria-hidden="true" />}
            <span>{isSidebarCollapsed ? "Expand" : "Collapse"}</span>
          </button>
          {settingsSidebarItems.map((item) => {
            const Icon = item.icon;
            const isActive = activeSection === item.id;
            return (
              <button
                key={item.id}
                type="button"
                className={isActive ? "settings-sidebar-item active" : "settings-sidebar-item"}
                onClick={() => setActiveSection(item.id)}
                aria-current={isActive ? "page" : undefined}
                aria-label={isSidebarCollapsed ? item.label : undefined}
                title={isSidebarCollapsed ? item.label : undefined}
              >
                <Icon aria-hidden="true" />
                <span>{item.label}</span>
              </button>
            );
          })}
        </aside>

        <section className="settings-main-panel">
          <div className="settings-window-heading">
            <h1>{activeSection === "general" ? "General Settings" : activeSection === "history" ? "History" : activeSection === "models" ? "Models Library" : "Permissions"}</h1>
            <p>{activeSection === "general" ? "Set language and where the transcript goes after recording." : activeSection === "history" ? "Review and copy recent transcripts." : activeSection === "models" ? "Choose a ggml model. Downloads are saved in Murmur app data." : `System permissions used by ${APP_NAME}.`}</p>
          </div>

          {activeSection === "general" ? <div id="dictation" className="settings-section">
            <h2>Dictation</h2>
            <div className="choice-group" aria-label="Language">
              <span className="field-label">Language</span>
              <div className="choice-grid two-column">
                {languageOptions.map((option) => (
                  <button key={option.value} type="button" className={language === option.value ? "choice-card selected" : "choice-card"} onClick={() => setLanguage(option.value)}>
                    <strong>{option.label}</strong>
                    <span>{option.detail}</span>
                  </button>
                ))}
              </div>
            </div>
            <div className="choice-group" aria-label="Output">
              <span className="field-label">Output</span>
              <div className="choice-grid">
                {outputOptions.map((option) => (
                  <button key={option.value} type="button" className={outputMode === option.value ? "choice-card selected" : "choice-card"} onClick={() => setOutputMode(option.value)}>
                    <strong>{option.label}</strong>
                    <span>{option.detail}</span>
                  </button>
                ))}
              </div>
            </div>
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

          {activeSection === "models" ? <div id="models" className="settings-section models-library-section">
            <div className="panel-heading">
              <h2>Models Library</h2>
              <button type="button" onClick={checkWhisper}>Check</button>
            </div>
            <div className={statusReady ? "engine-state ready" : "engine-state"}>{isChecking ? "Checking..." : whisperStatus?.message}</div>
            <div className="model-list" aria-label="Whisper models">
              <button type="button" className={modelPath ? "model-row" : "model-row selected"} onClick={() => setModelPath("") }>
                <span className="model-icon"><IconCheckCircle aria-hidden="true" /></span>
                <span className="model-main"><strong>Auto select</strong><small>Use the best multilingual ggml model Murmur can find.</small></span>
                <span className="model-meta">Default</span>
              </button>
              <div className="model-group"><span>Multilingual</span></div>
              {multilingualCatalog.map(renderCatalogModel)}
              {multilingualExtraModels.map(renderExtraModel)}
              <div className="model-group"><span>English only</span></div>
              {englishCatalog.map(renderCatalogModel)}
              {englishExtraModels.map(renderExtraModel)}
            </div>
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
