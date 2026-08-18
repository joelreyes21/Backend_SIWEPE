/*! SIWEPE · © 2026 Joel Reyes. Todos los derechos reservados. · Prohibida su reproduccion o distribucion sin autorizacion. */
/* server.js — API REST JSON de SIWEPE. Arranca con: npm start */
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { initDb, getPool } = require('./db');
const { hashPassword, checkPassword, signToken, requireAuth, requireRole, requireSuper } = require('./auth');

const app = express();
const PORT = process.env.PORT || 3000;

/* Detrás de un proxy (Railway u otro), confiar en X-Forwarded-For para que
   req.ip sea la IP real del cliente y no la del proxy — si no, el limitador
   de intentos de abajo agrupa a todos los usuarios bajo la misma IP. */
app.set('trust proxy', 1);

// Headers de seguridad estándar (X-Content-Type-Options, X-Frame-Options,
// Strict-Transport-Security, etc.) — API JSON, así que el CSP por defecto de
// helmet no afecta nada (no servimos HTML desde aquí).
app.use(helmet());

/* API pública consumida por front-ends propios (siwepe.shop en producción,
   localhost:5500 en desarrollo). Antes estaba abierta a cualquier origen
   (`cors()` sin opciones); se restringe a una lista conocida — no es la única
   defensa (la sesión va por JWT), pero reduce que cualquier sitio arbitrario
   pueda pegarle a la API desde el navegador de un visitante. Configurable por
   env (`CORS_ORIGINS`, separado por comas) para agregar dominios sin tocar código. */
const CORS_ORIGINS = (process.env.CORS_ORIGINS || 'https://siwepe.shop,http://localhost:5500,http://127.0.0.1:5500')
  .split(',').map(s => s.trim()).filter(Boolean);
console.log('CORS_ORIGINS configurados:', CORS_ORIGINS);
app.use(cors({
  origin: function(origin, callback) {
    if (!origin || CORS_ORIGINS.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error('CORS: Origin no permitido: ' + origin));
    }
  },
  credentials: true,
}));

// Límite general anti-scraping/DoS básico sobre toda la API (además del
// limitador específico de login/registro más abajo). Generoso a propósito:
// el panel admin hace polling cada 4s, así que no debe estorbar el uso normal.
app.use(rateLimit({ windowMs: 15 * 60 * 1000, max: 1500, standardHeaders: true, legacyHeaders: false }));

app.use(express.json({ limit: '30mb' }));           // imágenes en base64
app.use(express.urlencoded({ extended: true, limit: '30mb' }));

/* Este servidor es SOLO API (el front-end se hostea aparte). */
app.get('/', (req, res) => res.json({ ok: true, service: 'SIWEPE API', ts: new Date().toISOString() }));

