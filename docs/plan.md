# Murmur Plan

Murmur is a soft personal macOS dictation app inspired by Superwhisper's desktop workflow. It is built for private daily use first, then made readable enough for open-source exploration.

## Goal

Build a local-first macOS dictation app:

1. Press `Option + Space` to start recording from any app.
2. Press `Option + Space` again to stop.
3. Record audio locally with CoreAudio/CPAL and write WAV with hound.
4. Run `whisper-cli` from whisper.cpp locally.
5. Copy the result, auto-paste it, or review it in local history.

This project is speech-to-text / dictation, not text-to-speech.

## Current product shape

- macOS-first Tauri v2 app.
- One main app shell with sidebar sections: Home, General, Models, History, Permissions.
- Menu bar / tray icon for background use.
- Global shortcut for start/stop dictation.
- Floating non-focusable recording/transcribing indicator.
- Local model library and transcript history.
- Astro landing page in `site/` deployed through GitHub Pages.

## Current architecture

```txt
Tauri v2 App
├─ main window: app shell / settings / history / model library
├─ indicator window: non-focusable recording pill + rolling waveform
├─ tray menu / menu bar status item
├─ global shortcut: Option + Space only
├─ Rust native recording through CPAL
├─ WAV writing through hound
├─ whisper.cpp command execution
├─ native Unicode clipboard through arboard
└─ CoreGraphics auto-paste
```

There is no standalone Settings window anymore. Settings are integrated into the main shell.

## Phase 1 — Foundation

Done:

- Scaffold Tauri v2 + TypeScript UI.
- Add tray icon/menu bar behavior.
- Add global shortcut plugin.
- Confirm local `whisper-cli` / whisper.cpp availability.
- Add native CPAL recording path.

## Phase 2 — First usable dictation loop

Done:

- Record audio to local WAV.
- Transcribe through whisper.cpp.
- Copy transcript to clipboard.
- Auto-paste via CoreGraphics after Accessibility permission.
- Show clear error states for missing model, missing permission, timeout, or cancelled transcription.

## Phase 3 — Daily-use polish

In progress / partially done:

- Main shell with Home/General/Models/History/Permissions.
- Model library download/select/uninstall.
- Floating recording indicator with rolling waveform.
- Sidebar collapse.
- Landing page.

Possible next polish:

- Launch-at-login setting.
- Edit-before-paste flow.
- Better permission diagnostics.
- More refined model download progress and failure recovery.
- Real screenshot/GIF for README and landing page.

## Phase 4 — Advanced local workflow

Future ideas:

- Keep model warm in a daemon/sidecar for lower latency if startup cost becomes painful.
- Add VAD / silence detection.
- Add streaming partial transcript if practical.
- Add prompt transforms such as cleanup, translate, summarize, or rewrite tone.
- Add notch-aware UI only after the dictation loop is stable.

## macOS permission notes

- Microphone permission is required for recording.
- Accessibility permission is required for automatic paste into the active app.
- Global shortcut may conflict with existing macOS/app shortcuts.
- Murmur should not register global Esc; it must not steal Esc from other apps.

## Technical bias

Keep the app pragmatic:

- Tauri v2 app shell.
- TypeScript frontend.
- Rust backend commands where Tauri integration is natural.
- whisper.cpp as a local binary first.
- Exact package versions in `package.json` files.
- Separate landing page in `site/`, not mixed into the desktop app UI.
