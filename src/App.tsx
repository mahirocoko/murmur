import { invoke } from '@tauri-apps/api/core'
import { emit, listen } from '@tauri-apps/api/event'
import { Effect, EffectState, getCurrentWindow } from '@tauri-apps/api/window'
import { writeText } from '@tauri-apps/plugin-clipboard-manager'
import type { ComponentType, CSSProperties, SVGProps } from 'react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import IconCheckCircle from '~icons/lucide/check-circle'
import IconCircleDot from '~icons/lucide/circle-dot'
import IconCloud from '~icons/lucide/cloud'
import IconDownload from '~icons/lucide/download'
import IconHardDrive from '~icons/lucide/hard-drive'
import IconHeadphones from '~icons/lucide/headphones'
import IconHistory from '~icons/lucide/history'
import IconHome from '~icons/lucide/home'
import IconLaptop from '~icons/lucide/laptop'
import IconLibraryBig from '~icons/lucide/library-big'
import IconMic from '~icons/lucide/mic'
import IconPanelLeftClose from '~icons/lucide/panel-left-close'
import IconPanelLeftOpen from '~icons/lucide/panel-left-open'
import IconRefreshCw from '~icons/lucide/refresh-cw'
import IconShieldCheck from '~icons/lucide/shield-check'
import IconSlidersHorizontal from '~icons/lucide/sliders-horizontal'
import IconSmartphone from '~icons/lucide/smartphone'
import IconTrash2 from '~icons/lucide/trash-2'
import './App.css'

interface IWhisperStatus {
  available: boolean
  binary_path: string | null
  model_path: string | null
  version: string | null
  message: string
}

interface IModelInfo {
  name: string
  path: string
  multilingual: boolean
  source: string
}

interface IModelCatalogItem {
  id: string
  name: string
  file_name: string
  multilingual: boolean
  size_mb: number
  quality: string
  speed: string
  url: string
  installed_path: string | null
  installed_source: string | null
}

interface IModelDownloadProgress {
  model_id: string
  downloaded_bytes: number
  total_bytes: number | null
  percent: number | null
  state: string
}

interface IInputDeviceInfo {
  name: string
  is_default: boolean
  is_selected: boolean
}

type DictationState = 'idle' | 'requesting-mic' | 'recording' | 'transcribing' | 'pasting' | 'done' | 'error'
type OutputMode = 'copy' | 'paste'
type SettingsSection = 'general' | 'history' | 'models' | 'permissions'
type AppSection = 'home' | SettingsSection

const APP_NAME = 'Murmur'
const HISTORY_STORAGE_KEY = 'murmur-history'
const LEGACY_HISTORY_STORAGE_KEY = 'mahiro-whisper-history'
const STORAGE_KEYS = {
  language: 'murmur-language',
  modelPath: 'murmur-model-path',
  outputMode: 'murmur-output-mode',
  inputDeviceName: 'murmur-input-device-name',
} as const
const LEGACY_STORAGE_KEYS = {
  language: 'mahiro-whisper-language',
  modelPath: 'mahiro-whisper-model-path',
  outputMode: 'mahiro-whisper-output-mode',
  inputDeviceName: 'mahiro-whisper-input-device-name',
} as const

interface INativePreferencesPayload {
  language: string
  model_path: string | null
  output_mode: OutputMode
  input_device_name: string | null
}

const languageOptions = [
  { value: 'mixed-th-en', label: 'Thai + English', detail: 'ถอดไทยเป็นหลัก และคงคำอังกฤษ/technical terms ไว้' },
  { value: 'th', label: 'Thai', detail: 'บังคับใช้ภาษาไทย' },
  { value: 'auto', label: 'Auto detect', detail: 'ให้ whisper.cpp ตรวจภาษาเอง' },
  { value: 'en', label: 'English', detail: 'สำหรับงานอังกฤษ หรือ model ตระกูล .en' },
  { value: 'ja', label: 'Japanese', detail: 'สำหรับงานภาษาญี่ปุ่น' },
  { value: 'zh', label: 'Chinese', detail: 'สำหรับงานภาษาจีน' },
]

const outputOptions: Array<{ value: OutputMode; label: string; detail: string }> = [
  { value: 'paste', label: 'Copy and auto-paste', detail: 'คัดลอก transcript แล้ววางกลับไปยังแอปเดิม' },
  { value: 'copy', label: 'Copy only', detail: 'เก็บไว้ใน clipboard ก่อน แล้วค่อยวางเอง' },
]

const WAVE_BAR_COUNT = 78
const WAVE_SCROLL_STEP = 2
const LOADING_WAVE_BAR_COUNT = WAVE_BAR_COUNT

type LoadingWaveStyle = CSSProperties & {
  '--wave-delay': string
  '--wave-duration': string
  '--wave-peak': string
  '--wave-rise': string
  '--wave-fall': string
}

