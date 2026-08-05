# AGENTS.md

This file provides guidance to Codex (Codex.ai/code) when working with code in this repository.

## Project

Node.js + Express + MySQL backend for "SIWEPE" (a.k.a. Belle Stock), an inventory/e-commerce API with role-based login (admin, proveedor, cliente). It is a JSON-only API — despite what the README implies, `server.js` does **not** serve any static frontend files (no `express.static`); the frontend is hosted separately and talks to this API over CORS (currently wide open, `cors()` with no origin restriction — auth is enforced via JWT instead).

## Commands

- `npm start` — run the server (`node server.js`)
- `npm run dev` — run with `node --watch` for auto-restart on file changes
- `npm run reset` — **destructive**: truncates business data (products, categories, clients, providers, purchases, sales, movements, orders, messages) but preserves `config` and ensures at least one admin user survives. There is no seed script anymore (`seed.js` was removed) — a fresh DB just gets an empty schema plus a default admin (`admin@siwepe.com` / `admin1234`), created by `asegurarBase()` on first boot.
- `node crear-usuario.js <email> <password> <role> "<name>"` — create or update (upsert by email) a `users` row with a bcrypt-hashed password. Roles: `admin | proveedor` only — `cliente` accounts are created via `POST /api/auth/register` (name + PIN against the `clientes` table, not `users`).

There is no test suite, linter, or build step in this project.

## Configuration

Config is loaded via `dotenv` from a `.env` file (gitignored, not committed). Copy `.env.example` to `.env` and fill in real values. Key variables:

- `PORT` — server port (default 3000)
- `JWT_SECRET` — secret for signing JWTs (falls back to an insecure dev default if unset)
- Local DB vars: `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, `DB_NAME`
- Railway-style DB vars (also supported, checked first via `MYSQLHOST`/`MYSQLUSER`/etc., or a full connection string via `DATABASE_URL` / `MYSQL_URL` / `MYSQL_PUBLIC_URL`)

`db.js` picks whichever connection style is present (`getCfg()`), tries to `CREATE DATABASE IF NOT EXISTS` (ignored if it fails, e.g. no permission on managed hosts), then opens a pool and re-runs `schema.sql` on every boot (all `CREATE TABLE IF NOT EXISTS`, so it's idempotent) with retry/backoff (`initDb`, 6 attempts / 3s apart).

## Architecture

Four files hold essentially the whole backend:

- **`db.js`** — connection pool + schema bootstrap (`initDb`), config resolution for local vs. Railway environments.
- **`auth.js`** — bcrypt password hashing, JWT sign/verify (10-year expiry — sessions intentionally never expire), `isHashed()` (detects an already-bcrypt-hashed string, used to avoid double-hashing values round-tripped through the full-state save), and two Express middlewares: `requireAuth` (valid Bearer token → `req.user`) and `requireRole(...roles)` (used by `POST /api/users`, admin-only).
- **`schema.sql`** — full normalized schema, re-applied idempotently on every startup. All tables use an app-assigned integer `id` (not auto-increment) except `users` and `pedido_items`, because IDs are generated client-side via a JSON sequence counter stored in `app_meta.seq` (mirrors what the frontend's local-storage version used to do).
- **`server.js`** — all routes. No router modules/controllers — everything lives in this one file.

### The "full state" sync model

This is the most important thing to understand before changing `server.js`. The frontend was originally a local-storage app; the backend today still mirrors that shape via two endpoints instead of granular REST resources:

- `GET /api/state` — returns the *entire* app state as one JSON blob, shaped differently by role:
  - `admin`/`proveedor` get everything: products, categories, providers, clients, purchases, sales, movements, orders, messages, full config (including `pinAdmin`).
  - `cliente` gets a filtered view: only their own client record, their own orders/order-items, and messages tied to those orders. Never other clients, never proveedores/compras/ventas/movimientos data, never the admin PIN.
- `PUT /api/state` — accepts the *entire* state and reconciles it against the DB. Behavior branches hard by role:
  - `guardarEstadoCompleto()` (admin/proveedor): **deletes and re-inserts every table** from the payload, inside a real transaction (uses `DELETE FROM`, not `TRUNCATE` — `TRUNCATE` causes an implicit commit in MySQL/InnoDB and would silently break rollback on a mid-save failure). Treat this as authoritative-overwrite semantics, not a diff/patch — any caller must send the complete state or data is lost. Client `pin` values are hashed on the way in (`isHashed(x.pin) ? x.pin : hashPassword(...)`) so already-hashed pins round-tripped from `GET /api/state` aren't re-hashed.
  - `guardarEstadoCliente()` (cliente): does *not* touch most tables. It only lets a client create/extend/cancel their own `pendiente` orders, recomputes item prices/totals server-side from current `productos` (never trusts client-submitted prices), and lets them post chat messages (always attributed to `'cliente'`, never impersonating `'admin'`) or mark admin messages as read. Everything else in the payload is silently ignored. Sequence counters (`app_meta.seq`) only ever move forward, and only for `pedido`/`mensaje`.

The README calls this out as a known rough edge ("Pendiente de endurecer"): the intended next step is per-resource endpoints with per-role permissions instead of whole-state read/write. When adding features, prefer extending this state-sync model consistently rather than introducing a parallel REST style unless asked to do the "harden into per-resource endpoints" migration itself.

### Other conventions

- Row→API object shaping happens via small mapper functions near the top of `server.js` (`mapProducto`, `mapPedidos`) and helpers `num()` (safe numeric coercion) / `arr()` (safe array coercion) / `dtMysql()` (ISO → MySQL datetime) — reuse these rather than re-deriving shapes inline.
- Login endpoints (`/api/auth/login`, `/api/auth/cliente-login`, `/api/auth/register`) are rate-limited by an in-memory `ip:route` map (`limitarIntentos`), not a shared store — this resets on restart and won't work correctly across multiple server instances. `app.set('trust proxy', 1)` is set so `req.ip` reflects the real client IP behind Railway's proxy instead of collapsing every user onto one key.
- Client login is by name + bcrypt-hashed PIN (not email) — `clientes.pin` is a bcrypt hash (`schema.sql`'s `pin` column is `VARCHAR(60)`), never compared or stored in plaintext. `asegurarBase()` migrates any legacy plaintext PINs to bcrypt on boot (`WHERE pin NOT LIKE '$2%'`). Because the PIN becomes a one-way hash, admin/proveedor views of a client's `pin` field (e.g. via `GET /api/state`) can no longer show the real PIN — only reset it to a new one.
- `POST /api/users` (admin-only, via `requireRole('admin')`) only accepts `role: 'admin' | 'proveedor'` — `'cliente'` is intentionally rejected there since client accounts live in the `clientes` table (name+PIN), not `users` (email+password); allowing it would create an unusable orphaned account.
- All source comments and console output are in Spanish; match that convention when editing these files.
