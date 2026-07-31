/* crear-usuario.js — crea (o actualiza) un usuario del sistema.
   Uso:
     node crear-usuario.js <correo> <contraseña> <rol> "<nombre>"
   Ejemplos:
     node crear-usuario.js joel@siwepe.com miClave123 admin "Joel Reyes"
     node crear-usuario.js prov@correo.com clave123 proveedor "Proveedor X"
   Roles válidos: admin | proveedor | cliente
*/
require('dotenv').config();
const { initDb, getPool } = require('./db');
const { hashPassword } = require('./auth');

async function run() {
  const [, , email, password, roleArg, ...nombreParts] = process.argv;
  const role = (roleArg || 'admin').toLowerCase();
  const nombre = nombreParts.join(' ') || 'Usuario';

  if (!email || !password) {
    console.log('Uso: node crear-usuario.js <correo> <contraseña> <rol> "<nombre>"');
    process.exit(1);
  }
  if (!['admin', 'proveedor', 'cliente'].includes(role)) {
    console.log('Rol inválido. Usa: admin | proveedor | cliente');
    process.exit(1);
  }

  await initDb();
  const pool = getPool();
  const hash = hashPassword(password);
  const correo = email.toLowerCase().trim();

  const [existe] = await pool.query('SELECT id FROM users WHERE email=? LIMIT 1', [correo]);
  if (existe.length) {
    await pool.query('UPDATE users SET nombre=?, password_hash=?, role=?, activo=1 WHERE email=?', [nombre, hash, role, correo]);
    console.log(`✅ Usuario actualizado: ${correo} (rol ${role})`);
  } else {
    await pool.query('INSERT INTO users (nombre,email,password_hash,role,activo) VALUES (?,?,?,?,1)', [nombre, correo, hash, role]);
    console.log(`✅ Usuario creado: ${correo} (rol ${role})`);
  }
  console.log(`   Entra en la tienda → pestaña Admin con: ${correo} / ${password}`);
  process.exit(0);
}

run().catch(err => { console.error('❌ Error:', err.message); process.exit(1); });
