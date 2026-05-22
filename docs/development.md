# Development Notes

## Requirements

- macOS
- Node.js + pnpm
- Rust + Cargo
- Tauri v2 prerequisites
- `ffmpeg`
- whisper.cpp CLI available as `whisper-cli`
- a whisper model file

The current machine has:

- `whisper-cli`: `/opt/homebrew/bin/whisper-cli`
- `ffmpeg`: `/opt/homebrew/bin/ffmpeg`
- model candidate: `~/.whisper/ggml-base.en.bin` and Superwhisper models

If the GUI environment cannot find paths, set:

```sh
export MAHIRO_WHISPER_CLI=/opt/homebrew/bin/whisper-cli
export MAHIRO_FFMPEG=/opt/homebrew/bin/ffmpeg
export MAHIRO_WHISPER_MODEL=$HOME/.whisper/ggml-base.en.bin
```

## Commands

```sh
pnpm install
pnpm build
cd src-tauri && cargo check
pnpm tauri dev
pnpm tauri build --debug
```

## Current MVP Flow

1. Open the app from the window or menu bar icon.
2. Press `Option + Space` or click `เริ่มอัดเสียง`.
3. Allow microphone access when macOS asks.
4. Press `Option + Space` again or click `หยุดอัดแล้วถอดเสียง`.
5. The app saves the browser-recorded audio into app data, converts it to 16 kHz mono WAV with ffmpeg, runs whisper.cpp, then copies the transcript to clipboard.
6. If output mode is `copy + auto paste`, the app sends `Cmd+V` through AppleScript. macOS may require Accessibility permission for this.

## Current Native Foundation

- Tray/menu bar icon exists through Tauri's tray API.
- Tray left-click opens/focuses the main window.
- Closing the main window hides it to the tray instead of quitting. Use tray Quit for real exit.
- Tray menu includes open, whisper status, and quit.
- `Option + Space` is registered through Tauri global shortcut.
- Tray menu can toggle recording, open Settings, open History, check whisper.cpp status, open the control center, or quit.
- `get_whisper_status` probes `whisper-cli`, `ffmpeg`, and model candidates.
- `transcribe_audio` accepts audio bytes, converts to WAV, runs whisper.cpp, and returns transcript text.
- `paste_clipboard` uses AppleScript to trigger `Cmd+V` after clipboard copy when auto-paste mode is enabled.
- Language, model path override, and output mode are persisted in localStorage.
- App data directories for `recordings` and `models` are created on startup.
- `src-tauri/Info.plist` includes the microphone usage description for macOS.

## Verified Locally

```sh
pnpm build
cd src-tauri && cargo check
pnpm tauri build --debug
```

Manual pipeline smoke test also passed with `say` → `ffmpeg` → `whisper-cli` using `~/.whisper/ggml-base.en.bin`.


## Shortcut behavior

`Option + Space` is intentionally seamless: it toggles native Rust/CoreAudio recording directly without opening the main control window, so the previously focused app keeps focus. While recording/transcribing, a small always-on-top non-focusable indicator window appears near the top center with an equalizer-style wave. When transcription finishes, the app copies the transcript and auto-pastes by default.

If auto-paste does nothing, grant Accessibility permission to Mahiro Whisper in macOS System Settings.


## Background recording implementation

The recording loop no longer depends on the main React webview being visible. Global shortcut and tray Toggle Recording now call `toggle_native_recording` in Rust, which records from the default input device with CPAL into a WAV file, runs whisper.cpp, copies via native Unicode clipboard (`arboard`), and auto-pastes with CoreGraphics `Cmd+V` key events. The React app is now primarily control/settings/history UI.


## Tray behavior

Left-clicking the menu bar icon opens the native tray dropdown. It does not open the main app window. Use `Open Control Center` or `Settings...` from the menu when you want the control window.


## Language behavior

Native background transcription now reads language/model/output preferences from the control window. The default spoken language is Thai + English mixed (`mixed-th-en`) instead of plain whisper auto-detect because short Thai dictation clips were frequently misdetected as English. If the selected language is not English, model selection also avoids `.en.bin` models unless the user explicitly overrides the model path.


## Clipboard encoding

Thai clipboard output uses native Unicode clipboard writing through `arboard`, not `pbcopy`, because app-launched `pbcopy` can inherit a non-UTF-8 locale and produce mojibake like `‡πÇ...`.


## Model list

The Control Center now lists discovered `ggml*.bin` models from Superwhisper, `~/.whisper`, and the local `whisper.cpp/models` directory. Non-English modes prefer multilingual models and avoid `.en.bin` unless the user explicitly selects one.

Current observed models on this machine:
- `/Users/mahiro/Library/Application Support/superwhisper/ggml-small.bin`
- `/Users/mahiro/Library/Application Support/superwhisper/ggml-medium.en.bin`
- `/Users/mahiro/.whisper/ggml-base.en.bin`
- `/Users/mahiro/ghq/github.com/ggml-org/whisper.cpp/models/ggml-base.bin`
- `/Users/mahiro/ghq/github.com/ggml-org/whisper.cpp/models/ggml-small.bin`


## Stop responsiveness

Stopping recording immediately switches the indicator to `Transcribing` before WAV finalization and transcription run. Paste uses session-level CoreGraphics Cmd+V events after a short clipboard-set delay. If paste still fails, reset Accessibility permission for `/Applications/Mahiro Whisper.app`.


## Indicator states

The floating pill listens to both `dictation-state` and `indicator-state`. Stop now switches to `Transcribing` immediately, then `Pasting`, then a short `Done`/`Needs attention` state before hiding. Recording uses equalizer bars; non-recording work uses a spinner so it does not look stuck on listening.
