# Murmur Plan

Murmur is a soft personal macOS dictation app inspired by Superwhisper. It is built for private daily use, not public distribution first.

## Goal

Build a local-first macOS menu bar dictation app:

1. Press a global shortcut to start recording.
2. Press again to stop.
3. Send audio to a local whisper.cpp worker/daemon.
4. Return text to the Tauri app.
5. Copy the result, auto-paste it, or show an editor before paste.

This project is speech-to-text / dictation, not text-to-speech.

## Product Shape

- macOS-first Tauri v2 app
- Menu bar / tray icon / status item as the primary entry point
- Global shortcut for start/stop dictation
- Floating recording/transcribing indicator
- Local history and settings
- whisper.cpp with Metal support on Apple Silicon where possible

## Architecture

```txt
Tauri v2 App
├─ Tray icon / menu bar status item
├─ Global shortcut
├─ Floating status/editor window
├─ Clipboard + optional auto-paste
├─ Settings + history
└─ Local IPC/HTTP/WebSocket client

Whisper Worker / Daemon
├─ Loads whisper.cpp model and keeps it warm
├─ Owns recording start/stop or accepts recorded files
├─ Runs transcription
├─ Reports progress/status
└─ Returns final transcript
```

## Phase 1 — Foundation

- Scaffold Tauri v2 + TypeScript UI.
- Add tray icon/menu bar behavior.
- Add basic window for settings/status.
- Add global shortcut plugin.
- Add a minimal sidecar/worker boundary.
- Confirm local `whisper-cli` / whisper.cpp availability.

## Phase 2 — First usable dictation loop

- Record audio to a temporary WAV file.
- Transcribe through whisper.cpp.
- Copy transcript to clipboard.
- Show clear error states for missing model, missing permission, timeout, or cancelled transcription.

## Phase 3 — Daily-use polish

- Auto-paste into the active app after Accessibility permission is granted.
- Add floating recording pill.
- Add history.
- Add edit-before-paste popup.
- Add launch-at-login setting.

## Phase 4 — Advanced local workflow

- Keep model warm in a daemon/sidecar for lower latency.
- Add VAD / silence detection.
- Add streaming partial transcript if practical.
- Add prompt transforms such as cleanup, translate, summarize, or rewrite tone.
- Add notch-aware UI only after the dictation loop is stable.

## macOS Permission Notes

- Microphone permission is required for recording.
- Accessibility permission is required for automatic paste into the active app.
- Global shortcut may conflict with existing macOS/app shortcuts.

## Initial Technical Bias

Start pragmatic:

- Tauri v2 app shell
- TypeScript frontend
- Rust backend commands where Tauri integration is natural
- whisper.cpp as a local binary/sidecar first
- Keep the daemon boundary simple until latency proves we need a long-running service
