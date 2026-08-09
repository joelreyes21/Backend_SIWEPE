/*! SIWEPE · © 2026 Joel Reyes. Todos los derechos reservados. · Prohibida su reproduccion o distribucion sin autorizacion. */
/* server.js — API REST + sirve la web (SIWEPE)
   Arranca con: npm start   →   http://localhost:3000/tienda.html */
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const { initDb, getPool } = require('./db');
const { hashPassword, checkPassword, signToken, requireAuth, requireRole, isHashed } = require('./auth');

const app = express();
const PORT = process.env.PORT || 3000;

/* Detrás de un proxy (Railway u otro), confiar en X-Forwarded-For para que
   req.ip sea la IP real del cliente y no la del proxy — si no, el limitador
   de intentos de abajo agrupa a todos los usuarios bajo la misma IP. */
app.set('trust proxy', 1);

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

/* ───────── CORREO (Resend) para verificación de empresas ───────── */
const { Resend } = require('resend');
const crypto = require('crypto');
const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;
const PUBLIC_API_URL = process.env.PUBLIC_API_URL || `http://localhost:${PORT}`;
const SITE_URL = process.env.SITE_URL || 'https://siwepe.shop';
const slugify = s => String(s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'empresa';
async function enviarVerificacion(correo, nombre, token) {
  const link = `${PUBLIC_API_URL}/api/empresas/verificar/${token}`;
  if (!resend) { console.warn('RESEND_API_KEY no configurada. Link de verificación:', link); return; }
  const remitente = process.env.MAIL_FROM || 'SIWEPE <onboarding@resend.dev>';
  // El SDK de Resend NO lanza excepción cuando la API rechaza el envío: devuelve
  // { data, error }. Hay que revisar `error` a mano, si no el fallo pasa en silencio.
  const { data, error } = await resend.emails.send({
    from: remitente,
    to: correo,
    subject: 'Verificá tu empresa en SIWEPE',
    html: `<div style="font-family:Arial,sans-serif;max-width:480px;margin:auto;color:#21303D">
      <h2 style="color:#4F86C6">Bienvenido a SIWEPE</h2>
      <p>Hola ${nombre}, gracias por registrar tu empresa.</p>
      <p>Para activarla, confirmá tu correo:</p>
      <p style="text-align:center;margin:24px 0"><a href="${link}" style="background:#4F86C6;color:#fff;padding:12px 26px;border-radius:8px;text-decoration:none;font-weight:bold">Verificar mi empresa</a></p>
      <p style="color:#888;font-size:13px">Si no fuiste vos, ignorá este correo.</p>
    </div>`
  });
  if (error) {
    console.error(`Error enviando correo (Resend) · from="${remitente}" to="${correo}" ->`, JSON.stringify(error));
    throw new Error(error.message || 'Resend rechazó el envío');
  }
  console.log('Correo de verificación enviado a', correo, '· id:', data && data.id);
  return data;
}

/* Resuelve una empresa ACTIVA a partir de su slug o su id numérico.
   Devuelve el id (número) o null si no existe / no está activa. */
async function empresaIdDe(ref) {
  if (ref == null || ref === '') return null;
  const pool = getPool();
  const s = String(ref).trim();
  const campo = /^\d+$/.test(s) ? 'id' : 'slug';
  const [r] = await pool.query(`SELECT id FROM empresas WHERE ${campo}=? AND estado='activa' LIMIT 1`, [campo === 'id' ? Number(s) : s]);
  return r.length ? r[0].id : null;
}

/* ───────── EMPRESAS (registro con verificación por correo) ───────── */
app.post('/api/empresas', limitarIntentos(5, 15 * 60 * 1000), async (req, res) => {
  const { nombre, rubro, descripcion, telefono, ciudad, pais, logo, dueno, correo, password } = req.body || {};
  if (!nombre || !dueno || !correo || !password) return res.status(400).json({ error: 'Faltan datos obligatorios' });
  if (String(password).length < 8) return res.status(400).json({ error: 'La contraseña debe tener al menos 8 caracteres' });
  const email = String(correo).toLowerCase().trim();
  const pool = getPool();
  try {
    // NADA se crea todavía: la empresa y la cuenta se crean SÓLO cuando se
    // confirma el correo (en /api/empresas/verificar/:token). Aquí sólo dejamos
    // la solicitud "en espera".
    const [dupU] = await pool.query('SELECT id FROM users WHERE email=? LIMIT 1', [email]);
    if (dupU.length) return res.status(409).json({ error: 'Ya existe una cuenta con ese correo' });

    const token = crypto.randomBytes(24).toString('hex');
    // 1) Enviar el correo PRIMERO. Si no se puede enviar, no guardamos nada.
    try {
      await enviarVerificacion(email, dueno.trim(), token);
    } catch (e) {
      console.warn('Registro abortado: no se pudo enviar el correo de verificación:', e.message);
      return res.status(502).json({ error: 'No pudimos enviar el correo de verificación a esa dirección. Revisá que el correo esté bien escrito e intentá de nuevo.' });
    }
    // 2) Guardar la solicitud PENDIENTE (todavía NO es empresa ni usuario).
    //    Reemplaza cualquier solicitud previa sin confirmar del mismo correo.
    await pool.query('DELETE FROM registros_pendientes WHERE correo=?', [email]);
    await pool.query(
      'INSERT INTO registros_pendientes (token,nombre,rubro,descripcion,telefono,ciudad,pais,logo,correo,dueno,password_hash) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
      [token, nombre.trim(), rubro || '', descripcion || '', telefono || '', ciudad || '', pais || '', logo || '', email, dueno.trim(), hashPassword(password)]);
    res.json({ ok: true, correo: email });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Lista pública de empresas activas (para "Descubrir empresas")
app.get('/api/empresas', async (req, res) => {
  try {
    const [rows] = await getPool().query("SELECT id,slug,nombre,rubro,ciudad,pais,logo FROM empresas WHERE estado='activa' ORDER BY nombre");
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Verificar el correo → RECIÉN AQUÍ se crea la empresa, la cuenta admin, su
// config y contadores. Si nunca se confirma, nada de esto llega a existir.
// El enlace vence a las 24 horas.
app.get('/api/empresas/verificar/:token', async (req, res) => {
  const pool = getPool();
  const c = await pool.getConnection();
  try {
    const [rows] = await pool.query(
      'SELECT * FROM registros_pendientes WHERE token=? AND created_at > (NOW() - INTERVAL 24 HOUR) LIMIT 1',
      [req.params.token]);
    if (!rows.length) return res.redirect(`${SITE_URL}/index.html?verify=invalido`);
    const r = rows[0];

    await c.beginTransaction();
    // Si mientras tanto alguien ya creó una cuenta con ese correo, abortar.
    const [dupU] = await c.query('SELECT id FROM users WHERE email=? LIMIT 1', [r.correo]);
    if (dupU.length) {
      await c.rollback();
      await pool.query('DELETE FROM registros_pendientes WHERE token=?', [req.params.token]);
      return res.redirect(`${SITE_URL}/index.html?verify=invalido`);
    }
    // slug único
    let base = slugify(r.nombre), slug = base, n = 1;
    for (;;) { const [ex] = await c.query('SELECT id FROM empresas WHERE slug=? LIMIT 1', [slug]); if (!ex.length) break; slug = base + '-' + (++n); }
    // Empresa ACTIVA
    const [ins] = await c.query(
      "INSERT INTO empresas (slug,nombre,rubro,descripcion,telefono,ciudad,pais,logo,correo,estado,verify_token) VALUES (?,?,?,?,?,?,?,?,?,'activa',NULL)",
      [slug, r.nombre, r.rubro || '', r.descripcion || '', r.telefono || '', r.ciudad || '', r.pais || '', r.logo || '', r.correo]);
    const empresaId = ins.insertId;
    // Cuenta admin ACTIVA (reutiliza el hash ya calculado en el registro)
    await c.query('INSERT INTO users (nombre,email,password_hash,role,empresa_id,activo) VALUES (?,?,?,?,?,1)',
      [r.dueno, r.correo, r.password_hash, 'admin', empresaId]);
    // Config y contadores propios de la empresa
    await c.query('INSERT INTO config (empresa_id,nombre,logo,moneda,tema,pin_admin,banners,pago) VALUES (?,?,?,?,?,?,?,?)',
      [empresaId, r.nombre, r.logo || '', 'L', 'cielo', '1234', JSON.stringify([]), JSON.stringify({ banco: '', cuenta: '', titular: '', tipo: '', nota: '' })]);
    await c.query('INSERT INTO app_meta (empresa_id,seq) VALUES (?,?)',
      [empresaId, JSON.stringify({ producto: 0, categoria: 0, proveedor: 0, cliente: 0, compra: 0, venta: 0, movimiento: 0, pedido: 0, mensaje: 0 })]);
    // Ya es empresa real: quitar la solicitud pendiente
    await c.query('DELETE FROM registros_pendientes WHERE token=?', [req.params.token]);
    await c.commit();
    res.redirect(`${SITE_URL}/index.html?verify=ok`);
  } catch (e) {
    await c.rollback().catch(() => {});
    res.status(500).send('Error: ' + e.message);
  } finally { c.release(); }
});

/* ───────── AUTENTICACIÓN ───────── */

// Admin / proveedor (email + contraseña)
app.post('/api/auth/login', limitarIntentos(10, 10 * 60 * 1000), async (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) return res.status(400).json({ error: 'Faltan datos' });
    const [rows] = await getPool().query('SELECT * FROM users WHERE email=? AND activo=1 LIMIT 1', [String(email).toLowerCase().trim()]);
    const u = rows[0];
    if (!u || !checkPassword(password, u.password_hash)) return res.status(401).json({ error: 'Correo o contraseña incorrectos' });
    const token = signToken({ id: u.id, nombre: u.nombre, role: u.role, empresa_id: u.empresa_id, ref_id: u.ref_id });
    res.json({ token, user: { id: u.id, nombre: u.nombre, role: u.role, empresa_id: u.empresa_id, ref_id: u.ref_id } });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Cliente (nombre + PIN) — PIN de 4 dígitos: limitar intentos es crítico
app.post('/api/auth/cliente-login', limitarIntentos(8, 10 * 60 * 1000), async (req, res) => {
  try {
    const { nombre, pin, empresa } = req.body || {};
    if (!nombre || !pin) return res.status(400).json({ error: 'Faltan datos' });
    const empresaId = await empresaIdDe(empresa);
    if (!empresaId) return res.status(400).json({ error: 'Tienda no válida' });
    const [rows] = await getPool().query('SELECT * FROM clientes WHERE empresa_id=? AND LOWER(nombre)=? LIMIT 1', [empresaId, String(nombre).toLowerCase().trim()]);
    const c = rows[0];
    if (!c || !checkPassword(String(pin).trim(), c.pin)) return res.status(401).json({ error: 'Nombre o PIN incorrecto' });
    const token = signToken({ id: c.id, nombre: c.nombre, role: 'cliente', empresa_id: empresaId, ref_id: c.id });
    res.json({ token, cliente: c });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Registro de cliente nuevo
app.post('/api/auth/register', limitarIntentos(6, 10 * 60 * 1000), async (req, res) => {
  const { nombre, pin, telefono, correo, direccion, empresa } = req.body || {};
  if (!nombre || !pin || String(pin).length < 4) return res.status(400).json({ error: 'Nombre y PIN (mín. 4 dígitos) obligatorios' });
  const empresaId = await empresaIdDe(empresa);
  if (!empresaId) return res.status(400).json({ error: 'Tienda no válida' });
  const pool = getPool();
  const c = await pool.getConnection();
  try {
    await c.beginTransaction();
    // Bloquea la fila de secuencias de ESTA empresa para serializar altas concurrentes
    // y evitar que dos registros al mismo tiempo calculen el mismo id de cliente.
    const [mrows] = await c.query('SELECT seq FROM app_meta WHERE empresa_id=? FOR UPDATE', [empresaId]);
    const [dup] = await c.query('SELECT id FROM clientes WHERE empresa_id=? AND LOWER(nombre)=? LIMIT 1', [empresaId, String(nombre).toLowerCase().trim()]);
    if (dup.length) {
      await c.rollback();
      return res.status(409).json({ error: 'Ya existe un cliente con ese nombre en esta tienda' });
    }
    // siguiente id (respeta la secuencia del front-end, por empresa)
    const seq = mrows[0] ? mrows[0].seq : {};
    const [maxr] = await c.query('SELECT COALESCE(MAX(id),0) AS m FROM clientes WHERE empresa_id=?', [empresaId]);
    const nid = Math.max(seq.cliente || 0, maxr[0].m) + 1;
    await c.query('INSERT INTO clientes (empresa_id,id,nombre,telefono,correo,direccion,whatsapp,pin,registrado) VALUES (?,?,?,?,?,?,?,?,1)',
      [empresaId, nid, nombre.trim(), telefono || '—', correo || '—', direccion || '—', '', hashPassword(String(pin).trim())]);
    seq.cliente = nid;
    await c.query('UPDATE app_meta SET seq=? WHERE empresa_id=?', [JSON.stringify(seq), empresaId]);
    await c.commit();
    const [rows] = await pool.query('SELECT * FROM clientes WHERE empresa_id=? AND id=?', [empresaId, nid]);
    const token = signToken({ id: nid, nombre: nombre.trim(), role: 'cliente', empresa_id: empresaId, ref_id: nid });
    res.json({ token, cliente: rows[0] });
  } catch (e) {
    await c.rollback().catch(() => {});
    res.status(500).json({ error: e.message });
  } finally {
    c.release();
  }
});

app.get('/api/me', requireAuth, (req, res) => res.json({ user: req.user }));

/* ───────── PERFIL DE MI EMPRESA ─────────
   nombre/rubro/descripcion/telefono/ciudad/pais/logo viven en `empresas`,
   NO en `config` — así que GET /api/state (que sólo lee `config`) nunca los
   devuelve, y hasta ahora no había forma de editarlos después del registro
   (POST /api/empresas sólo los ESCRIBE una vez, al crear la solicitud
   pendiente). Estas dos rutas son las únicas que los exponen. */
app.get('/api/empresas/mi', requireAuth, requireRole('admin'), async (req, res) => {
  const empresaId = req.user.empresa_id;
  if (!empresaId) return res.status(403).json({ error: 'Tu usuario no está asociado a ninguna empresa' });
  try {
    const [[fila]] = await getPool().query(
      'SELECT id,slug,nombre,rubro,descripcion,telefono,ciudad,pais,logo,correo FROM empresas WHERE id=?', [empresaId]);
    if (!fila) return res.status(404).json({ error: 'Empresa no encontrada' });
    res.json(fila);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/empresas/mi', requireAuth, requireRole('admin'), async (req, res) => {
  const empresaId = req.user.empresa_id;
  if (!empresaId) return res.status(403).json({ error: 'Tu usuario no está asociado a ninguna empresa' });
  const { nombre, rubro, descripcion, telefono, ciudad, pais, logo } = req.body || {};
  if (!nombre || !String(nombre).trim()) return res.status(400).json({ error: 'Falta el nombre del negocio' });
  try {
    await getPool().query(
      'UPDATE empresas SET nombre=?, rubro=?, descripcion=?, telefono=?, ciudad=?, pais=?, logo=? WHERE id=?',
      [String(nombre).trim(), rubro || '', descripcion || '', telefono || '', ciudad || '', pais || '', logo || '', empresaId]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/* ───────── PERFIL DE MI CUENTA (cliente) ─────────
   nombre/telefono/correo/direccion/whatsapp viven en `clientes`. GET /api/state
   ya devuelve la fila propia del cliente logueado, pero PUT /api/state la
   ignora por completo (guardarEstadoCliente sólo toca pedidos/mensajes) —
   esta ruta es la única forma de editarla después del registro. */
app.put('/api/clientes/mi', requireAuth, requireRole('cliente'), async (req, res) => {
  const empresaId = req.user.empresa_id;
  const refId = req.user.ref_id;
  if (!empresaId || !refId) return res.status(403).json({ error: 'Sesión de cliente inválida' });
  const { nombre, telefono, correo, direccion, whatsapp } = req.body || {};
  if (!nombre || !String(nombre).trim()) return res.status(400).json({ error: 'Falta el nombre' });
  try {
    await getPool().query(
      'UPDATE clientes SET nombre=?, telefono=?, correo=?, direccion=?, whatsapp=? WHERE empresa_id=? AND id=?',
      [String(nombre).trim(), telefono || '', correo || '', direccion || '', whatsapp || '', empresaId, refId]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Crear (o actualizar) un usuario del sistema — solo un admin puede hacerlo
app.post('/api/users', requireAuth, requireRole('admin'), async (req, res) => {
  try {
    const { nombre, email, password, role } = req.body || {};
    if (!email || !password) return res.status(400).json({ error: 'Correo y contraseña obligatorios' });
    // Solo admin/proveedor: 'cliente' entra por nombre+PIN contra la tabla `clientes`,
    // no por email+contraseña contra `users` — permitirlo aquí crearía una cuenta
    // huérfana que nunca podría iniciar sesión.
    if (!['admin', 'proveedor'].includes(role)) {
      return res.status(400).json({ error: "Rol inválido: usa 'admin' o 'proveedor'" });
    }
    const correo = String(email).toLowerCase().trim();
    const pool = getPool();
    const [ex] = await pool.query('SELECT id FROM users WHERE email=? LIMIT 1', [correo]);
    if (ex.length) {
      await pool.query('UPDATE users SET nombre=?, password_hash=?, role=?, activo=1 WHERE email=?',
        [nombre || 'Usuario', hashPassword(password), role, correo]);
      return res.json({ ok: true, actualizado: true, email: correo, role });
    }
    await pool.query('INSERT INTO users (nombre,email,password_hash,role,empresa_id,activo) VALUES (?,?,?,?,?,1)',
      [nombre || 'Usuario', correo, hashPassword(password), role, req.user.empresa_id || null]);
    res.json({ ok: true, creado: true, email: correo, role });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ───────── CATÁLOGO PÚBLICO (para navegar sin iniciar sesión) ───────── */
app.get('/api/catalog', async (req, res) => {
  try {
    const empresaId = await empresaIdDe(req.query.empresa);
    if (!empresaId) return res.status(404).json({ error: 'Tienda no encontrada' });
    const pool = getPool();
    const [cfg] = await pool.query('SELECT * FROM config WHERE empresa_id=?', [empresaId]);
    const [cats] = await pool.query('SELECT * FROM categorias WHERE empresa_id=?', [empresaId]);
    const [prods] = await pool.query('SELECT * FROM productos WHERE empresa_id=?', [empresaId]);
    const c = cfg[0] || {};
    res.json({
      empresa_id: empresaId,
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
    const empresaId = req.user.empresa_id;
    if (!empresaId) return res.status(403).json({ error: 'Tu usuario no está asociado a ninguna empresa' });
    const pool = getPool();
    const [[cfg]] = await pool.query('SELECT * FROM config WHERE empresa_id=?', [empresaId]);
    const [[meta]] = await pool.query('SELECT seq FROM app_meta WHERE empresa_id=?', [empresaId]);
    const [categorias] = await pool.query('SELECT id,nombre,descripcion,estado FROM categorias WHERE empresa_id=?', [empresaId]);
    const [prods] = await pool.query('SELECT * FROM productos WHERE empresa_id=?', [empresaId]);
    const cfgBase = cfg || { nombre: 'SIWEPE', moneda: 'L', tema: 'cielo' };

    if (req.user.role === 'cliente') {
      const refId = req.user.ref_id;
      const [clientes] = await pool.query('SELECT * FROM clientes WHERE empresa_id=? AND id=?', [empresaId, refId]);
      const [peds] = await pool.query('SELECT * FROM pedidos WHERE empresa_id=? AND cliente_id=?', [empresaId, refId]);
      const pedIds = peds.map(p => p.id);
      const [items] = pedIds.length ? await pool.query('SELECT * FROM pedido_items WHERE empresa_id=? AND pedido_id IN (?)', [empresaId, pedIds]) : [[]];
      const [mensajes] = pedIds.length ? await pool.query('SELECT * FROM mensajes WHERE empresa_id=? AND pedido_id IN (?)', [empresaId, pedIds]) : [[]];

      return res.json({
        config: { nombre: cfgBase.nombre, logo: cfgBase.logo || '', moneda: cfgBase.moneda, tema: cfgBase.tema, banners: arr(cfgBase.banners), pago: cfgBase.pago || {} },
        seq: meta ? meta.seq : {},
        categorias,
        proveedores: [],
        clientes: clientes.map(c => ({ id: c.id, nombre: c.nombre, telefono: c.telefono, correo: c.correo, direccion: c.direccion, whatsapp: c.whatsapp, registrado: !!c.registrado })),
        productos: prods.map(mapProducto),
        compras: [], ventas: [], movimientos: [],
        pedidos: mapPedidos(peds, items),
        mensajes: mensajes.map(m => ({ id: m.id, pedido_id: m.pedido_id, autor: m.autor, texto: m.texto, fecha: m.fecha, leido: !!m.leido })),
      });
    }

    // admin / proveedor: estado completo del negocio (de SU empresa)
    const [proveedores] = await pool.query('SELECT id,nombre,telefono,correo,empresa,direccion,whatsapp,estado FROM proveedores WHERE empresa_id=?', [empresaId]);
    const [clientes] = await pool.query('SELECT * FROM clientes WHERE empresa_id=?', [empresaId]);
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

/* ───────── GUARDAR ESTADO COMPLETO (sólo admin/proveedor) ─────────
   Sobrescribe SÓLO los datos de la empresa `E`: borra e inserta usando
   empresa_id=E en cada tabla, así nunca toca los datos de otras empresas. */
async function guardarEstadoCompleto(c, E, db) {
  await c.query('SET FOREIGN_KEY_CHECKS = 0');
  try {
    // DELETE (no TRUNCATE): TRUNCATE hace commit implícito en MySQL/InnoDB, lo que
    // rompería la atomicidad de la transacción — un error a mitad de esta función
    // dejaría las tablas ya "truncadas" vacías para siempre, sin poder revertir.
    for (const t of ['mensajes','pedido_items','pedidos','movimientos','ventas','compras','productos','clientes','proveedores','categorias'])
      await c.query(`DELETE FROM ${t} WHERE empresa_id=?`, [E]);

    if (db.config) {
      const cf = db.config;
      // UPSERT: si la empresa aún no tiene fila de config, la crea.
      await c.query(
        'INSERT INTO config (empresa_id,nombre,logo,moneda,tema,pin_admin,banners,pago) VALUES (?,?,?,?,?,?,?,?) ' +
        'ON DUPLICATE KEY UPDATE nombre=VALUES(nombre),logo=VALUES(logo),moneda=VALUES(moneda),tema=VALUES(tema),pin_admin=VALUES(pin_admin),banners=VALUES(banners),pago=VALUES(pago)',
        [E, cf.nombre || 'SIWEPE', cf.logo || '', cf.moneda || 'L', cf.tema || 'cielo', cf.pinAdmin || '1234', JSON.stringify(cf.banners || []), JSON.stringify(cf.pago || {})]);
    }
    if (db.seq) await c.query('INSERT INTO app_meta (empresa_id,seq) VALUES (?,?) ON DUPLICATE KEY UPDATE seq=VALUES(seq)', [E, JSON.stringify(db.seq)]);

    for (const x of db.categorias || [])
      await c.query('INSERT INTO categorias (empresa_id,id,nombre,descripcion,estado) VALUES (?,?,?,?,?)', [E, x.id, x.nombre, x.descripcion || '', x.estado || 'activo']);
    for (const x of db.proveedores || [])
      await c.query('INSERT INTO proveedores (empresa_id,id,nombre,telefono,correo,empresa,direccion,whatsapp,estado) VALUES (?,?,?,?,?,?,?,?,?)', [E, x.id, x.nombre, x.telefono || '', x.correo || '', x.empresa || '', x.direccion || '', x.whatsapp || '', x.estado || 'activo']);
    for (const x of db.clientes || [])
      await c.query('INSERT INTO clientes (empresa_id,id,nombre,telefono,correo,direccion,whatsapp,pin,registrado) VALUES (?,?,?,?,?,?,?,?,?)',
        [E, x.id, x.nombre, x.telefono || '', x.correo || '', x.direccion || '', x.whatsapp || '', isHashed(x.pin) ? x.pin : hashPassword(String(x.pin || '0000')), x.registrado ? 1 : 0]);
    for (const x of db.productos || [])
      await c.query('INSERT INTO productos (empresa_id,id,codigo,nombre,categoria_id,descripcion,precio_compra,precio_venta,stock,stock_min,imagen,estado,destacado,marca,tipo_piel) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
        [E, x.id, x.codigo || '', x.nombre, x.categoria_id || null, x.descripcion || '', num(x.precio_compra), num(x.precio_venta), num(x.stock), num(x.stock_min), x.imagen || '', x.estado || 'activo', x.destacado ? 1 : 0, x.marca || '', JSON.stringify(x.tipoPiel || [])]);
    for (const x of db.compras || [])
      await c.query('INSERT INTO compras (empresa_id,id,producto_id,proveedor_id,cantidad,precio,fecha,obs) VALUES (?,?,?,?,?,?,?,?)', [E, x.id, x.producto_id || null, x.proveedor_id || null, num(x.cantidad), num(x.precio), x.fecha, x.obs || '']);
    for (const x of db.ventas || [])
      await c.query('INSERT INTO ventas (empresa_id,id,producto_id,cliente_id,cantidad,precio,fecha,total) VALUES (?,?,?,?,?,?,?,?)', [E, x.id, x.producto_id || null, x.cliente_id || null, num(x.cantidad), num(x.precio), x.fecha, num(x.total)]);
    for (const x of db.movimientos || [])
      await c.query('INSERT INTO movimientos (empresa_id,id,tipo,signo,producto_id,cantidad,fecha,usuario,obs) VALUES (?,?,?,?,?,?,?,?,?)', [E, x.id, x.tipo, x.signo || null, x.producto_id || null, num(x.cantidad), x.fecha, x.usuario || '', x.obs || '']);
    for (const p of db.pedidos || []) {
      await c.query('INSERT INTO pedidos (empresa_id,id,cliente_id,total,nota,fecha,estado,metodo_pago,comprobante) VALUES (?,?,?,?,?,?,?,?,?)', [E, p.id, p.cliente_id || null, num(p.total), p.nota || '', p.fecha, p.estado || 'pendiente', p.metodoPago || '', p.comprobante || '']);
      for (const it of p.items || [])
        await c.query('INSERT INTO pedido_items (empresa_id,pedido_id,producto_id,cantidad,precio,subtotal) VALUES (?,?,?,?,?,?)', [E, p.id, it.producto_id || null, num(it.cantidad), num(it.precio), num(it.subtotal)]);
    }
    for (const m of db.mensajes || [])
      await c.query('INSERT INTO mensajes (empresa_id,id,pedido_id,autor,texto,fecha,leido) VALUES (?,?,?,?,?,?,?)', [E, m.id, m.pedido_id, m.autor, m.texto, dtMysql(m.fecha), m.leido ? 1 : 0]);
  } finally {
    // Siempre reactivar los checks de FK, incluso si algo falló arriba — si no,
    // la conexión vuelve al pool con las validaciones apagadas para siempre.
    await c.query('SET FOREIGN_KEY_CHECKS = 1');
  }
}

/* ───────── GUARDAR ESTADO (cliente) ─────────
   Un cliente sólo puede: crear/ampliar/cancelar SUS PROPIOS pedidos (mientras
   sigan 'pendiente'), enviar mensajes en el chat de esos pedidos (como
   'cliente', nunca suplantando a 'admin') y marcar como leídos los mensajes
   que le contestaron. Todo lo demás del payload (productos, precios,
   categorías, proveedores, compras, ventas, movimientos, config, otros
   clientes u otros pedidos) se ignora por completo: nunca se toca esa tabla. */
async function guardarEstadoCliente(c, E, refId, db) {
  // ── Pedidos propios ── (todo acotado a la empresa E del cliente)
  const pedidosEnviados = (db.pedidos || []).filter(p => p && p.cliente_id === refId && p.id != null);
  const idsEnviados = pedidosEnviados.map(p => p.id);
  const [existentesRows] = idsEnviados.length
    ? await c.query('SELECT id, cliente_id, estado FROM pedidos WHERE empresa_id=? AND id IN (?)', [E, idsEnviados])
    : [[]];
  const existentePorId = new Map(existentesRows.map(p => [p.id, p]));

  for (const p of pedidosEnviados) {
    const existente = existentePorId.get(p.id);
    if (existente && existente.cliente_id !== refId) continue;   // id ya usado por otro cliente: ignorar
    if (existente && existente.estado !== 'pendiente') continue; // ya no editable (aprobado/entregado/cancelado)

    const items = arr(p.items);
    const productoIds = [...new Set(items.map(it => it && it.producto_id).filter(Boolean))];
    const [prodRows] = productoIds.length
      ? await c.query('SELECT id, precio_venta FROM productos WHERE empresa_id=? AND id IN (?)', [E, productoIds])
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
      await c.query('INSERT INTO pedidos (empresa_id,id,cliente_id,total,nota,fecha,estado,metodo_pago,comprobante) VALUES (?,?,?,?,?,?,?,?,?)',
        [E, p.id, refId, total, nota, fecha, estado, metodoPago, comprobante]);
    } else {
      await c.query('UPDATE pedidos SET total=?,nota=?,estado=?,metodo_pago=?,comprobante=? WHERE empresa_id=? AND id=? AND cliente_id=?',
        [total, nota, estado, metodoPago, comprobante, E, p.id, refId]);
      await c.query('DELETE FROM pedido_items WHERE empresa_id=? AND pedido_id=?', [E, p.id]);
    }
    for (const it of itemsCalc)
      await c.query('INSERT INTO pedido_items (empresa_id,pedido_id,producto_id,cantidad,precio,subtotal) VALUES (?,?,?,?,?,?)',
        [E, p.id, it.producto_id, it.cantidad, it.precio, it.subtotal]);
  }

  // ── Mensajes de chat, sólo dentro de pedidos propios ──
  const [pedRows] = await c.query('SELECT id FROM pedidos WHERE empresa_id=? AND cliente_id=?', [E, refId]);
  const misPedidoIds = new Set(pedRows.map(r => r.id));
  const [msgRows] = misPedidoIds.size
    ? await c.query('SELECT id, autor FROM mensajes WHERE empresa_id=? AND pedido_id IN (?)', [E, [...misPedidoIds]])
    : [[]];
  const msgExistente = new Map(msgRows.map(m => [m.id, m]));

  for (const m of db.mensajes || []) {
    if (!m || m.id == null || !misPedidoIds.has(m.pedido_id)) continue; // mensaje fuera de sus pedidos: ignorar
    const existente = msgExistente.get(m.id);
    if (!existente) {
      // Mensaje nuevo: siempre se crea a nombre de 'cliente', nunca suplantando al admin
      await c.query('INSERT INTO mensajes (empresa_id,id,pedido_id,autor,texto,fecha,leido) VALUES (?,?,?,?,?,?,?)',
        [E, m.id, m.pedido_id, 'cliente', String(m.texto || '').slice(0, 2000), dtMysql(new Date().toISOString()), 0]);
    } else if (existente.autor !== 'cliente') {
      // Mensaje del admin: sólo se permite marcarlo como leído
      await c.query('UPDATE mensajes SET leido=? WHERE empresa_id=? AND id=?', [m.leido ? 1 : 0, E, m.id]);
    }
    // Mensaje propio ya existente: no editable, se ignora
  }

  // ── Secuencias: sólo avanzan (nunca retroceden) y sólo para pedido/mensaje ──
  const [[meta]] = await c.query('SELECT seq FROM app_meta WHERE empresa_id=?', [E]);
  const seqActual = (meta && meta.seq) || {};
  const seqEnviado = (db.seq && typeof db.seq === 'object') ? db.seq : {};
  const seqNuevo = { ...seqActual };
  for (const k of ['pedido', 'mensaje']) seqNuevo[k] = Math.max(num(seqActual[k]), num(seqEnviado[k]));
  await c.query('INSERT INTO app_meta (empresa_id,seq) VALUES (?,?) ON DUPLICATE KEY UPDATE seq=VALUES(seq)', [E, JSON.stringify(seqNuevo)]);
}

app.put('/api/state', requireAuth, async (req, res) => {
  const db = req.body || {};
  const pool = getPool();
  const c = await pool.getConnection();
  const E = req.user.empresa_id;
  if (!E) { c.release(); return res.status(403).json({ error: 'Tu usuario no está asociado a ninguna empresa' }); }
  try {
    await c.beginTransaction();
    if (req.user.role === 'cliente') await guardarEstadoCliente(c, E, req.user.ref_id, db);
    else await guardarEstadoCompleto(c, E, db);
    await c.commit();
    res.json({ ok: true });
  } catch (e) {
    await c.rollback();
    res.status(500).json({ error: e.message });
  } finally { c.release(); }
});

/* Asegura filas base: un admin de plataforma y que cada empresa tenga su
   config + contadores. (config y app_meta ahora son POR empresa.) */
async function asegurarBase() {
  const pool = getPool();
  const [u] = await pool.query("SELECT COUNT(*) AS n FROM users WHERE role='admin'");
  if (u[0].n === 0) {
    // Admin de plataforma (sin empresa): existe para no dejar la instalación sin ningún admin.
    await pool.query('INSERT INTO users (nombre,email,password_hash,role,empresa_id,activo) VALUES (?,?,?,?,NULL,1)',
      ['Administrador', 'admin@siwepe.com', hashPassword('admin1234'), 'admin']);
    console.log('Admin de plataforma creado: admin@siwepe.com / admin1234');
  }

  // Cada empresa debe tener su fila de config y de contadores (por si faltara,
  // p. ej. tras la migración de esquema). Idempotente.
  const [emps] = await pool.query('SELECT id, nombre FROM empresas');
  for (const e of emps) {
    await pool.query(
      'INSERT IGNORE INTO config (empresa_id,nombre,logo,moneda,tema,pin_admin,banners,pago) VALUES (?,?,?,?,?,?,?,?)',
      [e.id, e.nombre || 'SIWEPE', '', 'L', 'cielo', '1234', JSON.stringify([]), JSON.stringify({ banco: '', cuenta: '', titular: '', tipo: '', nota: '' })]);
    await pool.query('INSERT IGNORE INTO app_meta (empresa_id,seq) VALUES (?,?)',
      [e.id, JSON.stringify({ producto: 0, categoria: 0, proveedor: 0, cliente: 0, compra: 0, venta: 0, movimiento: 0, pedido: 0, mensaje: 0 })]);
  }

  // Migra a bcrypt los PIN de clientes que hayan quedado en texto plano
  // (bases creadas antes de este cambio). Idempotente: no toca lo ya migrado.
  const [pendientes] = await pool.query("SELECT empresa_id, id, pin FROM clientes WHERE pin NOT LIKE '$2%'");
  for (const cl of pendientes) {
    await pool.query('UPDATE clientes SET pin=? WHERE empresa_id=? AND id=?', [hashPassword(String(cl.pin || '0000')), cl.empresa_id, cl.id]);
  }
  if (pendientes.length) console.log(`PIN de ${pendientes.length} cliente(s) migrado(s) a bcrypt.`);

  // Limpia solicitudes de registro sin confirmar con más de 24h (nunca fueron empresa).
  try { await pool.query('DELETE FROM registros_pendientes WHERE created_at < (NOW() - INTERVAL 24 HOUR)'); }
  catch (e) { /* la tabla se crea en el arranque; si aún no existe, se ignora */ }
}

/* ───────── ARRANQUE ───────── */
initDb()
  .then(asegurarBase)
  .then(() => app.listen(PORT, () => {
    console.log(`\nSIWEPE backend escuchando en el puerto ${PORT}\n`);
  }))
  .catch(err => { console.error('No se pudo conectar a MySQL:', err.code || err.message || err); process.exit(1); });
