# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Node.js + Express + MySQL backend for "SIWEPE" (a.k.a. Belle Stock), a **multi-tenant** inventory/e-commerce API: each registered business ("empresa") gets its own isolated catalog, clients, orders, etc., with role-based login (admin, proveedor, cliente) scoped per empresa. It is a JSON-only API — despite what the README implies, `server.js` does **not** serve any static frontend files (no `express.static`); the frontend is hosted separately (`siwepe.shop`) and talks to this API over CORS (currently wide open, `cors()` with no origin restriction — auth is enforced via JWT instead).

## Commands

- `npm start` — run the server (`node server.js`)
- `npm run dev` — run with `node --watch` for auto-restart on file changes
- `npm run reset` — **destructive, and currently broken against the multi-empresa schema**: it `TRUNCATE`s business tables across *all* empresas (no `empresa_id` filter) and then queries `app_meta`/`config` `WHERE id=1`, but those tables no longer have an `id` column (`schema.sql` uses `empresa_id` as the primary key) — it will throw a SQL error before finishing. Don't rely on it without fixing it first; there is no seed script (`seed.js` was removed).
- `node crear-usuario.js <email> <password> <role> "<name>"` — create or update (upsert by email) a `users` row with a bcrypt-hashed password. Roles: `admin | proveedor` only — `cliente` accounts are created via `POST /api/auth/register` (name + PIN against the `clientes` table, not `users`). **Note:** this script inserts with no `empresa_id`, so the resulting user is a "platform admin"/unattached user (see below) — it's meant for bootstrapping, not for creating a normal in-tenant admin/proveedor (use `POST /api/users` with an authenticated admin for that).

There is no test suite, linter, or build step in this project.

## Configuration

Config is loaded via `dotenv` from a `.env` file (gitignored, not committed). Copy `.env.example` to `.env` and fill in real values. Key variables:

- `PORT` — server port (default 3000)
- `JWT_SECRET` — secret for signing JWTs (falls back to an insecure dev default if unset)
- Local DB vars: `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, `DB_NAME`
- Railway-style DB vars (also supported, checked first via `MYSQLHOST`/`MYSQLUSER`/etc., or a full connection string via `DATABASE_URL` / `MYSQL_URL` / `MYSQL_PUBLIC_URL`)
- `RESEND_API_KEY` — enables sending real verification emails via [Resend](https://resend.com) for empresa signup (see below). If unset, `enviarVerificacion()` just logs the verification link to the console instead of sending mail — useful for local dev.
- `MAIL_FROM` — sender address for verification emails (default `SIWEPE <onboarding@resend.dev>`)
- `PUBLIC_API_URL` — base URL used to build the verification link (`{PUBLIC_API_URL}/api/empresas/verificar/:token`); defaults to `http://localhost:{PORT}`
- `SITE_URL` — frontend URL the verification endpoint redirects to after success/failure (default `https://siwepe.shop`)

`db.js` picks whichever connection style is present (`getCfg()`), tries to `CREATE DATABASE IF NOT EXISTS` (ignored if it fails, e.g. no permission on managed hosts), then opens a pool and re-runs `schema.sql` on every boot (all `CREATE TABLE IF NOT EXISTS`, so it's idempotent) with retry/backoff (`initDb`, 6 attempts / 3s apart). It then runs `_migrarMultiEmpresa()`, a one-time adapter for databases created before the multi-tenant migration: if `users` lacks `empresa_id` it adds the column (backfilling admins' `empresa_id` from their old `ref_id`); if `productos` lacks `empresa_id` it **drops and recreates all business tables** (safe only because, at the time this migration was written, those tables were still empty in practice).

## Architecture

Four files hold essentially the whole backend:

