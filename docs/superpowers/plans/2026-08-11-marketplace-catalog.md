# Catálogo cruzado entre tiendas (`GET /api/marketplace`) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a public, read-only `GET /api/marketplace` endpoint that returns products from all active empresas (each tagged with its owning empresa's public info), so the mobile app / siwepe.shop can show one cross-store catalog and link from any product into that empresa's own storefront.

**Architecture:** Single new route in `server.js`, placed next to the existing `GET /api/catalog` route. One SQL query joins `productos` to `empresas`, filtered to `empresas.estado='activa'` and `productos.estado='activo'`. Reuses the existing `mapProducto()` mapper and adds an embedded `empresa` object per product. No schema changes, no new tables, no auth changes — this endpoint is public like `/api/catalog`.

**Tech Stack:** Node.js, Express, mysql2 (existing project stack — no new dependencies).

## Global Constraints

- No schema/migration changes — `schema.sql` is untouched.
- No pagination, no filters (category/search/rubro) — return everything in one response (confirmed scale: a few dozen tiendas/productos).
- Omit `precio_compra` and `stock_min` from the response — internal business data, not to be exposed in a cross-tenant public view.
- Do not resolve/join `categorias` — `categoria_id` stays as a raw id; category names are only meaningful within a single empresa's own catalog view.
- The `empresa` object per product must use the same field names as `GET /api/empresas` (`id`, `slug`, `nombre`, `rubro`, `ciudad`, `logo`) for consistency across the API.
- All source comments and console output in Spanish, matching the rest of `server.js`.
- No test suite exists in this project — verification is manual (curl/PowerShell against a running local server), per `CLAUDE.md`.

---

### Task 1: Add `GET /api/marketplace` route

**Files:**
- Modify: `server.js` — insert the new route immediately after the existing `GET /api/catalog` route (ends at line 410, right before `function mapPedidos` at line 412).

**Interfaces:**
- Consumes: `getPool()` (existing DB pool accessor, defined earlier in `server.js`), `mapProducto(r)` (existing mapper at `server.js:48-53`, returns `{ id, codigo, nombre, categoria_id, descripcion, precio_compra, precio_venta, stock, stock_min, imagen, estado, destacado, marca, tipoPiel }`).
- Produces: `GET /api/marketplace` — public endpoint, no auth, no params. Response shape: `{ productos: [ { ...camposDeProducto (sin precio_compra ni stock_min), empresa: { id, slug, nombre, rubro, ciudad, logo } } ] }`.

- [ ] **Step 1: Write the route handler**

Insert this block into `server.js`, directly after the closing `});` of the `GET /api/catalog` route (line 410) and before `function mapPedidos(peds, items) {` (line 412):

```js
/* ───────── MARKETPLACE (catálogo cruzado entre todas las tiendas activas) ─────────
   A diferencia de /api/catalog (una sola tienda), esta ruta junta productos
   de TODAS las empresas activas para la vista de "descubrir productos" en
   la app móvil / siwepe.shop. Cada producto trae su propia empresa embebida
   para poder armar el link al perfil de esa tienda (GET /api/catalog?empresa=<slug>). */
app.get('/api/marketplace', async (req, res) => {
  try {
    const [rows] = await getPool().query(
      `SELECT productos.*, empresas.id AS emp_id, empresas.slug AS emp_slug,
              empresas.nombre AS emp_nombre, empresas.rubro AS emp_rubro,
              empresas.ciudad AS emp_ciudad, empresas.logo AS emp_logo
       FROM productos
       JOIN empresas ON productos.empresa_id = empresas.id
       WHERE empresas.estado = 'activa' AND productos.estado = 'activo'`
    );
    res.json({
      productos: rows.map(r => {
        const { precio_compra, stock_min, ...p } = mapProducto(r);
        return {
          ...p,
          empresa: {
            id: r.emp_id, slug: r.emp_slug, nombre: r.emp_nombre,
            rubro: r.emp_rubro || '', ciudad: r.emp_ciudad || '', logo: r.emp_logo || '',
          },
        };
      }),
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
```

