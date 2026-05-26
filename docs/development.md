# Development Notes

## Current shape

Murmur is now a single-window macOS dictation app plus a small floating indicator.

- `main` window: wide sidebar app shell with Home, General, Models, History, and Permissions sections.
- `indicator` window: always-on-top, non-focusable recording/transcribing pill with rolling waveform.
- There is no separate Settings window anymore. Tray Settings/History actions open the main shell and switch section.
- Landing page lives in `site/` and deploys to GitHub Pages through `.github/workflows/pages.yaml`.

## Requirements

- macOS
- Node.js + pnpm
- Rust + Cargo
- Tauri v2 prerequisites
- `whisper-cli` from whisper.cpp
- a `ggml*.bin` Whisper model, preferably managed through the Models section in the app

The current machine has `whisper-cli` at `/opt/homebrew/bin/whisper-cli`. If the GUI environment cannot find it, set:

```sh
export MAHIRO_WHISPER_CLI=/opt/homebrew/bin/whisper-cli
```

The native recording flow writes WAV directly through CPAL + hound, so `ffmpeg` is no longer required for the active dictation path.

## Commands

```sh
pnpm install
pnpm build
pnpm site:build
cd src-tauri && cargo check
pnpm tauri dev
pnpm tauri build --debug
```

`pnpm site:build` runs `astro check && astro build` inside `site/`.

## Current dictation flow

1. Open Murmur or leave it in the tray.
2. Press `Option + Space` from any app, or click the record button in the main shell.
3. Rust starts native CPAL recording from the default input device and writes a WAV file with hound.
4. The non-focusable indicator appears and shows a rolling waveform from real microphone input.
5. Press `Option + Space` again to stop.
6. Rust runs `whisper-cli` against the WAV file and reads the generated transcript.
7. The transcript is written to the native Unicode clipboard through `arboard`.
8. If output mode is `paste`, Murmur sends a CoreGraphics `Cmd+V` event back to the active app.
9. The transcript is stored in local history and shown in the main shell.

## Shortcut behavior

`Option + Space` is the only global shortcut. It toggles native recording directly without opening/focusing the main window, so the previously focused app keeps focus.

Murmur intentionally does **not** register global `Esc`. A previous global Esc shortcut intercepted Esc in other apps even when Murmur was not focused. The current frontend still listens for Escape while the main window is focused, but it should not consume Esc globally.

## Tray behavior

Left-clicking the menu bar icon opens the native tray menu. Right-clicking the tray icon shows the main window.

Tray actions:

- `Toggle Recording` — calls the native recording toggle.
- `Open History` — opens the main shell and switches to History.
- `Open General` — opens the main shell and switches to General.
- `Check whisper.cpp` — opens the main shell, switches Home/status context, and refreshes status.
- `Open Main Window` — opens/focuses the main shell.
- `Quit` — exits the app.

## Main shell sections

- **Home** — engine/model/output/shortcut status, onboarding checklist, latest transcript.
- **General** — language and output mode.
- **Models** — model catalog, download, select, uninstall.
- **History** — local transcript history and copy actions.
- **Permissions** — microphone, accessibility, and shortcut reminders.

The sidebar supports icon-only collapse. When editing it, test traffic controls, brand, nav labels, active state, and footer status in both expanded and collapsed modes.

## Language behavior

Native background transcription reads language/model/output preferences from the main shell. The default spoken language is Thai + English mixed (`mixed-th-en`) because short Thai dictation clips can be misdetected as English. If the selected language is not English, model selection avoids `.en.bin` models unless the user explicitly selects/overrides one.

## Clipboard encoding

Thai clipboard output uses native Unicode clipboard writing through `arboard`, not `pbcopy`, because app-launched `pbcopy` can inherit a non-UTF-8 locale and produce mojibake like `‡πÇ...`.

Auto-paste uses CoreGraphics `Cmd+V` events, not AppleScript/System Events. If paste does nothing, grant Accessibility permission to Murmur in macOS System Settings.

## Model library

Murmur manages downloaded `ggml*.bin` models in the app data `models` directory. The status check is ready when it finds both `whisper-cli` and at least one app-managed model.

Non-English modes prefer multilingual models and avoid `.en.bin` unless explicitly selected.

## Indicator behavior

The floating indicator listens to `dictation-state`, `indicator-state`, `audio-level`, and `audio-waveform` events.

- Recording uses a rolling waveform timeline. New bars append from the right; older bars slide left and remain visible until they leave the viewport.
- Stop switches to `Transcribing` immediately before whisper.cpp runs.
- Then it switches to `Pasting`, then briefly `Done` or `Needs attention`, before hiding.
- Non-recording states use a spinner so the indicator does not look stuck on listening.

## Landing site

The landing page is a separate Astro workspace under `site/`.

- Astro 6
- Tailwind CSS 4 through PostCSS (`@tailwindcss/postcss`)
- shadcn-style Astro primitives in `site/src/components/ui/`
- GitHub Pages workflow in `.github/workflows/pages.yaml`

The project uses exact package versions, no `^`/`~` ranges.

## Verified locally

Current verification set after app + site work:

```sh
pnpm build
pnpm site:build
cd src-tauri && cargo check
ruby -e "require 'yaml'; YAML.load_file('.github/workflows/pages.yaml')"
```

For release confidence or window/capability changes, also run:

```sh
pnpm tauri build --debug
```

Manual QA is still essential for:

- native window material and opacity,
- sidebar collapse layout,
- global shortcut behavior,
- Accessibility permission and auto-paste,
- real waveform feel while speaking.
