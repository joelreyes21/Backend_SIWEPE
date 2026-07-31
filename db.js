/* db.js — conexión a MySQL (pool) + creación del esquema */
require('dotenv').config();
const mysql = require('mysql2/promise');
const fs = require('fs');
const path = require('path');

const CFG = {
  host: process.env.DB_HOST || 'localhost',
  port: +(process.env.DB_PORT || 3306),
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD ?? '',
  database: process.env.DB_NAME || 'SIWEPE',
};

let pool;

/* Crea la base de datos si no existe y devuelve el pool ya conectado a ella */
async function initDb() {
  // 1) Conexión sin base para poder crearla
  const root = await mysql.createConnection({
    host: CFG.host, port: CFG.port, user: CFG.user, password: CFG.password,
  });
  await root.query(
    `CREATE DATABASE IF NOT EXISTS \`${CFG.database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`
  );
  await root.end();

  // 2) Pool sobre la base
  pool = mysql.createPool({
    ...CFG,
    waitForConnections: true,
    connectionLimit: 10,
    multipleStatements: true,
    dateStrings: true,
  });

  // 3) Crear tablas (schema.sql)
  const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  await pool.query(schema);

  return pool;
}

function getPool() {
  if (!pool) throw new Error('El pool no está listo. Llama a initDb() primero.');
  return pool;
}

module.exports = { initDb, getPool, CFG };
