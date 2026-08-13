# Contributing to Cap

Thanks for taking the time. This file covers the mechanics; [ARCHITECTURE.md](ARCHITECTURE.md)
explains how the pieces fit together, and the [docs](docs) directory covers each
subsystem in depth.

## Getting set up

```bash
pnpm install
cp .env.example .env.local
pnpm dev
```

`docker compose up -d` starts PostgreSQL, Redis, and the workers if you need the
full pipeline rather than just the web app.

## Before you open a pull request

Run the same checks CI runs:

```bash
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

`pnpm test` is unit-only and needs no external services. The integration and
end-to-end suites need a live stack; see [README.md](README.md#checks) and
[tests/e2e](tests/e2e/README.md).

## What we look for in a change

- **One reason to change per pull request.** A bug fix, a feature, or a
  refactor — not all three. Small pull requests get reviewed faster.
- **Tests on the paths that matter.** Anything touching authorization, sharing,
  uploads, billing limits, or credential handling needs a test that fails
  without the change.
- **No second home for a piece of knowledge.** Roles, enums, schemas, and
  formatting helpers live in one place — usually a package under `packages/`.
  If you need one in two apps, move it to a shared package rather than copying.
- **Comments explain why, not what.** Names should carry the what.
- **Match the surrounding code.** Prettier settles formatting; everything else
  should read like the file it lives in.

## Sign your commits (DCO)

This project uses the [Developer Certificate of Origin](https://developercertificate.org/)
instead of a contributor licence agreement. It is a statement that you wrote the
patch, or otherwise have the right to submit it under the project's licence.

Add a sign-off line to each commit:

```bash
git commit -s -m "Fix transcript cue alignment"
```

which appends:

```
Signed-off-by: Your Name <your.email@example.com>
```

Commits without a sign-off cannot be merged.

## Licence

Cap is licensed under the [GNU AGPL v3](LICENSE). By contributing you agree that
your contribution is licensed under the same terms. Note the practical
consequence for everyone, including us: if you run a modified copy of Cap as a
network service, the people using it are entitled to your modified source.

## Reporting problems

- **Bugs and features:** open an issue using one of the templates.
- **Security vulnerabilities:** do not open a public issue. Follow
  [docs/SECURITY.md](docs/SECURITY.md).
- **Conduct concerns:** see [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).
