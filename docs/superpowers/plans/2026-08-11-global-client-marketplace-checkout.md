# Cuenta global de cliente + checkout cruzando tiendas (Spec B) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the client account global (correo+contraseña, not tied to one empresa) and let a client buy products from several tiendas in one checkout, per `docs/superpowers/specs/2026-08-11-global-client-marketplace-checkout-design.md`.

**Architecture:** The client stops being a row in the tenant-scoped `clientes` table and becomes a row in `users` (`role='cliente'`, `empresa_id=NULL`), reusing the existing login/JWT/`auth.js` machinery that admin/proveedor already use. `pedidos.cliente_id`/`ventas.cliente_id` now point at that global `users.id`. The client is removed from the full-state sync model (`/api/state` 403s for `role='cliente'`) and gets small dedicated REST endpoints instead: checkout (creates one `pedido` per empresa in the cart, all-or-nothing), "mis pedidos" (cross-empresa order history), and per-order chat. The admin/proveedor's "client directory" in `/api/state` changes from a table it manages to a query derived from who has ordered in that empresa.

**Tech Stack:** Node.js, Express, mysql2 (existing project stack — no new dependencies).

## Global Constraints

- No test suite in this project — verification is a `node --check server.js` syntax pass (something this plan's executor can always run) plus manual live testing against a real MySQL instance (something to run on a machine where the project's DB credentials actually work — the sandbox this plan was designed in did not have working DB access; each task notes this explicitly).
- Prices in `pedido_items` are always recalculated server-side from the empresa's own `productos.precio_venta` — never trust a client-submitted price (existing convention, `CLAUDE.md`).
- App-assigned ids (`pedidos.id`, `mensajes.id`) are allocated per-empresa via `app_meta.seq`, using `SELECT ... FOR UPDATE` to serialize concurrent allocations — existing convention, reuse it exactly (see `server.js`'s `POST /api/auth/register` today for the reference pattern).
- All source comments and console output in Spanish, matching the rest of the codebase.
- No stock-level validation in checkout — the system doesn't have it today either (stock is managed separately via `movimientos`), so this plan does not add it.
- This plan does **not** touch `guardarEstadoCompleto()`'s handling of any table other than `clientes` (categorias/proveedores/productos/compras/ventas/movimientos/pedidos/mensajes stay exactly as they are).

---

### Task 1: Schema change + migration + fix everything that reads/writes the dropped `clientes` table

This is the foundational task: it removes the `clientes` table and, in the same task, fixes every place in `db.js`/`server.js` that would otherwise break by referencing a table that no longer exists. Landing this without the fixes would leave the server unable to serve `/api/state` for admin/proveedor (500 errors on `FROM clientes`) or boot cleanly (`asegurarBase()` also queries `clientes`), so it must go in as one unit.

**Files:**
- Modify: `schema.sql:81-91` (the `users` table) and `schema.sql:115-127` (the `clientes` table — to be removed)
- Modify: `db.js` — add `_migrarClienteGlobal()` after `_migrarMultiEmpresa()` (currently ends at `db.js:68`), call it from `initDb()` (currently calls `_migrarMultiEmpresa` at `db.js:84`)
- Modify: `server.js:9` (import line), `server.js:454-510` (`GET /api/state`), `server.js:515-562` (`guardarEstadoCompleto`), `server.js:564-648` (`guardarEstadoCliente` — deleted entirely), `server.js:650-666` (`PUT /api/state`), `server.js:691-697` (inside `asegurarBase`, the plaintext-PIN migration block)

**Interfaces:**
- Consumes: `getPool()`, `num()`, `arr()` (all already defined earlier in `server.js`).
- Produces: after this task, `users` has `telefono`, `direccion`, `whatsapp` nullable columns; the `clientes` table no longer exists; `GET /api/state` for admin/proveedor returns a `clientes` array derived from `pedidos`+`users` (fields: `id, nombre, correo, telefono, direccion, whatsapp` — no `pin`, no `registrado`); `GET`/`PUT /api/state` return `403` for `role==='cliente'` with the message `'Los clientes ya no usan /api/state; usá /api/marketplace, /api/catalog, /api/pedidos/checkout, /api/mis-pedidos'`.

- [x] **Step 1: Update `schema.sql`**

In the `users` table (`schema.sql:81-91`), add three nullable columns after `ref_id`:

```sql
CREATE TABLE IF NOT EXISTS users (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  nombre        VARCHAR(80)  NOT NULL,
  email         VARCHAR(120) UNIQUE,
  password_hash VARCHAR(120) NOT NULL,
  role          ENUM('admin','proveedor','cliente') NOT NULL DEFAULT 'cliente',
  empresa_id    INT,                       -- empresa a la que pertenece (NULL = admin de plataforma o cliente global)
  ref_id        INT,                       -- id de proveedor asociado (si aplica)
  telefono      VARCHAR(30),                -- solo se usa cuando role='cliente'
  direccion     VARCHAR(160),               -- solo se usa cuando role='cliente'
  whatsapp      VARCHAR(24),                -- solo se usa cuando role='cliente'
  activo        TINYINT NOT NULL DEFAULT 1,
  created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
```

Delete the entire `clientes` table block (`schema.sql:115-127`, from `CREATE TABLE IF NOT EXISTS clientes (` through its closing `) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;`).

- [x] **Step 2: Add the migrator to `db.js`**

Insert this function right after `_migrarMultiEmpresa()` (after its closing `}` on `db.js:68`), before `async function initDb(...)`:

```js
/* Convierte las cuentas de cliente de "una tabla por empresa" (clientes) a
   "una fila global en users" (role='cliente', empresa_id=NULL). Idempotente:
   si ya está migrada (existen las columnas nuevas y no existe `clientes`),
   no hace nada. Etapa temprana del proyecto: no se preservan filas viejas
   de `clientes`, se descartan junto con la tabla. */
async function _migrarClienteGlobal(pool) {
  const [tc] = await pool.query("SHOW COLUMNS FROM users LIKE 'telefono'");
  if (!tc.length) {
    await pool.query(
      'ALTER TABLE users ADD COLUMN telefono VARCHAR(30) NULL, ' +
      'ADD COLUMN direccion VARCHAR(160) NULL, ADD COLUMN whatsapp VARCHAR(24) NULL'
    );
  }
  const [ct] = await pool.query("SHOW TABLES LIKE 'clientes'");
  if (ct.length) {
    console.warn('Migrando cuentas de cliente a users (cuenta global): eliminando tabla clientes vieja.');
    await pool.query('DROP TABLE clientes');
  }
}
```

Then call it in `initDb()`, right after the existing `await _migrarMultiEmpresa(pool, schema);` line (`db.js:84`):

```js
      await _migrarMultiEmpresa(pool, schema);
      await _migrarClienteGlobal(pool);
```

- [x] **Step 3: Remove the unused `isHashed` import in `server.js`**

`server.js:9` currently reads:
```js
const { hashPassword, checkPassword, signToken, requireAuth, requireRole, isHashed } = require('./auth');
```
Change to:
```js
const { hashPassword, checkPassword, signToken, requireAuth, requireRole } = require('./auth');
```
(`isHashed` was only used for hashing client PINs on full-state save, which Step 6 below removes.)

- [x] **Step 4: Rewrite `GET /api/state` (`server.js:454-510`)**

Replace the whole route with:

```js
app.get('/api/state', requireAuth, async (req, res) => {
  if (req.user.role === 'cliente') {
    return res.status(403).json({ error: 'Los clientes ya no usan /api/state; usá /api/marketplace, /api/catalog, /api/pedidos/checkout, /api/mis-pedidos' });
  }
  try {
    const empresaId = req.user.empresa_id;
    if (!empresaId) return res.status(403).json({ error: 'Tu usuario no está asociado a ninguna empresa' });
    const pool = getPool();
    const [[cfg]] = await pool.query('SELECT * FROM config WHERE empresa_id=?', [empresaId]);
    const [[meta]] = await pool.query('SELECT seq FROM app_meta WHERE empresa_id=?', [empresaId]);
    const [categorias] = await pool.query('SELECT id,nombre,descripcion,estado FROM categorias WHERE empresa_id=?', [empresaId]);
    const [prods] = await pool.query('SELECT * FROM productos WHERE empresa_id=?', [empresaId]);
    const cfgBase = cfg || { nombre: 'SIWEPE', moneda: 'L', tema: 'cielo' };

    // admin / proveedor: estado completo del negocio (de SU empresa)
    const [proveedores] = await pool.query('SELECT id,nombre,telefono,correo,empresa,direccion,whatsapp,estado FROM proveedores WHERE empresa_id=?', [empresaId]);
    // `clientes` ya no es una tabla propia: se deriva de quién le compró a esta empresa.
    const [clientes] = await pool.query(
      `SELECT DISTINCT users.id, users.nombre, users.email AS correo, users.telefono, users.direccion, users.whatsapp
       FROM users JOIN pedidos ON pedidos.cliente_id = users.id
       WHERE pedidos.empresa_id = ? AND users.role = 'cliente'`, [empresaId]);
    const [compras] = await pool.query('SELECT * FROM compras WHERE empresa_id=?', [empresaId]);
    const [ventas] = await pool.query('SELECT * FROM ventas WHERE empresa_id=?', [empresaId]);
    const [movimientos] = await pool.query('SELECT id,tipo,signo,producto_id,cantidad,fecha,usuario,obs FROM movimientos WHERE empresa_id=?', [empresaId]);
    const [peds] = await pool.query('SELECT * FROM pedidos WHERE empresa_id=?', [empresaId]);
    const [items] = await pool.query('SELECT * FROM pedido_items WHERE empresa_id=?', [empresaId]);
    const [mensajes] = await pool.query('SELECT id,pedido_id,autor,texto,fecha,leido FROM mensajes WHERE empresa_id=?', [empresaId]);

    res.json({
      config: { nombre: cfgBase.nombre, logo: cfgBase.logo || '', moneda: cfgBase.moneda, tema: cfgBase.tema, pinAdmin: cfgBase.pin_admin, banners: arr(cfgBase.banners), pago: cfgBase.pago || {} },
      seq: meta ? meta.seq : {},
      categorias,
      proveedores,
      clientes,
      productos: prods.map(mapProducto),
      compras: compras.map(x => ({ ...x, precio: num(x.precio) })),
      ventas: ventas.map(x => ({ ...x, precio: num(x.precio), total: num(x.total) })),
      movimientos,
      pedidos: mapPedidos(peds, items),
      mensajes: mensajes.map(m => ({ ...m, leido: !!m.leido })),
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
```

- [x] **Step 5: Trim `guardarEstadoCompleto()` (`server.js:515-562`)**

Change the `DELETE` loop (currently `server.js:521`):
```js
    for (const t of ['mensajes','pedido_items','pedidos','movimientos','ventas','compras','productos','clientes','proveedores','categorias'])
```
to:
```js
    for (const t of ['mensajes','pedido_items','pedidos','movimientos','ventas','compras','productos','proveedores','categorias'])
```

Delete this block entirely (currently `server.js:538-540`, right before `for (const x of db.productos || [])`):
```js
    for (const x of db.clientes || [])
      await c.query('INSERT INTO clientes (empresa_id,id,nombre,telefono,correo,direccion,whatsapp,pin,registrado) VALUES (?,?,?,?,?,?,?,?,?)',
        [E, x.id, x.nombre, x.telefono || '', x.correo || '', x.direccion || '', x.whatsapp || '', isHashed(x.pin) ? x.pin : hashPassword(String(x.pin || '0000')), x.registrado ? 1 : 0]);
```

- [x] **Step 6: Delete `guardarEstadoCliente()` entirely (`server.js:564-648`)**

Delete the function and its preceding doc comment block, from `/* ───────── GUARDAR ESTADO (cliente) ─────────` through the function's closing `}` (currently `server.js:564` through `server.js:648`).

- [x] **Step 7: Rewrite `PUT /api/state` (`server.js:650-666`)**

Replace with:

```js
app.put('/api/state', requireAuth, async (req, res) => {
  if (req.user.role === 'cliente') {
    return res.status(403).json({ error: 'Los clientes ya no usan /api/state; usá /api/marketplace, /api/catalog, /api/pedidos/checkout, /api/mis-pedidos' });
  }
  const db = req.body || {};
  const pool = getPool();
  const c = await pool.getConnection();
  const E = req.user.empresa_id;
  if (!E) { c.release(); return res.status(403).json({ error: 'Tu usuario no está asociado a ninguna empresa' }); }
  try {
    await c.beginTransaction();
    await guardarEstadoCompleto(c, E, db);
    await c.commit();
    res.json({ ok: true });
  } catch (e) {
    await c.rollback();
    res.status(500).json({ error: e.message });
  } finally { c.release(); }
});
```

- [x] **Step 8: Remove the plaintext-PIN migration block from `asegurarBase()` (`server.js:691-697`)**

Delete these lines entirely:
```js
  // Migra a bcrypt los PIN de clientes que hayan quedado en texto plano
  // (bases creadas antes de este cambio). Idempotente: no toca lo ya migrado.
  const [pendientes] = await pool.query("SELECT empresa_id, id, pin FROM clientes WHERE pin NOT LIKE '$2%'");
  for (const cl of pendientes) {
    await pool.query('UPDATE clientes SET pin=? WHERE empresa_id=? AND id=?', [hashPassword(String(cl.pin || '0000')), cl.empresa_id, cl.id]);
  }
  if (pendientes.length) console.log(`PIN de ${pendientes.length} cliente(s) migrado(s) a bcrypt.`);
```

- [x] **Step 9: Syntax check** — `node --check server.js` y `node --check db.js` pasaron sin errores.

Run: `node --check server.js` and `node --check db.js`
Expected: no output, exit code 0 (parses cleanly — this does not execute the code or need a DB connection).

- [ ] **Step 10: Manual live verification (run on a machine with working DB access to this project)** — **PENDIENTE, correr en tu máquina** (este entorno no tuvo acceso a un MySQL con las credenciales del proyecto).

1. Start the server (`npm start`) against a MySQL instance with the project's real credentials.
2. Confirm no crash on boot, and the console shows the migration warning line (`Migrando cuentas de cliente a users...`) the first time it runs against a pre-existing DB, or nothing if the DB was already empty.
3. `SHOW COLUMNS FROM users;` → confirm `telefono`, `direccion`, `whatsapp` are present. `SHOW TABLES;` → confirm `clientes` is gone.
4. Log in as an existing admin/proveedor (`POST /api/auth/login`) and call `GET /api/state` → confirm it still returns `200` with a `clientes: []` (empty, since there are no `pedidos` yet pointing at a global client) instead of erroring.
5. **Do not** test `POST /api/auth/cliente-login` or the old `POST /api/auth/register` shape here — they still reference the old model and are fixed in Task 2, which lands next.

- [x] **Step 11: Commit** — `796dca9`

```bash
git add schema.sql db.js server.js
git commit -m "$(cat <<'EOF'
Elimina la tabla clientes: el login de cliente pasa a ser global (users)

Primer paso de la cuenta unica de cliente (Spec B): users gana columnas
de perfil (telefono/direccion/whatsapp), se elimina clientes, y se
adapta todo lo que la referenciaba. El directorio de clientes que ve
el admin en GET /api/state ahora se deriva de quien le compro (JOIN
pedidos+users) en vez de ser una tabla que el admin gestiona a mano.
/api/state ya no acepta el rol cliente (403), lo que habilita sacarlo
del modelo de estado completo en las proximas tareas.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Global client registration + consolidate login

**Files:**
- Modify: `server.js` — delete the `POST /api/auth/cliente-login` route (located after Task 1 by searching for `app.post('/api/auth/cliente-login'`), rewrite the `POST /api/auth/register` route (search for `app.post('/api/auth/register'`).

**Interfaces:**
- Consumes: `getPool()`, `hashPassword()`, `signToken()` (all already imported/defined).
- Produces: `POST /api/auth/register` now takes `{ nombre, correo, password, telefono?, direccion?, whatsapp? }` and returns `{ token, user: { id, nombre, email, role: 'cliente' } }`. `POST /api/auth/login` (unchanged code) now also authenticates clients, since they're `users` rows.

- [x] **Step 1: Delete the `POST /api/auth/cliente-login` route**

Find and delete this entire route block:
```js
// Cliente (nombre + contraseña) — la columna se sigue llamando `pin` en la
// base de datos por compatibilidad, pero ya no está limitada a dígitos.
app.post('/api/auth/cliente-login', limitarIntentos(8, 10 * 60 * 1000), async (req, res) => {
  try {
    const { nombre, pin, empresa } = req.body || {};
    if (!nombre || !pin) return res.status(400).json({ error: 'Faltan datos' });
    const empresaId = await empresaIdDe(empresa);
    if (!empresaId) return res.status(400).json({ error: 'Tienda no válida' });
    const [rows] = await getPool().query('SELECT * FROM clientes WHERE empresa_id=? AND LOWER(nombre)=? LIMIT 1', [empresaId, String(nombre).toLowerCase().trim()]);
    const c = rows[0];
    if (!c || !checkPassword(String(pin).trim(), c.pin)) return res.status(401).json({ error: 'Nombre o contraseña incorrectos' });
    const token = signToken({ id: c.id, nombre: c.nombre, role: 'cliente', empresa_id: empresaId, ref_id: c.id });
    res.json({ token, cliente: c });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
```

- [x] **Step 2: Rewrite `POST /api/auth/register`**

Replace the whole route (currently the "Registro de cliente nuevo" block that queries `clientes`/`app_meta` per empresa) with:

```js
// Registro de cliente nuevo — cuenta global (correo+contraseña), no ligada a una empresa
app.post('/api/auth/register', limitarIntentos(6, 10 * 60 * 1000), async (req, res) => {
  const { nombre, correo, password, telefono, direccion, whatsapp } = req.body || {};
  if (!nombre || !String(nombre).trim() || !correo || !password || String(password).length < 8) {
    return res.status(400).json({ error: 'Nombre, correo y contraseña (mín. 8 caracteres) obligatorios' });
  }
  const email = String(correo).toLowerCase().trim();
  try {
    const pool = getPool();
    const [ex] = await pool.query('SELECT id FROM users WHERE email=? LIMIT 1', [email]);
    if (ex.length) return res.status(409).json({ error: 'Ya existe una cuenta con ese correo' });
    const [result] = await pool.query(
      'INSERT INTO users (nombre,email,password_hash,role,empresa_id,telefono,direccion,whatsapp,activo) VALUES (?,?,?,?,NULL,?,?,?,1)',
      [nombre.trim(), email, hashPassword(String(password)), 'cliente', telefono || '', direccion || '', whatsapp || '']);
    const token = signToken({ id: result.insertId, nombre: nombre.trim(), role: 'cliente', empresa_id: null, ref_id: null });
    res.json({ token, user: { id: result.insertId, nombre: nombre.trim(), email, role: 'cliente' } });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
```

- [x] **Step 3: Syntax check** — pasó.

- [ ] **Step 4: Manual live verification** — **PENDIENTE, correr en tu máquina**

1. `curl -X POST http://localhost:3000/api/auth/register -H "Content-Type: application/json" -d '{"nombre":"Ana Test","correo":"ana@test.com","password":"clave1234"}'` → expect `200` with `{ token, user }`.
2. Repeat the same request → expect `409` (`Ya existe una cuenta con ese correo`).
3. `curl -X POST http://localhost:3000/api/auth/login -H "Content-Type: application/json" -d '{"email":"ana@test.com","password":"clave1234"}'` → expect `200` with a token (confirms the client authenticates through the same route as admin/proveedor now).
4. `curl -X POST http://localhost:3000/api/auth/cliente-login -H "Content-Type: application/json" -d '{}'` → expect `404` (route no longer exists).

- [x] **Step 5: Commit** — `85966a8`

```bash
git add server.js
git commit -m "$(cat <<'EOF'
Registro de cliente global por correo; elimina el login por nombre+PIN

POST /api/auth/register ahora crea una fila en users (role=cliente,
sin empresa) en vez de en la vieja tabla clientes por empresa. Se
elimina POST /api/auth/cliente-login: el cliente entra por la misma
POST /api/auth/login que ya usan admin y proveedor.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: `PUT /api/clientes/mi` edits the global `users` row

**Files:**
- Modify: `server.js` — rewrite the `PUT /api/clientes/mi` route (search for `app.put('/api/clientes/mi'`).

**Interfaces:**
- Consumes: `getPool()`, `req.user.id` (present in every JWT since `auth.js`'s `signToken` payloads always include `id`).
- Produces: `PUT /api/clientes/mi` body `{ nombre, telefono?, correo?, direccion?, whatsapp? }` → `200 { ok: true }` or `409` if `correo` collides with another account.

- [x] **Step 1: Rewrite the route**

Replace the existing route (and its doc comment) with:

```js
/* ───────── PERFIL DE MI CUENTA (cliente) ─────────
   nombre/telefono/correo/direccion/whatsapp viven ahora en `users` (el cliente
   es una fila global, no una por empresa). Si cambia el correo, se revalida
   que siga siendo único, porque también es su credencial de login. */
app.put('/api/clientes/mi', requireAuth, requireRole('cliente'), async (req, res) => {
  const { nombre, telefono, correo, direccion, whatsapp } = req.body || {};
  if (!nombre || !String(nombre).trim()) return res.status(400).json({ error: 'Falta el nombre' });
  const email = correo ? String(correo).toLowerCase().trim() : null;
  try {
    const pool = getPool();
    if (email) {
      const [dup] = await pool.query('SELECT id FROM users WHERE email=? AND id<>? LIMIT 1', [email, req.user.id]);
      if (dup.length) return res.status(409).json({ error: 'Ese correo ya está en uso' });
    }
    await pool.query(
      'UPDATE users SET nombre=?, telefono=?, email=COALESCE(?,email), direccion=?, whatsapp=? WHERE id=?',
      [String(nombre).trim(), telefono || '', email, direccion || '', whatsapp || '', req.user.id]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});
```

- [x] **Step 2: Syntax check** — pasó.

- [ ] **Step 3: Manual live verification** — **PENDIENTE, correr en tu máquina**

1. Log in as the client created in Task 2 (`ana@test.com`).
2. `curl -X PUT http://localhost:3000/api/clientes/mi -H "Authorization: Bearer <token>" -H "Content-Type: application/json" -d '{"nombre":"Ana Actualizada","telefono":"9999-0000"}'` → expect `200 { ok: true }`.
3. `GET /api/me` with the same token → confirm the response reflects... (note: `GET /api/me` just echoes the JWT payload, which won't show the new `nombre` until the client logs in again — that's expected, not a bug, since the JWT isn't re-issued on profile edit). Instead confirm the update by having an admin whose empresa this client ordered from check `GET /api/state`'s derived `clientes` list once Task 4 has produced an order — or query the DB directly: `SELECT nombre, telefono FROM users WHERE email='ana@test.com';`.
4. Try updating with a `correo` that belongs to another existing user → expect `409`.

- [x] **Step 4: Commit** — `7e3559b`

```bash
git add server.js
git commit -m "$(cat <<'EOF'
PUT /api/clientes/mi edita la fila global de users, no la vieja clientes

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Checkout cruzando tiendas (`POST /api/pedidos/checkout`)

**Files:**
- Modify: `server.js` — add the new route right after `PUT /api/clientes/mi` and before `POST /api/users` (search for `app.post('/api/users', requireAuth, requireRole('admin')` to find the insertion point).

**Interfaces:**
- Consumes: `getPool()`, `num()`, `arr()`, `req.user.id`.
- Produces: `POST /api/pedidos/checkout` → `{ pedidos: [{ id, cliente_id, total, nota, fecha, estado, metodoPago, comprobante, items, empresa }] }`, one entry per empresa in the cart. Later tasks (`GET /api/mis-pedidos`) reuse this exact per-pedido shape.

- [x] **Step 1: Add the route**

```js
/* ───────── CHECKOUT (cliente) ─────────
   El carrito puede tener productos de varias empresas. Se agrupa por
   empresa_id y se crea UN pedido por empresa, todo dentro de una sola
   transacción: si algo no resuelve (empresa inactiva, producto inexistente
   o inactivo en esa empresa), se aborta TODO el checkout, sin pedidos
   parciales. Los precios siempre se recalculan server-side. */
app.post('/api/pedidos/checkout', requireAuth, requireRole('cliente'), async (req, res) => {
  const items = arr(req.body && req.body.items);
  if (!Array.isArray(items) || !items.length) return res.status(400).json({ error: 'El carrito está vacío' });
  const nota = String((req.body && req.body.nota) || '').slice(0, 500);
  const metodoPago = String((req.body && req.body.metodoPago) || '');
  const comprobante = String((req.body && req.body.comprobante) || '');

  const porEmpresa = new Map();
  for (const it of items) {
    const empresaId = it && num(it.empresa_id);
    const productoId = it && num(it.producto_id);
    const cantidad = it && num(it.cantidad);
    if (!empresaId || !productoId || cantidad <= 0) {
      return res.status(400).json({ error: 'Item de carrito inválido: falta empresa_id, producto_id o cantidad' });
    }
    if (!porEmpresa.has(empresaId)) porEmpresa.set(empresaId, []);
    porEmpresa.get(empresaId).push({ producto_id: productoId, cantidad });
  }

  const pool = getPool();
  const c = await pool.getConnection();
  try {
    await c.beginTransaction();
    const pedidosCreados = [];

    for (const [empresaId, itemsEmpresa] of porEmpresa) {
      const [[emp]] = await c.query("SELECT id, slug, nombre, rubro, ciudad, logo FROM empresas WHERE id=? AND estado='activa'", [empresaId]);
      if (!emp) { await c.rollback(); return res.status(400).json({ error: `La tienda ${empresaId} no existe o no está activa` }); }

      const productoIds = itemsEmpresa.map(it => it.producto_id);
      const [prodRows] = await c.query(
        "SELECT id, precio_venta FROM productos WHERE empresa_id=? AND estado='activo' AND id IN (?)",
        [empresaId, productoIds]);
      const precios = new Map(prodRows.map(pr => [pr.id, num(pr.precio_venta)]));

      const itemsCalc = itemsEmpresa.map(it => {
        if (!precios.has(it.producto_id)) return null;
        const precio = precios.get(it.producto_id);
        return { producto_id: it.producto_id, cantidad: it.cantidad, precio, subtotal: +(precio * it.cantidad).toFixed(2) };
      });
      if (itemsCalc.some(x => x === null)) {
        await c.rollback();
        return res.status(400).json({ error: `Uno o más productos de la tienda "${emp.nombre}" ya no están disponibles` });
      }

      const total = +itemsCalc.reduce((s, i) => s + i.subtotal, 0).toFixed(2);

      const [mrows] = await c.query('SELECT seq FROM app_meta WHERE empresa_id=? FOR UPDATE', [empresaId]);
      const seq = (mrows[0] && mrows[0].seq) || {};
      const [maxr] = await c.query('SELECT COALESCE(MAX(id),0) AS m FROM pedidos WHERE empresa_id=?', [empresaId]);
      const nid = Math.max(num(seq.pedido), maxr[0].m) + 1;
      const fecha = new Date().toISOString().slice(0, 10);

      await c.query('INSERT INTO pedidos (empresa_id,id,cliente_id,total,nota,fecha,estado,metodo_pago,comprobante) VALUES (?,?,?,?,?,?,?,?,?)',
        [empresaId, nid, req.user.id, total, nota, fecha, 'pendiente', metodoPago, comprobante]);
      for (const it of itemsCalc)
        await c.query('INSERT INTO pedido_items (empresa_id,pedido_id,producto_id,cantidad,precio,subtotal) VALUES (?,?,?,?,?,?)',
          [empresaId, nid, it.producto_id, it.cantidad, it.precio, it.subtotal]);

      seq.pedido = nid;
      await c.query('UPDATE app_meta SET seq=? WHERE empresa_id=?', [JSON.stringify(seq), empresaId]);

      pedidosCreados.push({
        id: nid, cliente_id: req.user.id, total, nota, fecha, estado: 'pendiente',
        metodoPago, comprobante, items: itemsCalc,
        empresa: { id: emp.id, slug: emp.slug, nombre: emp.nombre, rubro: emp.rubro || '', ciudad: emp.ciudad || '', logo: emp.logo || '' },
      });
    }

    await c.commit();
    res.json({ pedidos: pedidosCreados });
  } catch (e) {
    await c.rollback().catch(() => {});
    res.status(500).json({ error: e.message });
  } finally { c.release(); }
});
```

- [x] **Step 2: Syntax check** — pasó.

- [ ] **Step 3: Manual live verification** — **PENDIENTE, correr en tu máquina**

Setup: 2 empresas `activa` (A and B), each with at least one `producto` `activo`. Log in as the client from Task 2/3.

1. Checkout with one item from empresa A only → expect `200`, `pedidos` has 1 entry, `empresa.id` matches A, `precio`/`subtotal` match A's `productos.precio_venta` (not any price you sent, if you sent one).
2. Checkout with one item from A and one from B in the same request → expect `200`, `pedidos` has 2 entries, one per empresa.
3. Checkout with a `producto_id` that doesn't exist in the given `empresa_id` → expect `400`, and confirm via `SELECT * FROM pedidos` that **no** new row was created for that request (all-or-nothing — including for the other, valid empresa group in the same cart if you mix a valid and an invalid group).
4. Checkout with `empresa_id` pointing at an empresa with `estado='pendiente'` (or a made-up id) → expect `400`.

- [x] **Step 4: Commit** — `a01eadf`

```bash
git add server.js
git commit -m "$(cat <<'EOF'
Agrega POST /api/pedidos/checkout: compra cruzando varias tiendas

Agrupa el carrito por empresa y crea un pedido por tienda dentro de una
sola transaccion (todo o nada): si algun item no resuelve a un producto
activo de esa empresa, se aborta el checkout completo sin pedidos
parciales. Precios recalculados server-side, nunca desde el cliente.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: "Mis pedidos" cruzando tiendas (`GET /api/mis-pedidos`)

**Files:**
- Modify: `server.js` — add the new route right after the checkout route from Task 4.

**Interfaces:**
- Consumes: `getPool()`, `num()`, `req.user.id`.
- Produces: `GET /api/mis-pedidos` → `{ pedidos: [...] }`, same per-pedido shape as `POST /api/pedidos/checkout`'s response.

**Note:** do not reuse the existing `mapPedidos(peds, items)` helper here — it matches items to a pedido only by `pedido_id`, which is unique per empresa, not globally. Across empresas, two different pedidos can share the same numeric `id` (e.g. pedido `3` in empresa A and pedido `3` in empresa B), so `mapPedidos` would cross-contaminate their items. Build the mapping manually, keyed by `empresa_id:id`, as shown below.

- [x] **Step 1: Add the route**

```js
/* ───────── MIS PEDIDOS (cliente) ─────────
   Todos los pedidos del cliente logueado, en TODAS las empresas donde
   compró. No reutiliza mapPedidos(): esa función empareja items por
   pedido_id, que sólo es único DENTRO de una empresa, así que cruzando
   empresas mezclaría items de pedidos distintos con el mismo id. */
app.get('/api/mis-pedidos', requireAuth, requireRole('cliente'), async (req, res) => {
  try {
    const pool = getPool();
    const [peds] = await pool.query(
      `SELECT pedidos.*, empresas.slug AS emp_slug, empresas.nombre AS emp_nombre,
              empresas.rubro AS emp_rubro, empresas.ciudad AS emp_ciudad, empresas.logo AS emp_logo
       FROM pedidos JOIN empresas ON pedidos.empresa_id = empresas.id
       WHERE pedidos.cliente_id = ?
       ORDER BY pedidos.fecha DESC, pedidos.id DESC`, [req.user.id]);

    const itemsPorPedido = new Map(); // clave "empresaId:pedidoId" -> items[]
    for (const p of peds) {
      const [rows] = await pool.query(
        'SELECT producto_id,cantidad,precio,subtotal FROM pedido_items WHERE empresa_id=? AND pedido_id=?', [p.empresa_id, p.id]);
      itemsPorPedido.set(`${p.empresa_id}:${p.id}`, rows.map(i => ({
        producto_id: i.producto_id, cantidad: num(i.cantidad), precio: num(i.precio), subtotal: num(i.subtotal),
      })));
    }

    res.json({
      pedidos: peds.map(p => ({
        id: p.id, cliente_id: p.cliente_id, total: num(p.total), nota: p.nota || '', fecha: p.fecha,
        estado: p.estado, metodoPago: p.metodo_pago || '', comprobante: p.comprobante || '',
        items: itemsPorPedido.get(`${p.empresa_id}:${p.id}`) || [],
        empresa: { id: p.empresa_id, slug: p.emp_slug, nombre: p.emp_nombre, rubro: p.emp_rubro || '', ciudad: p.emp_ciudad || '', logo: p.emp_logo || '' },
      })),
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
```

- [x] **Step 2: Syntax check** — pasó.

- [ ] **Step 3: Manual live verification** — **PENDIENTE, correr en tu máquina**

1. As the client from Task 4, call `GET /api/mis-pedidos` → expect the 2 pedidos created in Task 4's Step 3.2 (one per empresa), each with the correct `empresa` object and `items`.
2. Log in as a *different* client (register a second one) with no orders → `GET /api/mis-pedidos` → expect `{ pedidos: [] }`.
3. If both test empresas happen to have produced a pedido with the same numeric `id` (likely, since `app_meta.seq` starts independently per empresa), confirm each pedido in the response has its OWN `items` (not a mix of both) — this is the scenario the "don't reuse `mapPedidos`" note above exists to prevent.

- [x] **Step 4: Commit** — `e5b8031`

```bash
git add server.js
git commit -m "$(cat <<'EOF'
Agrega GET /api/mis-pedidos: historial de pedidos cruzando tiendas

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: Chat de pedidos (`GET`/`POST /api/pedidos/:empresaId/:pedidoId/mensajes`)

**Files:**
- Modify: `server.js` — add both routes right after the `GET /api/mis-pedidos` route from Task 5.

**Interfaces:**
- Consumes: `getPool()`, `num()`, `dtMysql()`, `req.user.id`.
- Produces: `GET /api/pedidos/:empresaId/:pedidoId/mensajes` → `{ mensajes: [{ id, pedido_id, autor, texto, fecha, leido }] }`. `POST ... /mensajes` body `{ texto }` → `{ ok: true, id }`.

- [x] **Step 1: Add the routes**

```js
/* ───────── MENSAJES DE UN PEDIDO (cliente) ─────────
   Reemplaza la porción de chat que antes vivía dentro de PUT /api/state
   para el cliente (guardarEstadoCliente, eliminada en la Tarea 1). Antes
   de leer/escribir, confirma que el pedido sea del cliente logueado — si
   no, 404 genérico (no revela si el pedido es de otro cliente o no existe). */
app.get('/api/pedidos/:empresaId/:pedidoId/mensajes', requireAuth, requireRole('cliente'), async (req, res) => {
  const empresaId = num(req.params.empresaId);
  const pedidoId = num(req.params.pedidoId);
  try {
    const pool = getPool();
    const [[pedido]] = await pool.query('SELECT id FROM pedidos WHERE empresa_id=? AND id=? AND cliente_id=?', [empresaId, pedidoId, req.user.id]);
    if (!pedido) return res.status(404).json({ error: 'Pedido no encontrado' });
    const [rows] = await pool.query(
      'SELECT id,pedido_id,autor,texto,fecha,leido FROM mensajes WHERE empresa_id=? AND pedido_id=? ORDER BY fecha ASC, id ASC',
      [empresaId, pedidoId]);
    res.json({ mensajes: rows.map(m => ({ ...m, leido: !!m.leido })) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/pedidos/:empresaId/:pedidoId/mensajes', requireAuth, requireRole('cliente'), async (req, res) => {
  const empresaId = num(req.params.empresaId);
  const pedidoId = num(req.params.pedidoId);
  const texto = String((req.body && req.body.texto) || '').slice(0, 2000).trim();
  if (!texto) return res.status(400).json({ error: 'Falta el texto del mensaje' });
  const pool = getPool();
  const c = await pool.getConnection();
  try {
    const [[pedido]] = await c.query('SELECT id FROM pedidos WHERE empresa_id=? AND id=? AND cliente_id=?', [empresaId, pedidoId, req.user.id]);
    if (!pedido) { c.release(); return res.status(404).json({ error: 'Pedido no encontrado' }); }

    await c.beginTransaction();
    const [[meta]] = await c.query('SELECT seq FROM app_meta WHERE empresa_id=? FOR UPDATE', [empresaId]);
    const seq = (meta && meta.seq) || {};
    const [maxr] = await c.query('SELECT COALESCE(MAX(id),0) AS m FROM mensajes WHERE empresa_id=?', [empresaId]);
    const nid = Math.max(num(seq.mensaje), maxr[0].m) + 1;

    await c.query('INSERT INTO mensajes (empresa_id,id,pedido_id,autor,texto,fecha,leido) VALUES (?,?,?,?,?,?,0)',
      [empresaId, nid, pedidoId, 'cliente', texto, dtMysql(new Date().toISOString())]);
    seq.mensaje = nid;
    await c.query('UPDATE app_meta SET seq=? WHERE empresa_id=?', [JSON.stringify(seq), empresaId]);
    await c.commit();
    res.json({ ok: true, id: nid });
  } catch (e) {
    await c.rollback().catch(() => {});
    res.status(500).json({ error: e.message });
  } finally { c.release(); }
});
```

- [x] **Step 2: Syntax check** — pasó.

- [ ] **Step 3: Manual live verification** — **PENDIENTE, correr en tu máquina**

Using one of the pedidos created in Task 4:

1. `POST /api/pedidos/<empresaId>/<pedidoId>/mensajes` with `{ "texto": "hola, cuando llega?" }` as the owning client → expect `200 { ok: true, id: 1 }`.
2. `GET /api/pedidos/<empresaId>/<pedidoId>/mensajes` as the same client → expect the message from step 1, with `autor: 'cliente'`.
3. Log in as the *other* test client (no relation to this pedido) and repeat step 2 with the same `empresaId`/`pedidoId` → expect `404`.
4. As the empresa's admin, call `GET /api/state` → confirm the message shows up in the admin's `mensajes` array (admin side is untouched, still reads from `mensajes` directly).

- [x] **Step 4: Commit** — `b4cb20b`

```bash
git add server.js
git commit -m "$(cat <<'EOF'
Agrega chat de pedidos por ruta propia (GET/POST /api/pedidos/:e/:p/mensajes)

Reemplaza la porcion de chat que vivia dentro de guardarEstadoCliente
(eliminada junto con /api/state para el rol cliente en la Tarea 1).
Verifica que el pedido pertenezca al cliente logueado antes de leer o
escribir; 404 generico si no.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Self-Review Notes

- **Spec coverage:** every section of `docs/superpowers/specs/2026-08-11-global-client-marketplace-checkout-design.md` maps to a task — modelo de datos/migración → Task 1, registro/login → Task 2, perfil → Task 3, checkout → Task 4, mis pedidos → Task 5, chat → Task 6, and the "directorio de clientes derivado" correction is folded into Task 1 (the `GET /api/state` rewrite) since it's a direct consequence of dropping `clientes` there.
- **Placeholder scan:** no TBD/TODO; every step has concrete code or concrete commands.
- **Type consistency:** the pedido shape returned by Task 4's checkout (`id, cliente_id, total, nota, fecha, estado, metodoPago, comprobante, items, empresa`) is deliberately mirrored exactly by Task 5's `GET /api/mis-pedidos`, field-for-field, so a front-end can render both with the same code. `req.user.id` is used consistently across Tasks 2-6 (present in every JWT payload signed by `signToken()`, confirmed against `auth.js` and the existing `/api/auth/login`/`/api/empresas/verificar` code). Caught and fixed one real bug during planning: `GET /api/mis-pedidos` must NOT reuse `mapPedidos()` (it matches items by `pedido_id` alone, which collides across empresas) — Task 5 builds the mapping manually instead, keyed by `empresa_id:id`.
- **Cross-task breakage window:** Task 1 alone leaves `POST /api/auth/cliente-login` and the old `POST /api/auth/register` shape referencing the now-dropped `clientes` table (they'd 500 if called) — this is called out explicitly in Task 1 Step 10 ("do not test these here") and fixed immediately by Task 2. No other task leaves a broken intermediate route.