/* ───────── helpers de conversión fila → objeto (forma que usa el front-end) ───────── */
const num = (v) => (v == null ? 0 : Number(v));
const jsonValor = (v, fallback) => {
  if (v == null || v === '') return fallback;
  if (typeof v !== 'string') return v;
  try { return JSON.parse(v); } catch (e) { return fallback; }
};
const arr = (v) => { const x=jsonValor(v, []); return Array.isArray(x) ? x : []; };
const obj = (v) => { const x=jsonValor(v, {}); return x && typeof x==='object' && !Array.isArray(x) ? x : {}; };
const dtMysql = (iso) => { const d = new Date(iso); return isNaN(d) ? iso : d.toISOString().slice(0, 19).replace('T', ' '); };
const escHtml = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
const MAX_IMAGEN = 8 * 1024 * 1024;
function imagenWebValida(v) {
  if (v == null || v === '') return true;
  if (typeof v !== 'string' || v.length > MAX_IMAGEN) return false;
  if (/^https:\/\/[a-z0-9.-]+(?:[:/][^\s"'<>]*)?$/i.test(v)) return true;
  return /^data:image\/(?:png|jpe?g|webp|gif);base64,[a-z0-9+/=\r\n]+$/i.test(v);
}
function exigirImagenWeb(v, campo) {
  if (!imagenWebValida(v)) {
    const e = new Error(`${campo || 'Imagen'} inválida. Usa JPG, PNG, WEBP o GIF de hasta 8 MB.`);
    e.status = 400;
    throw e;
  }
  return v || '';
}
function normalizarDirecciones(v) {
  v = arr(v);
  if (v.length > 6) { const e = new Error('Puedes guardar hasta 6 direcciones'); e.status = 400; throw e; }
  const limpias = v.map((d, i) => ({
    id: String(d && d.id || `direccion-${i + 1}`).slice(0, 48),
    etiqueta: String(d && d.etiqueta || 'Dirección').trim().slice(0, 40),
    nombre: String(d && d.nombre || '').trim().slice(0, 120),
    direccion: String(d && d.direccion || '').trim().slice(0, 160),
    ciudad: String(d && d.ciudad || '').trim().slice(0, 80),
    departamento: String(d && d.departamento || '').trim().slice(0, 80),
    referencia: String(d && d.referencia || '').trim().slice(0, 160),
    telefono: String(d && d.telefono || '').trim().slice(0, 30),
    principal: !!(d && d.principal),
  }));
  if (limpias.some(d => !d.direccion)) { const e = new Error('Cada dirección debe incluir la dirección exacta'); e.status = 400; throw e; }
  for (const d of limpias) {
    const vD = validarDireccion(d.direccion, 'dirección');
    if (!vD.ok) { const e = new Error(vD.error); e.status = 400; throw e; }
    d.direccion = vD.valor.slice(0, 160);
    const vT = validarTelefono(d.telefono, null, 'teléfono');
    if (!vT.ok) { const e = new Error(vT.error); e.status = 400; throw e; }
    d.telefono = vT.valor;
  }
  let principal = limpias.findIndex(d => d.principal);
  if (limpias.length && principal < 0) principal = 0;
  limpias.forEach((d, i) => { d.principal = i === principal; });
  return limpias;
}
function normalizarTiposNegocio(v) {
  if (!Array.isArray(v)) return [];
  const permitidos = new Set(['Productos','Servicios','Comida y bebidas','Otro']);
  const tipos = [...new Set(v.map(x => String(x || '').trim()).filter(x => permitidos.has(x)))];
  if (tipos.length > 4) { const e = new Error('Selección de negocio inválida'); e.status = 400; throw e; }
  return tipos;
}
function normalizarRubros(v, principal='') {
  const entrada=Array.isArray(v)?v:[principal];
  const rubros=[...new Set(entrada.map(x=>String(x||'').trim()).filter(Boolean))];
  if (!rubros.length) { const e=new Error('Selecciona al menos una categoría'); e.status=400; throw e; }
  if (rubros.length>2) { const e=new Error('Puedes seleccionar como máximo dos categorías'); e.status=400; throw e; }
  if (rubros.some(x=>x.length>60)) { const e=new Error('Una de las categorías es demasiado larga'); e.status=400; throw e; }
  return rubros;
}
function errorPublico(res, e) {
  const status = e && e.status ? e.status : 500;
  if (status >= 500) console.error(e);
  return res.status(status).json({ error: status >= 500 ? 'Ocurrió un error interno. Inténtalo de nuevo.' : e.message });
}
async function subirVersion(c, empresaId) {
  await c.query('UPDATE app_meta SET version=version+1 WHERE empresa_id=?', [empresaId]);
  const [[m]] = await c.query('SELECT version FROM app_meta WHERE empresa_id=?', [empresaId]);
  return num(m && m.version);
}

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

/* ───────── anti-bot para formularios públicos de registro ─────────
   Dos señales que un humano nunca dispara pero un script sí:
   1) "web": campo trampa, invisible en el formulario — un bot que
      autocompleta todos los inputs lo llena, una persona ni lo ve.
   2) "ts": el momento (Date.now()) en que el navegador cargó la página,
      mandado de vuelta con el registro — si entre eso y el envío pasó
      menos de un segundo, nadie tuvo tiempo real de leer y escribir.
   Devuelve un error genérico en ambos casos (nunca "éxito falso" con un
   token inventado): si alguna vez un humano real cae en un falso positivo
   — p. ej. un gestor de contraseñas demasiado agresivo llenando el campo
   trampa — reintentar le funciona en vez de dejarlo con una sesión rota. */
function pareceBot(req) {
  const web = String(req.body && req.body.web || '').trim();
  if (web) return true;
  const ts = Number(req.body && req.body.ts);
  if (ts && Date.now() - ts < 1000) return true;
  return false;
}
// Proveedores de correo temporal/desechable más comunes — quien registra
// una cuenta real casi nunca usa uno de estos a propósito.
const DOMINIOS_DESECHABLES = new Set([
  'mailinator.com','tempmail.com','temp-mail.org','guerrillamail.com','guerrillamail.info',
  '10minutemail.com','10minutemail.net','yopmail.com','trashmail.com','getnada.com',
  'throwawaymail.com','fakeinbox.com','maildrop.cc','sharklasers.com','mintemail.com',
  'dispostable.com','mailnesia.com','mohmal.com','tempinbox.com','moakt.com',
  'emailondeck.com','crazymailing.com','discardmail.com','spambog.com','tempr.email',
]);
function esCorreoDesechable(correo) {
  const dominio = String(correo || '').split('@')[1] || '';
  return DOMINIOS_DESECHABLES.has(dominio.toLowerCase().trim());
}

function mapProducto(r) {
  const imagenes = arr(r.imagenes).filter(Boolean);
  if (r.imagen && !imagenes.includes(r.imagen)) imagenes.unshift(r.imagen);
  return { id: r.id, codigo: r.codigo, nombre: r.nombre, categoria_id: r.categoria_id,
    descripcion: r.descripcion || '', precio_compra: num(r.precio_compra), precio_venta: num(r.precio_venta),
    stock: num(r.stock), stock_inventario: num(r.stock_inventario), stock_min: num(r.stock_min), imagen: r.imagen || '', estado: r.estado,
    imagenes, destacado: !!r.destacado, publicado_alguna_vez: !!r.publicado_alguna_vez, marca: r.marca || '', tipoPiel: arr(r.tipo_piel) };
}

/* ───────── CORREO (Resend) para verificación de empresas ───────── */
const { Resend } = require('resend');
const crypto = require('crypto');
const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;
const PUBLIC_API_URL = process.env.PUBLIC_API_URL || `http://localhost:${PORT}`;
const SITE_URL = process.env.SITE_URL || 'https://siwepe.shop';
const slugify = s => String(s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'empresa';

/* ───────── Validación de nombres y teléfonos (la autoridad es el backend) ─────────
   Nombre: debe tener letras; máximo 4 números y máximo 3 signos (evita basura
   como "56838383" o "-·-·-·-"). Teléfono: solo dígitos, cantidad correcta según
   el país; en Honduras exige celular (8 dígitos que empiecen con 3, 7, 8 o 9,
   sin atarse a operadora por la portabilidad). */
function validarNombreNegocio(nombre, etiqueta, maxLen) {
  const et = etiqueta || 'nombre';
  const max = maxLen || 120;
  const n = String(nombre || '').trim().replace(/\s+/g, ' ');
  if (n.length < 2) return { ok: false, error: `El ${et} es muy corto.` };
  if (n.length > max) return { ok: false, error: `El ${et} no puede pasar de ${max} caracteres.` };
  const letras = (n.match(/[a-zA-ZáéíóúüñÁÉÍÓÚÜÑ]/g) || []).length;
  if (letras < 2) return { ok: false, error: `El ${et} debe tener letras, no solo números o símbolos.` };
  if ((n.match(/[0-9]/g) || []).length > 4) return { ok: false, error: `El ${et} no puede tener más de 4 números.` };
  if ((n.match(/[^0-9a-zA-ZáéíóúüñÁÉÍÓÚÜÑ\s]/g) || []).length > 3) return { ok: false, error: `El ${et} no puede tener más de 3 signos.` };
  return { ok: true, valor: n };
}
const TEL_PAISES = {
  'Honduras': { code: '504', len: 8, movil: /^[3789]/ },
  'Guatemala': { code: '502', len: 8 }, 'El Salvador': { code: '503', len: 8 },
  'Nicaragua': { code: '505', len: 8 }, 'Costa Rica': { code: '506', len: 8 },
  'Panamá': { code: '507', len: 8 }, 'Panama': { code: '507', len: 8 },
  'México': { code: '52', len: 10 }, 'Mexico': { code: '52', len: 10 },
  'Colombia': { code: '57', len: 10 }, 'Estados Unidos': { code: '1', len: 10 },
  'España': { code: '34', len: 9 }, 'Espana': { code: '34', len: 9 }
};
function validarTelefono(raw, pais, etiqueta) {
  const et = etiqueta || 'teléfono';
  const solo = String(raw || '').replace(/\D/g, '');
  if (!solo) return { ok: true, valor: '' };  // opcional: si no lo ponen, se permite
  const info = TEL_PAISES[pais] || TEL_PAISES['Honduras'];  // default: Honduras (plataforma hondureña)
  let local = solo;
  if (info.code && local.length > info.len && local.startsWith(info.code)) local = local.slice(info.code.length);
  if (local.length !== info.len) return { ok: false, error: `El ${et} debe tener ${info.len} dígitos${pais ? ' en ' + pais : ''}.` };
  if (info.movil && !info.movil.test(local)) return { ok: false, error: `Ingresá un ${et} de celular válido (debe empezar con 3, 7, 8 o 9).` };
  return { ok: true, valor: local };
}
/* Nombre de PERSONA (dueño / cliente): solo letras, espacios y los signos
   propios de un nombre (guion y apóstrofo, p. ej. "José-María", "O'Brien").
   NO permite números ni caracteres especiales. Para nombres de NEGOCIO o
   PRODUCTO usá validarNombreNegocio (esos sí pueden llevar números, p. ej.
   "Café 24/7"). */
function validarNombrePersona(nombre, etiqueta, maxLen) {
  const et = etiqueta || 'nombre';
  const max = maxLen || 30;
  const n = String(nombre || '').trim().replace(/\s+/g, ' ');
  if (n.length < 2) return { ok: false, error: `El ${et} es muy corto.` };
  if (n.length > max) return { ok: false, error: `El ${et} no puede pasar de ${max} caracteres.` };
  if (/[0-9]/.test(n)) return { ok: false, error: `El ${et} no puede tener números.` };
  if (!/^[a-zA-ZáéíóúüñÁÉÍÓÚÜÑ'’\- ]+$/.test(n)) return { ok: false, error: `El ${et} solo puede tener letras (sin caracteres especiales).` };
  const letras = (n.match(/[a-zA-ZáéíóúüñÁÉÍÓÚÜÑ]/g) || []).length;
  if (letras < 2) return { ok: false, error: `Escribí un ${et} válido.` };
  return { ok: true, valor: n };
}
/* Dirección: valida FORMATO razonable (tiene letras, largo mínimo, sin
   caracteres raros tipo emojis o <>{}[]|). Permite números y la puntuación
   típica de direcciones ( . , # - / ° º ª ( ) ). OJO: verificar que la
   dirección EXISTA de verdad requiere una API de mapas/geocoding (servicio
   externo); esto solo garantiza que no sea basura. Vacío se permite. */
function validarDireccion(raw, etiqueta) {
  const et = etiqueta || 'dirección';
  const d = String(raw || '').trim().replace(/\s+/g, ' ');
  if (!d) return { ok: true, valor: '' };
  if (d.length < 5) return { ok: false, error: `La ${et} es muy corta, escribila completa.` };
  const letras = (d.match(/[a-zA-ZáéíóúüñÁÉÍÓÚÜÑ]/g) || []).length;
  if (letras < 3) return { ok: false, error: `La ${et} debe incluir el nombre de la calle o barrio, no solo números o símbolos.` };
  if (!/^[0-9a-zA-ZáéíóúüñÁÉÍÓÚÜÑ .,#/°ºª()'’\-]+$/.test(d)) return { ok: false, error: `La ${et} tiene caracteres no permitidos. Usá solo letras, números y . , # - /` };
  return { ok: true, valor: d };
}
function webBaseSeguro(valor) {
  try {
    const u=new URL(String(valor||''));
    const configurado=new URL(SITE_URL);
    if (u.origin===configurado.origin || ((u.hostname==='localhost'||u.hostname==='127.0.0.1') && u.protocol==='http:')) return u.origin;
  } catch(e) {}
  return SITE_URL.replace(/\/$/,'');
}
async function enviarVerificacion(correo, nombre, token, webBase) {
  const link = `${PUBLIC_API_URL}/api/empresas/verificar/${token}?site=${encodeURIComponent(webBaseSeguro(webBase))}`;
  // Sin RESEND_API_KEY (típico en desarrollo local) no hay cómo mandar el correo
  // de verdad: se avisa por consola y se devuelve el link para que quien llamó
  // (POST /api/empresas) pueda mostrárselo al usuario en la propia UI.
  if (!resend) { console.warn('RESEND_API_KEY no configurada. Link de verificación:', link); return { enviado: false, link }; }
  const remitente = process.env.MAIL_FROM || 'SIWEPE <onboarding@resend.dev>';
  // El SDK de Resend NO lanza excepción cuando la API rechaza el envío: devuelve
  // { data, error }. Hay que revisar `error` a mano, si no el fallo pasa en silencio.
  const { data, error } = await resend.emails.send({
    from: remitente,
    to: correo,
    subject: 'Verificá tu empresa en SIWEPE',
    html: `<div style="font-family:Arial,sans-serif;max-width:480px;margin:auto;color:#21303D">
      <h2 style="color:#4F86C6">Bienvenido a SIWEPE</h2>
      <p>Hola ${escHtml(nombre)}, gracias por registrar tu empresa.</p>
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
  return { enviado: true, link };
}

async function enviarRecuperacion(correo, nombre, token) {
  const link = `${SITE_URL}/pages/admin.html?reset=${token}`;
  if (!resend) { console.warn('RESEND_API_KEY no configurada. Link de recuperación:', link); return; }
  const remitente = process.env.MAIL_FROM || 'SIWEPE <onboarding@resend.dev>';
  const { data, error } = await resend.emails.send({
    from: remitente,
    to: correo,
    subject: 'Recuperar tu contraseña en SIWEPE',
    html: `<div style="font-family:Arial,sans-serif;max-width:480px;margin:auto;color:#21303D">
      <h2 style="color:#4F86C6">Recuperar contraseña</h2>
      <p>Hola ${escHtml(nombre)}, pediste restablecer tu contraseña del panel de SIWEPE.</p>
      <p style="text-align:center;margin:24px 0"><a href="${link}" style="background:#4F86C6;color:#fff;padding:12px 26px;border-radius:8px;text-decoration:none;font-weight:bold">Elegir nueva contraseña</a></p>
      <p style="color:#888;font-size:13px">Este enlace vence en 2 horas. Si no fuiste vos, ignorá este correo — tu contraseña actual sigue funcionando.</p>
    </div>`
  });
  if (error) {
    console.error(`Error enviando correo de recuperación (Resend) · to="${correo}" ->`, JSON.stringify(error));
    throw new Error(error.message || 'Resend rechazó el envío');
  }
  console.log('Correo de recuperación enviado a', correo, '· id:', data && data.id);
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
app.post('/api/empresas', limitarIntentos(4, 15 * 60 * 1000), async (req, res) => {
  if (pareceBot(req)) return res.status(400).json({ error: 'No pudimos procesar el registro. Recargá la página e intentá de nuevo.' });
  const { nombre, tiposNegocio, rubro, rubros, descripcion, telefono, ciudad, pais, logo, dueno, correo, password } = req.body || {};
  if (!nombre || !dueno || !correo || !password) return res.status(400).json({ error: 'Faltan datos obligatorios' });
  if (String(password).length < 8) return res.status(400).json({ error: 'La contraseña debe tener al menos 8 caracteres' });
  { const vN = validarNombreNegocio(nombre, 'nombre del negocio', 30); if (!vN.ok) return res.status(400).json({ error: vN.error }); }
  { const vD = validarNombrePersona(dueno, 'nombre del dueño'); if (!vD.ok) return res.status(400).json({ error: vD.error }); }
  { const vT = validarTelefono(telefono, pais, 'teléfono'); if (!vT.ok) return res.status(400).json({ error: vT.error }); }
  const email = String(correo).toLowerCase().trim();
  if (esCorreoDesechable(email)) return res.status(400).json({ error: 'Usá un correo real, no uno temporal — lo vas a necesitar para administrar tu tienda.' });
  const pool = getPool();
  try {
    exigirImagenWeb(logo, 'Logo');
    const tipos = normalizarTiposNegocio(tiposNegocio);
    const categorias = normalizarRubros(rubros, rubro);
    if (Array.isArray(tiposNegocio) && !tipos.length) return res.status(400).json({ error: 'Selecciona qué vende tu negocio' });
    if (String(rubro || '').length > 60 || String(descripcion || '').length > 255) return res.status(400).json({ error: 'La categoría o descripción es demasiado larga' });
    // NADA se crea todavía: la empresa y la cuenta se crean SÓLO cuando se
    // confirma el correo (en /api/empresas/verificar/:token). Aquí sólo dejamos
    // la solicitud "en espera".
    const [dupU] = await pool.query('SELECT role FROM users WHERE email=? LIMIT 1', [email]);
    if (dupU.length) {
      const mensaje=dupU[0].role==='cliente'
        ? 'Ese correo ya pertenece a una cuenta de cliente. Para administrar una empresa usa otro correo.'
        : 'Ya existe una cuenta SIWEPE con ese correo.';
      return res.status(409).json({ error: mensaje });
    }

    const token = crypto.randomBytes(24).toString('hex');
    // 1) Enviar el correo PRIMERO. Si no se puede enviar, no guardamos nada.
    let verif;
    try {
      verif = await enviarVerificacion(email, dueno.trim(), token, req.headers.origin);
    } catch (e) {
      console.warn('Registro abortado: no se pudo enviar el correo de verificación:', e.message);
      return res.status(502).json({ error: 'No pudimos enviar el correo de verificación a esa dirección. Revisá que el correo esté bien escrito e intentá de nuevo.' });
    }
    // 2) Guardar la solicitud PENDIENTE (todavía NO es empresa ni usuario).
    //    Reemplaza cualquier solicitud previa sin confirmar del mismo correo.
    await pool.query('DELETE FROM registros_pendientes WHERE correo=?', [email]);
    await pool.query(
      'INSERT INTO registros_pendientes (token,nombre,tipos_negocio,rubro,rubros,descripcion,telefono,ciudad,pais,logo,correo,dueno,password_hash) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',
      [token, nombre.trim().slice(0,120), JSON.stringify(tipos), categorias[0], JSON.stringify(categorias), String(descripcion||'').slice(0,255), String(telefono||'').slice(0,40), String(ciudad||'').slice(0,80), String(pais||'').slice(0,60), logo || '', email, dueno.trim().slice(0,120), hashPassword(password)]);
    // Sin Resend configurado (desarrollo local) no hay correo real: se manda el
    // link directo en la respuesta para que el front lo pueda mostrar/abrir.
    const body = { ok: true, correo: email };
    if (verif && verif.enviado === false) body.devLink = verif.link;
    res.json(body);
  } catch (e) {
    errorPublico(res, e);
  }
});

// Lista pública de empresas activas (para "Descubrir empresas")
app.get('/api/empresas', async (req, res) => {
  try {
    const [rows] = await getPool().query("SELECT id,slug,nombre,tipos_negocio,rubro,rubros,descripcion,telefono,ciudad,pais,logo,contacto_publico,correo_publico,visitas FROM empresas WHERE estado='activa' ORDER BY nombre");
    res.json(rows.map(({ tipos_negocio, rubros, contacto_publico, correo_publico, ...x }) => ({
      ...x,
      tiposNegocio: arr(tipos_negocio),
      rubros: arr(rubros).length?arr(rubros):[x.rubro].filter(Boolean),
      contactoPublico: contacto_publico || '',
      correoPublico: correo_publico || ''
    })));
  } catch (e) { errorPublico(res, e); }
});

// Estado de un registro por correo — lo usa la pantalla de espera del wizard
// (index.html) para saber, con polling, si ya se confirmó el correo sin que
// el usuario tenga que volver a esta pestaña manualmente.
app.get('/api/empresas/estado', limitarIntentos(40, 10 * 60 * 1000), async (req, res) => {
  const correo = String(req.query.correo || '').toLowerCase().trim();
  if (!correo) return res.status(400).json({ error: 'Falta correo' });
  try {
    const pool = getPool();
    const [u] = await pool.query(
      "SELECT e.slug FROM users u JOIN empresas e ON e.id=u.empresa_id WHERE u.email=? AND u.role='admin' LIMIT 1", [correo]);
    if (u.length) return res.json({ estado: 'activa', slug: u[0].slug });
    const [p] = await pool.query('SELECT 1 FROM registros_pendientes WHERE correo=? LIMIT 1', [correo]);
    res.json({ estado: p.length ? 'pendiente' : 'no_encontrada' });
  } catch (e) { errorPublico(res, e); }
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
      "INSERT INTO empresas (slug,nombre,tipos_negocio,rubro,rubros,descripcion,telefono,ciudad,pais,logo,correo,estado,verify_token) VALUES (?,?,?,?,?,?,?,?,?,?,?,'activa',NULL)",
      [slug, r.nombre, JSON.stringify(arr(r.tipos_negocio)), r.rubro || '', JSON.stringify(arr(r.rubros).length?arr(r.rubros):[r.rubro].filter(Boolean)), r.descripcion || '', r.telefono || '', r.ciudad || '', r.pais || '', r.logo || '', r.correo]);
    const empresaId = ins.insertId;
    // Cuenta admin ACTIVA (reutiliza el hash ya calculado en el registro)
    const [adminIns] = await c.query('INSERT INTO users (nombre,email,password_hash,role,empresa_id,activo) VALUES (?,?,?,?,?,1)',
      [r.dueno, r.correo, r.password_hash, 'admin', empresaId]);
    // Config y contadores propios de la empresa
    await c.query('INSERT INTO config (empresa_id,nombre,logo,moneda,tema,pin_admin,banners,pago) VALUES (?,?,?,?,?,?,?,?)',
      [empresaId, r.nombre, r.logo || '', 'L', 'cielo', '1234', JSON.stringify([]), JSON.stringify({ banco: '', cuenta: '', titular: '', tipo: '', nota: '' })]);
    await c.query('INSERT INTO app_meta (empresa_id,seq) VALUES (?,?)',
      [empresaId, JSON.stringify({ producto: 0, categoria: 0, proveedor: 0, cliente: 0, compra: 0, venta: 0, movimiento: 0, pedido: 0, mensaje: 0 })]);
    // Ya es empresa real: quitar la solicitud pendiente
    await c.query('DELETE FROM registros_pendientes WHERE token=?', [req.params.token]);
    await c.commit();
    const codigo=crypto.randomBytes(32).toString('hex');
    await pool.query('DELETE FROM onboarding_sessions WHERE user_id=? OR expires_at<NOW()',[adminIns.insertId]);
    await pool.query('INSERT INTO onboarding_sessions (code,user_id,expires_at) VALUES (?,?,DATE_ADD(NOW(),INTERVAL 15 MINUTE))',[codigo,adminIns.insertId]);
    const destino=webBaseSeguro(req.query.site);
    res.redirect(`${destino}/pages/admin.html?onboarding=${encodeURIComponent(codigo)}&e=${encodeURIComponent(slug)}`);
  } catch (e) {
    await c.rollback().catch(() => {});
    console.error(e);
    res.redirect(`${SITE_URL}/index.html?verify=error`);
  } finally { c.release(); }
});

/* ───────── AUTENTICACIÓN ───────── */

// Una sola identidad por correo. El portal únicamente limita QUÉ interfaz
// puede abrir esa identidad; nunca crea ni transforma roles.
app.post('/api/auth/login', limitarIntentos(10, 5 * 60 * 1000), async (req, res) => {
  try {
    const { email, password, portal } = req.body || {};
    if (!email || !password) return res.status(400).json({ error: 'Faltan datos' });
    const [[u]] = await getPool().query('SELECT * FROM users WHERE email=? AND activo=1 LIMIT 1', [String(email).toLowerCase().trim()]);
    if (!u || !checkPassword(password, u.password_hash)) return res.status(401).json({ error: 'Correo o contraseña incorrectos' });
    if(portal==='admin'&&!['admin','proveedor'].includes(u.role)) return res.status(403).json({error:'Esta cuenta es de cliente y no tiene acceso administrativo.'});
    if(portal==='compras'&&!['cliente','admin'].includes(u.role)) return res.status(403).json({error:'Esta cuenta no tiene acceso al portal de compras.'});
    const token = signToken({ id: u.id, nombre: u.nombre, role: u.role, empresa_id: u.empresa_id, ref_id: u.ref_id });
    res.json({ token, user: { id: u.id, nombre: u.nombre, role: u.role, empresa_id: u.empresa_id, ref_id: u.ref_id, super_admin: !!u.super_admin } });
  } catch (e) { errorPublico(res, e); }
});

// Canje de un código de verificación por una sesión administrativa. El código
// funciona una sola vez y vence en 15 minutos.
app.post('/api/auth/onboarding', limitarIntentos(10, 10 * 60 * 1000), async (req,res)=>{
  const code=String(req.body&&req.body.code||'');
  if(!code) return res.status(400).json({error:'Falta el código de activación'});
  const c=await getPool().getConnection();
  try{
    await c.beginTransaction();
    const [[fila]]=await c.query("SELECT o.code,u.*,e.slug FROM onboarding_sessions o JOIN users u ON u.id=o.user_id JOIN empresas e ON e.id=u.empresa_id WHERE o.code=? AND o.used_at IS NULL AND o.expires_at>NOW() AND u.role='admin' AND u.activo=1 FOR UPDATE",[code]);
    if(!fila){ await c.rollback(); return res.status(400).json({error:'El acceso automático venció o ya fue utilizado'}); }
    await c.query('UPDATE onboarding_sessions SET used_at=NOW() WHERE code=?',[code]);
    await c.commit();
    const token=signToken({id:fila.id,nombre:fila.nombre,role:fila.role,empresa_id:fila.empresa_id,ref_id:fila.ref_id});
    res.json({token,slug:fila.slug,user:{id:fila.id,nombre:fila.nombre,role:fila.role,empresa_id:fila.empresa_id,ref_id:fila.ref_id}});
  }catch(e){await c.rollback().catch(()=>{});errorPublico(res,e);}finally{c.release();}
});

// Olvidé mi contraseña (admin/proveedor) — pide el correo, manda un enlace.
// Responde {ok:true} exista o no la cuenta, para no revelar qué correos están registrados.
app.post('/api/auth/olvide', limitarIntentos(5, 15 * 60 * 1000), async (req, res) => {
  const { correo } = req.body || {};
  if (!correo) return res.status(400).json({ error: 'Falta el correo' });
  const email = String(correo).toLowerCase().trim();
  try {
    const pool = getPool();
    const [rows] = await pool.query("SELECT id, nombre FROM users WHERE email=? AND role IN ('admin','proveedor') AND activo=1 LIMIT 1", [email]);
    if (rows.length) {
      const u = rows[0];
      const token = crypto.randomBytes(24).toString('hex');
      await pool.query('DELETE FROM password_resets WHERE user_id=?', [u.id]);
      await pool.query('INSERT INTO password_resets (token,user_id) VALUES (?,?)', [token, u.id]);
      try { await enviarRecuperacion(email, u.nombre, token); }
      catch (e) { console.warn('No se pudo enviar el correo de recuperación:', e.message); }
    }
    res.json({ ok: true });
  } catch (e) { errorPublico(res, e); }
});

// Elegir nueva contraseña con el token del correo de recuperación
app.post('/api/auth/reset', limitarIntentos(8, 15 * 60 * 1000), async (req, res) => {
  const { token, password } = req.body || {};
  if (!token || !password) return res.status(400).json({ error: 'Faltan datos' });
  if (String(password).length < 8) return res.status(400).json({ error: 'La contraseña debe tener al menos 8 caracteres' });
  try {
    const pool = getPool();
    const [rows] = await pool.query(
      'SELECT * FROM password_resets WHERE token=? AND created_at > (NOW() - INTERVAL 2 HOUR) LIMIT 1', [token]);
    if (!rows.length) return res.status(400).json({ error: 'El enlace no es válido o ya venció. Pedí uno nuevo.' });
    await pool.query('UPDATE users SET password_hash=? WHERE id=?', [hashPassword(password), rows[0].user_id]);
    await pool.query('DELETE FROM password_resets WHERE user_id=?', [rows[0].user_id]);
    res.json({ ok: true });
  } catch (e) { errorPublico(res, e); }
});

// Registro de cliente nuevo — cuenta global (correo+contraseña), no ligada a una empresa
app.post('/api/auth/register', limitarIntentos(4, 10 * 60 * 1000), async (req, res) => {
  if (pareceBot(req)) return res.status(400).json({ error: 'No pudimos procesar el registro. Recargá la página e intentá de nuevo.' });
  const { nombre, correo, password, telefono, direccion, whatsapp } = req.body || {};
  if (!nombre || !String(nombre).trim() || !correo || !password || String(password).length < 8) {
    return res.status(400).json({ error: 'Nombre, correo y contraseña (mín. 8 caracteres) obligatorios' });
  }
  { const vN = validarNombrePersona(nombre, 'nombre'); if (!vN.ok) return res.status(400).json({ error: vN.error }); }
  { const vT = validarTelefono(telefono, null, 'teléfono'); if (!vT.ok) return res.status(400).json({ error: vT.error }); }
  { const vW = validarTelefono(whatsapp, null, 'WhatsApp'); if (!vW.ok) return res.status(400).json({ error: vW.error }); }
  const email = String(correo).toLowerCase().trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'Correo electrónico inválido' });
  if (esCorreoDesechable(email)) return res.status(400).json({ error: 'Usá un correo real, no uno temporal — lo vas a necesitar para recuperar tu cuenta.' });
  try {
    const pool = getPool();
    const [ex] = await pool.query('SELECT id FROM users WHERE email=? LIMIT 1', [email]);
    if (ex.length) return res.status(409).json({ error: 'Ya existe una cuenta con ese correo' });
    const [result] = await pool.query(
      'INSERT INTO users (nombre,email,password_hash,role,empresa_id,telefono,direccion,whatsapp,activo) VALUES (?,?,?,?,NULL,?,?,?,1)',
      [nombre.trim(), email, hashPassword(String(password)), 'cliente', telefono || '', direccion || '', whatsapp || '']);
    const token = signToken({ id: result.insertId, nombre: nombre.trim(), role: 'cliente', empresa_id: null, ref_id: null });
    res.json({ token, user: { id: result.insertId, nombre: nombre.trim(), email, role: 'cliente' } });
  } catch (e) { errorPublico(res, e); }
});

app.get('/api/me', requireAuth, (req, res) => res.json({ user: req.user }));

/* ══════════════════ SUPER ADMIN DE PLATAFORMA ══════════════════
   Panel del dueño de SIWEPE. Métricas globales de toda la plataforma y
   gestión de tiendas (activar / desactivar / eliminar). Todo protegido con
   requireSuper: solo un usuario con super_admin=1 puede tocar estos datos. */

/* Resumen general: KPIs de toda la plataforma + series para gráficas. */
app.get('/api/super/overview', requireAuth, requireSuper, async (req, res) => {
  try {
    const pool = getPool();
    const uno = async (sql) => { const [[r]] = await pool.query(sql); return Number(Object.values(r)[0]) || 0; };
    const [tiendasActivas, tiendasInactivas, pendientes, productos, admins, clientes, pedidos, ventasTotal, visitasTotal] = await Promise.all([
      uno("SELECT COUNT(*) n FROM empresas WHERE estado='activa'"),
      uno("SELECT COUNT(*) n FROM empresas WHERE estado<>'activa'"),
      uno("SELECT COUNT(*) n FROM registros_pendientes"),
      uno("SELECT COUNT(*) n FROM productos"),
      uno("SELECT COUNT(*) n FROM users WHERE role IN ('admin','proveedor')"),
      uno("SELECT COUNT(*) n FROM users WHERE role='cliente'"),
      uno("SELECT COUNT(*) n FROM pedidos"),
      uno("SELECT COALESCE(SUM(total),0) n FROM pedidos WHERE estado<>'cancelado'"),
      uno("SELECT COALESCE(SUM(visitas),0) n FROM empresas"),
    ]);
    const [tiendasMes] = await pool.query("SELECT DATE_FORMAT(created_at,'%Y-%m') ym, COUNT(*) n FROM empresas GROUP BY ym ORDER BY ym DESC LIMIT 6");
    const [pedidosMes] = await pool.query("SELECT DATE_FORMAT(fecha,'%Y-%m') ym, COUNT(*) n, COALESCE(SUM(total),0) monto FROM pedidos GROUP BY ym ORDER BY ym DESC LIMIT 6");
    const [rubros] = await pool.query("SELECT COALESCE(NULLIF(TRIM(rubro),''),'Otros') rubro, COUNT(*) n FROM empresas WHERE estado='activa' GROUP BY rubro ORDER BY n DESC LIMIT 8");
    const [topTiendas] = await pool.query("SELECT e.nombre, COALESCE(e.visitas,0) visitas, (SELECT COUNT(*) FROM productos p WHERE p.empresa_id=e.id) productos FROM empresas e WHERE e.estado='activa' ORDER BY visitas DESC, productos DESC LIMIT 6");
    res.json({
      kpis: { tiendasActivas, tiendasInactivas, pendientes, productos, admins, clientes, pedidos, ventasTotal, visitasTotal },
      tiendasMes: tiendasMes.reverse(),
      pedidosMes: pedidosMes.reverse(),
      rubros, topTiendas,
    });
  } catch (e) { errorPublico(res, e); }
});

/* Lista TODAS las tiendas (cualquier estado) con su dueño y # de productos. */
app.get('/api/super/tiendas', requireAuth, requireSuper, async (req, res) => {
  try {
    const [rows] = await getPool().query(
      `SELECT e.id, e.slug, e.nombre, e.rubro, e.ciudad, e.pais, e.estado, COALESCE(e.visitas,0) visitas, e.created_at,
              (SELECT u.nombre FROM users u WHERE u.empresa_id=e.id AND u.role='admin' ORDER BY u.id LIMIT 1) AS dueno,
              (SELECT u.email  FROM users u WHERE u.empresa_id=e.id AND u.role='admin' ORDER BY u.id LIMIT 1) AS correo,
              (SELECT COUNT(*) FROM productos p WHERE p.empresa_id=e.id) AS productos
       FROM empresas e ORDER BY e.created_at DESC, e.id DESC`);
    res.json({ tiendas: rows });
  } catch (e) { errorPublico(res, e); }
});

/* Activar / desactivar una tienda (borrado suave, reversible). Desactivar la
   oculta de todo el sitio público sin borrar sus datos. */
app.patch('/api/super/tiendas/:id/estado', requireAuth, requireSuper, async (req, res) => {
  try {
    const id = Number(req.params.id);
    const estado = String(req.body && req.body.estado || '');
    if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'Tienda inválida' });
    if (!['activa', 'inactiva'].includes(estado)) return res.status(400).json({ error: 'Estado inválido' });
    const [r] = await getPool().query('UPDATE empresas SET estado=? WHERE id=?', [estado, id]);
    if (!r.affectedRows) return res.status(404).json({ error: 'Tienda no encontrada' });
    res.json({ ok: true, estado });
  } catch (e) { errorPublico(res, e); }
});

/* Eliminar una tienda POR COMPLETO: borra la empresa y todos sus datos
   (productos, pedidos, ventas, config, usuarios admin/proveedor, etc.) dentro
   de una transacción. Irreversible: para ocultar sin perder datos usá PATCH
   estado=inactiva. */
app.delete('/api/super/tiendas/:id', requireAuth, requireSuper, async (req, res) => {
  const pool = getPool();
  const c = await pool.getConnection();
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1) { c.release(); return res.status(400).json({ error: 'Tienda inválida' }); }
    await c.beginTransaction();
    const [[emp]] = await c.query('SELECT id FROM empresas WHERE id=? FOR UPDATE', [id]);
    if (!emp) { await c.rollback(); c.release(); return res.status(404).json({ error: 'Tienda no encontrada' }); }
    for (const t of ['mensajes','pedido_items','pedidos','movimientos','ventas','compras','productos','clientes_empresa','proveedores','categorias','config','app_meta'])
      await c.query('DELETE FROM `' + t + '` WHERE empresa_id=?', [id]);
    await c.query("DELETE FROM users WHERE empresa_id=? AND role IN ('admin','proveedor')", [id]);
    await c.query('DELETE FROM empresas WHERE id=?', [id]);
    await c.commit();
    res.json({ ok: true });
  } catch (e) {
    try { await c.rollback(); } catch (_) {}
    errorPublico(res, e);
  } finally { c.release(); }
});

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
      'SELECT id,slug,nombre,tipos_negocio,rubro,rubros,descripcion,telefono,ciudad,pais,logo,correo,contacto_publico,correo_publico FROM empresas WHERE id=?', [empresaId]);
    if (!fila) return res.status(404).json({ error: 'Empresa no encontrada' });
    fila.tiposNegocio = arr(fila.tipos_negocio);
    fila.rubros = arr(fila.rubros).length?arr(fila.rubros):[fila.rubro].filter(Boolean);
    fila.contactoPublico = fila.contacto_publico || '';
    fila.correoPublico = fila.correo_publico || '';
    delete fila.tipos_negocio;
    delete fila.contacto_publico;
    delete fila.correo_publico;
    res.json(fila);
  } catch (err) { errorPublico(res, err); }
});

app.put('/api/empresas/mi', requireAuth, requireRole('admin'), async (req, res) => {
  const empresaId = req.user.empresa_id;
  if (!empresaId) return res.status(403).json({ error: 'Tu usuario no está asociado a ninguna empresa' });
  const { nombre, tiposNegocio, rubro, rubros, descripcion, telefono, ciudad, pais, logo, contactoPublico, correoPublico } = req.body || {};
  if (!nombre || !String(nombre).trim()) return res.status(400).json({ error: 'Falta el nombre del negocio' });
  { const vN = validarNombreNegocio(nombre, 'nombre del negocio', 30); if (!vN.ok) return res.status(400).json({ error: vN.error }); }
  { const vT = validarTelefono(telefono, pais, 'teléfono'); if (!vT.ok) return res.status(400).json({ error: vT.error }); }
  try {
    exigirImagenWeb(logo, 'Logo');
    const tipos = Array.isArray(tiposNegocio) ? normalizarTiposNegocio(tiposNegocio) : null;
    const categorias = Array.isArray(rubros) ? normalizarRubros(rubros,rubro) : null;
    const emailPublico = String(correoPublico || '').toLowerCase().trim();
    if (emailPublico && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailPublico)) return res.status(400).json({ error: 'El correo público no es válido' });
    const pool = getPool();
    // Regenera el slug (el apodo de la URL, ?e=...) a partir del nombre nuevo,
    // para que el enlace de la tienda refleje el nombre actual. Se mantiene
    // único entre empresas, excluyendo la propia.
    let base = slugify(nombre), nuevoSlug = base, n = 1;
    for (;;) {
      const [ex] = await pool.query('SELECT id FROM empresas WHERE slug=? AND id<>? LIMIT 1', [nuevoSlug, empresaId]);
      if (!ex.length) break;
      nuevoSlug = base + '-' + (++n);
    }
    await pool.query(
      'UPDATE empresas SET nombre=?, slug=?, tipos_negocio=COALESCE(?,tipos_negocio), rubro=?, rubros=COALESCE(?,rubros), descripcion=?, telefono=?, ciudad=?, pais=?, logo=?, contacto_publico=?, correo_publico=? WHERE id=?',
      [String(nombre).trim().slice(0,120), nuevoSlug, tipos ? JSON.stringify(tipos) : null, categorias?categorias[0]:(rubro||''), categorias?JSON.stringify(categorias):null, String(descripcion||'').slice(0,255), String(telefono||'').slice(0,40), String(ciudad||'').slice(0,80), String(pais||'').slice(0,60), logo || '', String(contactoPublico || '').trim().slice(0,120), emailPublico.slice(0,120), empresaId]);
    res.json({ ok: true, slug: nuevoSlug });
  } catch (err) { errorPublico(res, err); }
});

/* ───────── AGENDA MANUAL DE CLIENTES DEL NEGOCIO ─────────
   Un registro manual es privado de la empresa y no crea credenciales ni una
   cuenta global SIWEPE. Las cuentas reales que compran por el portal siguen
   derivándose de users+pedidos y se muestran juntas en el panel. */
function datosClienteManual(body) {
  const nombre=String(body && body.nombre || '').trim().slice(0,120);
  const correo=String(body && body.correo || '').trim().toLowerCase().slice(0,120);
  if (!nombre) { const e=new Error('Escribe el nombre del cliente'); e.status=400; throw e; }
  if (correo && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(correo)) { const e=new Error('El correo no es válido'); e.status=400; throw e; }
  { const vN=validarNombrePersona(nombre,'nombre del cliente'); if(!vN.ok){ const e=new Error(vN.error); e.status=400; throw e; } }
  const vT=validarTelefono(body && body.telefono, null, 'teléfono'); if(!vT.ok){ const e=new Error(vT.error); e.status=400; throw e; }
  const vW=validarTelefono(body && body.whatsapp, null, 'WhatsApp'); if(!vW.ok){ const e=new Error(vW.error); e.status=400; throw e; }
  const vD=validarDireccion(body && body.direccion, 'dirección'); if(!vD.ok){ const e=new Error(vD.error); e.status=400; throw e; }
  return {
    nombre,
    telefono:vT.valor,
    correo,
    whatsapp:vW.valor,
    direccion:vD.valor.slice(0,180)
  };
}

app.post('/api/clientes-manuales', requireAuth, requireRole('admin'), async (req, res) => {
  try {
    const E=req.user.empresa_id; if(!E) return res.status(403).json({error:'Tu usuario no está asociado a una empresa'});
    const d=datosClienteManual(req.body);
    const [r]=await getPool().query('INSERT INTO clientes_empresa (empresa_id,nombre,telefono,correo,whatsapp,direccion) VALUES (?,?,?,?,?,?)',[E,d.nombre,d.telefono,d.correo,d.whatsapp,d.direccion]);
    res.status(201).json({ok:true,cliente:{id:'manual-'+r.insertId,manualId:r.insertId,...d,registrado:false,origen:'manual'}});
  } catch(e) { errorPublico(res,e); }
});

app.put('/api/clientes-manuales/:id', requireAuth, requireRole('admin'), async (req, res) => {
  try {
    const E=req.user.empresa_id, id=Number(req.params.id); if(!E) return res.status(403).json({error:'Tu usuario no está asociado a una empresa'});
    if(!Number.isInteger(id)||id<1) return res.status(400).json({error:'Cliente inválido'});
    const d=datosClienteManual(req.body);
    const [r]=await getPool().query('UPDATE clientes_empresa SET nombre=?,telefono=?,correo=?,whatsapp=?,direccion=? WHERE empresa_id=? AND id=?',[d.nombre,d.telefono,d.correo,d.whatsapp,d.direccion,E,id]);
    if(!r.affectedRows) return res.status(404).json({error:'Cliente no encontrado'});
    res.json({ok:true});
  } catch(e) { errorPublico(res,e); }
});

app.delete('/api/clientes-manuales/:id', requireAuth, requireRole('admin'), async (req, res) => {
  try {
    const E=req.user.empresa_id, id=Number(req.params.id); if(!E) return res.status(403).json({error:'Tu usuario no está asociado a una empresa'});
    if(!Number.isInteger(id)||id<1) return res.status(400).json({error:'Cliente inválido'});
    const [r]=await getPool().query('DELETE FROM clientes_empresa WHERE empresa_id=? AND id=?',[E,id]);
    if(!r.affectedRows) return res.status(404).json({error:'Cliente no encontrado'});
    res.json({ok:true});
  } catch(e) { errorPublico(res,e); }
});

/* Guardado dedicado para la galería. Evita enviar y reescribir todo el estado
   del negocio cada vez que el administrador publica una fotografía. */
app.put('/api/galeria', requireAuth, requireRole('admin'), async (req, res) => {
  const E=req.user.empresa_id; if(!E) return res.status(403).json({error:'Tu usuario no está asociado a una empresa'});
  const galeria=arr(req.body && req.body.galeria);
  if(galeria.length>12) return res.status(400).json({error:'La galería admite hasta 12 imágenes'});
  const pesoGaleria=galeria.reduce((s,item)=>s+String(typeof item==='string'?item:(item&&item.imagen)||'').length,0);
  if(pesoGaleria>22*1024*1024) return res.status(413).json({error:'La galería completa supera el límite permitido. Reduce el peso de algunas fotografías.'});
  try {
    const limpia=galeria.map((item,i)=>{
      const g=typeof item==='string'?{imagen:item}:item||{};
      exigirImagenWeb(g.imagen,'Imagen de galería');
      return {id:String(g.id||Date.now()+i).slice(0,48),imagen:g.imagen,titulo:String(g.titulo||'').trim().slice(0,80),descripcion:String(g.descripcion||'').trim().slice(0,180)};
    });
    const c=await getPool().getConnection();
    try {
      await c.beginTransaction();
      await c.query('UPDATE config SET galeria=? WHERE empresa_id=?',[JSON.stringify(limpia),E]);
      const revision=await subirVersion(c,E);
      await c.commit();
      res.json({ok:true,revision,galeria:limpia});
    } catch(e) { await c.rollback(); throw e; } finally { c.release(); }
  } catch(e) { errorPublico(res,e); }
});

/* ───────── INVENTARIO ESTRICTO ─────────
   Las compras ingresan al almacén. Publicar/retirar son traslados entre el
   almacén y la tienda: nunca crean ni destruyen unidades. */
function datosOperacionInventario(body) {
  const cantidad=num(body&&body.cantidad), precio=num(body&&body.precio);
  const fecha=String(body&&body.fecha||'');
  if(!Number.isInteger(cantidad)||cantidad<=0){const e=new Error('La cantidad debe ser un entero mayor que cero');e.status=400;throw e;}
  if(precio<0){const e=new Error('El precio de compra no es válido');e.status=400;throw e;}
  if(!/^\d{4}-\d{2}-\d{2}$/.test(fecha)){const e=new Error('Selecciona una fecha válida');e.status=400;throw e;}
  return {cantidad,precio,fecha,obs:String(body&&body.obs||'').trim().slice(0,255)};
}

app.post('/api/inventario/compras', requireAuth, requireRole('admin'), async(req,res)=>{
  const E=req.user.empresa_id, c=await getPool().getConnection();
  try{
    const op=datosOperacionInventario(req.body||{});
    let proveedorId=num(req.body&&req.body.proveedorId), proveedorCreado=false;
    const proveedorNombre=String(req.body&&req.body.proveedorNombre||'').trim().slice(0,80);
    await c.beginTransaction();
    const [[meta]]=await c.query('SELECT seq FROM app_meta WHERE empresa_id=? FOR UPDATE',[E]);
    const seq=obj(meta&&meta.seq);
    if(proveedorId){
      const [[proveedor]]=await c.query("SELECT id FROM proveedores WHERE empresa_id=? AND id=? AND estado='activo' FOR UPDATE",[E,proveedorId]);
      if(!proveedor){await c.rollback();return res.status(400).json({error:'El proveedor no está disponible'});}
    }else if(proveedorNombre){
      const [[existente]]=await c.query("SELECT id FROM proveedores WHERE empresa_id=? AND LOWER(nombre)=LOWER(?) AND estado='activo' LIMIT 1 FOR UPDATE",[E,proveedorNombre]);
      if(existente) proveedorId=num(existente.id);
      else{
        const [[mp]]=await c.query('SELECT COALESCE(MAX(id),0) m FROM proveedores WHERE empresa_id=?',[E]);
        proveedorId=Math.max(num(seq.proveedor),num(mp&&mp.m))+1; seq.proveedor=proveedorId;
        await c.query("INSERT INTO proveedores (empresa_id,id,nombre,telefono,correo,empresa,direccion,whatsapp,origen,estado) VALUES (?,?,?,'','','','','','no_registrado','activo')",[E,proveedorId,proveedorNombre]);
        proveedorCreado=true;
      }
    }else proveedorId=null;
    let productoId=num(req.body&&req.body.productoId), producto;
    if(productoId){
      [[producto]]=await c.query('SELECT * FROM productos WHERE empresa_id=? AND id=? FOR UPDATE',[E,productoId]);
      if(!producto){await c.rollback();return res.status(404).json({error:'Producto no encontrado'});}
      await c.query('UPDATE productos SET stock_inventario=stock_inventario+?,precio_compra=? WHERE empresa_id=? AND id=?',[op.cantidad,op.precio,E,productoId]);
    }else{
      const nuevo=req.body&&req.body.nuevo||{}, nombre=String(nuevo.nombre||'').trim().slice(0,120), categoriaId=num(nuevo.categoria_id);
      if(!nombre||!categoriaId){await c.rollback();return res.status(400).json({error:'Para un artículo nuevo indica nombre y categoría'});}
      const [[cat]]=await c.query("SELECT id FROM categorias WHERE empresa_id=? AND id=? AND estado='activo'",[E,categoriaId]);
      if(!cat){await c.rollback();return res.status(400).json({error:'La categoría no está disponible'});}
      const [[mx]]=await c.query('SELECT COALESCE(MAX(id),0) m FROM productos WHERE empresa_id=?',[E]);
      productoId=Math.max(num(seq.producto),num(mx&&mx.m))+1; seq.producto=productoId;
      const codigo=String(nuevo.codigo||`PROD-${String(productoId).padStart(4,'0')}`).trim().slice(0,40);
      await c.query('INSERT INTO productos (empresa_id,id,codigo,nombre,categoria_id,descripcion,precio_compra,precio_venta,stock,stock_inventario,stock_min,imagen,imagenes,estado,destacado,publicado_alguna_vez,marca,tipo_piel) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
        [E,productoId,codigo,nombre,categoriaId,String(nuevo.descripcion||'').slice(0,1000),op.precio,num(nuevo.precio_venta),0,op.cantidad,Math.max(0,num(nuevo.stock_min)), '',JSON.stringify([]),'inactivo',0,0,String(nuevo.marca||'').slice(0,80),JSON.stringify([])]);
    }
    const [[mc]]=await c.query('SELECT COALESCE(MAX(id),0) m FROM compras WHERE empresa_id=?',[E]);
    const compraId=Math.max(num(seq.compra),num(mc&&mc.m))+1; seq.compra=compraId;
    await c.query('INSERT INTO compras (empresa_id,id,producto_id,proveedor_id,cantidad,precio,fecha,obs) VALUES (?,?,?,?,?,?,?,?)',[E,compraId,productoId,proveedorId,op.cantidad,op.precio,op.fecha,op.obs]);
    const [[mm]]=await c.query('SELECT COALESCE(MAX(id),0) m FROM movimientos WHERE empresa_id=?',[E]);
    const movimientoId=Math.max(num(seq.movimiento),num(mm&&mm.m))+1;seq.movimiento=movimientoId;
    await c.query('INSERT INTO movimientos (empresa_id,id,tipo,signo,producto_id,cantidad,fecha,usuario,obs) VALUES (?,?,?,?,?,?,?,?,?)',[E,movimientoId,'entrada',null,productoId,op.cantidad,op.fecha,req.user.nombre,op.obs?`Compra → inventario · ${op.obs}`:'Compra → inventario']);
    await c.query('UPDATE app_meta SET seq=? WHERE empresa_id=?',[JSON.stringify(seq),E]);
    const revision=await subirVersion(c,E); await c.commit();
    res.status(201).json({ok:true,productoId,compraId,proveedorId,proveedorCreado,revision});
  }catch(e){await c.rollback().catch(()=>{});errorPublico(res,e);}finally{c.release();}
});

app.post('/api/inventario/transferir', requireAuth, requireRole('admin'), async(req,res)=>{
  const E=req.user.empresa_id, productoId=num(req.body&&req.body.productoId), cantidad=num(req.body&&req.body.cantidad), direccion=String(req.body&&req.body.direccion||'');
  if(!productoId||!Number.isInteger(cantidad)||cantidad<=0||!['publicar','retirar'].includes(direccion)) return res.status(400).json({error:'Traslado de inventario inválido'});
  const c=await getPool().getConnection();
  try{
    await c.beginTransaction();
    const [[p]]=await c.query('SELECT nombre,stock,stock_inventario FROM productos WHERE empresa_id=? AND id=? FOR UPDATE',[E,productoId]);
    if(!p){await c.rollback();return res.status(404).json({error:'Producto no encontrado'});}
    if(direccion==='publicar'&&num(p.stock_inventario)<cantidad){await c.rollback();return res.status(409).json({error:`Solo hay ${num(p.stock_inventario)} unidades en inventario`});}
    if(direccion==='retirar'&&num(p.stock)<cantidad){await c.rollback();return res.status(409).json({error:`Solo hay ${num(p.stock)} unidades publicadas`});}
    if(direccion==='publicar') await c.query("UPDATE productos SET stock=stock+?,stock_inventario=stock_inventario-?,estado='activo',publicado_alguna_vez=1 WHERE empresa_id=? AND id=?",[cantidad,cantidad,E,productoId]);
    else await c.query('UPDATE productos SET stock=stock-?,stock_inventario=stock_inventario+? WHERE empresa_id=? AND id=?',[cantidad,cantidad,E,productoId]);
    const [[meta]]=await c.query('SELECT seq FROM app_meta WHERE empresa_id=? FOR UPDATE',[E]),seq=obj(meta&&meta.seq);
    const [[mm]]=await c.query('SELECT COALESCE(MAX(id),0) m FROM movimientos WHERE empresa_id=?',[E]);
    const movimientoId=Math.max(num(seq.movimiento),num(mm&&mm.m))+1;seq.movimiento=movimientoId;
    await c.query('INSERT INTO movimientos (empresa_id,id,tipo,signo,producto_id,cantidad,fecha,usuario,obs) VALUES (?,?,?,?,?,?,?,?,?)',[E,movimientoId,'ajuste',direccion==='publicar'?'+':'-',productoId,cantidad,new Date().toISOString().slice(0,10),req.user.nombre,direccion==='publicar'?'Inventario → tienda':'Tienda → inventario']);
    await c.query('UPDATE app_meta SET seq=? WHERE empresa_id=?',[JSON.stringify(seq),E]);
    const revision=await subirVersion(c,E);await c.commit();
    res.json({ok:true,revision,stock:direccion==='publicar'?num(p.stock)+cantidad:num(p.stock)-cantidad,stockInventario:direccion==='publicar'?num(p.stock_inventario)-cantidad:num(p.stock_inventario)+cantidad});
  }catch(e){await c.rollback().catch(()=>{});errorPublico(res,e);}finally{c.release();}
});

app.post('/api/ventas/directas', requireAuth, requireRole('admin'), async(req,res)=>{
  const E=req.user.empresa_id, productoId=num(req.body&&req.body.productoId), cantidad=num(req.body&&req.body.cantidad), precio=num(req.body&&req.body.precio), fecha=String(req.body&&req.body.fecha||''), confirmar=!!(req.body&&req.body.confirmarInventario);
  const clienteNombre=String(req.body&&req.body.clienteNombre||'').trim().slice(0,120), clienteIdentidad=String(req.body&&req.body.clienteIdentidad||'').trim().slice(0,40);
  if(!productoId||!Number.isInteger(cantidad)||cantidad<=0||precio<0||!clienteNombre||!/^\d{4}-\d{2}-\d{2}$/.test(fecha)) return res.status(400).json({error:'Completa correctamente los datos de la venta'});
  const c=await getPool().getConnection();
  try{
    await c.beginTransaction();
    const [[p]]=await c.query('SELECT nombre,stock,stock_inventario,stock_min FROM productos WHERE empresa_id=? AND id=? FOR UPDATE',[E,productoId]);
    if(!p){await c.rollback();return res.status(404).json({error:'Producto no encontrado'});}
    const tienda=Math.min(cantidad,num(p.stock)), inventario=cantidad-tienda, totalDisponible=num(p.stock)+num(p.stock_inventario);
    if(cantidad>totalDisponible){await c.rollback();return res.status(409).json({error:`Solo hay ${totalDisponible} unidades entre tienda e inventario`});}
    if(inventario>0&&!confirmar){await c.rollback();return res.status(409).json({error:`La tienda tiene ${num(p.stock)} unidades. Para completar la venta se tomarán ${inventario} del inventario.`,requiereConfirmacion:true,distribucion:{tienda,inventario}});}
    await c.query('UPDATE productos SET stock=stock-?,stock_inventario=stock_inventario-? WHERE empresa_id=? AND id=?',[tienda,inventario,E,productoId]);
    const [[meta]]=await c.query('SELECT seq FROM app_meta WHERE empresa_id=? FOR UPDATE',[E]),seq=obj(meta&&meta.seq);
    const [[mv]]=await c.query('SELECT COALESCE(MAX(id),0) m FROM ventas WHERE empresa_id=?',[E]);
    const ventaId=Math.max(num(seq.venta),num(mv&&mv.m))+1;seq.venta=ventaId;
    const origen=inventario&&tienda?'mixto':inventario?'inventario':'tienda';
    await c.query('INSERT INTO ventas (empresa_id,id,producto_id,cliente_id,cliente_nombre,cliente_identidad,pedido_id,estado,origen_stock,stock_tienda_usado,stock_inventario_usado,cantidad,precio,fecha,total) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',[E,ventaId,productoId,null,clienteNombre,clienteIdentidad,null,'activa',origen,tienda,inventario,cantidad,precio,fecha,+(cantidad*precio).toFixed(2)]);
    const [[mm]]=await c.query('SELECT COALESCE(MAX(id),0) m FROM movimientos WHERE empresa_id=?',[E]);
    const movimientoId=Math.max(num(seq.movimiento),num(mm&&mm.m))+1;seq.movimiento=movimientoId;
    await c.query('INSERT INTO movimientos (empresa_id,id,tipo,signo,producto_id,cantidad,fecha,usuario,obs) VALUES (?,?,?,?,?,?,?,?,?)',[E,movimientoId,'salida',null,productoId,cantidad,fecha,req.user.nombre,`Venta a ${clienteNombre} · ${tienda} tienda${inventario?` + ${inventario} inventario`:''}`]);
    await c.query('UPDATE app_meta SET seq=? WHERE empresa_id=?',[JSON.stringify(seq),E]);
    const revision=await subirVersion(c,E);await c.commit();
    res.status(201).json({ok:true,ventaId,revision,origen,distribucion:{tienda,inventario},stock:num(p.stock)-tienda,stockInventario:num(p.stock_inventario)-inventario});
  }catch(e){await c.rollback().catch(()=>{});errorPublico(res,e);}finally{c.release();}
});

/* ───────── PERFIL DE MI CUENTA (cliente) ─────────
   nombre/telefono/correo/direccion/whatsapp viven ahora en `users` (el cliente
   es una fila global, no una por empresa). Si cambia el correo, se revalida
   que siga siendo único, porque también es su credencial de login. */
app.put('/api/clientes/mi', requireAuth, requireRole('cliente','admin'), async (req, res) => {
  const { nombre, telefono, correo, direccion, whatsapp } = req.body || {};
  if (!nombre || !String(nombre).trim()) return res.status(400).json({ error: 'Falta el nombre' });
  { const vN = validarNombrePersona(nombre, 'nombre'); if (!vN.ok) return res.status(400).json({ error: vN.error }); }
  { const vT = validarTelefono(telefono, null, 'teléfono'); if (!vT.ok) return res.status(400).json({ error: vT.error }); }
  { const vW = validarTelefono(whatsapp, null, 'WhatsApp'); if (!vW.ok) return res.status(400).json({ error: vW.error }); }
  const email = correo ? String(correo).toLowerCase().trim() : null;
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'Correo electrónico inválido' });
  try {
    const actualizaDirecciones = Array.isArray(req.body && req.body.direcciones);
    const direcciones = actualizaDirecciones ? normalizarDirecciones(req.body.direcciones) : null;
    const principal = direcciones && direcciones.find(d => d.principal);
    const direccionPrincipal = principal ? [principal.direccion, principal.ciudad, principal.departamento].filter(Boolean).join(', ') : String(direccion || '').slice(0, 160);
    const pool = getPool();
    if (email) {
      const [dup] = await pool.query('SELECT id FROM users WHERE email=? AND id<>? LIMIT 1', [email, req.user.id]);
      if (dup.length) return res.status(409).json({ error: 'Ese correo ya está en uso' });
    }
    await pool.query(
      'UPDATE users SET nombre=?, telefono=?, email=COALESCE(?,email), direccion=?, direcciones=COALESCE(?,direcciones), whatsapp=? WHERE id=?',
      [String(nombre).trim(), String(telefono || '').slice(0, 30), email, direccionPrincipal, direcciones ? JSON.stringify(direcciones) : null, String(whatsapp || '').slice(0, 24), req.user.id]);
    res.json({ ok: true });
  } catch (err) { errorPublico(res, err); }
});

app.get('/api/clientes/mi', requireAuth, requireRole('cliente','admin'), async (req, res) => {
  try {
    const [[u]] = await getPool().query(
      "SELECT id,nombre,email AS correo,role,empresa_id,telefono,direccion,direcciones,whatsapp,created_at FROM users WHERE id=? AND role IN ('cliente','admin') AND activo=1",
      [req.user.id]);
    if (!u) return res.status(404).json({ error: 'Cuenta no encontrada' });
    u.direcciones = arr(u.direcciones);
    if (!u.direcciones.length && u.direccion) u.direcciones = [{ id:'principal', etiqueta:'Principal', nombre:u.nombre, direccion:u.direccion, ciudad:'', departamento:'', referencia:'', telefono:u.telefono || '', principal:true }];
    res.json(u);
  } catch (e) { errorPublico(res, e); }
});

app.put('/api/clientes/mi/password', limitarIntentos(8, 15 * 60 * 1000), requireAuth, requireRole('cliente','admin'), async (req, res) => {
  const actual = String(req.body && req.body.actual || '');
  const nueva = String(req.body && req.body.nueva || '');
  if (!actual || nueva.length < 8) return res.status(400).json({ error: 'La nueva contraseña debe tener al menos 8 caracteres' });
  try {
    const pool = getPool();
    const [[u]] = await pool.query("SELECT password_hash FROM users WHERE id=? AND role IN ('cliente','admin') AND activo=1", [req.user.id]);
    if (!u || !checkPassword(actual, u.password_hash)) return res.status(401).json({ error: 'La contraseña actual no es correcta' });
    if (checkPassword(nueva, u.password_hash)) return res.status(400).json({ error: 'La nueva contraseña debe ser diferente a la actual' });
    await pool.query('UPDATE users SET password_hash=? WHERE id=?', [hashPassword(nueva), req.user.id]);
    res.json({ ok:true });
  } catch (e) { errorPublico(res, e); }
});

/* ───────── CHECKOUT (cliente) ─────────
   El carrito puede tener productos de varias empresas. Se agrupa por
   empresa_id y se crea UN pedido por empresa, todo dentro de una sola
   transacción: si algo no resuelve (empresa inactiva, producto inexistente
   o inactivo en esa empresa), se aborta TODO el checkout, sin pedidos
   parciales. Los precios siempre se recalculan server-side. */
app.post('/api/pedidos/checkout', limitarIntentos(20, 10 * 60 * 1000), requireAuth, requireRole('cliente','admin'), async (req, res) => {
  const items = arr(req.body && req.body.items);
  if (!Array.isArray(items) || !items.length) return res.status(400).json({ error: 'El carrito está vacío' });
  const nota = String((req.body && req.body.nota) || '').slice(0, 500);
  const metodoPago = String((req.body && req.body.metodoPago) || '').slice(0, 40);
  const comprobante = String((req.body && req.body.comprobante) || '');
  const entregaSolicitada = obj(req.body && req.body.entrega);
  const detallePago = obj(req.body && req.body.detallePago);
  if (!['transferencia','tarjeta'].includes(metodoPago)) return res.status(400).json({ error: 'Selecciona un método de pago válido' });
  if (metodoPago === 'transferencia' && !comprobante) return res.status(400).json({ error: 'Falta el comprobante de transferencia' });
  if (metodoPago === 'tarjeta' && detallePago.modo !== 'pendiente_pasarela') return res.status(400).json({ error: 'No se pudo validar la referencia de la tarjeta' });
  try { exigirImagenWeb(comprobante, 'Comprobante'); }
  catch (e) { return errorPublico(res, e); }

  const porEmpresa = new Map();
  for (const it of items) {
    const empresaId = it && num(it.empresa_id);
    const productoId = it && num(it.producto_id);
    const cantidad = it && num(it.cantidad);
    if (!empresaId || !productoId || cantidad <= 0) {
      return res.status(400).json({ error: 'Item de carrito inválido: falta empresa_id, producto_id o cantidad' });
    }
    if (!porEmpresa.has(empresaId)) porEmpresa.set(empresaId, []);
    const grupo = porEmpresa.get(empresaId);
    const repetido = grupo.find(x => x.producto_id === productoId);
    if (repetido) repetido.cantidad += cantidad;
    else grupo.push({ producto_id: productoId, cantidad });
  }

  const pool = getPool();
  const c = await pool.getConnection();
  try {
    await c.beginTransaction();
    const [[perfilEntrega]] = await c.query("SELECT nombre,telefono,direccion,direcciones FROM users WHERE id=? AND role IN ('cliente','admin') FOR UPDATE", [req.user.id]);
    const direcciones = arr(perfilEntrega && perfilEntrega.direcciones);
    const dirPrincipal = direcciones.find(d => d && d.principal) || direcciones[0] || {};
    const destinatario = String(entregaSolicitada.nombre || dirPrincipal.nombre || perfilEntrega.nombre || '').trim().slice(0, 120);
    const telefonoEntrega = String(entregaSolicitada.telefono || dirPrincipal.telefono || perfilEntrega.telefono || '').trim().slice(0, 30);
    const direccionEntrega = String([
      entregaSolicitada.direccion || dirPrincipal.direccion || perfilEntrega.direccion || '',
      entregaSolicitada.ciudad || dirPrincipal.ciudad || '',
      entregaSolicitada.departamento || dirPrincipal.departamento || ''
    ].filter(Boolean).join(', ')).trim().slice(0, 240);
    if (!destinatario || !telefonoEntrega || !direccionEntrega) {
      await c.rollback();
      return res.status(400).json({ error: 'Completa el nombre, teléfono y dirección de entrega' });
    }
    { const vT = validarTelefono(telefonoEntrega, null, 'teléfono de entrega'); if (!vT.ok) { await c.rollback(); return res.status(400).json({ error: vT.error }); } }
    { const vD = validarDireccion(direccionEntrega, 'dirección de entrega'); if (!vD.ok) { await c.rollback(); return res.status(400).json({ error: vD.error }); } }
    const pagoEstado = metodoPago === 'transferencia' ? 'en_revision' : 'pendiente_pasarela';
    const pagoReferencia = metodoPago === 'tarjeta'
      ? `${String(detallePago.marca || 'Tarjeta').slice(0,24)} •••• ${String(detallePago.ultimos4 || '').replace(/\D/g,'').slice(-4)}`
      : '';
    const pedidosCreados = [];

    for (const [empresaId, itemsEmpresa] of porEmpresa) {
      const [[emp]] = await c.query("SELECT id, slug, nombre, rubro, ciudad, logo FROM empresas WHERE id=? AND estado='activa'", [empresaId]);
      if (!emp) { await c.rollback(); return res.status(400).json({ error: `La tienda ${empresaId} no existe o no está activa` }); }

      const productoIds = itemsEmpresa.map(it => it.producto_id);
      const [prodRows] = await c.query(
        "SELECT id, nombre, precio_venta, stock, imagen, imagenes FROM productos WHERE empresa_id=? AND estado='activo' AND id IN (?) FOR UPDATE",
        [empresaId, productoIds]);
      const productos = new Map(prodRows.map(pr => [pr.id, { nombre: pr.nombre, precio: num(pr.precio_venta), stock: num(pr.stock), imagen: pr.imagen || arr(pr.imagenes)[0] || '' }]));

      const itemsCalc = itemsEmpresa.map(it => {
        if (!productos.has(it.producto_id)) return null;
        const disponible = productos.get(it.producto_id);
        if (it.cantidad > disponible.stock) return { errorStock: true, producto_id: it.producto_id, disponible: disponible.stock };
        const precio = disponible.precio;
        return { producto_id: it.producto_id, nombre: disponible.nombre, imagen: disponible.imagen, cantidad: it.cantidad, precio, subtotal: +(precio * it.cantidad).toFixed(2) };
      });
      if (itemsCalc.some(x => x === null)) {
        await c.rollback();
        return res.status(400).json({ error: `Uno o más productos de la tienda "${emp.nombre}" ya no están disponibles` });
      }
      const sinStock = itemsCalc.find(x => x && x.errorStock);
      if (sinStock) {
        await c.rollback();
        return res.status(409).json({ error: `Stock insuficiente en "${emp.nombre}"`, producto_id: sinStock.producto_id, disponible: sinStock.disponible });
      }

      const total = +itemsCalc.reduce((s, i) => s + i.subtotal, 0).toFixed(2);

      const [mrows] = await c.query('SELECT seq FROM app_meta WHERE empresa_id=? FOR UPDATE', [empresaId]);
      const seq = (mrows[0] && mrows[0].seq) || {};
      const [maxr] = await c.query('SELECT COALESCE(MAX(id),0) AS m FROM pedidos WHERE empresa_id=?', [empresaId]);
      const nid = Math.max(num(seq.pedido), maxr[0].m) + 1;
      const fecha = new Date().toISOString().slice(0, 10);

      await c.query('INSERT INTO pedidos (empresa_id,id,cliente_id,total,nota,fecha,estado,metodo_pago,pago_estado,pago_referencia,comprobante,destinatario,telefono_entrega,direccion_entrega) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
        [empresaId, nid, req.user.id, total, nota, fecha, 'pendiente', metodoPago, pagoEstado, pagoReferencia, comprobante, destinatario, telefonoEntrega, direccionEntrega]);
      for (const it of itemsCalc)
        await c.query('INSERT INTO pedido_items (empresa_id,pedido_id,producto_id,cantidad,precio,subtotal) VALUES (?,?,?,?,?,?)',
          [empresaId, nid, it.producto_id, it.cantidad, it.precio, it.subtotal]);

      seq.pedido = nid;
      await c.query('UPDATE app_meta SET seq=?, version=version+1 WHERE empresa_id=?', [JSON.stringify(seq), empresaId]);

      pedidosCreados.push({
        id: nid, cliente_id: req.user.id, total, nota, fecha, estado: 'pendiente', destinatario, telefonoEntrega, direccionEntrega,
        metodoPago, pagoEstado, pagoReferencia, comprobante, items: itemsCalc,
        empresa: { id: emp.id, slug: emp.slug, nombre: emp.nombre, rubro: emp.rubro || '', ciudad: emp.ciudad || '', logo: emp.logo || '' },
      });
    }

    await c.commit();
    res.json({ pedidos: pedidosCreados });
  } catch (e) {
    await c.rollback().catch(() => {});
    errorPublico(res, e);
  } finally { c.release(); }
});

/* ───────── MIS PEDIDOS (cliente) ─────────
   Todos los pedidos del cliente logueado, en TODAS las empresas donde
   compró. No reutiliza mapPedidos(): esa función empareja items por
   pedido_id, que sólo es único DENTRO de una empresa, así que cruzando
   empresas mezclaría items de pedidos distintos con el mismo id. */
app.get('/api/mis-pedidos', requireAuth, requireRole('cliente','admin'), async (req, res) => {
  try {
    const pool = getPool();
    const [peds] = await pool.query(
      `SELECT pedidos.*, empresas.slug AS emp_slug, empresas.nombre AS emp_nombre,
              empresas.rubro AS emp_rubro, empresas.ciudad AS emp_ciudad, empresas.logo AS emp_logo,
              config.moneda AS emp_moneda
       FROM pedidos JOIN empresas ON pedidos.empresa_id = empresas.id
       LEFT JOIN config ON config.empresa_id = empresas.id
       WHERE pedidos.cliente_id = ?
       ORDER BY pedidos.fecha DESC, pedidos.id DESC`, [req.user.id]);

    const itemsPorPedido = new Map(); // clave "empresaId:pedidoId" -> items[]
    const mensajesPorPedido = new Map();
    for (const p of peds) {
      const [rows] = await pool.query(
        `SELECT pi.producto_id,pi.cantidad,pi.precio,pi.subtotal,
                COALESCE(pr.nombre, 'Producto no disponible') AS nombre,
                COALESCE(pr.imagen, '') AS imagen, pr.imagenes
         FROM pedido_items pi
         LEFT JOIN productos pr ON pr.empresa_id=pi.empresa_id AND pr.id=pi.producto_id
         WHERE pi.empresa_id=? AND pi.pedido_id=?`, [p.empresa_id, p.id]);
      itemsPorPedido.set(`${p.empresa_id}:${p.id}`, rows.map(i => ({
        producto_id: i.producto_id, nombre: i.nombre, imagen: i.imagen || arr(i.imagenes)[0] || '', cantidad: num(i.cantidad), precio: num(i.precio), subtotal: num(i.subtotal),
      })));
      const [mensajes] = await pool.query(
        'SELECT id,autor,texto,fecha,leido FROM mensajes WHERE empresa_id=? AND pedido_id=? ORDER BY fecha ASC,id ASC',
        [p.empresa_id,p.id]);
      mensajesPorPedido.set(`${p.empresa_id}:${p.id}`,mensajes.map(m=>({...m,empresa_id:p.empresa_id,pedido_id:p.id,leido:!!m.leido})));
    }

    res.json({
      pedidos: peds.map(p => ({
        id: p.id, cliente_id: p.cliente_id, total: num(p.total), nota: p.nota || '', fecha: p.fecha,
        estado: p.estado, metodoPago: p.metodo_pago || '', pagoEstado:p.pago_estado||'pendiente', pagoReferencia:p.pago_referencia||'', comprobante: p.comprobante || '',
        destinatario: p.destinatario || '', telefonoEntrega: p.telefono_entrega || '', direccionEntrega: p.direccion_entrega || '',
        items: itemsPorPedido.get(`${p.empresa_id}:${p.id}`) || [],
        mensajes: mensajesPorPedido.get(`${p.empresa_id}:${p.id}`) || [],
        empresa: { id: p.empresa_id, slug: p.emp_slug, nombre: p.emp_nombre, rubro: p.emp_rubro || '', ciudad: p.emp_ciudad || '', logo: p.emp_logo || '', moneda: p.emp_moneda || 'L' },
      })),
    });
  } catch (e) { errorPublico(res, e); }
});

/* ───────── MENSAJES DE UN PEDIDO (cliente) ─────────
   Reemplaza la porción de chat que antes vivía dentro de PUT /api/state
   para el cliente (guardarEstadoCliente, eliminada al globalizar la cuenta).
   Antes de leer/escribir, confirma que el pedido sea del cliente logueado —
   si no, 404 genérico (no revela si el pedido es de otro cliente o no existe). */
app.get('/api/pedidos/:empresaId/:pedidoId/mensajes', requireAuth, requireRole('cliente','admin'), async (req, res) => {
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
  } catch (e) { errorPublico(res, e); }
});

app.post('/api/pedidos/:empresaId/:pedidoId/mensajes', limitarIntentos(30, 10 * 60 * 1000), requireAuth, requireRole('cliente','admin'), async (req, res) => {
  const empresaId = num(req.params.empresaId);
  const pedidoId = num(req.params.pedidoId);
  const texto = String((req.body && req.body.texto) || '').slice(0, 2000).trim();
  if (!texto) return res.status(400).json({ error: 'Falta el texto del mensaje' });
  const pool = getPool();
  const c = await pool.getConnection();
  try {
    const [[pedido]] = await c.query('SELECT id FROM pedidos WHERE empresa_id=? AND id=? AND cliente_id=?', [empresaId, pedidoId, req.user.id]);
    if (!pedido) return res.status(404).json({ error: 'Pedido no encontrado' });

    await c.beginTransaction();
    const [[meta]] = await c.query('SELECT seq FROM app_meta WHERE empresa_id=? FOR UPDATE', [empresaId]);
    const seq = (meta && meta.seq) || {};
    const [maxr] = await c.query('SELECT COALESCE(MAX(id),0) AS m FROM mensajes WHERE empresa_id=?', [empresaId]);
    const nid = Math.max(num(seq.mensaje), maxr[0].m) + 1;

    await c.query('INSERT INTO mensajes (empresa_id,id,pedido_id,autor,texto,fecha,leido) VALUES (?,?,?,?,?,?,0)',
      [empresaId, nid, pedidoId, 'cliente', texto, dtMysql(new Date().toISOString())]);
    seq.mensaje = nid;
    await c.query('UPDATE app_meta SET seq=?, version=version+1 WHERE empresa_id=?', [JSON.stringify(seq), empresaId]);
    await c.commit();
    res.json({ ok: true, mensaje: { id: nid, pedido_id: pedidoId, autor: 'cliente', texto, fecha: new Date().toISOString(), leido: false } });
  } catch (e) {
    await c.rollback().catch(() => {});
    errorPublico(res, e);
  } finally { c.release(); }
});

app.patch('/api/pedidos/:empresaId/:pedidoId/mensajes/leidos', requireAuth, requireRole('cliente','admin'), async (req, res) => {
  const empresaId = num(req.params.empresaId), pedidoId = num(req.params.pedidoId);
  try {
    const pool = getPool();
    const [[p]] = await pool.query('SELECT id FROM pedidos WHERE empresa_id=? AND id=? AND cliente_id=?', [empresaId, pedidoId, req.user.id]);
    if (!p) return res.status(404).json({ error: 'Pedido no encontrado' });
    await pool.query("UPDATE mensajes SET leido=1 WHERE empresa_id=? AND pedido_id=? AND autor='admin'", [empresaId, pedidoId]);
    res.json({ ok: true });
  } catch (e) { errorPublico(res, e); }
});

app.patch('/api/pedidos/:empresaId/:pedidoId/cancelar', requireAuth, requireRole('cliente','admin'), async (req, res) => {
  const empresaId = num(req.params.empresaId), pedidoId = num(req.params.pedidoId);
  const c = await getPool().getConnection();
  try {
    await c.beginTransaction();
    const [[p]] = await c.query('SELECT estado FROM pedidos WHERE empresa_id=? AND id=? AND cliente_id=? FOR UPDATE', [empresaId, pedidoId, req.user.id]);
    if (!p) { await c.rollback(); return res.status(404).json({ error: 'Pedido no encontrado' }); }
    if (p.estado !== 'pendiente') { await c.rollback(); return res.status(409).json({ error: 'Solo se puede cancelar un pedido pendiente' }); }
    await c.query("UPDATE pedidos SET estado='cancelado' WHERE empresa_id=? AND id=?", [empresaId, pedidoId]);
    const revision = await subirVersion(c, empresaId);
    await c.commit();
    res.json({ ok: true, revision });
  } catch (e) { await c.rollback().catch(() => {}); errorPublico(res, e); }
  finally { c.release(); }
});

/* Transición transaccional de pedidos. El stock se descuenta una sola vez al
   aprobar y se repone si un pedido aprobado se cancela. Las ventas se anulan,
   no se borran, para conservar trazabilidad. */
app.patch('/api/pedidos/:pedidoId/estado', requireAuth, requireRole('admin'), async (req, res) => {
  const E = req.user.empresa_id, pedidoId = num(req.params.pedidoId);
  const destino = String((req.body && req.body.estado) || '');
  const estados=['pendiente','aprobado','preparando','listo','enviado','entregado','cancelado'];
  if (!estados.includes(destino)) return res.status(400).json({ error: 'Estado inválido' });
  const c = await getPool().getConnection();
  try {
    await c.beginTransaction();
    const [[pedido]] = await c.query('SELECT * FROM pedidos WHERE empresa_id=? AND id=? FOR UPDATE', [E, pedidoId]);
    if (!pedido) { await c.rollback(); return res.status(404).json({ error: 'Pedido no encontrado' }); }
    if (pedido.estado === destino) { await c.rollback(); return res.json({ ok: true, estado: destino }); }
    const transiciones={
      pendiente:['aprobado','cancelado'],
      aprobado:['preparando','listo','enviado','entregado','cancelado'],
      preparando:['listo','enviado','entregado','cancelado'],
      listo:['enviado','entregado','cancelado'],
      enviado:['entregado'],
      entregado:[],cancelado:[]
    };
    const permitida=(transiciones[pedido.estado]||[]).includes(destino);
    if (!permitida) { await c.rollback(); return res.status(409).json({ error: `No se puede pasar de ${pedido.estado} a ${destino}` }); }

    const [items] = await c.query('SELECT * FROM pedido_items WHERE empresa_id=? AND pedido_id=?', [E, pedidoId]);
    const [[meta]] = await c.query('SELECT seq FROM app_meta WHERE empresa_id=? FOR UPDATE', [E]);
    const seq = (meta && meta.seq) || {};
    const fecha = new Date().toISOString().slice(0, 10);
    const [[cliente]] = await c.query('SELECT nombre FROM users WHERE id=?', [pedido.cliente_id]);

    if (pedido.estado === 'pendiente' && destino === 'aprobado') {
      for (const it of items) {
        const [[prod]] = await c.query('SELECT nombre,stock FROM productos WHERE empresa_id=? AND id=? FOR UPDATE', [E, it.producto_id]);
        if (!prod || num(prod.stock) < num(it.cantidad)) {
          await c.rollback();
          return res.status(409).json({ error: `Stock insuficiente para ${prod ? prod.nombre : 'un producto'}` });
        }
      }
      for (const it of items) {
        await c.query('UPDATE productos SET stock=stock-? WHERE empresa_id=? AND id=?', [it.cantidad, E, it.producto_id]);
        seq.venta = num(seq.venta) + 1;
        await c.query('INSERT INTO ventas (empresa_id,id,producto_id,cliente_id,cliente_nombre,cliente_identidad,pedido_id,estado,cantidad,precio,fecha,total) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
          [E, seq.venta, it.producto_id, pedido.cliente_id, (cliente && cliente.nombre) || '', '', pedidoId, 'activa', it.cantidad, it.precio, fecha, it.subtotal]);
        seq.movimiento = num(seq.movimiento) + 1;
        await c.query('INSERT INTO movimientos (empresa_id,id,tipo,signo,producto_id,cantidad,fecha,usuario,obs) VALUES (?,?,?,?,?,?,?,?,?)',
          [E, seq.movimiento, 'salida', null, it.producto_id, it.cantidad, fecha, req.user.nombre, `Pedido #${pedidoId} aprobado`]);
      }
    }

    if (['aprobado','preparando','listo'].includes(pedido.estado) && destino === 'cancelado') {
      for (const it of items) {
        await c.query('UPDATE productos SET stock=stock+? WHERE empresa_id=? AND id=?', [it.cantidad, E, it.producto_id]);
        seq.movimiento = num(seq.movimiento) + 1;
        await c.query('INSERT INTO movimientos (empresa_id,id,tipo,signo,producto_id,cantidad,fecha,usuario,obs) VALUES (?,?,?,?,?,?,?,?,?)',
          [E, seq.movimiento, 'entrada', null, it.producto_id, it.cantidad, fecha, req.user.nombre, `Reposición por cancelación del pedido #${pedidoId}`]);
      }
      await c.query("UPDATE ventas SET estado='anulada' WHERE empresa_id=? AND pedido_id=?", [E, pedidoId]);
    }

    await c.query('UPDATE pedidos SET estado=? WHERE empresa_id=? AND id=?', [destino, E, pedidoId]);
    const etiquetas={aprobado:'confirmado',preparando:'en preparación',listo:'listo para entregar',enviado:'en camino',entregado:'entregado',cancelado:'cancelado'};
    seq.mensaje=num(seq.mensaje)+1;
    await c.query('INSERT INTO mensajes (empresa_id,id,pedido_id,autor,texto,fecha,leido) VALUES (?,?,?,?,?,?,0)',
      [E,seq.mensaje,pedidoId,'admin',`Actualización automática: tu pedido ahora está ${etiquetas[destino]||destino}.`,dtMysql(new Date().toISOString())]);
    await c.query('UPDATE app_meta SET seq=? WHERE empresa_id=?', [JSON.stringify(seq), E]);
    const revision = await subirVersion(c, E);
    await c.commit();
    res.json({ ok: true, estado: destino, revision });
  } catch (e) { await c.rollback().catch(() => {}); errorPublico(res, e); }
  finally { c.release(); }
});

/* Mensajería administrativa dedicada. Evita reescribir todo /api/state para
   enviar una sola observación y conserva el aislamiento por empresa. */
app.post('/api/pedidos/:pedidoId/mensajes/admin', limitarIntentos(60, 10 * 60 * 1000), requireAuth, requireRole('admin'), async (req,res)=>{
  const E=req.user.empresa_id,pedidoId=num(req.params.pedidoId);
  const texto=String((req.body&&req.body.texto)||'').trim().slice(0,2000);
  if(!texto) return res.status(400).json({error:'Escribe una observación para el cliente'});
  const c=await getPool().getConnection();
  try{
    await c.beginTransaction();
    const [[pedido]]=await c.query('SELECT id FROM pedidos WHERE empresa_id=? AND id=? FOR UPDATE',[E,pedidoId]);
    if(!pedido){await c.rollback();return res.status(404).json({error:'Pedido no encontrado'});}
    const [[meta]]=await c.query('SELECT seq FROM app_meta WHERE empresa_id=? FOR UPDATE',[E]);
    const seq=(meta&&meta.seq)||{};
    const [maxr]=await c.query('SELECT COALESCE(MAX(id),0) AS m FROM mensajes WHERE empresa_id=?',[E]);
    const nid=Math.max(num(seq.mensaje),maxr[0].m)+1;
    const fecha=new Date().toISOString();
    await c.query('INSERT INTO mensajes (empresa_id,id,pedido_id,autor,texto,fecha,leido) VALUES (?,?,?,?,?,?,0)',[E,nid,pedidoId,'admin',texto,dtMysql(fecha)]);
    seq.mensaje=nid;
    await c.query('UPDATE app_meta SET seq=? WHERE empresa_id=?',[JSON.stringify(seq),E]);
    const revision=await subirVersion(c,E);
    await c.commit();
    res.json({ok:true,revision,mensaje:{id:nid,pedido_id:pedidoId,autor:'admin',texto,fecha,leido:false}});
  }catch(e){await c.rollback().catch(()=>{});errorPublico(res,e);}finally{c.release();}
});

app.patch('/api/pedidos/:pedidoId/mensajes/admin/leidos', requireAuth, requireRole('admin'), async (req,res)=>{
  const E=req.user.empresa_id,pedidoId=num(req.params.pedidoId);
  try{
    const pool=getPool();
    const [[pedido]]=await pool.query('SELECT id FROM pedidos WHERE empresa_id=? AND id=?',[E,pedidoId]);
    if(!pedido) return res.status(404).json({error:'Pedido no encontrado'});
    await pool.query("UPDATE mensajes SET leido=1 WHERE empresa_id=? AND pedido_id=? AND autor='cliente'",[E,pedidoId]);
    res.json({ok:true});
  }catch(e){errorPublico(res,e);}
});

// Lista de administradores/proveedores de la propia empresa (panel "Administradores").
// Nunca incluye password_hash; scopeada a empresa_id igual que el resto de rutas admin.
app.get('/api/users', requireAuth, requireRole('admin'), async (req, res) => {
  if (!req.user.empresa_id) return res.status(403).json({ error: 'Tu cuenta no está asociada a una empresa' });
  try {
    const [rows] = await getPool().query(
      "SELECT id,nombre,email,role,activo,created_at FROM users WHERE empresa_id=? AND role IN ('admin','proveedor') ORDER BY nombre",
      [req.user.empresa_id]);
    res.json(rows);
  } catch (e) { errorPublico(res, e); }
});

// Crear (o actualizar) un usuario del sistema — solo un admin puede hacerlo
app.post('/api/users', requireAuth, requireRole('admin'), async (req, res) => {
  try {
    const { nombre, email, password, role } = req.body || {};
    if (!req.user.empresa_id) return res.status(403).json({ error: 'Tu cuenta no está asociada a una empresa' });
    if (!email || !password || String(password).length < 8) return res.status(400).json({ error: 'Correo y contraseña de al menos 8 caracteres obligatorios' });
    // Las cuentas cliente son globales y nacen en /api/auth/register; esta ruta
    // sólo administra personal asociado a la empresa del administrador actual.
    if (!['admin', 'proveedor'].includes(role)) {
      return res.status(400).json({ error: "Rol inválido: usa 'admin' o 'proveedor'" });
    }
    const correo = String(email).toLowerCase().trim();
    const pool = getPool();
    const [ex] = await pool.query('SELECT id,empresa_id,role FROM users WHERE email=? LIMIT 1', [correo]);
    if (ex.length) {
      if (num(ex[0].empresa_id) !== num(req.user.empresa_id) || !['admin','proveedor'].includes(ex[0].role)) {
        return res.status(409).json({ error: 'Ese correo ya pertenece a otra cuenta de SIWEPE' });
      }
      await pool.query('UPDATE users SET nombre=?, password_hash=?, role=?, activo=1 WHERE id=? AND empresa_id=?',
        [nombre || 'Usuario', hashPassword(password), role, ex[0].id, req.user.empresa_id]);
      return res.json({ ok: true, actualizado: true, email: correo, role });
    }
    await pool.query('INSERT INTO users (nombre,email,password_hash,role,empresa_id,activo) VALUES (?,?,?,?,?,1)',
      [nombre || 'Usuario', correo, hashPassword(password), role, req.user.empresa_id || null]);
    res.json({ ok: true, creado: true, email: correo, role });
  } catch (e) { errorPublico(res, e); }
});

/* ───────── CATÁLOGO PÚBLICO (para navegar sin iniciar sesión) ───────── */
app.get('/api/catalog', async (req, res) => {
  try {
    const empresaId = await empresaIdDe(req.query.empresa);
    if (!empresaId) return res.status(404).json({ error: 'Tienda no encontrada' });
    const pool = getPool();
    // No se espera (no debe frenar la respuesta ni fallar la carga de la tienda
    // si esto falla): solo alimenta el contador de "tiendas destacadas".
    pool.query('UPDATE empresas SET visitas = visitas + 1 WHERE id=?', [empresaId]).catch(() => {});
    const [cfg] = await pool.query('SELECT * FROM config WHERE empresa_id=?', [empresaId]);
    const [[empresa]] = await pool.query("SELECT id,slug,nombre,tipos_negocio,rubro,rubros,descripcion,telefono,ciudad,pais,logo,contacto_publico,correo_publico FROM empresas WHERE id=? AND estado='activa'", [empresaId]);
    const [cats] = await pool.query('SELECT * FROM categorias WHERE empresa_id=?', [empresaId]);
    const [prods] = await pool.query("SELECT * FROM productos WHERE empresa_id=? AND estado='activo'", [empresaId]);
    const c = cfg[0] || {};
    res.json({
      empresa_id: empresaId,
      empresa: empresa ? { id:empresa.id, slug:empresa.slug, nombre:empresa.nombre, tiposNegocio:arr(empresa.tipos_negocio), rubro:empresa.rubro||'', rubros:arr(empresa.rubros).length?arr(empresa.rubros):[empresa.rubro].filter(Boolean), descripcion:empresa.descripcion||'', telefono:empresa.telefono||'', ciudad:empresa.ciudad||'', pais:empresa.pais||'', logo:empresa.logo||'', contactoPublico:empresa.contacto_publico||'', correoPublico:empresa.correo_publico||'' } : null,
      config: { nombre: c.nombre, logo: c.logo || '', moneda: c.moneda, tema: c.tema, banners: arr(c.banners), galeria: arr(c.galeria), pago: obj(c.pago) },
      categorias: cats,
      productos: prods.map(r => {
        const { precio_compra, stock_inventario, stock_min, publicado_alguna_vez, ...publico } = mapProducto(r);
        return publico;
      }),
    });
  } catch (e) { errorPublico(res, e); }
});

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
              empresas.ciudad AS emp_ciudad, empresas.logo AS emp_logo,
              config.moneda AS emp_moneda
       FROM productos
       JOIN empresas ON productos.empresa_id = empresas.id
       JOIN config ON config.empresa_id = empresas.id
       WHERE empresas.estado = 'activa' AND productos.estado = 'activo'`
    );
    res.json({
      productos: rows.map(r => {
        const { precio_compra, stock_inventario, stock_min, publicado_alguna_vez, ...p } = mapProducto(r);
        return {
          ...p,
          empresa: {
            id: r.emp_id, slug: r.emp_slug, nombre: r.emp_nombre,
            rubro: r.emp_rubro || '', ciudad: r.emp_ciudad || '', logo: r.emp_logo || '', moneda: r.emp_moneda || 'L',
          },
        };
      }),
    });
  } catch (e) { errorPublico(res, e); }
});

function mapPedidos(peds, items) {
  return peds.map(p => ({
    id: p.id, cliente_id: p.cliente_id, total: num(p.total), nota: p.nota || '', fecha: p.fecha,
    estado: p.estado, metodoPago: p.metodo_pago || '', pagoEstado:p.pago_estado||'pendiente', pagoReferencia:p.pago_referencia||'', comprobante: p.comprobante || '',
    destinatario: p.destinatario || '', telefonoEntrega: p.telefono_entrega || '', direccionEntrega: p.direccion_entrega || '',
    items: items.filter(i => i.pedido_id === p.id).map(i => ({ producto_id: i.producto_id, cantidad: num(i.cantidad), precio: num(i.precio), subtotal: num(i.subtotal) })),
  }));
}

/* ───────── ESTADO DE EMPRESA (admin/proveedor) ───────── */
app.get('/api/state', requireAuth, requireRole('admin','proveedor'), async (req, res) => {
  try {
    const empresaId = req.user.empresa_id;
    if (!empresaId) return res.status(403).json({ error: 'Tu usuario no está asociado a ninguna empresa' });
    const pool = getPool();
    const [[cfg]] = await pool.query('SELECT * FROM config WHERE empresa_id=?', [empresaId]);
    const [[meta]] = await pool.query('SELECT seq,version FROM app_meta WHERE empresa_id=?', [empresaId]);
    const [categorias] = await pool.query('SELECT id,nombre,descripcion,estado FROM categorias WHERE empresa_id=?', [empresaId]);
    const [prods] = await pool.query('SELECT * FROM productos WHERE empresa_id=?', [empresaId]);
    const cfgBase = cfg || { nombre: 'SIWEPE', moneda: 'L', tema: 'cielo' };

    // admin / proveedor: estado completo del negocio (de SU empresa)
    const [proveedores] = await pool.query('SELECT id,nombre,telefono,correo,empresa,direccion,whatsapp,origen,estado FROM proveedores WHERE empresa_id=?', [empresaId]);
    // Cuentas SIWEPE que ya compraron aquí + agenda privada creada por el admin.
    const [clientesCuenta] = await pool.query(
      `SELECT DISTINCT users.id, users.nombre, users.email AS correo, users.telefono, users.direccion, users.whatsapp
       FROM users JOIN pedidos ON pedidos.cliente_id = users.id
       WHERE pedidos.empresa_id = ? AND users.role IN ('cliente','admin')`, [empresaId]);
    const [clientesManuales] = await pool.query('SELECT id AS manualId,nombre,telefono,correo,whatsapp,direccion,created_at FROM clientes_empresa WHERE empresa_id=? ORDER BY nombre',[empresaId]);
    const clientes=[
      ...clientesCuenta.map(c=>({...c,registrado:true,origen:'siwepe'})),
      ...clientesManuales.map(c=>({...c,id:'manual-'+c.manualId,registrado:false,origen:'manual'}))
    ];
    const [compras] = await pool.query('SELECT * FROM compras WHERE empresa_id=?', [empresaId]);
    const [ventas] = await pool.query('SELECT * FROM ventas WHERE empresa_id=?', [empresaId]);
    const [movimientos] = await pool.query('SELECT id,tipo,signo,producto_id,cantidad,fecha,usuario,obs FROM movimientos WHERE empresa_id=?', [empresaId]);
    const [peds] = await pool.query('SELECT * FROM pedidos WHERE empresa_id=?', [empresaId]);
    const [items] = await pool.query('SELECT * FROM pedido_items WHERE empresa_id=?', [empresaId]);
    const [mensajes] = await pool.query('SELECT id,pedido_id,autor,texto,fecha,leido FROM mensajes WHERE empresa_id=?', [empresaId]);

    res.json({
      _revision: num(meta && meta.version),
      config: { nombre: cfgBase.nombre, logo: cfgBase.logo || '', moneda: cfgBase.moneda, tema: cfgBase.tema, banners: arr(cfgBase.banners), galeria: arr(cfgBase.galeria), pago: obj(cfgBase.pago) },
      seq: meta ? obj(meta.seq) : {},
      categorias,
      proveedores,
      clientes,
      productos: prods.map(mapProducto),
      compras: compras.map(x => ({ ...x, precio: num(x.precio) })),
      ventas: ventas.map(x => ({ ...x, precio: num(x.precio), total: num(x.total), stock_tienda_usado:num(x.stock_tienda_usado), stock_inventario_usado:num(x.stock_inventario_usado) })),
      movimientos,
      pedidos: mapPedidos(peds, items),
      mensajes: mensajes.map(m => ({ ...m, leido: !!m.leido })),
    });
  } catch (e) { errorPublico(res, e); }
});

/* ───────── GUARDAR ESTADO COMPLETO (sólo admin) ─────────
   Sobrescribe SÓLO los datos de la empresa `E`: borra e inserta usando
   empresa_id=E en cada tabla, así nunca toca los datos de otras empresas. */
async function guardarEstadoCompleto(c, E, db) {
  const colecciones = ['categorias','proveedores','productos','compras','ventas','movimientos','pedidos','mensajes'];
  for (const nombre of colecciones) {
    if (db[nombre] != null && !Array.isArray(db[nombre])) {
      const e = new Error(`La colección ${nombre} no es válida`); e.status = 400; throw e;
    }
    if ((db[nombre] || []).length > 20000) {
      const e = new Error(`La colección ${nombre} excede el límite permitido`); e.status = 413; throw e;
    }
  }
  for (const p of db.productos || []) {
    if (!num(p.id) || !String(p.nombre || '').trim() || [p.precio_compra,p.precio_venta,p.stock,p.stock_inventario,p.stock_min].some(v => num(v) < 0)) {
      const e = new Error('Hay un producto con nombre, identificador o valores numéricos inválidos'); e.status = 400; throw e;
    }
    { const vP = validarNombreNegocio(p.nombre, 'nombre del producto'); if (!vP.ok) { const e = new Error(vP.error); e.status = 400; throw e; } }
    if (!['activo','inactivo'].includes(p.estado || 'activo')) { const e = new Error('Estado de producto inválido'); e.status = 400; throw e; }
    exigirImagenWeb(p.imagen, 'Imagen del producto');
    const imagenes=arr(p.imagenes);
    if(imagenes.length>6){ const e=new Error('Cada producto admite hasta 6 imágenes'); e.status=400; throw e; }
    for (const imagen of imagenes) exigirImagenWeb(imagen, 'Imagen del producto');
  }
  for (const p of db.pedidos || []) {
    if (!['pendiente','aprobado','preparando','listo','enviado','entregado','cancelado'].includes(p.estado || 'pendiente')) { const e = new Error('Estado de pedido inválido'); e.status = 400; throw e; }
    exigirImagenWeb(p.comprobante, 'Comprobante');
    for (const it of p.items || []) if (num(it.cantidad) <= 0 || num(it.precio) < 0) { const e = new Error('Item de pedido inválido'); e.status = 400; throw e; }
  }
  for (const m of db.mensajes || []) {
    if (!['admin','cliente'].includes(m.autor) || !String(m.texto || '').trim() || String(m.texto).length > 2000) {
      const e = new Error('Mensaje inválido'); e.status = 400; throw e;
    }
  }
  await c.query('SET FOREIGN_KEY_CHECKS = 0');
  try {
    // DELETE (no TRUNCATE): TRUNCATE hace commit implícito en MySQL/InnoDB, lo que
    // rompería la atomicidad de la transacción — un error a mitad de esta función
    // dejaría las tablas ya "truncadas" vacías para siempre, sin poder revertir.
    for (const t of ['mensajes','pedido_items','pedidos','movimientos','ventas','compras','productos','proveedores','categorias'])
      await c.query(`DELETE FROM ${t} WHERE empresa_id=?`, [E]);

    if (db.config) {
      const cf = db.config;
      exigirImagenWeb(cf.logo, 'Logo');
      for (const banner of arr(cf.banners)) exigirImagenWeb(banner, 'Banner');
      const galeria=arr(cf.galeria);
      if(galeria.length>12){ const e=new Error('La galería admite hasta 12 imágenes'); e.status=400; throw e; }
      for (const item of galeria) {
        exigirImagenWeb(typeof item==='string'?item:item&&item.imagen, 'Imagen de galería');
        if(item&&typeof item==='object'&&(String(item.titulo||'').length>80||String(item.descripcion||'').length>180)){
          const e=new Error('El texto de una fotografía de galería es demasiado largo'); e.status=400; throw e;
        }
      }
      // UPSERT: si la empresa aún no tiene fila de config, la crea.
      await c.query(
        'INSERT INTO config (empresa_id,nombre,logo,moneda,tema,banners,galeria,pago) VALUES (?,?,?,?,?,?,?,?) ' +
        'ON DUPLICATE KEY UPDATE nombre=VALUES(nombre),logo=VALUES(logo),moneda=VALUES(moneda),tema=VALUES(tema),banners=VALUES(banners),galeria=VALUES(galeria),pago=VALUES(pago)',
        [E, cf.nombre || 'SIWEPE', cf.logo || '', cf.moneda || 'L', cf.tema || 'cielo', JSON.stringify(cf.banners || []), JSON.stringify(galeria), JSON.stringify(cf.pago || {})]);
    }
    if (db.seq) await c.query('INSERT INTO app_meta (empresa_id,seq) VALUES (?,?) ON DUPLICATE KEY UPDATE seq=VALUES(seq)', [E, JSON.stringify(db.seq)]);

    for (const x of db.categorias || [])
      await c.query('INSERT INTO categorias (empresa_id,id,nombre,descripcion,estado) VALUES (?,?,?,?,?)', [E, x.id, String(x.nombre||'').slice(0,80), String(x.descripcion||'').slice(0,255), x.estado || 'activo']);
    for (const x of db.proveedores || []) {
      { const vT = validarTelefono(x.telefono, null, 'teléfono del proveedor'); if (!vT.ok) { const e = new Error(vT.error); e.status = 400; throw e; } }
      { const vW = validarTelefono(x.whatsapp, null, 'WhatsApp del proveedor'); if (!vW.ok) { const e = new Error(vW.error); e.status = 400; throw e; } }
      { const vD = validarDireccion(x.direccion, 'dirección del proveedor'); if (!vD.ok) { const e = new Error(vD.error); e.status = 400; throw e; } }
      await c.query('INSERT INTO proveedores (empresa_id,id,nombre,telefono,correo,empresa,direccion,whatsapp,origen,estado) VALUES (?,?,?,?,?,?,?,?,?,?)', [E, x.id, String(x.nombre||'').slice(0,80), String(x.telefono||'').slice(0,30), String(x.correo||'').slice(0,120), String(x.empresa||'').slice(0,80), String(x.direccion||'').slice(0,160), String(x.whatsapp||'').slice(0,24), x.origen==='no_registrado'?'no_registrado':'registrado', x.estado || 'activo']);
    }
    for (const x of db.productos || []) {
      const imagenes=arr(x.imagenes).filter(Boolean).slice(0,6);
      const portada=x.imagen||imagenes[0]||'';
      await c.query('INSERT INTO productos (empresa_id,id,codigo,nombre,categoria_id,descripcion,precio_compra,precio_venta,stock,stock_inventario,stock_min,imagen,imagenes,estado,destacado,publicado_alguna_vez,marca,tipo_piel) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
        [E, x.id, String(x.codigo||'').slice(0,40), String(x.nombre||'').slice(0,120), x.categoria_id || null, String(x.descripcion||''), num(x.precio_compra), num(x.precio_venta), num(x.stock), num(x.stock_inventario), num(x.stock_min), portada, JSON.stringify(imagenes), x.estado || 'activo', x.destacado ? 1 : 0, x.publicado_alguna_vez ? 1 : 0, String(x.marca||'').slice(0,80), JSON.stringify(x.tipoPiel || [])]);
    }
    for (const x of db.compras || [])
      await c.query('INSERT INTO compras (empresa_id,id,producto_id,proveedor_id,cantidad,precio,fecha,obs) VALUES (?,?,?,?,?,?,?,?)', [E, x.id, x.producto_id || null, x.proveedor_id || null, num(x.cantidad), num(x.precio), x.fecha, x.obs || '']);
    for (const x of db.ventas || [])
      await c.query('INSERT INTO ventas (empresa_id,id,producto_id,cliente_id,cliente_nombre,cliente_identidad,pedido_id,estado,origen_stock,stock_tienda_usado,stock_inventario_usado,cantidad,precio,fecha,total) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
        [E, x.id, x.producto_id || null, x.cliente_id || null, x.cliente_nombre || '', x.cliente_identidad || '', x.pedido_id || null, x.estado || 'activa', x.origen_stock || 'tienda', num(x.stock_tienda_usado == null ? x.cantidad : x.stock_tienda_usado), num(x.stock_inventario_usado), num(x.cantidad), num(x.precio), x.fecha, +(num(x.cantidad) * num(x.precio)).toFixed(2)]);
    for (const x of db.movimientos || [])
      await c.query('INSERT INTO movimientos (empresa_id,id,tipo,signo,producto_id,cantidad,fecha,usuario,obs) VALUES (?,?,?,?,?,?,?,?,?)', [E, x.id, x.tipo, x.signo || null, x.producto_id || null, num(x.cantidad), x.fecha, x.usuario || '', x.obs || '']);
    for (const p of db.pedidos || []) {
      const itemsPedido = p.items || [];
      const totalPedido = itemsPedido.reduce((s, it) => s + num(it.cantidad) * num(it.precio), 0);
      await c.query('INSERT INTO pedidos (empresa_id,id,cliente_id,total,nota,fecha,estado,metodo_pago,pago_estado,pago_referencia,comprobante,destinatario,telefono_entrega,direccion_entrega) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)', [E, p.id, p.cliente_id || null, +totalPedido.toFixed(2), String(p.nota || '').slice(0, 500), p.fecha, p.estado || 'pendiente', p.metodoPago || '', p.pagoEstado||'pendiente', p.pagoReferencia||'', p.comprobante || '', p.destinatario || '', p.telefonoEntrega || '', p.direccionEntrega || '']);
      for (const it of itemsPedido)
        await c.query('INSERT INTO pedido_items (empresa_id,pedido_id,producto_id,cantidad,precio,subtotal) VALUES (?,?,?,?,?,?)', [E, p.id, it.producto_id || null, num(it.cantidad), num(it.precio), +(num(it.cantidad) * num(it.precio)).toFixed(2)]);
    }
    for (const m of db.mensajes || [])
      await c.query('INSERT INTO mensajes (empresa_id,id,pedido_id,autor,texto,fecha,leido) VALUES (?,?,?,?,?,?,?)', [E, m.id, m.pedido_id, m.autor, m.texto, dtMysql(m.fecha), m.leido ? 1 : 0]);
  } finally {
    // Siempre reactivar los checks de FK, incluso si algo falló arriba — si no,
    // la conexión vuelve al pool con las validaciones apagadas para siempre.
    await c.query('SET FOREIGN_KEY_CHECKS = 1');
  }
}

app.put('/api/state', requireAuth, requireRole('admin'), async (req, res) => {
  const db = req.body || {};
  const pool = getPool();
  const c = await pool.getConnection();
  const E = req.user.empresa_id;
  if (!E) { c.release(); return res.status(403).json({ error: 'Tu usuario no está asociado a ninguna empresa' }); }
  try {
    await c.beginTransaction();
    const [[meta]] = await c.query('SELECT version FROM app_meta WHERE empresa_id=? FOR UPDATE', [E]);
    if (db._revision == null) {
      await c.rollback();
      return res.status(428).json({ error: 'Falta la revisión del estado. Recarga el panel antes de guardar.' });
    }
    if (num(db._revision) !== num(meta && meta.version)) {
      await c.rollback();
      return res.status(409).json({ error: 'Hay cambios más recientes en el servidor. Recarga el panel para evitar sobrescribirlos.' });
    }
    await guardarEstadoCompleto(c, E, db);
    const revision = await subirVersion(c, E);
    await c.commit();
    res.json({ ok: true, revision });
  } catch (e) {
    await c.rollback().catch(() => {});
    errorPublico(res, e);
  } finally { c.release(); }
});

/* Asegura filas base. Nunca crea credenciales conocidas: un administrador de
   plataforma inicial sólo se crea si el operador define ambas variables. */
async function asegurarBase() {
  const pool = getPool();
  const [u] = await pool.query("SELECT COUNT(*) AS n FROM users WHERE role='admin'");
  if (u[0].n === 0) {
    const email = String(process.env.BOOTSTRAP_ADMIN_EMAIL || '').trim().toLowerCase();
    const password = String(process.env.BOOTSTRAP_ADMIN_PASSWORD || '');
    if (email && password.length >= 12) {
      await pool.query('INSERT INTO users (nombre,email,password_hash,role,empresa_id,activo) VALUES (?,?,?,?,NULL,1)',
        ['Administrador de plataforma', email, hashPassword(password), 'admin']);
      console.log('Administrador inicial creado desde variables de entorno:', email);
    } else {
      console.warn('No hay administradores. Registra una empresa o configura BOOTSTRAP_ADMIN_EMAIL y BOOTSTRAP_ADMIN_PASSWORD (mínimo 12 caracteres).');
    }
  }

  // SUPER ADMINISTRADOR de plataforma desde variables de entorno. Si están
  // BOOTSTRAP_SUPER_EMAIL y BOOTSTRAP_SUPER_PASSWORD (mín. 8), asegura que esa
  // cuenta exista y quede marcada super_admin=1 en cada arranque (idempotente).
  // Cómodo para crear/recuperar el panel de plataforma sin usar la terminal.
  {
    const semail = String(process.env.BOOTSTRAP_SUPER_EMAIL || '').trim().toLowerCase();
    const spass = String(process.env.BOOTSTRAP_SUPER_PASSWORD || '');
    if (semail && spass.length >= 8) {
      const hash = hashPassword(spass);
      const [ex] = await pool.query('SELECT id FROM users WHERE email=? LIMIT 1', [semail]);
      if (ex.length) {
        await pool.query("UPDATE users SET nombre=COALESCE(NULLIF(nombre,''),'Super Admin'), password_hash=?, role='admin', super_admin=1, empresa_id=NULL, activo=1 WHERE email=?", [hash, semail]);
        console.log('Super administrador asegurado desde variables de entorno:', semail);
      } else {
        await pool.query("INSERT INTO users (nombre,email,password_hash,role,super_admin,empresa_id,activo) VALUES (?,?,?,'admin',1,NULL,1)", ['Super Admin', semail, hash]);
        console.log('Super administrador creado desde variables de entorno:', semail);
      }
    }
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

  // Limpia solicitudes de registro sin confirmar con más de 24h (nunca fueron empresa).
  try { await pool.query('DELETE FROM registros_pendientes WHERE created_at < (NOW() - INTERVAL 24 HOUR)'); }
  catch (e) { /* la tabla se crea en el arranque; si aún no existe, se ignora */ }

  // Limpia tokens de recuperación de contraseña vencidos (más de 2h).
  try { await pool.query('DELETE FROM password_resets WHERE created_at < (NOW() - INTERVAL 2 HOUR)'); }
  catch (e) { /* la tabla se crea en el arranque; si aún no existe, se ignora */ }
}

app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  errorPublico(res, err);
});

async function start() {
  await initDb();
  await asegurarBase();
  return app.listen(PORT, () => console.log(`\nSIWEPE backend escuchando en el puerto ${PORT}\n`));
}

if (require.main === module) {
  start().catch(err => { console.error('No se pudo iniciar SIWEPE:', err.code || err.message || err); process.exit(1); });
}

module.exports = { app, start, asegurarBase, imagenWebValida };
