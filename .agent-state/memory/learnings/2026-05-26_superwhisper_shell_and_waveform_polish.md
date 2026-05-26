# Lesson Learned — Murmur shell redesign and waveform timeline

**Date**: 2026-05-26  
**Tags**: murmur, tauri, desktop-ui, sidebar, waveform, direct-cli, uncodixify

## Lesson

When Mahiro provides a UI reference, treat it as layout anatomy and interaction intent, not a style to clone literally. In this session the Superwhisper screenshot meant: wide desktop shell, left navigation, top toolbar, useful home overview, and quick access to settings sections. The Murmur implementation should still be about local dictation, local model readiness, output behavior, history, permissions, and recording state.

## Architecture Lesson

Once a main app shell contains General, Models, History, and Permissions, a standalone settings window becomes duplicated architecture. Remove the extra window early:

- remove the Tauri window entry,
- remove the window from capabilities,
- remove React window routing/components,
- route tray/menu actions back to the main shell,
- keep event payloads if they still help section switching.

This avoids two UI paths drifting apart.

## Sidebar Collapse Checklist

For icon-only sidebar states, check every sidebar child, not just nav labels:

- traffic-light controls should not overflow;
- brand text should hide while icon stays centered;
- nav labels should hide but keep `aria-label`/`title`;
- footer/status text should hide;
- active states must still be visible around icons;
- collapsed width must fit the widest remaining visible control.

## Tauri Material Lesson

If Murmur should look equally opaque when focused and unfocused, do not use `EffectState.FollowsWindowActiveState`. Use `EffectState.Active` in runtime `setEffects` and `configure `tauri.conf.json` window effects with `"state": "active"`. Then tune CSS opacity separately. Native material state and CSS tint opacity are two independent layers.

## Waveform Lesson

Murmur's indicator should feel like a rolling recording timeline, not only an instantaneous equalizer. For this product, the better model is:

- Rust emits recent audio waveform/level from real CPAL input.
- Frontend compresses each emission into a small number of incoming bars.
- New bars append at the right edge.
- Existing bars shift left and remain visible until they leave the viewport.
- Do not decay older bars unless the intended design is fading ambience rather than speech history.
- Bar height can still be gain/compression tuned, but the time behavior should preserve earlier speech visually.

## Future Checklist

- Before merging large direct-cli UI passes, inspect for duplicated architecture, unused windows, stale commands, and reference leakage.
- Run visual QA in `pnpm tauri dev`; builds cannot prove desktop material, sidebar collapse geometry, or waveform feel.
- If a user says an animation should “flow,” clarify whether they mean current-state motion or time-history motion.
