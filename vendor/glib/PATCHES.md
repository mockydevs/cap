# Local security backport

This directory contains the published `glib` 0.18.5 crate with the upstream
`VariantStrIter::impl_get` undefined-behavior fix from gtk-rs-core pull request
[#1343](https://github.com/gtk-rs/gtk-rs-core/pull/1343). The source archive is
otherwise unchanged.

Tauri 2.11 still depends on the GTK 0.18 crate family, while the advisory is
only marked fixed starting with `glib` 0.20. The workspace patch in
`apps/desktop/src-tauri/Cargo.toml` therefore keeps Tauri's compatible API and
backports the two-line fix. Remove this directory, the Cargo patch, and the
narrow CI audit exception once Tauri adopts `glib` 0.20 or newer.

Advisory: `RUSTSEC-2024-0429` / `GHSA-wrw7-89jp-8q8g`.