function readTranscriptHistory() {
  try {
    const parsed = JSON.parse(
      localStorage.getItem(HISTORY_STORAGE_KEY) ?? localStorage.getItem(LEGACY_HISTORY_STORAGE_KEY) ?? '[]',
    )
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : []
  } catch {
    return []
  }
}

function readStoredPreference(key: keyof typeof STORAGE_KEYS, fallback = '') {
  return localStorage.getItem(STORAGE_KEYS[key]) ?? localStorage.getItem(LEGACY_STORAGE_KEYS[key]) ?? fallback
}

function prependTranscriptHistory(items: string[], transcript: string) {
  const nextItems = [transcript, ...items].slice(0, 20)
  localStorage.setItem(HISTORY_STORAGE_KEY, JSON.stringify(nextItems))
  return nextItems
}

function formatBytes(bytes: number) {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`
  if (bytes < 1024 * 1024 * 1024) return `${Math.round(bytes / 1024 / 1024)} MB`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`
}

function IndicatorWindow() {
  // _State
  const [state, setState] = useState('recording')
  const [audioLevel, setAudioLevel] = useState(0)
  const [waveBars, setWaveBars] = useState(() => Array.from({ length: WAVE_BAR_COUNT }, () => 0))

  // _Memo
  const waveHeights = useMemo(() => {
    const level = state === 'recording' ? Math.sqrt(audioLevel) : 0
    const floor = 2
    const max = 38

    return waveBars.map((bar) => {
      const voice = Math.max(bar * 0.9, level * 0.08)
      const height = floor + Math.pow(voice, 0.78) * max

      return Math.max(floor, Math.min(max, height))
    })
  }, [audioLevel, state, waveBars])

  const indicatorCopy: Record<string, { title: string; detail: string }> = {
    recording: { title: 'Listening', detail: 'Esc cancels this take' },
    transcribing: { title: 'Transcribing', detail: 'Turning speech into text' },
    pasting: { title: 'Pasting', detail: 'Sending text to the active app' },
    done: { title: 'Done', detail: 'Transcript copied' },
    error: { title: 'Needs attention', detail: `Open ${APP_NAME}` },
  }
  const copy = indicatorCopy[state] ?? { title: 'Working', detail: APP_NAME }

  const loadingWaveBars = useMemo<LoadingWaveStyle[]>(
    () =>
      Array.from({ length: LOADING_WAVE_BAR_COUNT }, (_, index) => {
        const centerDistance = Math.abs(index - (LOADING_WAVE_BAR_COUNT - 1) / 2) / LOADING_WAVE_BAR_COUNT
        const peak = 0.68 + Math.sin(index * 0.43) * 0.14 + (0.5 - centerDistance) * 0.42
        const verticalDrift = 1.2 + Math.abs(Math.sin(index * 0.36)) * 3.2

        return {
          '--wave-delay': `${index * -42}ms`,
          '--wave-duration': `${980 + (index % 9) * 34}ms`,
          '--wave-peak': peak.toFixed(3),
          '--wave-rise': `${-verticalDrift.toFixed(2)}px`,
          '--wave-fall': `${(verticalDrift * 0.45).toFixed(2)}px`,
        } as LoadingWaveStyle
      }),
    [],
  )

  // _Effect
  useEffect(() => {
    document.documentElement.dataset.window = 'indicator'
    document.body.dataset.window = 'indicator'

    const normalize = (value: string) => setState(value.toLowerCase())
    const unlistenIndicator = listen<string>('indicator-state', (event) => normalize(event.payload))
    const unlistenDictation = listen<string>('dictation-state', (event) => normalize(event.payload))
    const unlistenAudioLevel = listen<number>('audio-level', (event) => {
      const nextLevel = Number.isFinite(event.payload) ? Math.max(0, Math.min(event.payload, 1)) : 0
      setAudioLevel((currentLevel) => {
        if (nextLevel > currentLevel) return currentLevel * 0.2 + nextLevel * 0.8
        return currentLevel * 0.8 + nextLevel * 0.2
      })
    })
    const unlistenAudioWaveform = listen<number[]>('audio-waveform', (event) => {
      if (!Array.isArray(event.payload)) return

      setWaveBars((currentBars) => {
        const nextBars = event.payload.map((value) => (Number.isFinite(value) ? Math.max(0, Math.min(value, 1)) : 0))
        if (!nextBars.length) return currentBars

        const incomingBars = Array.from({ length: WAVE_SCROLL_STEP }, (_, index) => {
          const start = Math.floor((index / WAVE_SCROLL_STEP) * nextBars.length)
          const end = Math.max(start + 1, Math.floor(((index + 1) / WAVE_SCROLL_STEP) * nextBars.length))
          const chunk = nextBars.slice(start, end)
          const peak = chunk.reduce((maxValue, value) => Math.max(maxValue, value), 0)
          const average = chunk.reduce((total, value) => total + value, 0) / chunk.length

          return Math.max(peak * 0.72, average)
        })

        return [...currentBars.slice(incomingBars.length), ...incomingBars]
      })
    })

    return () => {
      delete document.documentElement.dataset.window
      delete document.body.dataset.window
      void unlistenIndicator.then((dispose) => dispose())
      void unlistenDictation.then((dispose) => dispose())
      void unlistenAudioLevel.then((dispose) => dispose())
      void unlistenAudioWaveform.then((dispose) => dispose())
    }
  }, [])

  useEffect(() => {
    if (state === 'recording') return
    setWaveBars(Array.from({ length: WAVE_BAR_COUNT }, () => 0))
  }, [state])

  return (
    <main className={`indicator-shell ${state}`}>
      <div
        className={state === 'recording' ? 'indicator-wave recording-wave' : 'indicator-wave loading-wave'}
        aria-hidden="true"
      >
        {state === 'recording'
          ? waveHeights.map((height, index) => (
              <i key={index} style={{ height: `${height}px`, opacity: 0.38 + Math.min(height / 44, 0.54) }} />
            ))
          : loadingWaveBars.map((style, index) => <span key={index} style={style} />)}
      </div>
      <div className="indicator-footer">
        <div className="indicator-mode">
          <span className={`indicator-mic ${state}`} aria-hidden="true" />
          <strong>{copy.title}</strong>
          <span>{copy.detail}</span>
        </div>
        <div className="indicator-actions">
          {state === 'recording' ? (
            <>
              <kbd>Esc</kbd>
              <span>cancel</span>
              <span className="indicator-action-divider" aria-hidden="true" />
            </>
          ) : null}
          <kbd>⌥</kbd>
          <kbd>Space</kbd>
          <span>{state === 'recording' ? 'stop' : 'toggle'}</span>
        </div>
      </div>
    </main>
  )
}

