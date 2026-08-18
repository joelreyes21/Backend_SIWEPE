/*! SIWEPE · © 2026 Joel Reyes. Todos los derechos reservados. · Prohibida su reproduccion o distribucion sin autorizacion. */
/* crear-superadmin.js — crea (o actualiza) la cuenta SUPER ADMINISTRADOR de la
   plataforma (el dueño de SIWEPE). Ve y controla todo: métricas globales y
   gestión de todas las tiendas (activar / desactivar / eliminar).

   Uso:
     node crear-superadmin.js <correo> <contraseña> "<nombre>"
   Ejemplo:
     node crear-superadmin.js joel@siwepe.shop MiClaveSegura123 "Joel Reyes"

   La cuenta se marca con super_admin=1 y empresa_id NULL (no pertenece a
   ninguna tienda). Luego entrá al panel en /pages/superadmin.html con ese
   correo y contraseña. La contraseña debe tener al menos 8 caracteres.
*/
require('dotenv').config();
const { initDb, getPool } = require('./db');
const { hashPassword } = require('./auth');

async function run() {
  const [, , email, password, ...nombreParts] = process.argv;
  const nombre = nombreParts.join(' ') || 'Super Admin';

  if (!email || !password) {
    console.log('Uso: node crear-superadmin.js <correo> <contraseña> "<nombre>"');
    process.exit(1);
  }
  if (String(password).length < 8) {
    console.log('La contraseña debe tener al menos 8 caracteres.');
    process.exit(1);
  }

  await initDb();
  const pool = getPool();
  const hash = hashPassword(password);
  const correo = String(email).toLowerCase().trim();

  const [existe] = await pool.query('SELECT id FROM users WHERE email=? LIMIT 1', [correo]);
  if (existe.length) {
    await pool.query(
      "UPDATE users SET nombre=?, password_hash=?, role='admin', super_admin=1, empresa_id=NULL, activo=1 WHERE email=?",
      [nombre, hash, correo]);
    console.log(`Super administrador actualizado: ${correo}`);
  } else {
    await pool.query(
      "INSERT INTO users (nombre,email,password_hash,role,super_admin,empresa_id,activo) VALUES (?,?,?,'admin',1,NULL,1)",
      [nombre, correo, hash]);
    console.log(`Super administrador creado: ${correo}`);
  }
  console.log(`   Entrá al panel de plataforma en /pages/superadmin.html con: ${correo} / ${password}`);
  process.exit(0);
}

run().catch(err => { console.error('Error:', err.message); process.exit(1); });
