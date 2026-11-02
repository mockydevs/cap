# Cap app identity

Canonical vector: `cap-mark.svg`. Navy speech bubble tile, white field and magenta audio bar. Hand-authored SVG; no external artwork or fonts.

Generate native assets from repository root with `corepack pnpm --filter @cap/desktop exec tauri icon ../../assets/branding/cap-mark.svg --output src-tauri/icons`. Desktop uses the same SVG from its public directory. Tauri generates Windows ICO, macOS ICNS and desktop PNGs. Only the desktop icons referenced in tauri.conf.json are packaged.

Extension icons use the same artwork, resized to 16, 32, 48 and 128 pixels. Keep transparent outer corners and the existing extension manifest key. Icon assets do not change an already installed app until its package is updated.
