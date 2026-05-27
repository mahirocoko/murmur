# Lesson Learned — Murmur microphone selection

**Date**: 2026-05-27
**Tags**: murmur, audio, cpal, tray, tauri, ui

## Lesson

Murmur microphone selection should keep two separate intents:

1. `Use system default` — follow whatever macOS currently considers the default input.
2. A named input device — pin recording to that CPAL device name when available.

The tray and main window must stay synchronized. When the user selects a mic from the tray, emit `preferences-updated` / `input-devices-updated` so React updates. When the user selects from React, `set_native_preferences` should refresh tray menu state and input-device events.

For the UI, keep the picker quiet and functional. A small toolbar dropdown and tray submenu with checkmarks is enough. Icons can be heuristic by device name (`AirPods/headphones`, `iPhone`, `MacBook/laptop`, generic mic), but should not become a fragile hardware taxonomy.

## Risks to remember

- CPAL names are alpha-good but not perfect stable IDs.
- Duplicate device names or renamed Continuity devices can confuse name-based selection.
- `cargo check` proves compile only; manual QA must confirm the selected mic is actually used during recording.
