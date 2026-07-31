/* reset.js — deja la base de datos VACÍA (sin datos de ejemplo).
   Ejecuta:  npm run reset
   Borra productos, categorías, clientes, proveedores, compras, ventas,
   movimientos, pedidos y mensajes. Conserva la configuración del negocio
   y deja al menos un usuario admin para poder entrar. */
require('dotenv').config();
const { initDb, getPool } = require('./db');
const { hashPassword } = require('./auth');

const seqCero = { producto:0, categoria:0, proveedor:0, cliente:0, compra:0, venta:0, movimiento:0, pedido:0, mensaje:0 };

async function run() {
  await initDb();
  const pool = getPool();
  const c = await pool.getConnection();
  try {
    await c.query('SET FOREIGN_KEY_CHECKS = 0');
    for (const t of ['mensajes','pedido_items','pedidos','movimientos','ventas','compras','productos','clientes','proveedores','categorias']) {
      await c.query(`TRUNCATE TABLE ${t}`);
    }
    await c.query('SET FOREIGN_KEY_CHECKS = 1');

    // Reiniciar los contadores de id a cero
    const [meta] = await c.query('SELECT id FROM app_meta WHERE id=1');
    if (meta.length) await c.query('UPDATE app_meta SET seq=? WHERE id=1', [JSON.stringify(seqCero)]);
    else await c.query('INSERT INTO app_meta (id,seq) VALUES (1,?)', [JSON.stringify(seqCero)]);

    // Asegurar la fila de configuración (sin pisar la tuya si ya existe)
    const [cfg] = await c.query('SELECT id FROM config WHERE id=1');
    if (!cfg.length) {
      await c.query('INSERT INTO config (id,nombre,logo,moneda,tema,pin_admin,banners,pago) VALUES (1,?,?,?,?,?,?,?)',
        ['Miscelaneasaly', '', 'L', 'rosado', '1234', JSON.stringify([]), JSON.stringify({ banco:'', cuenta:'', titular:'', tipo:'', nota:'' })]);
    }

    // Asegurar que exista un admin para poder entrar
    const [admins] = await c.query("SELECT id FROM users WHERE role='admin' AND activo=1");
    if (!admins.length) {
      await c.query('INSERT INTO users (nombre,email,password_hash,role,activo) VALUES (?,?,?,?,1)',
        ['Administrador', 'admin@siwepe.com', hashPassword('admin1234'), 'admin']);
      console.log('   (No había admin: creé admin@siwepe.com / admin1234)');
    }

    console.log('✅ Base de datos vacía. Ahora todo lo que agregues viene de la base.');
    console.log('   Entra al admin y empieza a crear tus categorías y productos.');
  } finally {
    c.release();
    process.exit(0);
  }
}

run().catch(err => { console.error('❌ Error al limpiar la base:', err.message); process.exit(1); });
