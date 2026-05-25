# Lesson Learned — Murmur UI Polish: Tauri Window Reality Before CSS Taste

**Date**: 2026-05-25  
**Tags**: murmur, tauri, macos, ui-polish, transparency, settings-window, direct-cli

## Lesson

When polishing Murmur’s desktop UI, check Tauri/native window behavior before relying on CSS intuition. Window dimensions and visual materials can be set in multiple places: `tauri.conf.json`, Rust helpers such as `show_main_window` / `show_settings_window`, and frontend `getCurrentWindow().setEffects(...)`. A visual bug may persist because one runtime path overrides a config change.

For macOS transparency/blur, the correct mental model is native material first, CSS tint second:

1. `transparent: true` and `backgroundColor: #00000000` in Tauri config.
2. Document/body/root backgrounds must remain transparent.
3. Apply native effects (`HudWindow`, `WindowBackground`, etc.) through Tauri config and runtime `setEffects`.
4. Keep app shells and panels as low-opacity tint layers. Avoid stacking opaque backgrounds over the native material.
5. Do not treat CSS `backdrop-filter` as proof of desktop blur; it only works against web content behind the element, not necessarily the macOS desktop/window material.

## Product Taste Lesson

Murmur’s main window should behave like a compact dictation appliance, not a dashboard. Keep the main surface to: status, record/stop action, error if needed, latest transcript. Move mode selection, model management, history, and permissions to Settings. If a UI element is only explaining the app or proving connectivity, remove it unless it helps recovery from a real state.

## Process Lesson

Use direct-cli reviewers after a first implementation pass for UI polish. Gemini helped diagnose the technical mismatch around Tauri width/transparency. Cursor Opus helped identify smaller UX seams: debug notices, one-item nav abstractions, and missing accessibility attributes for collapsed icon-only navigation.

## Future Checklist

- Search all `set_size`, `setEffects`, `windowEffects`, and config window dimensions before reporting Tauri visual changes.
- Restart `pnpm tauri dev` after Tauri config/Rust window changes; hot reload is not enough.
- For collapsed sidebar UI, include `aria-expanded`, `aria-current`, and icon-only labels/tooltips.
- Before adding UI, ask whether it belongs on the compact main surface or the dedicated settings window.
