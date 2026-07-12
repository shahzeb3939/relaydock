# Contributing to RelayDock

RelayDock accepts focused changes that preserve its outbound-only agent model and least-privilege defaults.

## Development setup

```bash
cp .env.example .env
docker compose up -d postgres
pnpm install
pnpm prisma:generate
pnpm prisma:migrate
pnpm dev
```

Run the Go agent separately from `apps/agent`.

## Before submitting a change

```bash
pnpm format:check
pnpm typecheck
pnpm test
pnpm build
```

Add or update tests for protocol changes, authorization boundaries, path handling, job transitions, and reconnect behavior. Protocol changes must remain versioned and be reflected in both TypeScript schemas and Go decoding. Update `docs/progress.md` truthfully; do not check off functionality that has not been exercised.

Use Conventional Commit subjects such as `feat(server): add device pairing` or `fix(agent): reject escaped working directories`. Never include credentials, terminal output containing secrets, or a real `.env` in an issue or commit.

Security reports belong in the private disclosure channel described in [SECURITY.md](SECURITY.md), not a public issue.
