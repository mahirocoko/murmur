# Learning — Murmur shortcut capture and permissions need native truth

Tags: murmur, tauri, macos, shortcut, permissions, ux

When adding customizable global shortcuts to Murmur, do not rely on React key events alone while the old shortcut remains registered globally. The OS/global-shortcut plugin can intercept the active combo before the WebView sees it, making the shortcut recorder look stuck at “Press shortcut…”. The correct pattern is:

1. Enter shortcut capture mode.
2. Temporarily unregister the currently active dictation shortcut.
3. Capture a new combo at the window level (`keydown`/`keyup`) and require at least one modifier.
4. If the user cancels, restore the previous shortcut.
5. If the user completes capture, register the new shortcut natively and persist it.

Also, macOS Accessibility permission can be checked for real through `AXIsProcessTrusted()`. Avoid static/fake permission switches when native truth exists. Use switch-style rows only as setup affordances and be honest that macOS requires user approval in System Settings.

UI taste note: selected states in Murmur should be clear but not heavy. A subtle selected background plus check icon worked better than a thick accent border/rail, which made compact translucent cards feel too loud.
