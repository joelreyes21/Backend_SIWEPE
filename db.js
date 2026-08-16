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

/* Convierte las cuentas de cliente de "una tabla por empresa" (clientes) a
   "una fila global en users" (role='cliente', empresa_id=NULL). Los admins
   comparten esta misma tabla y pueden comprar sin cambiar de rol. Idempotente:
   si ya está migrada (existen las columnas nuevas y no existe `clientes`),
   no hace nada. Etapa temprana del proyecto: no se preservan filas viejas
   de `clientes`, se descartan junto con la tabla. */
async function _migrarClienteGlobal(pool) {
  const [tc] = await pool.query("SHOW COLUMNS FROM users LIKE 'telefono'");
  if (!tc.length) {
    await pool.query(
      'ALTER TABLE users ADD COLUMN telefono VARCHAR(30) NULL, ' +
      'ADD COLUMN direccion VARCHAR(160) NULL, ADD COLUMN whatsapp VARCHAR(24) NULL'
    );
  }
  const [dc] = await pool.query("SHOW COLUMNS FROM users LIKE 'direcciones'");
  if (!dc.length) await pool.query('ALTER TABLE users ADD COLUMN direcciones JSON NULL AFTER direccion');
  const [ct] = await pool.query("SHOW TABLES LIKE 'clientes'");
  if (ct.length) {
    console.warn('Migrando cuentas de cliente a users (cuenta global): eliminando tabla clientes vieja.');
    await pool.query('DROP TABLE clientes');
  }
}

/* Datos de entrega se copian al pedido para conservar el historial aunque el
   cliente edite después su perfil o su libreta de direcciones. */
async function _migrarEntregaPedidos(pool) {
  const [d] = await pool.query("SHOW COLUMNS FROM pedidos LIKE 'destinatario'");
  if (!d.length) await pool.query('ALTER TABLE pedidos ADD COLUMN destinatario VARCHAR(120) NULL AFTER comprobante');
  const [t] = await pool.query("SHOW COLUMNS FROM pedidos LIKE 'telefono_entrega'");
  if (!t.length) await pool.query('ALTER TABLE pedidos ADD COLUMN telefono_entrega VARCHAR(30) NULL AFTER destinatario');
  const [a] = await pool.query("SHOW COLUMNS FROM pedidos LIKE 'direccion_entrega'");
  if (!a.length) await pool.query('ALTER TABLE pedidos ADD COLUMN direccion_entrega VARCHAR(240) NULL AFTER telefono_entrega');
  const [pe] = await pool.query("SHOW COLUMNS FROM pedidos LIKE 'pago_estado'");
  if (!pe.length) await pool.query("ALTER TABLE pedidos ADD COLUMN pago_estado VARCHAR(24) NOT NULL DEFAULT 'pendiente' AFTER metodo_pago");
  const [pr] = await pool.query("SHOW COLUMNS FROM pedidos LIKE 'pago_referencia'");
  if (!pr.length) await pool.query('ALTER TABLE pedidos ADD COLUMN pago_referencia VARCHAR(80) NULL AFTER pago_estado');
}

/* Venta directa (mostrador): antes exigía un cliente con cuenta SIWEPE
   (`cliente_id`); ahora se captura el nombre a mano, así que `ventas` necesita
   columnas de texto libre. Idempotente: si ya existen, no hace nada. */
async function _migrarVentasClienteManual(pool) {
  const [c1] = await pool.query("SHOW COLUMNS FROM ventas LIKE 'cliente_nombre'");
  if (!c1.length) await pool.query('ALTER TABLE ventas ADD COLUMN cliente_nombre VARCHAR(120) NULL AFTER cliente_id');
  const [c2] = await pool.query("SHOW COLUMNS FROM ventas LIKE 'cliente_identidad'");
  if (!c2.length) await pool.query('ALTER TABLE ventas ADD COLUMN cliente_identidad VARCHAR(40) NULL AFTER cliente_nombre');
  const [c3] = await pool.query("SHOW COLUMNS FROM ventas LIKE 'pedido_id'");
  if (!c3.length) await pool.query('ALTER TABLE ventas ADD COLUMN pedido_id INT NULL AFTER cliente_identidad, ADD KEY idx_venta_pedido (empresa_id, pedido_id)');
  const [c4] = await pool.query("SHOW COLUMNS FROM ventas LIKE 'estado'");
  if (!c4.length) await pool.query("ALTER TABLE ventas ADD COLUMN estado VARCHAR(12) NOT NULL DEFAULT 'activa' AFTER pedido_id");
}

/* Versión optimista del estado: evita que una pestaña vieja sobrescriba
   silenciosamente cambios guardados por otra persona o por un checkout. */
async function _migrarVersionEstado(pool) {
  const [c] = await pool.query("SHOW COLUMNS FROM app_meta LIKE 'version'");
  if (!c.length) await pool.query('ALTER TABLE app_meta ADD COLUMN version INT NOT NULL DEFAULT 0');
}

