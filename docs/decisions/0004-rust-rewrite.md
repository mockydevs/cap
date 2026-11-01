# ADR 0004: Cap becomes a Rust system

Status: accepted (Don, 2026-11-01: "The system should be fully rust").

## Context

Today Cap is a Next.js 16 web app (~80 API routes, ~23k lines of TypeScript),
six TypeScript workers, shared TypeScript packages, and a Tauri 2 desktop app
whose recorder is Rust but whose window UI is React. Production runs on Coolify
at `cap.calari.tech` with one PostgreSQL database (45 tables, migrations
`apps/web/db/migrations/0000`–`0023`) and a private S3 bucket.

Cap is now an internal Mocky tool: Clare records screens and meetings, and
meeting transcripts go privately to the Calari portal.

## Decision

Replace the TypeScript system with Rust, in phases, without a big-bang cutover
and without losing data.

- **One Rust server** (`crates/cap-server`, axum) owns HTTP, auth and jobs. It
  reads and writes the **existing** PostgreSQL tables and S3 objects. Nothing is
  copied to a new store; the database schema is the compatibility contract.
- **Workers** become Tokio job runners inside the same binary (or a second
  binary from the same crate), replacing the TS media, transcription, render and
  webhook workers. FFmpeg stays an external process: it is a C program either
  way, and rewriting codecs is not in scope.
- **UI** is server-rendered HTML from Rust plus Rust→WASM (`web-sys`) where the
  browser must do work, such as screen and tab recording. Browser-only APIs
  (`getDisplayMedia`, `MediaRecorder`, `chrome.*` extension APIs) are reached
  through `web-sys`/thin JS shims; a Chrome extension still needs a JSON
  manifest and a small JS service worker, because Chrome only runs extension
  code that way.
- **Desktop** stays Tauri (already Rust); its React window is replaced by the
  same server-rendered/WASM approach.
- **Migrations**: Rust-owned tables use their own ledger (sqlx's `_sqlx_migrations`).
  Until the Rust server owns a feature, the TS app keeps working against the same
  tables. When a phase moves a feature, its TS routes are removed in that phase.

## Phases

| Phase | Moves to Rust                                                                                                                                            | TS removed                  |
| ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------- |
| 1     | Meeting pipeline: pairing, chunk upload, on-server transcription, signed Calari delivery; detector; static landing page; extension; desktop meeting mode | none (new feature)          |
| 2     | Auth (Argon2id sessions, Google OAuth), workspaces, upload sessions, recordings, playback, desktop endpoints                                             | matching `app/api/*` routes |
| 3     | Media, transcription, render and webhook workers                                                                                                         | `apps/*-worker`             |
| 4     | Library, record, watch, share and admin pages; browser recorder in WASM                                                                                  | `apps/web`                  |

Each phase ships only after its checks pass and Don approves the deploy; pushing
to `main` deploys production.

## Consequences

- During phases 1–3 two languages run against one database. Every Rust change
  to a shared table must stay readable by the TS code still using it.
- Features Cap no longer needs as an internal tool (billing, public API,
  multi-tenant AI BYOK) are candidates to drop rather than port; that is Don's
  call per feature, recorded in this ADR when made.
