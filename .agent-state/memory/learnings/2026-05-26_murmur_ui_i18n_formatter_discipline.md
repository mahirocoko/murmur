# Lesson Learned — Murmur UI/i18n/formatter discipline

**Date**: 2026-05-26
**Tags**: murmur, tauri, landing, thai-copy, biome, ui-motion, process

## Lesson

When adding Thai landing-page copy for Murmur, load `kien-thai` before writing or reviewing the prose. Hero copy, feature descriptions, privacy paragraphs, install text, and footer copy are non-trivial Thai prose, not just UI labels. If I forget and Mahiro asks whether the skill was used, acknowledge the miss plainly and run the review immediately.

For visual indicator work, build/lint checks are necessary but not sufficient. Motion quality is product feel: a loading wave that compiles can still feel flat. A better Murmur loading wave uses full-width bars plus per-bar phase variation (`delay`, `duration`, `peak`, `rise/fall`) rather than a single uniform spinner-like pulse.

Introducing Biome to a previously unformatted repo is intentionally noisy. Before or after running write-mode commands, clearly state that `pnpm lint` and `pnpm format` can reformat multiple files beyond the feature lines, then inspect/report the diff honestly.

## Future Checklist

- Thai landing/README/prose: invoke `kien-thai` first.
- UI motion: verify with build/lint, then ask for or run manual visual QA when practical.
- Formatter setup: install exact versions, add scripts/config, run formatter, report write-mode effects.
- React section comments: use them as scan anchors only in complex components; keep order meaningful.
