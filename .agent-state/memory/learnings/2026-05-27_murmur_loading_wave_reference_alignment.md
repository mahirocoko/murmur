# Lesson: Tune UI motion from live/reference evidence, not only math

**Date**: 2026-05-27
**Project**: Murmur (`mahiro-whisper`)
**Tags**: ui-motion, reference-video, direct-cli, indicator, rAF, transform-animation

When Mahiro asks for a loading/indicator animation to match a video, treat the video and Mahiro's perception as source of truth. Do not overclaim that a result matches the reference unless I have inspected the reference carefully and ideally compared against the running UI.

Practical lessons:

- Static frame extraction is useful but incomplete for motion; label it as an approximation.
- Use direct-cli agents as evidence gatherers and alternate implementers, not final taste authorities.
- Smoothness should be evaluated visually. `requestAnimationFrame` and direct DOM writes can be technically smooth but visually strange if they mutate layout properties like `height` across many elements.
- Prefer transform-based motion (`scaleY`, opacity, composited transforms) over per-frame layout-height writes when tuning many bars.
- Preserve the user's latest qualitative judgment as current reality. In this session, the final state is “about 60% better,” not “done perfectly.”
- For future continuation, tune the smallest visible levers: bar count, bar width, max visual height, time scale, carrier frequency, and envelope width.

Good future recovery phrase:

> Current state is closer, but not fully matched. I’ll tune one visual variable at a time and verify against the video/live UI before claiming it is done.
