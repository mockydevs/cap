# Download hub imagery

The white hub uses Calari's navy `#0B192C` and magenta `#9D3292` / `#C2185B`, taken from its website stylesheet. The wordmark preserves the paths from the Calari website `apps/web/public/logo.svg`; its white fill is changed to navy. It is embedded through one explicit Rust route, with no directory serving.

## Editorial photograph

Mode: built-in ImageGen, new generation, no reference image. The person and laptop interface are illustrative, not an actual employee portrait or product screenshot. The caption and alternative text identify the illustration. Only proportional Lanczos resizing and WebP compression (quality 84, method 6) were applied after generation.

Assets:

- `apps/site/assets/cap-recording-editorial-v1-1200.webp`: 1200 × 800, 67,350 bytes; SHA-256 `12257a25a5d446bd31ce9060b367c3e7b8c7f3c67c1c76bd96b91173ccdfa5b1`.
- `apps/site/assets/cap-recording-editorial-v1-640.webp`: 640 × 427, 29,742 bytes; SHA-256 `dfcea357687e8eb593b6ccfd4ef13a1290e0125b64d1d5a819ceab37c8c0d98c`.

Both are compiled into the Rust binary and served only on their exact named routes. Responsive source selection avoids downloading the larger photograph on mobile. Future replacements should use new versioned names.

Final generation prompt:

> Use case: photorealistic-natural. Create one premium editorial photograph for a Calari meeting-recorder website hero, landscape 3:2 composition. A natural candid three-quarter side view of a Black female professional in her early thirties, wearing a simple navy cotton shirt, listening attentively through a discreet headset while using a laptop at a real light oak desk. Include her face in profile and the laptop screen clearly in the same composition: the screen shows a restrained, generic unbranded meeting-recording view with a short flat magenta audio waveform and a white transcript column with subdued lines of text, not a huge dashboard. The computer interaction and visible transcript should communicate recording and note-taking at a glance. Warm off-white daylight office, soft window light, realistic skin texture, ordinary slight fabric creases, small human imperfections, understated deep navy and magenta accents. Beautiful photographic composition with believable proportions and one naturally placed hand on the laptop trackpad, other hand out of frame. Crisp subject and laptop, quiet softly defocused background. This is an illustrative human-use scene, not a real staff portrait or an actual product screenshot. No logos, partner brands, watermarks, legible invented names, slogans or floating interface panels. No neon, luminous dots, colored glows, holograms, lens flares, sci-fi visuals, plastic skin, corporate posed handshake or overly polished AI-stock aesthetic. Do not add text outside the laptop. Natural premium magazine photography, credible and calm.
