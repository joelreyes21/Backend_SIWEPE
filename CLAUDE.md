# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Node.js + Express + MySQL backend for "SIWEPE" (a.k.a. Belle Stock), an inventory/e-commerce API with role-based login (admin, proveedor, cliente). It is a JSON-only API — despite what the README implies, `server.js` does **not** serve any static frontend files (no `express.static`); the frontend is hosted separately and talks to this API over CORS (currently wide open, `cors()` with no origin restriction — auth is enforced via JWT instead).

## Commands

- `npm start` — run the server (`node server.js`)
- `npm run dev` — run with `node --watch` for auto-restart on file changes
- `npm run seed` — **destructive**: truncates all tables and reloads demo data (categories, products, clients, providers, sales, purchases, orders, and the two default users). Run this once to bootstrap a local DB.
- `npm run reset` — **destructive**: truncates business data (products, categories, clients, providers, purchases, sales, movements, orders, messages) but preserves `config` and ensures at least one admin user survives.
- `node crear-usuario.js <email> <password> <role> "<name>"` — create or update (upsert by email) a `users` row with a bcrypt-hashed password. Roles: `admin | proveedor | cliente`.

There is no test suite, linter, or build step in this project.

## Configuration

Config is loaded via `dotenv` from a `.env` file (not committed; README references a `.env.example` that isn't present in the repo — check with the user before assuming its shape). Key variables:

- `PORT` — server port (default 3000)
- `JWT_SECRET` — secret for signing JWTs (falls back to an insecure dev default if unset)
- Local DB vars: `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, `DB_NAME`
- Railway-style DB vars (also supported, checked first via `MYSQLHOST`/`MYSQLUSER`/etc., or a full connection string via `DATABASE_URL` / `MYSQL_URL` / `MYSQL_PUBLIC_URL`)

`db.js` picks whichever connection style is present (`getCfg()`), tries to `CREATE DATABASE IF NOT EXISTS` (ignored if it fails, e.g. no permission on managed hosts), then opens a pool and re-runs `schema.sql` on every boot (all `CREATE TABLE IF NOT EXISTS`, so it's idempotent) with retry/backoff (`initDb`, 6 attempts / 3s apart).

## Architecture

Four files hold essentially the whole backend:

- **`db.js`** — connection pool + schema bootstrap (`initDb`), config resolution for local vs. Railway environments.
- **`auth.js`** — bcrypt password hashing, JWT sign/verify (10-year expiry — sessions intentionally never expire), and two Express middlewares: `requireAuth` (valid Bearer token → `req.user`) and `requireRole(...roles)`.
- **`schema.sql`** — full normalized schema, re-applied idempotently on every startup. All tables use an app-assigned integer `id` (not auto-increment) except `users` and `pedido_items`, because IDs are generated client-side via a JSON sequence counter stored in `app_meta.seq` (mirrors what the frontend's local-storage version used to do).
- **`server.js`** — all routes. No router modules/controllers — everything lives in this one file.

### The "full state" sync model

This is the most important thing to understand before changing `server.js`. The frontend was originally a local-storage app; the backend today still mirrors that shape via two endpoints instead of granular REST resources:

- `GET /api/state` — returns the *entire* app state as one JSON blob, shaped differently by role:
  - `admin`/`proveedor` get everything: products, categories, providers, clients, purchases, sales, movements, orders, messages, full config (including `pinAdmin`).
  - `cliente` gets a filtered view: only their own client record, their own orders/order-items, and messages tied to those orders. Never other clients, never proveedores/compras/ventas/movimientos data, never the admin PIN.
- `PUT /api/state` — accepts the *entire* state and reconciles it against the DB. Behavior branches hard by role:
  - `guardarEstadoCompleto()` (admin/proveedor): **truncates and re-inserts every table** from the payload. Treat this as authoritative-overwrite semantics, not a diff/patch — any caller must send the complete state or data is lost.
  - `guardarEstadoCliente()` (cliente): does *not* touch most tables. It only lets a client create/extend/cancel their own `pendiente` orders, recomputes item prices/totals server-side from current `productos` (never trusts client-submitted prices), and lets them post chat messages (always attributed to `'cliente'`, never impersonating `'admin'`) or mark admin messages as read. Everything else in the payload is silently ignored. Sequence counters (`app_meta.seq`) only ever move forward, and only for `pedido`/`mensaje`.

The README calls this out as a known rough edge ("Pendiente de endurecer"): the intended next step is per-resource endpoints with per-role permissions instead of whole-state read/write. When adding features, prefer extending this state-sync model consistently rather than introducing a parallel REST style unless asked to do the "harden into per-resource endpoints" migration itself.

### Other conventions

- Row→API object shaping happens via small mapper functions near the top of `server.js` (`mapProducto`, `mapPedidos`) and helpers `num()` (safe numeric coercion) / `arr()` (safe array coercion) / `dtMysql()` (ISO → MySQL datetime) — reuse these rather than re-deriving shapes inline.
- Login endpoints (`/api/auth/login`, `/api/auth/cliente-login`, `/api/auth/register`) are rate-limited by an in-memory `ip:route` map (`limitarIntentos`), not a shared store — this resets on restart and won't work correctly across multiple server instances.
- Client login is by name + 4-digit PIN, not email — brute-force limiting on that route is treated as critical (see comments in `server.js`).
- All source comments and console output are in Spanish; match that convention when editing these files.