/* Contador de visitas por empresa (para "tiendas destacadas" en descubrir.html). */
async function _migrarVisitasEmpresa(pool) {
  const [c] = await pool.query("SHOW COLUMNS FROM empresas LIKE 'visitas'");
  if (!c.length) await pool.query('ALTER TABLE empresas ADD COLUMN visitas INT NOT NULL DEFAULT 0');
}

/* Galería pública de la tienda e imágenes múltiples por producto. Se dejan
   `logo`, `banners` e `imagen` intactos para conservar compatibilidad con los
   datos creados antes de esta versión. */
async function _migrarGalerias(pool) {
  const [cg] = await pool.query("SHOW COLUMNS FROM config LIKE 'galeria'");
  if (!cg.length) await pool.query('ALTER TABLE config ADD COLUMN galeria JSON NULL AFTER banners');
  const [pi] = await pool.query("SHOW COLUMNS FROM productos LIKE 'imagenes'");
  if (!pi.length) await pool.query('ALTER TABLE productos ADD COLUMN imagenes JSON NULL AFTER imagen');
}

/* Clasificación inicial del onboarding: una empresa puede vender productos,
   ofrecer servicios y/o preparar comida. Se conserva además de su rubro. */
async function _migrarTiposNegocio(pool) {
  const [e] = await pool.query("SHOW COLUMNS FROM empresas LIKE 'tipos_negocio'");
  if (!e.length) await pool.query('ALTER TABLE empresas ADD COLUMN tipos_negocio JSON NULL AFTER nombre');
  const [p] = await pool.query("SHOW COLUMNS FROM registros_pendientes LIKE 'tipos_negocio'");
  if (!p.length) await pool.query('ALTER TABLE registros_pendientes ADD COLUMN tipos_negocio JSON NULL AFTER nombre');
}

/* Una persona tiene una sola identidad SIWEPE por correo. Si una versión
   anterior alcanzó a crear un perfil cliente y otro admin con el mismo email,
   se conserva admin (luego proveedor, luego cliente), se trasladan sus pedidos
   y datos de entrega, y se elimina únicamente la fila duplicada. */
