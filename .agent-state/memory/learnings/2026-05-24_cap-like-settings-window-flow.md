# Lesson Learned — Cap-like desktop UX needs window lifecycle pairs

**Date**: 2026-05-24  
**Tags**: mahiro-whisper, tauri, cap-reference, settings-window, desktop-ux, window-lifecycle

## Context
Mahiro wanted Mahiro Whisper's settings behavior to match Cap more closely. A separate settings window was not enough; the settings surface needed a Cap-like sidebar and the main window needed to remain a focused compact capture surface.

## Durable Lesson
When using Cap as the reference, copy the product hierarchy, not just isolated visuals. For Mahiro Whisper:
- Main window = compact dictation/capture surface.
- Settings window = larger sidebar-driven configuration/history surface.
- History belongs in the settings/sidebar surface unless it becomes a first-class capture-time workflow.
- Mode selection can live inside main as internal tabs/cards, similar to Cap's capture choices.

Window lifecycle must be paired:
- Opening settings hides main.
- Opening indicator hides main.
- Closing settings restores main.
- Tray actions should route to the right window rather than overloading the main view.

## Future Checklist
- Before adding a window, define: owner window, open path, close path, restore behavior, tray/menu routing, and capabilities.
- After moving a view between windows, remove old state machine branches and run TypeScript to catch stale state.
- For custom desktop chrome, verify behavior manually in `pnpm tauri dev`; builds do not prove window lifecycle UX.
- Keep scrollbars, titlebar height, and sidebar density aligned with the desktop reference app, not generic web defaults.

## Evidence
- `src-tauri/tauri.conf.json` defines a dedicated `settings` window.
- `src-tauri/src/lib.rs` owns show/hide/restore behavior for main/settings/indicator flows.
- `src/App.tsx` renders separate `SettingsWindow` and `MainApp` based on Tauri window label.
