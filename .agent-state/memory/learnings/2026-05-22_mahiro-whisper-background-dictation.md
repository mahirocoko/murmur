# Lesson: Background dictation apps need native ownership

**Date**: 2026-05-22
**Tags**: mahiro-whisper, tauri, macos, dictation, tray-app, whisper.cpp, accessibility, thai

## Lesson

For a macOS dictation/menu-bar app, React/Tauri webviews are not the right owner for recording, paste, or state-critical background behavior. The main window can disappear, be hidden, or lose event reliability, but the user still expects the global shortcut to work. The durable architecture is:

```txt
Global shortcut / tray menu (native)
→ native recording state machine
→ WAV/model/transcription pipeline
→ Unicode clipboard
→ native paste event
→ UI receives status/history as observer
```

## Specific gotchas from Mahiro Whisper

- Hidden main window broke `MediaRecorder`; move recording to Rust/CoreAudio (`cpal`).
- `pbcopy` can produce Thai mojibake when launched from an app process with bad locale; use native Unicode clipboard (`arboard`).
- AppleScript paste is less reliable for background dictation; CoreGraphics events are better but still require Accessibility permission.
- Whisper `.en.bin` models are wrong for Thai; use multilingual `.bin` models for Thai+English.
- `auto` language detection is not enough for short Thai clips; add a Thai+English mixed mode with prompt bias.
- Indicator windows may miss the first event; emit state after show and replay/delay important states.

## Future checklist

Before claiming a dictation workflow works, test with the main window closed:

1. Shortcut starts recording without opening/focusing the main window.
2. Indicator shows Listening.
3. Shortcut stops recording and immediately shows Transcribing.
4. It shows Pasting/Done or Error.
5. Text is Unicode-correct in Thai.
6. Text is pasted into the original focused app.
7. If paste fails, the UI points to Accessibility permission clearly.
