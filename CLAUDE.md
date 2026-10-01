# CLAUDE.md

Anastasia (package name `event-watcher`) watches ticket-sale events (Ticketmaster Discovery API, and Ticketmaster.co pages served by Crowder, which it scrapes) and notifies subscribed users by Telegram, WhatsApp or email when an event's status changes. [README.md](README.md) is the full reference, in Spanish: architecture, API routes, env vars, deploy and extension recipes. Read it before larger changes. This file covers what matters most while editing.

## Commands

```bash
npm run dev                       # backend (tsx watch) on :3001
npm --prefix frontend run dev     # frontend (Vite) on :5173, proxies /api to :3001
npm test                          # Vitest, all backend tests
npx vitest run test/application/NotifySubscribers.test.ts   # single file
npx tsc --noEmit                  # backend type-check (src/ only; tsconfig excludes test/)
npm --prefix frontend run build   # frontend type-check + build
npm --prefix frontend run lint    # oxlint
npx tsx scripts/<name>.ts         # manual tools (see README "Scripts de soporte")
```

Use Node 22. `better-sqlite3` is a native module, which is why the Docker image uses `bookworm-slim` and not alpine.

## Architecture (hexagonal)

- `src/domain`: entities (`Event`, `Subscription`, `User`, `NotificationRecord`), value objects, errors. No I/O.
- `src/application`: use cases plus ports. `ports/in` defines what each use case offers; `ports/out` defines what it needs (`EventProviderPort`, `NotificationPort`, `*RepositoryPort`). Depends only on the domain.
- `src/infrastructure`: adapters (Express in `http/server.ts`, SQLite repos, Ticketmaster and Crowder providers, notifiers, `PollingScheduler`).
- `src/config/container.ts`: the composition root. It wires everything and also holds **all Telegram bot command handlers** (`/start`, `/start <token>`, `/misuscripciones`, `/unsuscribe`, the `unsub:` callback buttons). `confirmTelegramSubscription` lives in `http/server.ts`.

Keep domain and application code free of Express, SQLite and vendor SDKs. New providers and channels are added as adapters and registered in `container.ts`. The README section "Cómo extender el proyecto" has the step-by-step recipe, including the frontend `CHANNEL_OPTIONS` and `CHANNELS` lists.

## Key behaviors and gotchas

- **Importing `src/config/env.ts` throws** if `TICKETMASTER_API_KEY`, `TELEGRAM_BOT_TOKEN` or `TELEGRAM_BOT_USERNAME` is missing. Tests must not import `env.ts` or `container.ts`. Build components directly, using `openDatabase(":memory:")` for SQLite and a mocked `fetch` for notifiers. Tests make no real network calls.
- **Telegram allows only one `getUpdates` consumer per token.** `buildContainer()` starts polling by default. Scripts pass `{ telegramPolling: false }`, and new scripts should too. Running the local backend against the prod bot token causes `409 Conflict` errors. Use a separate dev bot in the local `.env`, or stop the Fly machine first (see README).
- **Opt-in channels:** WhatsApp, email (Brevo) and the WhatsApp webhook are registered only when their env vars are present. A subscription whose channel has no notifier is logged and recorded as `FAILED`. It must never crash startup. `/api/channels` exposes only the registered channels.
- **Notifications fire only** on a change *to* `ONSALE`, `CANCELLED` or `RESCHEDULED`. The first reading of an event only sets the baseline. Status text shown to users comes from `infrastructure/notifiers/statusLabel.ts`.
- **Event ids:** Ticketmaster uses the raw Discovery id. Crowder uses `crowder:<page-slug>/<item-key>`, built in `container.ts` through `crowderEventId`/`crowderPageSlug`. In `config/watched-events.json`, a Crowder `id` is only the item key. Each Crowder page gets one `CrowderPageClient` (with a cache) and its own scheduler.
- **`activeFrom`/`activeUntil` windows** stop the scheduler from contacting the provider outside the window. This matters because Crowder has anti-bot protection, so keep polling scoped and don't add aggressive or indefinite scraping.
- **Crowder scraping** depends on Ticketmaster.co HTML (`.button_item`, `.tm-status-dot`) parsed with cheerio in `CrowderPageClient`. Before changing it, check against a real page with `scripts/list-crowder-items.ts` or `scripts/validate-crowder-*.ts`.
- **Identity is the phone number**, normalized (for example `+57 300 123 4567` becomes `3001234567`) in `http/phone.ts` and checked against `ALLOWED_PHONES`. There is no real authentication. Every route that takes `phone` must go through `readPhone`. WhatsApp adds the country code (`WHATSAPP_DEFAULT_COUNTRY_CODE`, default `57`) when sending.
- `SubscribeUserToEvent` is idempotent: it reactivates an existing subscription instead of creating a duplicate.
- `NotificationRecord` is not persisted yet, so there is no send history.

## Database migrations

The real migrations are the `MIGRATIONS` array in `src/infrastructure/persistence/sqlite/migrations.ts`. They are tracked in `schema_migrations`, and each runs once, in order, inside a transaction. The `.sql` files in `persistence/migrations/` are documentation only and mirror that array. To add a migration, append `{ version: N+1, description, run }` and a matching `.sql` file. Never edit a migration that has already shipped. The latest version is currently 5.

## Conventions

- Code comments, log messages and all user-facing text are in Spanish. Bot replies use the voseo form ("tenés", "usá"). The UI says "inscrito"/"suscrito", never "inscripto"/"suscripto".
- Log lines are prefixed with a bracketed component tag such as `[main]` or `[notify]`.
- Comments explain *why* (constraints, vendor quirks), not what the code does.
- Backend: TypeScript strict, CommonJS, classes with `private readonly` constructor injection. Frontend: React 19 + Vite + Tailwind v4 + lucide-react, with a typed API client in `frontend/src/api.ts`.
- Never commit `.env`, because it holds real credentials. Document new variables in `.env.example` and in the README env table.

## Deploy

Fly.io app `event-wa` (region `gru`) runs as a single always-on machine. The SQLite database lives on the volume at `/data`. The multi-stage `Dockerfile` builds the frontend into `./public`, served through `STATIC_DIR`. Non-secret config goes in `fly.toml [env]`, and secrets are set with `fly secrets`. `fly deploy` does not start a stopped machine. There is no CI in this repo.