async function _migrarCuentaUnicaPorCorreo(pool) {
  const c=await pool.getConnection();
  try {
    await c.beginTransaction();
    const [duplicados]=await c.query("SELECT email FROM users WHERE email IS NOT NULL AND email<>'' GROUP BY email HAVING COUNT(*)>1");
    for (const grupo of duplicados) {
      const [cuentas]=await c.query("SELECT * FROM users WHERE email=? ORDER BY FIELD(role,'admin','proveedor','cliente'), id",[grupo.email]);
      const principal=cuentas[0];
      for (const extra of cuentas.slice(1)) {
        await c.query(
          "UPDATE users SET telefono=COALESCE(NULLIF(telefono,''),?), direccion=COALESCE(NULLIF(direccion,''),?), direcciones=COALESCE(direcciones,?), whatsapp=COALESCE(NULLIF(whatsapp,''),?) WHERE id=?",
          [extra.telefono||null,extra.direccion||null,extra.direcciones||null,extra.whatsapp||null,principal.id]);
        await c.query('UPDATE pedidos SET cliente_id=? WHERE cliente_id=?',[principal.id,extra.id]);
        await c.query('UPDATE ventas SET cliente_id=? WHERE cliente_id=?',[principal.id,extra.id]);
        await c.query('DELETE FROM password_resets WHERE user_id=?',[extra.id]);
        await c.query('DELETE FROM onboarding_sessions WHERE user_id=?',[extra.id]);
        await c.query('DELETE FROM users WHERE id=?',[extra.id]);
      }
    }
    await c.commit();
  } catch(e) { await c.rollback(); throw e; } finally { c.release(); }

  let [indices]=await pool.query('SHOW INDEX FROM users');
  const compuestos=[...new Set(indices.filter(i=>Number(i.Non_unique)===0&&i.Key_name!=='PRIMARY'&&i.Column_name==='email').map(i=>i.Key_name))]
    .filter(nombre=>indices.filter(i=>i.Key_name===nombre).length>1);
  for(const nombre of compuestos) await pool.query('ALTER TABLE users DROP INDEX `'+String(nombre).replace(/`/g,'')+'`');
  [indices]=await pool.query('SHOW INDEX FROM users');
  const tieneEmailUnico=indices.some(i=>Number(i.Non_unique)===0&&i.Key_name!=='PRIMARY'&&i.Column_name==='email'&&indices.filter(x=>x.Key_name===i.Key_name).length===1);
  if(!tieneEmailUnico) await pool.query('ALTER TABLE users ADD UNIQUE KEY uq_users_email (email)');
}

/* Dos categorías visibles como máximo, conservando `rubro` como categoría
   principal para compatibilidad con tiendas creadas antes de este cambio. */
async function _migrarRubrosEmpresa(pool) {
  const [e] = await pool.query("SHOW COLUMNS FROM empresas LIKE 'rubros'");
  if (!e.length) await pool.query('ALTER TABLE empresas ADD COLUMN rubros JSON NULL AFTER rubro');
  const [p] = await pool.query("SHOW COLUMNS FROM registros_pendientes LIKE 'rubros'");
  if (!p.length) await pool.query('ALTER TABLE registros_pendientes ADD COLUMN rubros JSON NULL AFTER rubro');
  await pool.query("UPDATE empresas SET rubros=JSON_ARRAY(rubro) WHERE rubros IS NULL AND rubro IS NOT NULL AND rubro<>''");
  await pool.query("UPDATE registros_pendientes SET rubros=JSON_ARRAY(rubro) WHERE rubros IS NULL AND rubro IS NOT NULL AND rubro<>''");
}

/* Datos de contacto que el administrador decide hacer públicos en el footer
   de su tienda. Nunca se usa automáticamente el correo privado de acceso. */
async function _migrarFooterEmpresa(pool) {
  const [n] = await pool.query("SHOW COLUMNS FROM empresas LIKE 'contacto_publico'");
  if (!n.length) await pool.query('ALTER TABLE empresas ADD COLUMN contacto_publico VARCHAR(120) NULL AFTER correo');
  const [c] = await pool.query("SHOW COLUMNS FROM empresas LIKE 'correo_publico'");
  if (!c.length) await pool.query('ALTER TABLE empresas ADD COLUMN correo_publico VARCHAR(120) NULL AFTER contacto_publico');
}

/* Inventario estricto: `stock` representa únicamente lo publicado en la
   tienda y `stock_inventario` lo que permanece en almacén. Las instalaciones
   anteriores conservan su stock actual como publicado para no ocultar ni
   duplicar mercadería. */
async function _migrarInventarioEstricto(pool) {
  const [si] = await pool.query("SHOW COLUMNS FROM productos LIKE 'stock_inventario'");
  if (!si.length) await pool.query('ALTER TABLE productos ADD COLUMN stock_inventario INT NOT NULL DEFAULT 0 AFTER stock');
  const [pa] = await pool.query("SHOW COLUMNS FROM productos LIKE 'publicado_alguna_vez'");
  if (!pa.length) {
    await pool.query('ALTER TABLE productos ADD COLUMN publicado_alguna_vez TINYINT NOT NULL DEFAULT 0 AFTER destacado');
    await pool.query("UPDATE productos SET publicado_alguna_vez=1 WHERE stock>0 OR estado='activo'");
  }
  const [os] = await pool.query("SHOW COLUMNS FROM ventas LIKE 'origen_stock'");
  if (!os.length) await pool.query("ALTER TABLE ventas ADD COLUMN origen_stock VARCHAR(24) NOT NULL DEFAULT 'tienda' AFTER estado");
  const [st] = await pool.query("SHOW COLUMNS FROM ventas LIKE 'stock_tienda_usado'");
  if (!st.length) {
    await pool.query('ALTER TABLE ventas ADD COLUMN stock_tienda_usado INT NOT NULL DEFAULT 0 AFTER origen_stock, ADD COLUMN stock_inventario_usado INT NOT NULL DEFAULT 0 AFTER stock_tienda_usado');
    await pool.query("UPDATE ventas SET stock_tienda_usado=cantidad WHERE origen_stock='tienda'");
  }
}

/* Distingue las fichas creadas deliberadamente en Proveedores de los nombres
   rápidos escritos durante una compra. Ambos pueden usarse y editarse, pero
   los segundos quedan visibles en su propia sección hasta completar la ficha. */
async function _migrarOrigenProveedores(pool) {
  const [c] = await pool.query("SHOW COLUMNS FROM proveedores LIKE 'origen'");
  if (!c.length) await pool.query("ALTER TABLE proveedores ADD COLUMN origen VARCHAR(20) NOT NULL DEFAULT 'registrado' AFTER whatsapp");
  await pool.query("UPDATE proveedores SET origen='registrado' WHERE origen IS NULL OR origen NOT IN ('registrado','no_registrado')");
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
      await _migrarClienteGlobal(pool);
      await _migrarVentasClienteManual(pool);
      await _migrarVersionEstado(pool);
      await _migrarVisitasEmpresa(pool);
      await _migrarGalerias(pool);
      await _migrarTiposNegocio(pool);
      await _migrarCuentaUnicaPorCorreo(pool);
      await _migrarRubrosEmpresa(pool);
      await _migrarFooterEmpresa(pool);
      await _migrarInventarioEstricto(pool);
      await _migrarOrigenProveedores(pool);
      await _migrarEntregaPedidos(pool);
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
