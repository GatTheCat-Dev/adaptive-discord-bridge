# App Template (AI-Agent Notes)

TypeScript + Hono API template used for Adaptive AI `util` apps.

## What This Repo Is

- RPC API server: `src/api/server.ts`
- RPC procedures (the main surface area to extend): `src/api/procedures.ts`
- Procedures re-export: `src/api/index.ts`
- Generated API types (build artifact): `dist/api-exports.d.ts`
- Env parsing/validation: `src/lib/env.ts` (Zod schema)

**Notes:**

- `npm run dev` loads `.env.development` and starts the agent in watch mode.
- TypeScript uses the path alias `@/*` → `src/*` (see `tsconfig.json`).

**Useful checks:**

```bash
npm run check   # tsc --noEmit
npm run lint
npm run format
```

## Runtime Behavior

- Starts a Hono server and serves `index.html` at `/`.
- Handles RPC requests at `POST /api/*` via `typed-rpc/server`.
- Uses `superjson` for request/response serialization.
- Can respond to cross-app requests made by other Adaptive AI apps.

## Debugging with Log Files

This template writes development logs to `api-dev.log` in the project root.

- `api-dev.log`: API server startup/restart output, runtime errors, and RPC execution logs.

## Environment Variables

All required env vars are validated at startup by `src/lib/env.ts`.

Environment mode behavior is:

- **Default and only state (expected):** development environment only.
- **Production Mode:** not supported for utility apps.
- **Routing behavior:** requests route to development.

Required keys include:

- `PORT`
- `DB_FILE_NAME`
- `GUEST_SERVICES_URL`
- `VITE_APP_ID`
- `VITE_BASE_URL`
- `VITE_ROOT_URL`
- `VITE_REALTIME_DOMAIN`
- `VITE_BOX_ID`
- `VITE_NODE_ENV` (defaults to `production` if unset in `src/lib/env.ts`)

Append additional env vars into `.env.development` and validate them in `src/lib/env.ts` as needed. Then, access them via the `env` object imported from `src/lib/env.ts`.

Utility apps are development-only in the current platform flow. Seeing no production environment is normal.

## Workflow Expectations

- Keep procedure signatures stable unless explicitly requested.
- If you add/rename procedures, ensure imports/exports still flow through `src/api/index.ts`.
- Run `npm run check` after TypeScript changes; run `npm run lint` if touching many files.
