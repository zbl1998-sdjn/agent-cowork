# Agent Cowork UI (React + Vite + TS)

Component-ised rewrite of the desktop frontend, replacing the legacy static
`resources/app.js`. Implements the 9 components in
`resources/component-manifest.json`.

## Why a separate folder

The repo root + Node host stay **zero-dependency**. Only this UI subproject has
npm deps. It builds to `../ui-dist/`, leaving the legacy `resources/` untouched
so nothing breaks until you flip the switch.

## Develop

```bash
cd apps/windows-client/ui
npm install
npm run dev          # Vite on http://127.0.0.1:5173
# in another terminal, start the host so the UI has an API:
node ../../../scripts/start-tauri-host.mjs   # host on :3017
```

The UI calls the host at `http://127.0.0.1:3017` via `src/lib/api.ts`
(absolute URL), so dev server + host coexist.

## Build + activate in Tauri

```bash
npm run build        # -> ../ui-dist
```

Then point the Tauri shell at the React build by editing
`apps/windows-client/src-tauri/tauri.conf.json`:

- `build.devUrl`        -> `http://127.0.0.1:5173`
- `build.frontendDist`  -> `../ui-dist`
- `build.beforeDevCommand` -> `npm --prefix apps/windows-client/ui run dev` (plus the host launcher)

The CSP already allows `connect-src http://127.0.0.1:3017`; add `:5173` for dev.

## Architecture

- `src/lib/api.ts`     typed host client (HOST_BASE, ensureHost, SSE, openPath) — mirrors the contract of the legacy `app-api-client.js`.
- `src/lib/types.ts`   shared run/event/operation types.
- `src/components/*`   one file per manifest component; pure, prop-driven.
- `src/App.tsx`        composition: conversation timeline + composer.
