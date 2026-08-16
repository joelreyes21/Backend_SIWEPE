/*! SIWEPE · reinicio seguro de una sola empresa */
require('dotenv').config();
const { initDb, getPool } = require('./db');

const arg = process.argv.find(x => x.startsWith('--empresa='));
const empresaRef = arg ? arg.slice('--empresa='.length).trim() : '';
const confirmacion = String(process.env.RESET_CONFIRM || '');
const seqCero = { producto:0, categoria:0, proveedor:0, cliente:0, compra:0, venta:0, movimiento:0, pedido:0, mensaje:0 };

async function run() {
  if (!empresaRef) throw new Error('Indica una empresa: npm run reset -- --empresa=mi-slug');
  if (confirmacion !== `BORRAR:${empresaRef}`) {
    throw new Error(`Define RESET_CONFIRM=BORRAR:${empresaRef} para confirmar. No se borró nada.`);
  }
  await initDb();
  const pool = getPool();
  const c = await pool.getConnection();
  try {
    const campo = /^\d+$/.test(empresaRef) ? 'id' : 'slug';
    const [[empresa]] = await c.query(`SELECT id,nombre,slug FROM empresas WHERE ${campo}=? LIMIT 1`, [campo === 'id' ? Number(empresaRef) : empresaRef]);
    if (!empresa) throw new Error('Empresa no encontrada. No se borró nada.');
    await c.beginTransaction();
    for (const tabla of ['mensajes','pedido_items','pedidos','movimientos','ventas','compras','productos','proveedores','categorias']) {
      await c.query(`DELETE FROM ${tabla} WHERE empresa_id=?`, [empresa.id]);
    }
    await c.query('UPDATE app_meta SET seq=?,version=version+1 WHERE empresa_id=?', [JSON.stringify(seqCero), empresa.id]);
    await c.commit();
    console.log(`Empresa reiniciada: ${empresa.nombre} (${empresa.slug}). Se conservaron usuarios, clientes globales y configuración.`);
  } catch (e) {
    await c.rollback().catch(() => {});
    throw e;
  } finally { c.release(); }
}

run().then(() => process.exit(0)).catch(err => { console.error('Reset cancelado:', err.message); process.exit(1); });
