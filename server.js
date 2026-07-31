/* server.js — API REST + sirve la web (Belle Stock)
   Arranca con: npm start   →   http://localhost:3000/tienda.html */
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const { initDb, getPool } = require('./db');
const { hashPassword, checkPassword, signToken, requireAuth, requireRole } = require('./auth');

const app = express();
const PORT = process.env.PORT || 3000;

/* API pública: el front-end (siwepe.shop) vive en otro hosting, así que se
   permite CORS desde cualquier origen. La seguridad va por el token JWT. */
app.use(cors());
app.use(express.json({ limit: '30mb' }));           // imágenes en base64
app.use(express.urlencoded({ extended: true, limit: '30mb' }));

/* Este servidor es SOLO API (el front-end se hostea aparte). */
app.get('/', (req, res) => res.json({ ok: true, service: 'SIWEPE API', ts: new Date().toISOString() }));

/* ───────── helpers de conversión fila → objeto (forma que usa el front-end) ───────── */
const num = (v) => (v == null ? 0 : Number(v));
const arr = (v) => (Array.isArray(v) ? v : (v == null ? [] : v));
const dtMysql = (iso) => { const d = new Date(iso); return isNaN(d) ? iso : d.toISOString().slice(0, 19).replace('T', ' '); };

/* ───────── límite de intentos (protege login/registro de fuerza bruta) ───────── */
const _intentos = new Map(); // "ip:ruta" -> { n, hasta }
setInterval(() => { const ahora = Date.now(); for (const [k, v] of _intentos) if (ahora > v.hasta) _intentos.delete(k); }, 30 * 60 * 1000).unref();
function limitarIntentos(max, ventanaMs) {
  return (req, res, next) => {
    const key = req.ip + ':' + req.path;
    const ahora = Date.now();
    const e = _intentos.get(key);
    if (!e || ahora > e.hasta) { _intentos.set(key, { n: 1, hasta: ahora + ventanaMs }); return next(); }
    if (e.n >= max) return res.status(429).json({ error: 'Demasiados intentos. Espera unos minutos e inténtalo de nuevo.' });
    e.n++;
    next();
  };
}

function mapProducto(r) {
  return { id: r.id, codigo: r.codigo, nombre: r.nombre, categoria_id: r.categoria_id,
    descripcion: r.descripcion || '', precio_compra: num(r.precio_compra), precio_venta: num(r.precio_venta),
    stock: num(r.stock), stock_min: num(r.stock_min), imagen: r.imagen || '', estado: r.estado,
    destacado: !!r.destacado, marca: r.marca || '', tipoPiel: arr(r.tipo_piel) };
}

/* ───────── AUTENTICACIÓN ───────── */

