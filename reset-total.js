/*! SIWEPE · © 2026 Joel Reyes. Todos los derechos reservados. · Prohibida su reproduccion o distribucion sin autorizacion. */
/* reset-total.js — REINICIO TOTAL de la plataforma.
   BORRA ABSOLUTAMENTE TODO (todas las tiendas, productos, pedidos, ventas,
   usuarios, clientes, config...) y deja SOLO tu cuenta como id 1 (super admin).
   ES IRREVERSIBLE.

   Uso (requiere confirmar con la variable RESET_CONFIRM):
     RESET_CONFIRM=BORRAR-TODO node reset-total.js <correo> <password> "<nombre>"
   Ejemplo:
     RESET_CONFIRM=BORRAR-TODO node reset-total.js jr4419543@gmail.com Joel2004_ "Joel Reyes"
   En Railway:
     railway run --service backend node reset-total.js jr4419543@gmail.com Joel2004_ "Joel Reyes"
     (con la variable RESET_CONFIRM=BORRAR-TODO definida)
*/
require('dotenv').config();
const { initDb, getPool } = require('./db');
const { hashPassword } = require('./auth');

// Orden de borrado: primero las tablas hijas, luego las padre (por si hubiera FKs).
const TABLAS = [
  'mensajes', 'pedido_items', 'pedidos', 'movimientos', 'ventas', 'compras',
  'abonos', 'creditos', 'calificaciones',
  'productos', 'clientes_empresa', 'proveedores', 'categorias', 'config',
  'app_meta', 'registros_pendientes', 'password_resets', 'onboarding_sessions',
  'empresas', 'users',
];

async function run() {
  const [, , email, password, ...nombreParts] = process.argv;
  const nombre = nombreParts.join(' ') || 'Joel Reyes';

  if (process.env.RESET_CONFIRM !== 'BORRAR-TODO') {
    console.log('Seguridad: definí la variable RESET_CONFIRM=BORRAR-TODO para confirmar. No se borró nada.');
    process.exit(1);
  }
  if (!email || !password || String(password).length < 8) {
    console.log('Uso: RESET_CONFIRM=BORRAR-TODO node reset-total.js <correo> <password (mín. 8)> "<nombre>"');
    process.exit(1);
  }

  await initDb(); // crea el esquema y corre migraciones (asegura la columna super_admin)
  const pool = getPool();

  await pool.query('SET FOREIGN_KEY_CHECKS = 0');
  for (const t of TABLAS) {
    try { await pool.query('TRUNCATE TABLE `' + t + '`'); console.log('  vaciada:', t); }
    catch (e) { console.warn('  (omitida ' + t + ': ' + e.message + ')'); }
  }
  await pool.query('SET FOREIGN_KEY_CHECKS = 1');

  const correo = String(email).toLowerCase().trim();
  await pool.query(
    "INSERT INTO users (nombre,email,password_hash,role,super_admin,empresa_id,activo) VALUES (?,?,?,'admin',1,NULL,1)",
    [nombre, correo, hashPassword(password)]);

  const [[u]] = await pool.query('SELECT id,nombre,email,role,super_admin FROM users');
  console.log('\nRESET TOTAL completado. Tu cuenta quedó así:', u);
  console.log(`Entrá a /pages/superadmin.html con: ${correo} / ${password}`);
  process.exit(0);
}

run().catch(err => { console.error('Reset cancelado:', err.message); process.exit(1); });
