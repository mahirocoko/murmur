# Lesson Learned — Indicator windows need explicit capabilities for real-time Tauri events

**Date**: 2026-05-24  
**Tags**: mahiro-whisper, tauri, capabilities, audio-visualization, cpal, verification

## Context
Mahiro wanted the Mahiro Whisper indicator/equalizer to react to real voice input instead of looking like a generic loading animation. Research via WebClaw direct scrapes of MDN Web Audio visualization docs and `react-voice-visualizer` confirmed the expected pattern: visualizers are driven by arrays of time-domain/frequency/audio data, not one scalar loudness value plus synthetic motion.

## Durable Lesson
For Mahiro Whisper, real recording visualization should come from the native CPAL recording stream, not from a second frontend microphone stream. Emit a compact array such as `audio-waveform: number[]` from Rust, then smooth/render it in the indicator UI.

When adding event listeners to the `indicator` window, also check `src-tauri/capabilities/default.json`. The capability scope must include `"indicator"`; otherwise frontend APIs like `listen()` may be unavailable or ineffective in that webview even though the `main` window works.

## Checklist for Future Indicator Work
- Confirm which Tauri window renders the UI (`main` vs `indicator`).
- Confirm the window is included in relevant capability scopes.
- For audio visualization, prefer per-bucket RMS/peak data from CPAL over fake sine/cosine animation.
- Verify both compile-time checks and runtime behavior. If I cannot manually click/speak into the app, report that limitation clearly.
- After dependency updates, rerun `cargo fmt --check`, `cargo check`, `pnpm build`, and for desktop-risk changes `pnpm tauri build --debug`.

## Evidence
- `src-tauri/src/lib.rs` now emits `audio-waveform` from native microphone samples.
- `src/App.tsx` listens for `audio-waveform` in `IndicatorWindow`.
- `src-tauri/capabilities/default.json` now scopes permissions to both `main` and `indicator`.