- **`db.js`** — connection pool + schema bootstrap (`initDb`), config resolution for local vs. Railway environments, and the mono-empresa → multi-empresa schema migration.
- **`auth.js`** — bcrypt password hashing, JWT sign/verify (10-year expiry — sessions intentionally never expire), `isHashed()` (detects an already-bcrypt-hashed string, used to avoid double-hashing values round-tripped through the full-state save), and two Express middlewares: `requireAuth` (valid Bearer token → `req.user`) and `requireRole(...roles)` (used by `POST /api/users`, admin-only).
- **`schema.sql`** — full normalized schema, re-applied idempotently on every startup. It is **multi-tenant**: every business table carries an `empresa_id` column and uses a composite primary key `(empresa_id, id)`, so app-assigned integer ids only need to be unique *within* an empresa (`users` and `pedido_items` are the exceptions — genuinely globally auto-incrementing). IDs are generated client-side via a JSON sequence counter stored per-empresa in `app_meta.seq` (mirrors what the frontend's local-storage version used to do).
- **`server.js`** — all routes. No router modules/controllers — everything lives in this one file.

### Multi-tenancy (`empresas`)

Every business ("empresa"/tienda) is a row in `empresas`, identified by an auto-increment `id` and a unique `slug`. Almost everything else in the schema is scoped by `empresa_id` and isolated per tenant — two different empresas can each have their own product `id=1`, their own `config` row, their own `app_meta.seq` counters, etc. `req.user.empresa_id` (from the JWT payload) is threaded through nearly every authenticated route to scope queries; `empresaIdDe(ref)` resolves a public-facing empresa reference (numeric id or slug) to an internal id, only matching empresas with `estado='activa'`.

There is also a "platform admin" concept: a `users` row with `empresa_id = NULL` (created once by `asegurarBase()` on first boot as `admin@siwepe.com` / `admin1234`, or by `crear-usuario.js` with no empresa argument). This account can authenticate but **cannot** use `/api/state` (`empresaId` is required, returns 403 without one) — it exists only so the install always has *some* admin credential, not as a cross-tenant superuser role.

#### Empresa registration flow (email-verified signup)

Registering a new empresa is a two-step, email-verified flow (see `POST /api/empresas`, `GET /api/empresas`, `GET /api/empresas/verificar/:token` in `server.js`):

1. `POST /api/empresas` — validates input, checks the email isn't already a `users` row, generates a random token, **sends the verification email first** (via Resend), and only if that succeeds does it write a row to `registros_pendientes` (any prior unconfirmed request for that email is deleted first). Nothing in `empresas`/`users` exists yet at this point.
2. `GET /api/empresas/verificar/:token` — looks up the pending registration (token must be <24h old), and inside a transaction: generates a unique `slug` from the empresa name, inserts the `empresas` row (`estado='activa'`), inserts the owner as a `users` row (`role='admin'`, reusing the already-hashed password), creates that empresa's `config` and `app_meta` rows, deletes the `registros_pendientes` row, then redirects to `{SITE_URL}/index.html?verify=ok` (or `?verify=invalido` if the token is missing/expired/already used).

If the link is never clicked, the pending row just expires — `asegurarBase()` sweeps `registros_pendientes` older than 24h on every boot. `GET /api/empresas` lists active empresas publicly (id, slug, nombre, rubro, ciudad, pais, logo) for a "discover businesses" UI. `GET /api/catalog?empresa=<slug-or-id>` is the public, unauthenticated storefront read (config subset + categorías + productos) for browsing a specific tienda without logging in.

#### Password recovery (admin/proveedor)

`POST /api/auth/olvide` (email in) → looks up the `users` row, and if found generates a random token into `password_resets` (`user_id`, expires after 2h) and emails a reset link (`{SITE_URL}/admin.html?reset=<token>`) via `enviarRecuperacion()`. Always responds `{ok:true}` regardless of whether the email matched, to avoid leaking which emails are registered. `POST /api/auth/reset` (token + new password in, min 8 chars) validates the token hasn't expired, updates `password_hash`, and deletes the token row. This is separate from client accounts — clients have no email-based recovery, only an admin/proveedor can reset their own login this way.

#### Editable profile endpoints

Two small profile-edit routes exist outside the full-state model, added because `empresas.*` fields (nombre/rubro/descripcion/telefono/ciudad/pais/logo) and a client's own contact fields aren't otherwise writable after initial registration:

- `GET`/`PUT /api/empresas/mi` (admin-only) — reads/writes the calling admin's own `empresas` row. Note `config` (via `/api/state`) does *not* carry these fields, so this is the only way to edit them post-signup.
- `PUT /api/clientes/mi` (cliente-only) — updates the logged-in client's own `clientes` row (nombre/telefono/correo/direccion/whatsapp). `guardarEstadoCliente()` (`PUT /api/state`) silently ignores changes to the client's own record, so this endpoint is the only way a client can edit their profile.

### The "full state" sync model

This is the most important thing to understand before changing `server.js`. The frontend was originally a local-storage app; the backend today still mirrors that shape via two endpoints instead of granular REST resources — both scoped to `req.user.empresa_id`:

- `GET /api/state` — returns the *entire* app state as one JSON blob for the caller's empresa, shaped differently by role:
  - `admin`/`proveedor` get everything: products, categories, providers, clients, purchases, sales, movements, orders, messages, full config (including `pinAdmin`).
  - `cliente` gets a filtered view: only their own client record, their own orders/order-items, and messages tied to those orders. Never other clients, never proveedores/compras/ventas/movimientos data, never the admin PIN.
- `PUT /api/state` — accepts the *entire* state and reconciles it against the DB, scoped to `E = req.user.empresa_id`. Behavior branches hard by role:
  - `guardarEstadoCompleto()` (admin/proveedor): **deletes and re-inserts every table for that empresa** from the payload, inside a real transaction (uses `DELETE FROM ... WHERE empresa_id=?`, not `TRUNCATE` — `TRUNCATE` causes an implicit commit in MySQL/InnoDB and would silently break rollback on a mid-save failure, and would also affect other tenants since these tables are shared). Treat this as authoritative-overwrite semantics for *that one empresa*, not a diff/patch — any caller must send the complete state or data is lost. Client `pin` values are hashed on the way in (`isHashed(x.pin) ? x.pin : hashPassword(...)`) so already-hashed pins round-tripped from `GET /api/state` aren't re-hashed.
  - `guardarEstadoCliente()` (cliente): does *not* touch most tables. It only lets a client create/extend/cancel their own `pendiente` orders (within their own empresa), recomputes item prices/totals server-side from current `productos` (never trusts client-submitted prices), and lets them post chat messages (always attributed to `'cliente'`, never impersonating `'admin'`) or mark admin messages as read. Everything else in the payload is silently ignored. Sequence counters (`app_meta.seq`, per-empresa) only ever move forward, and only for `pedido`/`mensaje`.

The README calls this out as a known rough edge ("Pendiente de endurecer"): the intended next step is per-resource endpoints with per-role permissions instead of whole-state read/write. When adding features, prefer extending this state-sync model consistently rather than introducing a parallel REST style unless asked to do the "harden into per-resource endpoints" migration itself.

### Other conventions

- Row→API object shaping happens via small mapper functions near the top of `server.js` (`mapProducto`, `mapPedidos`) and helpers `num()` (safe numeric coercion) / `arr()` (safe array coercion) / `dtMysql()` (ISO → MySQL datetime) — reuse these rather than re-deriving shapes inline.
- Login/registration endpoints (`/api/auth/login`, `/api/auth/olvide`, `/api/auth/reset`, `/api/auth/cliente-login`, `/api/auth/register`, `/api/empresas`) are rate-limited by an in-memory `ip:route` map (`limitarIntentos`), not a shared store — this resets on restart and won't work correctly across multiple server instances. `app.set('trust proxy', 1)` is set so `req.ip` reflects the real client IP behind Railway's proxy instead of collapsing every user onto one key.
- Client login is by name + bcrypt-hashed password, scoped to an empresa (`nombre` only has to be unique within `empresa_id`) — the column is still named `pin` in `schema.sql` (`VARCHAR(60)`, bcrypt hash, never compared or stored in plaintext) for backward compatibility, but it's no longer treated as a short numeric PIN: `POST /api/auth/register` now requires it to be at least 6 characters, with no digits-only restriction. `asegurarBase()` migrates any legacy plaintext PINs to bcrypt on boot (`WHERE pin NOT LIKE '$2%'`). Because it's a one-way hash, admin/proveedor views of a client's `pin` field (e.g. via `GET /api/state`) can no longer show the real value — only reset it to a new one.
- `POST /api/users` (admin-only, via `requireRole('admin')`) only accepts `role: 'admin' | 'proveedor'` — `'cliente'` is intentionally rejected there since client accounts live in the `clientes` table (name+PIN), not `users` (email+password); allowing it would create an unusable orphaned account. New users created this way inherit `req.user.empresa_id` (the calling admin's own empresa).
- The Resend integration (`enviarVerificacion()`) checks the SDK's `{ data, error }` return value explicitly — the Resend SDK does not throw on a rejected send, so a missed `error` check would fail silently.
- All source comments and console output are in Spanish; match that convention when editing these files.
