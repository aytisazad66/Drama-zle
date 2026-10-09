# Drama Downloader

Expo mobile app and Express API for browsing drama episodes, downloading them to a device, and automatically queueing the catalog for Cloudflare Stream.

## Run & Operate

- `pnpm install --frozen-lockfile` — install workspace dependencies
- `pnpm --filter @workspace/db run push` — apply the development database schema
- `pnpm --filter @workspace/api-server run dev` — run the API (the Replit artifact supplies its port)
- `pnpm --filter @workspace/drama-downloader run dev` — run the Expo app
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec
- Required environment: `DATABASE_URL`, `CF_ACCOUNT_ID`, `CF_STREAM_TOKEN`
- Set `DRAMA_AUTOMATION_ENABLED=true` to run the catalog scanner and upload queue in the API background worker.
- `GET /api/drama/automation/status` reports scanning state, queue totals, and the last error.

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- API: Express 5
- DB: PostgreSQL + Drizzle ORM
- Validation: Zod (`zod/v4`), `drizzle-zod`
- API codegen: Orval (from OpenAPI spec)
- Build: esbuild (CJS bundle)

## Where things live

- `artifacts/drama-downloader` — Expo Router app
- `artifacts/api-server` — Express API, source catalog scraper, Cloudflare Stream uploads, and background worker
- `lib/db/src/schema` — PostgreSQL schema
- `lib/api-spec/openapi.yaml` — API contract
- `lib/api-client-react` and `lib/api-zod` — generated client and validation schemas

## Architecture decisions

- Automation is enabled in this Replit environment and begins scanning when the API server starts.
- The worker stores its queue in PostgreSQL and uses an advisory lock so multiple API instances do not process the same queue concurrently.
- Generated Zod output targets Zod 3; the Orval config pins that generator version to match the workspace dependency.

## Product

Browse and search the drama catalog, select episodes for downloads, and monitor the automatic Cloudflare Stream catalog upload queue.

## User preferences

- The user wants the series catalog to upload to Cloudflare Stream automatically in the background without manual episode-by-episode actions.

## Gotchas

- Run the database schema push before starting the API worker on a fresh database.
- Expo uses the injected artifact port; a duplicate Expo process can prompt to switch ports and leave the preview attached to the original process.

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