// Admin / proveedor (email + contraseña)
app.post('/api/auth/login', limitarIntentos(10, 10 * 60 * 1000), async (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) return res.status(400).json({ error: 'Faltan datos' });
    const [rows] = await getPool().query('SELECT * FROM users WHERE email=? AND activo=1 LIMIT 1', [String(email).toLowerCase().trim()]);
    const u = rows[0];
    if (!u || !checkPassword(password, u.password_hash)) return res.status(401).json({ error: 'Correo o contraseña incorrectos' });
    const token = signToken({ id: u.id, nombre: u.nombre, role: u.role, ref_id: u.ref_id });
    res.json({ token, user: { id: u.id, nombre: u.nombre, role: u.role, ref_id: u.ref_id } });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Cliente (nombre + PIN) — PIN de 4 dígitos: limitar intentos es crítico
app.post('/api/auth/cliente-login', limitarIntentos(8, 10 * 60 * 1000), async (req, res) => {
  try {
    const { nombre, pin } = req.body || {};
    if (!nombre || !pin) return res.status(400).json({ error: 'Faltan datos' });
    const [rows] = await getPool().query('SELECT * FROM clientes WHERE LOWER(nombre)=? AND pin=? LIMIT 1', [String(nombre).toLowerCase().trim(), String(pin).trim()]);
    const c = rows[0];
    if (!c) return res.status(401).json({ error: 'Nombre o PIN incorrecto' });
    const token = signToken({ id: c.id, nombre: c.nombre, role: 'cliente', ref_id: c.id });
    res.json({ token, cliente: c });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Registro de cliente nuevo
app.post('/api/auth/register', limitarIntentos(6, 10 * 60 * 1000), async (req, res) => {
  try {
    const { nombre, pin, telefono, correo, direccion } = req.body || {};
    if (!nombre || !pin || String(pin).length < 4) return res.status(400).json({ error: 'Nombre y PIN (mín. 4 dígitos) obligatorios' });
    const pool = getPool();
    const [dup] = await pool.query('SELECT id FROM clientes WHERE LOWER(nombre)=? LIMIT 1', [String(nombre).toLowerCase().trim()]);
    if (dup.length) return res.status(409).json({ error: 'Ya existe un cliente con ese nombre' });
    // siguiente id (respeta la secuencia del front-end)
    const [mrows] = await pool.query('SELECT seq FROM app_meta WHERE id=1');
    const seq = mrows[0] ? mrows[0].seq : {};
    const [maxr] = await pool.query('SELECT COALESCE(MAX(id),0) AS m FROM clientes');
    const nid = Math.max(seq.cliente || 0, maxr[0].m) + 1;
    await pool.query('INSERT INTO clientes (id,nombre,telefono,correo,direccion,whatsapp,pin,registrado) VALUES (?,?,?,?,?,?,?,1)',
      [nid, nombre.trim(), telefono || '—', correo || '—', direccion || '—', '', String(pin).trim()]);
    seq.cliente = nid;
    await pool.query('UPDATE app_meta SET seq=? WHERE id=1', [JSON.stringify(seq)]);
    const [rows] = await pool.query('SELECT * FROM clientes WHERE id=?', [nid]);
    const token = signToken({ id: nid, nombre: nombre.trim(), role: 'cliente', ref_id: nid });
    res.json({ token, cliente: rows[0] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/me', requireAuth, (req, res) => res.json({ user: req.user }));

/* ───────── CATÁLOGO PÚBLICO (para navegar sin iniciar sesión) ───────── */
app.get('/api/catalog', async (req, res) => {
  try {
    const pool = getPool();
    const [cfg] = await pool.query('SELECT * FROM config WHERE id=1');
    const [cats] = await pool.query('SELECT * FROM categorias');
    const [prods] = await pool.query('SELECT * FROM productos');
    const c = cfg[0] || {};
    res.json({
      config: { nombre: c.nombre, logo: c.logo || '', moneda: c.moneda, tema: c.tema, banners: arr(c.banners), pago: c.pago || {} },
      categorias: cats,
      productos: prods.map(mapProducto),
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

function mapPedidos(peds, items) {
  return peds.map(p => ({
    id: p.id, cliente_id: p.cliente_id, total: num(p.total), nota: p.nota || '', fecha: p.fecha,
    estado: p.estado, metodoPago: p.metodo_pago || '', comprobante: p.comprobante || '',
    items: items.filter(i => i.pedido_id === p.id).map(i => ({ producto_id: i.producto_id, cantidad: num(i.cantidad), precio: num(i.precio), subtotal: num(i.subtotal) })),
  }));
}

/* ───────── ESTADO (requiere sesión) ─────────
   admin/proveedor → todo el negocio. cliente → sólo su propio perfil, sus
   propios pedidos y los mensajes de esos pedidos (nunca los de otros clientes,
   ni el PIN del admin, ni compras/ventas/proveedores). */
app.get('/api/state', requireAuth, async (req, res) => {
  try {
    const pool = getPool();
    const [[cfg]] = await pool.query('SELECT * FROM config WHERE id=1');
    const [[meta]] = await pool.query('SELECT seq FROM app_meta WHERE id=1');
    const [categorias] = await pool.query('SELECT * FROM categorias');
    const [prods] = await pool.query('SELECT * FROM productos');

    if (req.user.role === 'cliente') {
      const refId = req.user.ref_id;
      const [clientes] = await pool.query('SELECT * FROM clientes WHERE id=?', [refId]);
      const [peds] = await pool.query('SELECT * FROM pedidos WHERE cliente_id=?', [refId]);
      const pedIds = peds.map(p => p.id);
      const [items] = pedIds.length ? await pool.query('SELECT * FROM pedido_items WHERE pedido_id IN (?)', [pedIds]) : [[]];
      const [mensajes] = pedIds.length ? await pool.query('SELECT * FROM mensajes WHERE pedido_id IN (?)', [pedIds]) : [[]];

      return res.json({
        config: { nombre: cfg.nombre, logo: cfg.logo || '', moneda: cfg.moneda, tema: cfg.tema, banners: arr(cfg.banners), pago: cfg.pago || {} },
        seq: meta ? meta.seq : {},
        categorias,
        proveedores: [],
        clientes: clientes.map(c => ({ ...c, registrado: !!c.registrado })),
        productos: prods.map(mapProducto),
        compras: [], ventas: [], movimientos: [],
        pedidos: mapPedidos(peds, items),
        mensajes: mensajes.map(m => ({ ...m, leido: !!m.leido })),
      });
    }

    // admin / proveedor: estado completo del negocio
    const [proveedores] = await pool.query('SELECT * FROM proveedores');
    const [clientes] = await pool.query('SELECT * FROM clientes');
    const [compras] = await pool.query('SELECT * FROM compras');
    const [ventas] = await pool.query('SELECT * FROM ventas');
    const [movimientos] = await pool.query('SELECT * FROM movimientos');
    const [peds] = await pool.query('SELECT * FROM pedidos');
    const [items] = await pool.query('SELECT * FROM pedido_items');
    const [mensajes] = await pool.query('SELECT * FROM mensajes');

    res.json({
      config: { nombre: cfg.nombre, logo: cfg.logo || '', moneda: cfg.moneda, tema: cfg.tema, pinAdmin: cfg.pin_admin, banners: arr(cfg.banners), pago: cfg.pago || {} },
      seq: meta ? meta.seq : {},
      categorias,
      proveedores,
      clientes: clientes.map(c => ({ ...c, registrado: !!c.registrado })),
      productos: prods.map(mapProducto),
      compras: compras.map(x => ({ ...x, precio: num(x.precio) })),
      ventas: ventas.map(x => ({ ...x, precio: num(x.precio), total: num(x.total) })),
      movimientos,
      pedidos: mapPedidos(peds, items),
      mensajes: mensajes.map(m => ({ ...m, leido: !!m.leido })),
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ───────── GUARDAR ESTADO COMPLETO (sólo admin/proveedor) ───────── */
async function guardarEstadoCompleto(c, db) {
  await c.query('SET FOREIGN_KEY_CHECKS = 0');
  for (const t of ['mensajes','pedido_items','pedidos','movimientos','ventas','compras','productos','clientes','proveedores','categorias'])
    await c.query(`TRUNCATE TABLE ${t}`);

  if (db.config) {
    const cf = db.config;
    await c.query('UPDATE config SET nombre=?,logo=?,moneda=?,tema=?,pin_admin=?,banners=?,pago=? WHERE id=1',
      [cf.nombre, cf.logo || '', cf.moneda, cf.tema, cf.pinAdmin || '1234', JSON.stringify(cf.banners || []), JSON.stringify(cf.pago || {})]);
  }
  if (db.seq) await c.query('UPDATE app_meta SET seq=? WHERE id=1', [JSON.stringify(db.seq)]);

  for (const x of db.categorias || [])
    await c.query('INSERT INTO categorias (id,nombre,descripcion,estado) VALUES (?,?,?,?)', [x.id, x.nombre, x.descripcion || '', x.estado || 'activo']);
  for (const x of db.proveedores || [])
    await c.query('INSERT INTO proveedores (id,nombre,telefono,correo,empresa,direccion,whatsapp,estado) VALUES (?,?,?,?,?,?,?,?)', [x.id, x.nombre, x.telefono || '', x.correo || '', x.empresa || '', x.direccion || '', x.whatsapp || '', x.estado || 'activo']);
  for (const x of db.clientes || [])
    await c.query('INSERT INTO clientes (id,nombre,telefono,correo,direccion,whatsapp,pin,registrado) VALUES (?,?,?,?,?,?,?,?)', [x.id, x.nombre, x.telefono || '', x.correo || '', x.direccion || '', x.whatsapp || '', x.pin || '0000', x.registrado ? 1 : 0]);
  for (const x of db.productos || [])
    await c.query('INSERT INTO productos (id,codigo,nombre,categoria_id,descripcion,precio_compra,precio_venta,stock,stock_min,imagen,estado,destacado,marca,tipo_piel) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      [x.id, x.codigo || '', x.nombre, x.categoria_id || null, x.descripcion || '', num(x.precio_compra), num(x.precio_venta), num(x.stock), num(x.stock_min), x.imagen || '', x.estado || 'activo', x.destacado ? 1 : 0, x.marca || '', JSON.stringify(x.tipoPiel || [])]);
  for (const x of db.compras || [])
    await c.query('INSERT INTO compras (id,producto_id,proveedor_id,cantidad,precio,fecha,obs) VALUES (?,?,?,?,?,?,?)', [x.id, x.producto_id || null, x.proveedor_id || null, num(x.cantidad), num(x.precio), x.fecha, x.obs || '']);
  for (const x of db.ventas || [])
    await c.query('INSERT INTO ventas (id,producto_id,cliente_id,cantidad,precio,fecha,total) VALUES (?,?,?,?,?,?,?)', [x.id, x.producto_id || null, x.cliente_id || null, num(x.cantidad), num(x.precio), x.fecha, num(x.total)]);
  for (const x of db.movimientos || [])
    await c.query('INSERT INTO movimientos (id,tipo,signo,producto_id,cantidad,fecha,usuario,obs) VALUES (?,?,?,?,?,?,?,?)', [x.id, x.tipo, x.signo || null, x.producto_id || null, num(x.cantidad), x.fecha, x.usuario || '', x.obs || '']);
  for (const p of db.pedidos || []) {
    await c.query('INSERT INTO pedidos (id,cliente_id,total,nota,fecha,estado,metodo_pago,comprobante) VALUES (?,?,?,?,?,?,?,?)', [p.id, p.cliente_id || null, num(p.total), p.nota || '', p.fecha, p.estado || 'pendiente', p.metodoPago || '', p.comprobante || '']);
    for (const it of p.items || [])
      await c.query('INSERT INTO pedido_items (pedido_id,producto_id,cantidad,precio,subtotal) VALUES (?,?,?,?,?)', [p.id, it.producto_id || null, num(it.cantidad), num(it.precio), num(it.subtotal)]);
  }
  for (const m of db.mensajes || [])
    await c.query('INSERT INTO mensajes (id,pedido_id,autor,texto,fecha,leido) VALUES (?,?,?,?,?,?)', [m.id, m.pedido_id, m.autor, m.texto, dtMysql(m.fecha), m.leido ? 1 : 0]);

  await c.query('SET FOREIGN_KEY_CHECKS = 1');
}

/* ───────── GUARDAR ESTADO (cliente) ─────────
   Un cliente sólo puede: crear/ampliar/cancelar SUS PROPIOS pedidos (mientras
   sigan 'pendiente'), enviar mensajes en el chat de esos pedidos (como
   'cliente', nunca suplantando a 'admin') y marcar como leídos los mensajes
   que le contestaron. Todo lo demás del payload (productos, precios,
   categorías, proveedores, compras, ventas, movimientos, config, otros
   clientes u otros pedidos) se ignora por completo: nunca se toca esa tabla. */
async function guardarEstadoCliente(c, refId, db) {
  // ── Pedidos propios ──
  const pedidosEnviados = (db.pedidos || []).filter(p => p && p.cliente_id === refId && p.id != null);
  const idsEnviados = pedidosEnviados.map(p => p.id);
  const [existentesRows] = idsEnviados.length
    ? await c.query('SELECT id, cliente_id, estado FROM pedidos WHERE id IN (?)', [idsEnviados])
    : [[]];
  const existentePorId = new Map(existentesRows.map(p => [p.id, p]));

  for (const p of pedidosEnviados) {
    const existente = existentePorId.get(p.id);
    if (existente && existente.cliente_id !== refId) continue;   // id ya usado por otro cliente: ignorar
    if (existente && existente.estado !== 'pendiente') continue; // ya no editable (aprobado/entregado/cancelado)

    const items = arr(p.items);
    const productoIds = [...new Set(items.map(it => it && it.producto_id).filter(Boolean))];
    const [prodRows] = productoIds.length
      ? await c.query('SELECT id, precio_venta FROM productos WHERE id IN (?)', [productoIds])
      : [[]];
    const precios = new Map(prodRows.map(pr => [pr.id, num(pr.precio_venta)]));

    const itemsCalc = items
      .filter(it => it && precios.has(it.producto_id) && num(it.cantidad) > 0)
      .map(it => {
        const precio = precios.get(it.producto_id);
        const cantidad = num(it.cantidad);
        return { producto_id: it.producto_id, cantidad, precio, subtotal: +(precio * cantidad).toFixed(2) };
      });
    const total = +itemsCalc.reduce((s, i) => s + i.subtotal, 0).toFixed(2);
    const nota = String(p.nota || '').slice(0, 500);
    const estado = p.estado === 'cancelado' ? 'cancelado' : 'pendiente'; // el cliente no puede fijar 'aprobado'/'entregado'
    const comprobante = String(p.comprobante || '');
    const metodoPago = String(p.metodoPago || '');

    if (!existente) {
      const fecha = new Date().toISOString().slice(0, 10);
      await c.query('INSERT INTO pedidos (id,cliente_id,total,nota,fecha,estado,metodo_pago,comprobante) VALUES (?,?,?,?,?,?,?,?)',
        [p.id, refId, total, nota, fecha, estado, metodoPago, comprobante]);
    } else {
      await c.query('UPDATE pedidos SET total=?,nota=?,estado=?,metodo_pago=?,comprobante=? WHERE id=? AND cliente_id=?',
        [total, nota, estado, metodoPago, comprobante, p.id, refId]);
      await c.query('DELETE FROM pedido_items WHERE pedido_id=?', [p.id]);
    }
    for (const it of itemsCalc)
      await c.query('INSERT INTO pedido_items (pedido_id,producto_id,cantidad,precio,subtotal) VALUES (?,?,?,?,?)',
        [p.id, it.producto_id, it.cantidad, it.precio, it.subtotal]);
  }

  // ── Mensajes de chat, sólo dentro de pedidos propios ──
  const [pedRows] = await c.query('SELECT id FROM pedidos WHERE cliente_id=?', [refId]);
  const misPedidoIds = new Set(pedRows.map(r => r.id));
  const [msgRows] = misPedidoIds.size
    ? await c.query('SELECT id, autor FROM mensajes WHERE pedido_id IN (?)', [[...misPedidoIds]])
    : [[]];
  const msgExistente = new Map(msgRows.map(m => [m.id, m]));

  for (const m of db.mensajes || []) {
    if (!m || m.id == null || !misPedidoIds.has(m.pedido_id)) continue; // mensaje fuera de sus pedidos: ignorar
    const existente = msgExistente.get(m.id);
    if (!existente) {
      // Mensaje nuevo: siempre se crea a nombre de 'cliente', nunca suplantando al admin
      await c.query('INSERT INTO mensajes (id,pedido_id,autor,texto,fecha,leido) VALUES (?,?,?,?,?,?)',
        [m.id, m.pedido_id, 'cliente', String(m.texto || '').slice(0, 2000), dtMysql(new Date().toISOString()), 0]);
    } else if (existente.autor !== 'cliente') {
      // Mensaje del admin: sólo se permite marcarlo como leído
      await c.query('UPDATE mensajes SET leido=? WHERE id=?', [m.leido ? 1 : 0, m.id]);
    }
    // Mensaje propio ya existente: no editable, se ignora
  }

  // ── Secuencias: sólo avanzan (nunca retroceden) y sólo para pedido/mensaje ──
  const [[meta]] = await c.query('SELECT seq FROM app_meta WHERE id=1');
  const seqActual = (meta && meta.seq) || {};
  const seqEnviado = (db.seq && typeof db.seq === 'object') ? db.seq : {};
  const seqNuevo = { ...seqActual };
  for (const k of ['pedido', 'mensaje']) seqNuevo[k] = Math.max(num(seqActual[k]), num(seqEnviado[k]));
  await c.query('UPDATE app_meta SET seq=? WHERE id=1', [JSON.stringify(seqNuevo)]);
}

app.put('/api/state', requireAuth, async (req, res) => {
  const db = req.body || {};
  const pool = getPool();
  const c = await pool.getConnection();
  try {
    await c.beginTransaction();
    if (req.user.role === 'cliente') await guardarEstadoCliente(c, req.user.ref_id, db);
    else await guardarEstadoCompleto(c, db);
    await c.commit();
    res.json({ ok: true });
  } catch (e) {
    await c.rollback();
    res.status(500).json({ error: e.message });
  } finally { c.release(); }
});

/* ───────── ARRANQUE ───────── */
initDb()
  .then(() => app.listen(PORT, () => {
    console.log(`\n🌸 Belle Stock backend en http://localhost:${PORT}`);
    console.log(`   Tienda: http://localhost:${PORT}/tienda.html`);
    console.log(`   Admin:  http://localhost:${PORT}/admin.html\n`);
  }))
  .catch(err => { console.error('❌ No se pudo conectar a MySQL:', err.code || err.message || err); process.exit(1); });
