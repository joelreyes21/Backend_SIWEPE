/*! SIWEPE · © 2026 Joel Reyes. Todos los derechos reservados. · Prohibida su reproduccion o distribucion sin autorizacion. */
/* db.js — conexión a MySQL (pool) + creación del esquema.
   Funciona en LOCAL (variables DB_*) y en RAILWAY (variables MYSQL*, o una URL
   de conexión: DATABASE_URL / MYSQL_URL / MYSQL_PUBLIC_URL). */
require('dotenv').config();
const mysql = require('mysql2/promise');
const fs = require('fs');
const path = require('path');


function getCfg() {
  const CONN = process.env.DATABASE_URL || process.env.MYSQL_URL || process.env.MYSQL_PUBLIC_URL;
  if (CONN) {
    const u = new URL(CONN);
    return {
      host: u.hostname,
      port: +(u.port || 3306),
      user: decodeURIComponent(u.username || 'root'),
      password: decodeURIComponent(u.password || ''),
      database: (u.pathname || '/railway').slice(1) || 'railway',
    };
  }
  return {
    host: process.env.MYSQLHOST || process.env.DB_HOST || 'localhost',
    port: +(process.env.MYSQLPORT || process.env.DB_PORT || 3306),
    user: process.env.MYSQLUSER || process.env.DB_USER || 'root',
    password: process.env.MYSQLPASSWORD ?? process.env.DB_PASSWORD ?? '',
    database: process.env.MYSQLDATABASE || process.env.DB_NAME || 'SIWEPE',
  };
}

const CFG = getCfg();
let pool;

/* Intenta crear la base (en Railway ya existe / puede no tener permiso: se ignora) */
async function _crearBaseSiFalta() {
  try {
    const root = await mysql.createConnection({ host: CFG.host, port: CFG.port, user: CFG.user, password: CFG.password });
    await root.query(`CREATE DATABASE IF NOT EXISTS \`${CFG.database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
    await root.end();
  } catch (e) {
    console.warn('Aviso al crear la base (se continúa):', e.code || e.message);
  }
}

/* Adapta una base con el esquema viejo (mono-empresa) al nuevo (multi-empresa).
   Idempotente: si ya está migrada, no hace nada. Como en esta etapa las tablas
   de negocio están vacías, recrearlas no pierde datos reales. */
async function _migrarMultiEmpresa(pool, schema) {
  // users: añadir columna empresa_id si falta (los admin viejos guardaban la empresa en ref_id)
  const [uc] = await pool.query("SHOW COLUMNS FROM users LIKE 'empresa_id'");
  if (!uc.length) {
    await pool.query('ALTER TABLE users ADD COLUMN empresa_id INT NULL AFTER role');
    await pool.query("UPDATE users SET empresa_id=ref_id WHERE role='admin' AND empresa_id IS NULL AND ref_id IS NOT NULL");
  }
  // productos sin empresa_id => forma vieja: recrear tablas de negocio con la nueva forma
  const [pc] = await pool.query("SHOW COLUMNS FROM productos LIKE 'empresa_id'");
  if (!pc.length) {
    console.warn('Migrando a esquema multi-empresa: recreando tablas de negocio (vacías).');
    await pool.query('SET FOREIGN_KEY_CHECKS = 0');
    for (const t of ['mensajes','pedido_items','pedidos','movimientos','ventas','compras','productos','clientes','proveedores','categorias','config','app_meta'])
      await pool.query('DROP TABLE IF EXISTS `' + t + '`');
    await pool.query('SET FOREIGN_KEY_CHECKS = 1');
    await pool.query(schema);   // vuelve a crear todo con PK (empresa_id, id)
    console.log('Esquema multi-empresa listo.');
  }
}

async function initDb(reintentos = 6) {
  let ultimoError;
  for (let i = 1; i <= reintentos; i++) {
    try {
      await _crearBaseSiFalta();
      pool = mysql.createPool({
        host: CFG.host, port: CFG.port, user: CFG.user, password: CFG.password, database: CFG.database,
        waitForConnections: true, connectionLimit: 10, multipleStatements: true, dateStrings: true,
      });
      const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
      await pool.query(schema);
      // Migración al esquema MULTI-EMPRESA (empresa_id en cada tabla del negocio).
      // CREATE TABLE IF NOT EXISTS no altera tablas ya existentes, así que si la base
      // trae la forma vieja (mono-empresa) hay que adaptarla.
      await _migrarMultiEmpresa(pool, schema);
      // Migración para bases creadas antes de que `pin` pasara a guardar un hash bcrypt
      // (CREATE TABLE IF NOT EXISTS no amplía columnas en tablas que ya existían).
      try { await pool.query("ALTER TABLE clientes MODIFY pin VARCHAR(60) NOT NULL DEFAULT '0000'"); }
      catch (e) { console.warn('Aviso al ampliar columna clientes.pin (se continúa):', e.code || e.message); }
      console.log(`MySQL conectado: ${CFG.user}@${CFG.host}:${CFG.port}/${CFG.database}`);
      return pool;
    } catch (e) {
      ultimoError = e;
      console.warn(`Intento ${i}/${reintentos} de conexión a MySQL falló: ${e.code || e.message || e}`);
      if (i < reintentos) await new Promise(r => setTimeout(r, 3000));
    }
  }
  throw ultimoError;
}

function getPool() {
  if (!pool) throw new Error('El pool no está listo. Llama a initDb() primero.');
  return pool;
}

module.exports = { initDb, getPool, CFG };
