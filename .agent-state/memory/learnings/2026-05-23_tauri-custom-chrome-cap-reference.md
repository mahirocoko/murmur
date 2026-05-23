# Lesson Learned — Tauri custom chrome should start from Cap

**Date**: 2026-05-23  
**Tags**: mahiro-whisper, tauri, cap-reference, custom-chrome, drag-region, macos-window

## Lesson
When working on Mahiro Whisper desktop chrome, control-center UI, traffic-light buttons, transparent/rounded windows, or drag behavior, study Cap first. Cap’s desktop app provides the nearest proven local pattern for this product style.

## Concrete findings
- Cap’s main toolbar is custom HTML/Solid, not native.
- Dragging is driven by `data-tauri-drag-region` on header/spacer/action containers.
- Tauri v2 requires capability permission such as `core:window:allow-start-dragging`; without it, drag-region markup can be correct while dragging silently fails.
- Cap pairs transparent undecorated windows with macOS material/effects and rounded inner shells.
- Custom macOS traffic-light buttons should stop event propagation, opt out of drag behavior, and show hover icons like the close X.
- For Mahiro Whisper, a backend `hide_main_window` command is a reliable way to hide the control center from a custom red button.

## Future checklist
1. Check Cap reference files before editing:
   - `/Users/mahiro/ghq/github.com/CapSoftware/Cap/apps/desktop/src/routes/(window-chrome).tsx`
   - `/Users/mahiro/ghq/github.com/CapSoftware/Cap/apps/desktop/src/components/titlebar/controls/CaptionControlsMacOS.tsx`
   - `/Users/mahiro/ghq/github.com/CapSoftware/Cap/apps/desktop/src/routes/(window-chrome)/new-main/index.tsx`
   - `/Users/mahiro/ghq/github.com/CapSoftware/Cap/apps/desktop/src-tauri/src/windows.rs`
2. Check Tauri capabilities before debugging DOM/CSS forever.
3. Treat manual interaction behavior as required verification; build success is not enough for custom chrome.
4. Avoid dynamic global shortcut registration during recording unless the lifecycle is proven safe.
