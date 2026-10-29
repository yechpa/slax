# Slax

Slax is a Slack-like team chat: channels, threads, reactions, file sharing,
direct messages and presence, with Google sign-in and a UI in English, Hebrew
(right-to-left) and French. Backend: Laravel (API, Reverb WebSockets, queues) on
PostgreSQL and Redis. Frontend: Vite, TypeScript and Preact. A small Python
service validates uploads.

Design and plan: [docs/superpowers/specs/2026-10-30-slax-design.md](docs/superpowers/specs/2026-10-30-slax-design.md).

## Run it locally

Requirements: Docker with the compose plugin, `make`, `openssl`, `curl`.

```sh
make up      # builds and starts everything, then migrates
make test    # Pest (backend), Vitest (frontend), pytest (scanner)
make lint    # Pint, ESLint, Ruff
make help    # all targets
```

`make up` creates `.env` from `.env.example` on first run (with a generated
`APP_KEY`). Then:

- App: <http://localhost:8080> (nginx proxies the Vite dev server, the API and the WebSocket server)
- Health check: <http://localhost:8080/api/v1/health> returns `{"status":"ok"}`
- MinIO console: <http://localhost:9001> (credentials in `.env`)

Stop with `make down`. Data lives in Docker volumes and survives restarts.

## Secrets

This repository is public. `.env` is git-ignored and `.env.example` holds
placeholders for the local stack only. Secrets are checked by gitleaks in CI and,
optionally, locally: `pre-commit install` (see `.pre-commit-config.yaml`).

## License

MIT, see [LICENSE](LICENSE).
