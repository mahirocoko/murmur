# Lesson: Continuous waveform loading needs a continuous envelope and stable animation signature

**Date**: 2026-05-28
**Project**: Murmur (`mahiro-whisper`)
**Tags**: ui-motion, waveform, css-animation, continuity, indicator

When a loading wave should look like one connected waveform, do not repeat a small peak pattern across the row. A repeated pattern creates visible clusters. Instead, compute each bar's peak from a continuous function over normalized position, such as a bell/Gaussian-like envelope with optional small shoulder.

For state continuity such as `transcribing → pasting → done`, keep the animation signature stable:

- same keyframe name,
- same duration,
- same delay strategy,
- same bar count and DOM shape,
- same transform/keyframe structure.

Changing animation duration or other animation-defining values by state can restart the browser's CSS animation and create a visible jump. Prefer changing only copy, shell color, or non-animation visual tokens if the motion should continue.

Good tuning levers:

- envelope center and width,
- envelope exponent for sharper or softer taper,
- shoulder intensity,
- idle scale,
- bar width,
- constant duration.

Always distinguish build verification from visual runtime confirmation.
