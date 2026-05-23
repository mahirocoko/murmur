# Lesson Learned — Indicator window HUD tuning

**Date**: 2026-05-22
**Tags**: tauri, ui-polish, macos-hud, audio-reactive, direct-cli

When Mahiro provides a visual reference for a floating UI, treat the screenshot as the product contract, not as a loose style hint. In this session, the correct direction was not to keep polishing the old small `Listening` pill; it was to rebuild the indicator into the wide rounded black HUD shown in the reference.

Durable rules:

- For Tauri floating windows, remove unwanted white/background chrome at the native window level (`transparent: true`) as well as in CSS (`html/body/#root` transparent and `overflow: hidden`).
- Match reference composition first: window size, rounded frame, dark panel, waveform prominence, footer controls. Only then tune fonts, spacing, and colors.
- If the user asks for an equalizer that responds to speech, use live microphone amplitude/RMS data from the recording path. CSS-only animation is not acceptable as the primary signal.
- Direct Gemini/Cursor review output must be treated as advisory. If the visual target and the agent output differ, correct the implementation before reporting success.
- Verification for UI polish includes real visual inspection in `pnpm tauri dev` or a rebuilt app, not only `pnpm build` and `cargo check`.

Concrete reminder for Mahiro Whisper: indicator changes touched `src/App.tsx`, `src/App.css`, `src-tauri/src/lib.rs`, and `src-tauri/tauri.conf.json`. Because window config changed, the app must be restarted/rebuilt to see the final transparent HUD.
