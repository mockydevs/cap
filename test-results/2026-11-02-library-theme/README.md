# Private library: Calari white/navy/magenta theme

Change: `crates/cap-server/src/web/app.css` only. No template, route, auth, role,
tenant, media, cookie or CSP change.

- Always light (`color-scheme: light`; the dark-mode block is removed), so the
  library no longer turns dark/red on computers set to dark mode.
- Calari palette (from the Calari portal tokens): text #101828, navy #1f3a5f for
  headings/brand/links/titles, magenta #c90061 (hover #a80051) for the dot,
  active nav, button, live badge and current transcript line.
- Contrast on white: text 17.8, navy 11.5, muted 5.0 (4.65 on page bg),
  white-on-magenta 5.7, status badges 5.7-7.5.
- Focus: one magenta indicator. Fields, meeting rows and time-stamp buttons
  change their own border; other links/buttons get a single outline.
  Forced colours: CanvasText outline.
- Phone layout: long previews no longer push the page wider than the screen
  (minmax(0, 1fr) columns; page width 500 = viewport, was 732).

Evidence: EXIT-CODES.txt (prettier, cap-server clippy, cap-server tests incl.
7 library security tests). preview/: offline renders of synthetic sample markup
mirroring pages.rs classes, headless Chrome forced to prefer dark, desktop
1280 and phone 390. Not a live page: root does the final live browser check.