- [ ] **Step 2: Start the server locally**

Run: `npm start` (or `npm run dev` if you want auto-restart while iterating)
Expected: console shows the server listening (no crash on boot — confirms the route was inserted with valid syntax and didn't break server startup).

- [ ] **Step 3: Manually verify the happy path**

With the server running and at least one empresa in `estado='activa'` that has at least one `producto` with `estado='activo'` (check existing dev data via `GET /api/empresas`, which lists active empresas), run:

PowerShell:
```powershell
Invoke-RestMethod http://localhost:3000/api/marketplace | ConvertTo-Json -Depth 5
```
or curl:
```bash
curl http://localhost:3000/api/marketplace
```

Expected: HTTP 200, JSON body `{ "productos": [...] }`. Each entry has `id`, `codigo`, `nombre`, `categoria_id`, `descripcion`, `precio_venta`, `stock`, `imagen`, `estado`, `destacado`, `marca`, `tipoPiel`, and an `empresa` object with `id`, `slug`, `nombre`, `rubro`, `ciudad`, `logo`. Confirm `precio_compra` and `stock_min` are **not** present on any product.

- [ ] **Step 4: Verify multi-tienda mixing**

If you have 2+ active empresas with products, confirm the response contains products whose `empresa.slug` differs across entries (i.e. it's not scoped to one tienda). If your local DB only has one active empresa, register a second one via `POST /api/empresas` + `GET /api/empresas/verificar/:token` (or check the console-logged verification link if `RESEND_API_KEY` isn't set) to get a second data point, add one product to it via the admin flow, then re-run Step 3.

- [ ] **Step 5: Verify filtering excludes inactive data**

Pick one product and temporarily set its `estado` to something other than `'activo'` directly in MySQL (e.g. `UPDATE productos SET estado='inactivo' WHERE empresa_id=<id> AND id=<id>`), or pick an empresa and set `estado='pendiente'`. Re-run Step 3's request and confirm that product (or all products of that empresa) no longer appears. Revert the manual `UPDATE` afterward so you don't leave test data in a broken state.

- [ ] **Step 6: Verify the empresa profile link works**

Take any `empresa.slug` from the `/api/marketplace` response and confirm:
```bash
curl "http://localhost:3000/api/catalog?empresa=<slug>"
```
returns that empresa's full catalog (HTTP 200, with `config`, `categorias`, `productos`). This confirms the "entrar al perfil de la empresa desde el producto" flow is already wired end-to-end via the existing route.

- [ ] **Step 7: Commit**

```bash
git add server.js
git commit -m "$(cat <<'EOF'
Agrega GET /api/marketplace: catalogo cruzado de todas las tiendas activas

Permite navegar productos de todas las empresas activas desde un solo
endpoint publico, con la empresa embebida en cada producto para poder
entrar a su perfil via GET /api/catalog?empresa=<slug> (ya existente).
No toca el esquema ni el aislamiento por empresa_id del resto de la API.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Self-Review Notes

- **Spec coverage:** Every requirement in `docs/superpowers/specs/2026-08-11-marketplace-catalog-design.md` maps to Task 1 — the endpoint contract (Step 1), the manual test plan from the spec's Testing section (Steps 3-6 mirror the spec's 5 verification points 1:1), and the explicit non-goals (no pagination/filters, no `categorias` join, no `precio_compra`/`stock_min`) are all reflected in the route code and the Global Constraints section.
- **Placeholder scan:** No TBD/TODO markers; every step has concrete code or concrete commands.
- **Type consistency:** `mapProducto(r)` and its output shape match the definition read from `server.js:48-53` exactly; the destructure `const { precio_compra, stock_min, ...p } = mapProducto(r)` relies on those exact property names.
