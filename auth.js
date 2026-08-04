/*! SIWEPE · © 2026 Joel Reyes. Todos los derechos reservados. · Prohibida su reproduccion o distribucion sin autorizacion. */
/* auth.js — cifrado de contraseñas (bcrypt) y tokens de sesión (JWT) */
require('dotenv').config();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const SECRET = process.env.JWT_SECRET || 'dev_secret_cambia_esto';
if (!process.env.JWT_SECRET) {
  console.warn('AVISO: JWT_SECRET no está definido — usando un valor de desarrollo INSEGURO. Defínelo en tu .env / variables de entorno antes de ir a producción.');
}

const hashPassword = (plain) => bcrypt.hashSync(plain, 10);
const checkPassword = (plain, hash) => bcrypt.compareSync(plain, hash || '');
// Detecta si un valor ya es un hash bcrypt (para no volver a hashear PINs que el
// front-end reenvía tal cual al guardar el estado completo).
const isHashed = (s) => typeof s === 'string' && /^\$2[aby]\$\d{2}\$/.test(s);

const signToken = (payload) => jwt.sign(payload, SECRET, { expiresIn: '3650d' }); // ~10 años: la sesión no se cierra

function verifyToken(token) {
  try { return jwt.verify(token, SECRET); }
  catch (e) { return null; }
}

/* Middleware: exige un token válido. Deja el usuario en req.user */
function requireAuth(req, res, next) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  const user = token && verifyToken(token);
  if (!user) return res.status(401).json({ error: 'No autorizado' });
  req.user = user;
  next();
}

/* Middleware: exige uno de los roles indicados */
function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'Permiso insuficiente' });
    }
    next();
  };
}

module.exports = { hashPassword, checkPassword, signToken, verifyToken, requireAuth, requireRole, isHashed };
