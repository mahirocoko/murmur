# Lesson Learned — Murmur landing page setup

**Date**: 2026-05-26  
**Tags**: murmur, astro, tailwind, shadcn-ui, github-pages, dependencies, exact-versions

## Lesson

For Murmur, the landing site should live as a separate `site/` workspace instead of being mixed into the Tauri/Vite desktop app. This keeps the desktop app runtime focused while still allowing a polished GitHub Pages site.

## Dependency Convention

Mahiro wants fixed package versions here. When adding or updating JavaScript dependencies for Murmur, use exact versions only:

- no `^`
- no `~`
- prefer checking latest with `pnpm view <package> version`
- write that exact version into `package.json`
- run `pnpm install` to refresh `pnpm-lock.yaml`

This applies to both root `package.json` and `site/package.json`.

## Tailwind/Astro Setup Lesson

Astro 6 + Tailwind 4 works well for the landing page, but the latest `@tailwindcss/vite` path hit a Vite 8 build issue in this repo (`Missing field tsconfigPaths`). The practical fix was to use `@tailwindcss/postcss` with `site/postcss.config.mjs` while keeping Tailwind 4. The site build passed afterward.

## shadcn-style in Astro

For this project, “use shadcn/ui” does not require bringing React shadcn components into the Astro landing page. A lightweight Astro-native approach works:

- `Button.astro` with CVA variants
- `Card.astro`
- `Badge.astro`
- `cn()` from `clsx` + `tailwind-merge`

This preserves the shadcn-style primitive API/taste without adding unnecessary client runtime.

## Design Lesson

The Murmur landing page felt good because it reused real product identity instead of generic landing-page filler:

- local-first macOS dictation
- whisper.cpp
- Thai + English workflow
- shortcut-driven flow
- app-shell mock inspired by the actual app
- privacy and build-from-source sections

Keep future site additions grounded in real app behavior. Avoid fake metrics, fake charts, inflated “AI assistant” claims, or SaaS-style filler panels.

## Future Checklist

- If GitHub repo remote is renamed to `mahirocoko/murmur`, update local `origin` before relying on Pages URL assumptions.
- After site changes, run `pnpm site:build` and parse workflow YAML.
- For broad repo changes, also run app `pnpm build` and `cargo check` so landing work does not break the desktop app.
- Keep `.astro/`, `site/dist/`, and `site/node_modules/` untracked/generated.
