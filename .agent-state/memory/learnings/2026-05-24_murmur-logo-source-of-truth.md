# Murmur Logo Source of Truth

**Date**: 2026-05-24
**Tags**: mahiro-whisper, murmur, branding, tauri-icons, assets

## Lesson

For Murmur branding, Mahiro-provided image assets override my generated placeholder assets immediately. The current preferred source is `murmur-logo-cute-borderless-trimmed.png` for favicon/UI usage and the square 1024px trimmed variant for Tauri icon generation.

## Practical checklist

- Use `/murmur-logo-cute-borderless-trimmed.png` for UI and favicon unless Mahiro changes the asset again.
- Use `public/murmur-logo-cute-borderless-trimmed-square-1024.png` as the source for `pnpm tauri icon ...`.
- Keep `object-fit: contain` where the logo is placed into fixed square UI slots.
- After `pnpm tauri icon`, remove generated `src-tauri/icons/android/`, `src-tauri/icons/ios/`, and `src-tauri/icons/64x64.png` if they are not part of the repo's tracked icon set.
- Do not reintroduce the earlier generated SVG/warm-wave placeholder unless Mahiro explicitly asks for it.

## Why it matters

Logo padding and trim affect whether the brand feels cute and intentional in the titlebar, favicon, tray/app icon, and bundle icon. A technically valid image can still be the wrong source if it carries extra transparent padding or an older creative direction.
