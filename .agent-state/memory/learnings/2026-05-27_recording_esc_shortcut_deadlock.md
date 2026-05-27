# Lesson Learned — Tauri global Esc must not block shortcut handlers

**Date**: 2026-05-27
**Tags**: murmur, tauri, global-shortcut, recording, indicator, deadlock

## Lesson

In Murmur, `Option + Space` is handled by the Tauri global shortcut plugin. Do not synchronously call `global_shortcut().on_shortcut(...)` or `global_shortcut().unregister(...)` from a flow invoked by that handler. The plugin schedules work on the main thread; if the handler is still running and waiting for another main-thread operation, recording can appear to hang.

The safe pattern for recording-only `Esc` is:

1. Start native recording and store recording state.
2. Spawn/defer `Esc` registration outside the current shortcut callback.
3. Before registering, check that recording is still active.
4. After registering, check again; if recording already stopped/canceled, unregister immediately.
5. Unregister `Esc` on cancel, stop, and final cleanup without blocking the shortcut handler path.

## Review Checklist

- Does `Option + Space` return quickly after toggling recording?
- Does `Esc` register only while recording is active?
- Does cancel remove the temporary WAV and hide the indicator?
- Does stop unregister `Esc` before transcribing?
- After cancel/stop, does `Esc` work normally in other apps?
- Was the flow manually tested in `pnpm tauri dev`, not only compiled?