const mainNavItems: Array<{ id: AppSection; label: string; icon: ComponentType<SVGProps<SVGSVGElement>> }> = [
  { id: 'home', label: 'Home', icon: IconHome },
  { id: 'general', label: 'General', icon: IconSlidersHorizontal },
  { id: 'models', label: 'Models', icon: IconLibraryBig },
  { id: 'history', label: 'History', icon: IconHistory },
  { id: 'permissions', label: 'Permissions', icon: IconShieldCheck },
]

function getInputDeviceIcon(name: string): ComponentType<SVGProps<SVGSVGElement>> {
  const normalizedName = name.toLowerCase()
  if (normalizedName.includes('airpods') || normalizedName.includes('headphone') || normalizedName.includes('buds')) {
    return IconHeadphones
  }
  if (normalizedName.includes('iphone') || normalizedName.includes('phone')) return IconSmartphone
  if (normalizedName.includes('macbook') || normalizedName.includes('laptop')) return IconLaptop
  return IconMic
}

function getInputDeviceLabel(device: IInputDeviceInfo) {
  return device.is_default ? `${device.name} (Default)` : device.name
}

function MainApp() {
  // _Ref
  const stateRef = useRef<DictationState>('idle')

  // _State
  const [activeSection, setActiveSection] = useState<AppSection>('home')
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(false)
  const [whisperStatus, setWhisperStatus] = useState<IWhisperStatus | null>(null)
  const [dictationState, setDictationState] = useState<DictationState>('idle')
  const [transcript, setTranscript] = useState('')
  const [history, setHistory] = useState<string[]>(readTranscriptHistory)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [language, setLanguage] = useState(() => readStoredPreference('language', 'mixed-th-en'))
  const [modelPath, setModelPath] = useState(() => readStoredPreference('modelPath'))
  const [outputMode, setOutputMode] = useState<OutputMode>(() =>
    readStoredPreference('outputMode') === 'copy' ? 'copy' : 'paste',
  )
  const [availableModels, setAvailableModels] = useState<IModelInfo[]>([])
  const [modelCatalog, setModelCatalog] = useState<IModelCatalogItem[]>([])
  const [downloadingModelId, setDownloadingModelId] = useState<string | null>(null)
  const [downloadProgress, setDownloadProgress] = useState<Record<string, IModelDownloadProgress>>({})
  const [uninstallingModelId, setUninstallingModelId] = useState<string | null>(null)
  const [inputDeviceName, setInputDeviceName] = useState(() => readStoredPreference('inputDeviceName'))
  const [inputDevices, setInputDevices] = useState<IInputDeviceInfo[]>([])
  const [isInputDeviceMenuOpen, setIsInputDeviceMenuOpen] = useState(false)

  // _Callback
  const updateDictationState = useCallback((nextState: DictationState) => {
    stateRef.current = nextState
    setDictationState(nextState)
  }, [])

  const refreshStatus = useCallback(async () => {
    try {
      const [status, models, catalog] = await Promise.all([
        invoke<IWhisperStatus>('get_whisper_status'),
        invoke<IModelInfo[]>('list_available_models'),
        invoke<IModelCatalogItem[]>('list_model_catalog'),
      ])
      setWhisperStatus(status)
      setAvailableModels(models)
      setModelCatalog(catalog)
    } catch (error) {
      setWhisperStatus({
        available: false,
        binary_path: null,
        model_path: null,
        version: null,
        message: error instanceof Error ? error.message : 'ตรวจสอบ whisper.cpp ไม่สำเร็จ',
      })
    }
  }, [])

  const refreshInputDevices = useCallback(async () => {
    try {
      const devices = await invoke<IInputDeviceInfo[]>('list_input_devices')
      setInputDevices(devices)
    } catch {
      setInputDevices([])
    }
  }, [])

  const selectInputDevice = useCallback((name: string | null) => {
    setInputDeviceName(name ?? '')
    setIsInputDeviceMenuOpen(false)
  }, [])

  const toggleDictation = useCallback(async () => {
    if (stateRef.current === 'requesting-mic' || stateRef.current === 'transcribing') return
    try {
      setErrorMessage(null)
      await invoke('toggle_native_recording')
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : String(error))
      updateDictationState('error')
    }
  }, [updateDictationState])

  const downloadModel = useCallback(
    async (modelId: string) => {
      setDownloadingModelId(modelId)
      try {
        const path = await invoke<string>('download_model', { modelId })
        setModelPath(path)
        await refreshStatus()
      } catch (error) {
        setErrorMessage(error instanceof Error ? error.message : String(error))
      } finally {
        setDownloadingModelId(null)
        window.setTimeout(() => {
          setDownloadProgress((items) => {
            const nextItems = { ...items }
            delete nextItems[modelId]
            return nextItems
          })
        }, 900)
      }
    },
    [refreshStatus],
  )

  const uninstallModel = useCallback(
    async (modelId: string, installedPath: string) => {
      setUninstallingModelId(modelId)
      try {
        await invoke('uninstall_model', { modelId })
        if (modelPath === installedPath) setModelPath('')
        await refreshStatus()
      } catch (error) {
        setErrorMessage(error instanceof Error ? error.message : String(error))
      } finally {
        setUninstallingModelId(null)
      }
    },
    [refreshStatus, modelPath],
  )

  // _Effect
  useEffect(() => {
    void getCurrentWindow()
      .setEffects({
        effects: [Effect.HudWindow],
        state: EffectState.Active,
        radius: 16,
      })
      .catch(() => undefined)
  }, [])

  useEffect(() => {
    void refreshStatus()
    void refreshInputDevices()

    const unlistenState = listen<DictationState>('dictation-state', (event) => {
      updateDictationState(event.payload)
      if (event.payload === 'done') void refreshStatus()
    })
    const unlistenTranscript = listen<string>('transcript-ready', (event) => {
      setTranscript(event.payload)
      setHistory((items) => prependTranscriptHistory(items, event.payload))
    })
    const unlistenError = listen<string>('dictation-error', (event) => {
      setErrorMessage(event.payload)
      updateDictationState('error')
    })
    const unlistenTray = listen<string>('tray-action', (event) => {
      if (event.payload === 'history') setActiveSection('history')
    })
    const unlistenSettings = listen<string>('settings-action', (event) => {
      if (event.payload === 'settings') setActiveSection('general')
      if (event.payload === 'history') setActiveSection('history')
      if (event.payload === 'status') {
        setActiveSection('home')
        void refreshStatus()
      }
    })
    const unlistenPreferences = listen<INativePreferencesPayload>('preferences-updated', (event) => {
      setLanguage(event.payload.language)
      setModelPath(event.payload.model_path ?? '')
      setOutputMode(event.payload.output_mode)
      setInputDeviceName(event.payload.input_device_name ?? '')
    })
    const unlistenInputDevices = listen<IInputDeviceInfo[]>('input-devices-updated', (event) => {
      setInputDevices(event.payload)
    })
    const unlistenDownloadProgress = listen<IModelDownloadProgress>('model-download-progress', (event) => {
      setDownloadProgress((items) => ({ ...items, [event.payload.model_id]: event.payload }))
    })

    return () => {
      void unlistenState.then((dispose) => dispose())
      void unlistenTranscript.then((dispose) => dispose())
      void unlistenError.then((dispose) => dispose())
      void unlistenTray.then((dispose) => dispose())
      void unlistenSettings.then((dispose) => dispose())
      void unlistenPreferences.then((dispose) => dispose())
      void unlistenInputDevices.then((dispose) => dispose())
      void unlistenDownloadProgress.then((dispose) => dispose())
    }
  }, [refreshStatus, refreshInputDevices, updateDictationState])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      if (stateRef.current !== 'recording') return
      event.preventDefault()
      void invoke('cancel_native_recording')
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  useEffect(() => {
    localStorage.setItem(STORAGE_KEYS.language, language)
  }, [language])

  useEffect(() => {
    localStorage.setItem(STORAGE_KEYS.modelPath, modelPath)
  }, [modelPath])

  useEffect(() => {
    localStorage.setItem(STORAGE_KEYS.outputMode, outputMode)
  }, [outputMode])

  useEffect(() => {
    localStorage.setItem(STORAGE_KEYS.inputDeviceName, inputDeviceName)
  }, [inputDeviceName])

  useEffect(() => {
    localStorage.setItem(HISTORY_STORAGE_KEY, JSON.stringify(history))
  }, [history])

  useEffect(() => {
    if (!isInputDeviceMenuOpen) return

    const onPointerDown = (event: PointerEvent) => {
      if (event.target instanceof Element && event.target.closest('.toolbar-device-menu')) return
      setIsInputDeviceMenuOpen(false)
    }

    window.addEventListener('pointerdown', onPointerDown)
    return () => window.removeEventListener('pointerdown', onPointerDown)
  }, [isInputDeviceMenuOpen])

  useEffect(() => {
    if (!modelPath || !availableModels.length) return
    if (!availableModels.some((model) => model.path === modelPath)) setModelPath('')
  }, [availableModels, modelPath])

  useEffect(() => {
    const preferences: INativePreferencesPayload = {
      language,
      model_path: modelPath.trim() || null,
      output_mode: outputMode,
      input_device_name: inputDeviceName.trim() || null,
    }
    void invoke('set_native_preferences', { preferences })
    void emit('preferences-updated', preferences)
  }, [language, modelPath, outputMode, inputDeviceName])

  // _Memo
  const stateLabel: Record<DictationState, string> = {
    idle: 'Ready',
    'requesting-mic': 'Requesting microphone',
    recording: 'Listening',
    transcribing: 'Transcribing',
    pasting: 'Pasting',
    done: outputMode === 'paste' ? 'Pasted' : 'Copied',
    error: 'Needs attention',
  }

  const stateDetail: Record<DictationState, string> = {
    idle: `Press ⌥ Space from any app, or record here. Output: ${outputMode === 'paste' ? 'auto-paste' : 'copy only'}.`,
    'requesting-mic': 'Waiting for macOS microphone access.',
    recording: 'Speak normally. Press ⌥ Space again when you are done.',
    transcribing: 'Audio is being converted locally through whisper.cpp.',
    pasting: 'The transcript is on the clipboard and is being sent to the active app.',
    done: outputMode === 'paste' ? 'Transcript was copied and pasted.' : 'Transcript was copied to the clipboard.',
    error: 'Check permissions, selected model, or local whisper.cpp setup.',
  }

  const canToggle =
    dictationState !== 'requesting-mic' && dictationState !== 'transcribing' && dictationState !== 'pasting'
  const primaryLabel =
    dictationState === 'recording' ? 'Stop' : dictationState === 'done' ? 'Record again' : 'Start recording'

  const statusReady = Boolean(whisperStatus?.available)
  const installedModels = modelCatalog.filter((model) => Boolean(model.installed_path))
  const selectedModelName = (() => {
    if (!modelPath) return whisperStatus?.model_path ? 'Auto' : 'None'
    const fromCatalog = modelCatalog.find((model) => model.installed_path === modelPath)
    if (fromCatalog) return fromCatalog.name
    const fromLocal = availableModels.find((model) => model.path === modelPath)
    return fromLocal?.name ?? 'Custom'
  })()

  const multilingualCatalog = modelCatalog.filter((model) => model.multilingual)
  const englishCatalog = modelCatalog.filter((model) => !model.multilingual)
  const appDataExtraModels = availableModels.filter(
    (model) => !modelCatalog.some((item) => item.file_name === model.name),
  )
  const multilingualExtraModels = appDataExtraModels.filter((model) => model.multilingual)
  const englishExtraModels = appDataExtraModels.filter((model) => !model.multilingual)
  const selectedInputDevice = inputDeviceName
    ? inputDevices.find((device) => device.name === inputDeviceName)
    : inputDevices.find((device) => device.is_default)
  const inputDeviceLabel = selectedInputDevice
    ? getInputDeviceLabel(selectedInputDevice)
    : inputDeviceName || 'System default mic'
  const InputDeviceIcon = selectedInputDevice ? getInputDeviceIcon(selectedInputDevice.name) : IconMic

  const renderCatalogModel = (model: IModelCatalogItem) => {
    const installedPath = model.installed_path
    const installedSource = model.installed_source
    const canUninstall = Boolean(installedPath && installedSource === 'Murmur')
    const isSelected = Boolean(installedPath && modelPath === installedPath)
    const isDownloading = downloadingModelId === model.id
    const isUninstalling = uninstallingModelId === model.id
    const progress = downloadProgress[model.id]
    const percent = progress?.percent ?? null
    const progressLabel = progress
      ? percent !== null
        ? `${Math.round(percent)}% · ${formatBytes(progress.downloaded_bytes)}`
        : formatBytes(progress.downloaded_bytes)
      : null

    return (
      <div key={model.id} className={isSelected ? 'model-row selected' : 'model-row'}>
        <button
          type="button"
          className="model-pick"
          onClick={() => (installedPath ? setModelPath(installedPath) : undefined)}
          disabled={!installedPath}
        >
          <span className="model-icon">
            {installedPath ? <IconHardDrive aria-hidden="true" /> : <IconCloud aria-hidden="true" />}
          </span>
          <span className="model-main">
            <strong>{model.name}</strong>
            <small>
              {installedPath ??
                `${model.file_name} · ${model.multilingual ? 'Multilingual' : 'English only'} · about ${model.size_mb} MB`}
            </small>
          </span>
          <span className="model-meta">{installedPath ? installedSource : `${model.speed} / ${model.quality}`}</span>
        </button>
        {canUninstall && installedPath ? (
          <button
            type="button"
            className="model-uninstall"
            onClick={() => uninstallModel(model.id, installedPath)}
            disabled={Boolean(uninstallingModelId)}
          >
            <IconTrash2 aria-hidden="true" />
            {isUninstalling ? 'Removing' : 'Uninstall'}
          </button>
        ) : installedPath ? (
          <span className="model-local-source">App data</span>
        ) : (
          <button
            type="button"
            className="model-download"
            onClick={() => downloadModel(model.id)}
            disabled={Boolean(downloadingModelId)}
          >
            <IconDownload aria-hidden="true" />
            {isDownloading ? (progressLabel ?? 'Downloading') : 'Download'}
          </button>
        )}
        {isDownloading ? (
          <span className="model-progress">
            <span style={{ width: `${percent ?? 12}%` }} />
          </span>
        ) : null}
      </div>
    )
  }

  const renderExtraModel = (model: IModelInfo) => (
    <button
      key={model.path}
      type="button"
      className={modelPath === model.path ? 'model-row selected' : 'model-row'}
      onClick={() => setModelPath(model.path)}
    >
      <span className="model-icon">
        <IconHardDrive aria-hidden="true" />
      </span>
      <span className="model-main">
        <strong>{model.name}</strong>
        <small>{model.path}</small>
      </span>
      <span className="model-meta">App data</span>
    </button>
  )

  const sectionTitle: Record<AppSection, { title: string; subtitle: string }> = {
    home: { title: 'Home', subtitle: 'Local dictation status and recent activity.' },
    general: { title: 'General', subtitle: 'Language and where the transcript goes after recording.' },
    models: { title: 'Models', subtitle: 'Choose a ggml model. Downloads are saved in Murmur app data.' },
    history: { title: 'History', subtitle: 'Review and copy recent transcripts.' },
    permissions: { title: 'Permissions', subtitle: `System permissions used by ${APP_NAME}.` },
  }

  const hasModel = Boolean(modelPath) || Boolean(whisperStatus?.model_path)
  const checklist: Array<{
    id: string
    title: string
    detail: string
    done: boolean
    action?: { label: string; onClick: () => void }
  }> = [
    {
      id: 'engine',
      title: 'Local engine ready',
      detail: statusReady ? 'whisper.cpp is available.' : (whisperStatus?.message ?? 'Checking whisper.cpp...'),
      done: statusReady,
      action: statusReady ? undefined : { label: 'Re-check', onClick: () => void refreshStatus() },
    },
    {
      id: 'model',
      title: 'Choose a model',
      detail: hasModel ? `Using ${selectedModelName}.` : 'Pick or download a ggml model for transcription.',
      done: hasModel,
      action: { label: hasModel ? 'Manage' : 'Open Models', onClick: () => setActiveSection('models') },
    },
    {
      id: 'output',
      title: 'Configure output',
      detail: outputMode === 'paste' ? 'Auto-paste to the active app.' : 'Copy only to the clipboard.',
      done: true,
      action: { label: 'Change', onClick: () => setActiveSection('general') },
    },
    {
      id: 'record',
      title: 'Try a recording',
      detail: 'Press ⌥ Space from any app, or use the button above.',
      done: dictationState === 'done' || history.length > 0,
      action: { label: primaryLabel, onClick: () => void toggleDictation() },
    },
  ]

  return (
    <main className={isSidebarCollapsed ? 'app-shell sidebar-collapsed' : 'app-shell'}>
      <aside className="app-sidebar" data-tauri-drag-region>
        <div className="sidebar-traffic" data-tauri-drag-region="false">
          <button
            type="button"
            className="window-close"
            aria-label={`Close ${APP_NAME}`}
            title="Close"
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => {
              event.preventDefault()
              event.stopPropagation()
              void invoke('hide_main_window').catch(() => getCurrentWindow().hide())
            }}
          />
          <span className="traffic-dim" aria-hidden="true" />
          <span className="traffic-dim" aria-hidden="true" />
        </div>

        <div className="sidebar-brand" data-tauri-drag-region>
          <img src="/murmur-logo-cute-borderless-trimmed.png" alt="" />
          <span>{APP_NAME}</span>
        </div>

        <nav className="sidebar-nav" aria-label={`${APP_NAME} sections`} data-tauri-drag-region="false">
          {mainNavItems.map((item) => {
            const Icon = item.icon
            const isActive = activeSection === item.id
            return (
              <button
                key={item.id}
                type="button"
                className={isActive ? 'sidebar-item active' : 'sidebar-item'}
                onClick={() => setActiveSection(item.id)}
                aria-current={isActive ? 'page' : undefined}
                aria-label={isSidebarCollapsed ? item.label : undefined}
                title={isSidebarCollapsed ? item.label : undefined}
              >
                <Icon aria-hidden="true" />
                <span>{item.label}</span>
              </button>
            )
          })}
        </nav>

        <div className="sidebar-foot" data-tauri-drag-region="false">
          <span className={`sidebar-state ${dictationState}`} />
          <span>{stateLabel[dictationState]}</span>
        </div>
      </aside>

      <section className="app-content">
        <header className="app-toolbar" data-tauri-drag-region>
          <button
            type="button"
            className="toolbar-sidebar-toggle"
            data-tauri-drag-region="false"
            onClick={() => setIsSidebarCollapsed((value) => !value)}
            aria-label={isSidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            aria-expanded={!isSidebarCollapsed}
            title={isSidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          >
            {isSidebarCollapsed ? <IconPanelLeftOpen aria-hidden="true" /> : <IconPanelLeftClose aria-hidden="true" />}
          </button>
          <div className="toolbar-title">
            <h1>{sectionTitle[activeSection].title}</h1>
            <p>{sectionTitle[activeSection].subtitle}</p>
          </div>
          <div className="toolbar-actions" data-tauri-drag-region="false">
            <div className="toolbar-device-menu">
              <button
                type="button"
                className="toolbar-device"
                onClick={() => {
                  setIsInputDeviceMenuOpen((value) => !value)
                  void refreshInputDevices()
                }}
                title="Input microphone"
                aria-haspopup="menu"
                aria-expanded={isInputDeviceMenuOpen}
              >
                <InputDeviceIcon aria-hidden="true" />
                <span>{inputDeviceLabel}</span>
              </button>
              {isInputDeviceMenuOpen ? (
                <div className="input-device-popover" role="menu" aria-label="Input microphone">
                  <button
                    type="button"
                    className={!inputDeviceName ? 'input-device-option selected' : 'input-device-option'}
                    onClick={() => selectInputDevice(null)}
                    role="menuitemradio"
                    aria-checked={!inputDeviceName}
                  >
                    <IconMic aria-hidden="true" />
                    <span>Use system default</span>
                    {!inputDeviceName ? <IconCheckCircle aria-hidden="true" /> : null}
                  </button>
                  {inputDevices.map((device) => {
                    const DeviceIcon = getInputDeviceIcon(device.name)
                    const isSelected = inputDeviceName === device.name
                    return (
                      <button
                        key={device.name}
                        type="button"
                        className={isSelected ? 'input-device-option selected' : 'input-device-option'}
                        onClick={() => selectInputDevice(device.name)}
                        role="menuitemradio"
                        aria-checked={isSelected}
                      >
                        <DeviceIcon aria-hidden="true" />
                        <span>{getInputDeviceLabel(device)}</span>
                        {isSelected ? <IconCheckCircle aria-hidden="true" /> : null}
                      </button>
                    )
                  })}
                  {inputDevices.length === 0 ? <p className="input-device-empty">No microphones found</p> : null}
                </div>
              ) : null}
            </div>
            <button
              type="button"
              className={dictationState === 'recording' ? 'toolbar-record stop' : 'toolbar-record'}
              onClick={() => void toggleDictation()}
              disabled={!canToggle}
            >
              <IconCircleDot aria-hidden="true" />
              <span>{primaryLabel}</span>
            </button>
          </div>
        </header>

        <div className="app-scroll">
          {errorMessage ? <div className="notice error">{errorMessage}</div> : null}

          {activeSection === 'home' ? (
            <div className="home-stack">
              <div className="metric-strip">
                <div className="metric-card">
                  <span className="metric-label">Engine</span>
                  <strong className={statusReady ? 'metric-value ok' : 'metric-value warn'}>
                    {statusReady ? 'Ready' : 'Not ready'}
                  </strong>
                  <span className="metric-detail">
                    {statusReady ? 'whisper.cpp local' : (whisperStatus?.message ?? 'Checking...')}
                  </span>
                </div>
                <div className="metric-card">
                  <span className="metric-label">Model</span>
                  <strong className="metric-value">{hasModel ? selectedModelName : 'Not selected'}</strong>
                  <span className="metric-detail">{installedModels.length} installed</span>
                </div>
                <div className="metric-card">
                  <span className="metric-label">Output</span>
                  <strong className="metric-value">{outputMode === 'paste' ? 'Auto-paste' : 'Copy only'}</strong>
                  <span className="metric-detail">{language}</span>
                </div>
                <div className="metric-card">
                  <span className="metric-label">Shortcut</span>
                  <strong className="metric-value">
                    <kbd>⌥</kbd> <kbd>Space</kbd>
                  </strong>
                  <span className="metric-detail">Toggle dictation</span>
                </div>
              </div>

              <section className="home-card">
                <div className="panel-heading">
                  <h2>Get started</h2>
                  <button type="button" onClick={() => void refreshStatus()}>
                    <IconRefreshCw aria-hidden="true" /> Refresh
                  </button>
                </div>
                <ul className="checklist">
                  {checklist.map((step) => (
                    <li key={step.id} className={step.done ? 'done' : undefined}>
                      <span className="check-mark" aria-hidden="true">
                        {step.done ? <IconCheckCircle /> : <IconCircleDot />}
                      </span>
                      <div className="check-main">
                        <strong>{step.title}</strong>
                        <span>{step.detail}</span>
                      </div>
                      {step.action ? (
                        <button type="button" className="check-action" onClick={step.action.onClick}>
                          {step.action.label}
                        </button>
                      ) : null}
                    </li>
                  ))}
                </ul>
              </section>

              <section className="home-card">
                <div className="panel-heading">
                  <h2>Latest transcript</h2>
                  {transcript ? (
                    <button type="button" onClick={() => writeText(transcript)}>
                      Copy
                    </button>
                  ) : null}
                </div>
                {transcript ? (
                  <p className="transcript-text">{transcript}</p>
                ) : history[0] ? (
                  <p className="transcript-text muted">{history[0]}</p>
                ) : (
                  <p className="empty">No transcripts yet. Press ⌥ Space to record.</p>
                )}
                <p className="state-detail">{stateDetail[dictationState]}</p>
              </section>
            </div>
          ) : null}

          {activeSection === 'general' ? (
            <div className="settings-section">
              <h2>Dictation</h2>
              <div className="choice-group" aria-label="Language">
                <span className="field-label">Language</span>
                <div className="choice-grid two-column">
                  {languageOptions.map((option) => (
                    <button
                      key={option.value}
                      type="button"
                      className={language === option.value ? 'choice-card selected' : 'choice-card'}
                      onClick={() => setLanguage(option.value)}
                    >
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
                    <button
                      key={option.value}
                      type="button"
                      className={outputMode === option.value ? 'choice-card selected' : 'choice-card'}
                      onClick={() => setOutputMode(option.value)}
                    >
                      <strong>{option.label}</strong>
                      <span>{option.detail}</span>
                    </button>
                  ))}
                </div>
              </div>
            </div>
          ) : null}

          {activeSection === 'models' ? (
            <div className="settings-section models-library-section">
              <div className="panel-heading">
                <h2>Models Library</h2>
                <button type="button" onClick={() => void refreshStatus()}>
                  Check
                </button>
              </div>
              <div className={statusReady ? 'engine-state ready' : 'engine-state'}>
                {whisperStatus?.message ?? 'Checking...'}
              </div>
              <div className="model-list" aria-label="Whisper models">
                <button
                  type="button"
                  className={modelPath ? 'model-row' : 'model-row selected'}
                  onClick={() => setModelPath('')}
                >
                  <span className="model-icon">
                    <IconCheckCircle aria-hidden="true" />
                  </span>
                  <span className="model-main">
                    <strong>Auto select</strong>
                    <small>Use the best multilingual ggml model Murmur can find.</small>
                  </span>
                  <span className="model-meta">Default</span>
                </button>
                <div className="model-group">
                  <span>Multilingual</span>
                </div>
                {multilingualCatalog.map(renderCatalogModel)}
                {multilingualExtraModels.map(renderExtraModel)}
                <div className="model-group">
                  <span>English only</span>
                </div>
                {englishCatalog.map(renderCatalogModel)}
                {englishExtraModels.map(renderExtraModel)}
              </div>
            </div>
          ) : null}

          {activeSection === 'history' ? (
            <div className="settings-section">
              <div className="panel-heading">
                <h2>Recent transcripts</h2>
                {history.length ? (
                  <button type="button" onClick={() => setHistory([])}>
                    Clear
                  </button>
                ) : null}
              </div>
              <div className="history-list">
                {history.length === 0 ? (
                  <p className="empty">No transcripts yet.</p>
                ) : (
                  history.map((item, index) => (
                    <button key={`${item}-${index}`} type="button" onClick={() => writeText(item)}>
                      {item}
                    </button>
                  ))
                )}
              </div>
            </div>
          ) : null}

          {activeSection === 'permissions' ? (
            <div className="settings-section">
              <h2>Permissions</h2>
              <div className="permission-item">
                <strong>Microphone</strong>
                <span>Required for recording.</span>
              </div>
              <div className="permission-item">
                <strong>Accessibility</strong>
                <span>Required for auto-paste.</span>
              </div>
              <div className="permission-item">
                <strong>Global shortcut</strong>
                <span>Used by ⌥ Space.</span>
              </div>
            </div>
          ) : null}
        </div>
      </section>
    </main>
  )
}

function App() {
  const windowLabel = getCurrentWindow().label
  if (windowLabel === 'indicator') return <IndicatorWindow />
  return <MainApp />
}

export default App
