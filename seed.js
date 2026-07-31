/* seed.js — crea el esquema y carga datos de ejemplo.
   Ejecuta:  npm run seed
   OJO: vacía y recarga las tablas con los datos de demostración. */
require('dotenv').config();
const { initDb, getPool } = require('./db');
const { hashPassword } = require('./auth');

const hoy = (d = 0) => { const x = new Date(); x.setDate(x.getDate() + d); return x.toISOString().slice(0, 10); };

const categorias = [
  { id:1, nombre:'Maquillaje', descripcion:'Labiales, sombras, bases', estado:'activo' },
  { id:2, nombre:'Cuidado de la piel', descripcion:'Cremas, sérums, limpiadores', estado:'activo' },
  { id:3, nombre:'Perfumería', descripcion:'Fragancias y splash corporales', estado:'activo' },
  { id:4, nombre:'Accesorios', descripcion:'Aretes, bolsos y detalles', estado:'activo' },
  { id:5, nombre:'Cabello', descripcion:'Tratamientos y styling', estado:'activo' },
];

const productos = [
  { id:1, codigo:'MAQ-001', nombre:'Labial mate Rosé', categoria_id:1, descripcion:'Larga duración, tono rosa nude. Fórmula hidratante que no reseca.', precio_compra:120, precio_venta:220, stock:24, stock_min:8, imagen:'', estado:'activo', destacado:1, marca:'', tipo_piel:[] },
  { id:2, codigo:'MAQ-002', nombre:'Paleta de sombras Sunset', categoria_id:1, descripcion:'12 tonos cálidos satinados. Pigmentación intensa, fácil difuminado.', precio_compra:280, precio_venta:480, stock:6, stock_min:10, imagen:'', estado:'activo', destacado:1, marca:'', tipo_piel:[] },
  { id:3, codigo:'PIEL-001', nombre:'Sérum de vitamina C', categoria_id:2, descripcion:'Ilumina y unifica el tono de la piel en 4 semanas. 30 ml.', precio_compra:210, precio_venta:390, stock:15, stock_min:6, imagen:'', estado:'activo', destacado:1, marca:'', tipo_piel:[] },
  { id:4, codigo:'PIEL-002', nombre:'Crema hidratante de rosas', categoria_id:2, descripcion:'Con agua de rosas y ácido hialurónico. Para piel sensible.', precio_compra:160, precio_venta:295, stock:3, stock_min:5, imagen:'', estado:'activo', destacado:0, marca:'', tipo_piel:[] },
  { id:5, codigo:'PERF-001', nombre:'Perfume Fleur Dorée 50 ml', categoria_id:3, descripcion:'Notas de peonía, vainilla y ámbar. Duración 8+ horas.', precio_compra:520, precio_venta:890, stock:9, stock_min:4, imagen:'', estado:'activo', destacado:1, marca:'', tipo_piel:[] },
  { id:6, codigo:'ACC-001', nombre:'Aretes perla dorada', categoria_id:4, descripcion:'Baño de oro 18k. Hipoalergénicos, ideales para piel sensible.', precio_compra:85, precio_venta:180, stock:30, stock_min:10, imagen:'', estado:'activo', destacado:0, marca:'', tipo_piel:[] },
  { id:7, codigo:'ACC-002', nombre:'Bolso mini beige', categoria_id:4, descripcion:'Piel sintética premium con cadena dorada. 20×15×6 cm.', precio_compra:340, precio_venta:620, stock:0, stock_min:3, imagen:'', estado:'activo', destacado:1, marca:'', tipo_piel:[] },
  { id:8, codigo:'CAB-001', nombre:'Mascarilla de keratina', categoria_id:5, descripcion:'Reparación profunda para cabello dañado. 250 g.', precio_compra:140, precio_venta:260, stock:18, stock_min:6, imagen:'', estado:'activo', destacado:0, marca:'', tipo_piel:[] },
];

const proveedores = [
  { id:1, nombre:'Karla Pineda', telefono:'9988-1122', correo:'ventas@bellezahn.com', empresa:'Belleza HN', direccion:'Col. Palmira, Tegucigalpa', whatsapp:'50499881122', estado:'activo' },
  { id:2, nombre:'Luis Fernández', telefono:'3344-5566', correo:'luis@cosmetigroup.com', empresa:'CosmetiGroup', direccion:'San Pedro Sula', whatsapp:'50433445566', estado:'activo' },
  { id:3, nombre:'María Castillo', telefono:'8877-2233', correo:'maria@doradaimport.com', empresa:'Dorada Import', direccion:'Comayagüela', whatsapp:'', estado:'inactivo' },
];

const clientes = [
  { id:1, nombre:'Andrea López', telefono:'9911-4455', correo:'andrea.lopez@gmail.com', direccion:'Res. El Trapiche', whatsapp:'50499114455', pin:'1111', registrado:1 },
  { id:2, nombre:'Sofía Martínez', telefono:'3300-7788', correo:'sofi.mtz@hotmail.com', direccion:'Col. Kennedy', whatsapp:'50433007788', pin:'2222', registrado:1 },
  { id:3, nombre:'Daniela Reyes', telefono:'9455-0000', correo:'dani.reyes@gmail.com', direccion:'Lomas del Guijarro', whatsapp:'50494550000', pin:'3333', registrado:1 },
  { id:4, nombre:'Cliente general', telefono:'—', correo:'—', direccion:'—', whatsapp:'', pin:'0000', registrado:1 },
];

const compras = [
  {id:1,producto_id:1,proveedor_id:1,cantidad:12,precio:120,fecha:hoy(-15),obs:'Reposición mensual'},
  {id:2,producto_id:5,proveedor_id:2,cantidad:6,precio:520,fecha:hoy(-10),obs:'Lote fragancias'},
  {id:3,producto_id:6,proveedor_id:1,cantidad:20,precio:85,fecha:hoy(-7),obs:''},
  {id:4,producto_id:3,proveedor_id:2,cantidad:10,precio:210,fecha:hoy(-5),obs:''},
  {id:5,producto_id:2,proveedor_id:3,cantidad:8,precio:280,fecha:hoy(-3),obs:'Reposición'},
  {id:6,producto_id:1,proveedor_id:1,cantidad:10,precio:120,fecha:hoy(-38),obs:''},
  {id:7,producto_id:4,proveedor_id:2,cantidad:8,precio:160,fecha:hoy(-35),obs:''},
  {id:8,producto_id:8,proveedor_id:1,cantidad:12,precio:140,fecha:hoy(-42),obs:''},
  {id:9,producto_id:2,proveedor_id:3,cantidad:6,precio:280,fecha:hoy(-70),obs:''},
  {id:10,producto_id:5,proveedor_id:2,cantidad:4,precio:520,fecha:hoy(-65),obs:''},
  {id:11,producto_id:6,proveedor_id:1,cantidad:15,precio:85,fecha:hoy(-98),obs:''},
  {id:12,producto_id:3,proveedor_id:2,cantidad:8,precio:210,fecha:hoy(-100),obs:''},
  {id:13,producto_id:1,proveedor_id:1,cantidad:14,precio:120,fecha:hoy(-130),obs:''},
  {id:14,producto_id:8,proveedor_id:1,cantidad:10,precio:140,fecha:hoy(-160),obs:''},
];

const ventas = [
  {id:1,producto_id:1,cliente_id:1,cantidad:2,precio:220,fecha:hoy(-8),total:440},
  {id:2,producto_id:3,cliente_id:2,cantidad:1,precio:390,fecha:hoy(-5),total:390},
  {id:3,producto_id:6,cliente_id:3,cantidad:3,precio:180,fecha:hoy(-3),total:540},
  {id:4,producto_id:5,cliente_id:1,cantidad:1,precio:890,fecha:hoy(-2),total:890},
  {id:5,producto_id:2,cliente_id:2,cantidad:1,precio:480,fecha:hoy(-1),total:480},
  {id:6,producto_id:1,cliente_id:3,cantidad:3,precio:220,fecha:hoy(),total:660},
  {id:7,producto_id:8,cliente_id:1,cantidad:2,precio:260,fecha:hoy(-4),total:520},
  {id:8,producto_id:1,cliente_id:2,cantidad:4,precio:220,fecha:hoy(-35),total:880},
  {id:9,producto_id:3,cliente_id:1,cantidad:2,precio:390,fecha:hoy(-30),total:780},
  {id:10,producto_id:5,cliente_id:3,cantidad:1,precio:890,fecha:hoy(-32),total:890},
  {id:11,producto_id:2,cliente_id:1,cantidad:2,precio:480,fecha:hoy(-28),total:960},
  {id:12,producto_id:6,cliente_id:2,cantidad:5,precio:180,fecha:hoy(-27),total:900},
  {id:13,producto_id:4,cliente_id:3,cantidad:2,precio:295,fecha:hoy(-25),total:590},
  {id:14,producto_id:1,cliente_id:1,cantidad:3,precio:220,fecha:hoy(-65),total:660},
  {id:15,producto_id:8,cliente_id:2,cantidad:3,precio:260,fecha:hoy(-62),total:780},
  {id:16,producto_id:5,cliente_id:1,cantidad:2,precio:890,fecha:hoy(-58),total:1780},
  {id:17,producto_id:3,cliente_id:3,cantidad:1,precio:390,fecha:hoy(-60),total:390},
  {id:18,producto_id:6,cliente_id:2,cantidad:4,precio:180,fecha:hoy(-55),total:720},
  {id:19,producto_id:2,cliente_id:1,cantidad:3,precio:480,fecha:hoy(-95),total:1440},
  {id:20,producto_id:1,cliente_id:3,cantidad:5,precio:220,fecha:hoy(-92),total:1100},
  {id:21,producto_id:5,cliente_id:2,cantidad:1,precio:890,fecha:hoy(-88),total:890},
  {id:22,producto_id:3,cliente_id:1,cantidad:2,precio:390,fecha:hoy(-90),total:780},
  {id:23,producto_id:4,cliente_id:2,cantidad:3,precio:295,fecha:hoy(-85),total:885},
  {id:24,producto_id:1,cliente_id:2,cantidad:6,precio:220,fecha:hoy(-125),total:1320},
  {id:25,producto_id:6,cliente_id:1,cantidad:8,precio:180,fecha:hoy(-122),total:1440},
  {id:26,producto_id:2,cliente_id:3,cantidad:2,precio:480,fecha:hoy(-118),total:960},
  {id:27,producto_id:8,cliente_id:2,cantidad:4,precio:260,fecha:hoy(-115),total:1040},
  {id:28,producto_id:3,cliente_id:1,cantidad:3,precio:390,fecha:hoy(-155),total:1170},
  {id:29,producto_id:5,cliente_id:3,cantidad:2,precio:890,fecha:hoy(-152),total:1780},
  {id:30,producto_id:1,cliente_id:2,cantidad:4,precio:220,fecha:hoy(-148),total:880},
  {id:31,producto_id:4,cliente_id:1,cantidad:2,precio:295,fecha:hoy(-150),total:590},
];

const movimientos = [
  {id:1,tipo:'entrada',signo:null,producto_id:1,cantidad:12,fecha:hoy(-15),usuario:'Admin',obs:'Compra · Reposición mensual'},
  {id:2,tipo:'entrada',signo:null,producto_id:5,cantidad:6,fecha:hoy(-10),usuario:'Admin',obs:'Compra · Lote fragancias'},
  {id:3,tipo:'salida',signo:null,producto_id:1,cantidad:2,fecha:hoy(-8),usuario:'Admin',obs:'Venta a Andrea López'},
  {id:4,tipo:'entrada',signo:null,producto_id:6,cantidad:20,fecha:hoy(-7),usuario:'Admin',obs:'Compra'},
  {id:5,tipo:'salida',signo:null,producto_id:3,cantidad:1,fecha:hoy(-5),usuario:'Admin',obs:'Venta a Sofía Martínez'},
  {id:6,tipo:'entrada',signo:null,producto_id:3,cantidad:10,fecha:hoy(-5),usuario:'Admin',obs:'Compra'},
  {id:7,tipo:'salida',signo:null,producto_id:6,cantidad:3,fecha:hoy(-3),usuario:'Admin',obs:'Venta a Daniela Reyes'},
  {id:8,tipo:'salida',signo:null,producto_id:5,cantidad:1,fecha:hoy(-2),usuario:'Admin',obs:'Venta a Andrea López'},
  {id:9,tipo:'entrada',signo:null,producto_id:2,cantidad:8,fecha:hoy(-3),usuario:'Admin',obs:'Compra'},
  {id:10,tipo:'salida',signo:null,producto_id:2,cantidad:1,fecha:hoy(-1),usuario:'Admin',obs:'Venta a Sofía Martínez'},
  {id:11,tipo:'salida',signo:null,producto_id:1,cantidad:3,fecha:hoy(),usuario:'Admin',obs:'Venta a Daniela Reyes'},
];

const pedidos = [
  { id:1, cliente_id:1, total:830, nota:'Para regalo, envolver por favor', fecha:hoy(-2), estado:'aprobado', metodo_pago:'transferencia', comprobante:'',
    items:[{producto_id:1,cantidad:2,precio:220,subtotal:440},{producto_id:3,cantidad:1,precio:390,subtotal:390}] },
  { id:2, cliente_id:2, total:890, nota:'', fecha:hoy(), estado:'pendiente', metodo_pago:'transferencia', comprobante:'',
    items:[{producto_id:5,cantidad:1,precio:890,subtotal:890}] },
];

const config = {
  nombre:'Belle Stock', logo:'', moneda:'L', tema:'rosado', pin_admin:'1234',
  banners:[], pago:{ banco:'', cuenta:'', titular:'', tipo:'', nota:'' },
};

const seq = { producto:8, categoria:5, proveedor:3, cliente:4, compra:14, venta:31, movimiento:11, pedido:2, mensaje:0 };

async function run() {
  await initDb();
  const pool = getPool();
  const c = await pool.getConnection();
  try {
    await c.query('SET FOREIGN_KEY_CHECKS = 0');
    for (const t of ['mensajes','pedido_items','pedidos','movimientos','ventas','compras','productos','clientes','proveedores','categorias','users','config','app_meta']) {
      await c.query(`TRUNCATE TABLE ${t}`);
    }

    await c.query('INSERT INTO config (id,nombre,logo,moneda,tema,pin_admin,banners,pago) VALUES (1,?,?,?,?,?,?,?)',
      [config.nombre, config.logo, config.moneda, config.tema, config.pin_admin, JSON.stringify(config.banners), JSON.stringify(config.pago)]);
    await c.query('INSERT INTO app_meta (id,seq) VALUES (1,?)', [JSON.stringify(seq)]);

    for (const x of categorias)
      await c.query('INSERT INTO categorias (id,nombre,descripcion,estado) VALUES (?,?,?,?)', [x.id,x.nombre,x.descripcion,x.estado]);
    for (const x of proveedores)
      await c.query('INSERT INTO proveedores (id,nombre,telefono,correo,empresa,direccion,whatsapp,estado) VALUES (?,?,?,?,?,?,?,?)', [x.id,x.nombre,x.telefono,x.correo,x.empresa,x.direccion,x.whatsapp,x.estado]);
    for (const x of clientes)
      await c.query('INSERT INTO clientes (id,nombre,telefono,correo,direccion,whatsapp,pin,registrado) VALUES (?,?,?,?,?,?,?,?)', [x.id,x.nombre,x.telefono,x.correo,x.direccion,x.whatsapp,x.pin,x.registrado]);
    for (const x of productos)
      await c.query('INSERT INTO productos (id,codigo,nombre,categoria_id,descripcion,precio_compra,precio_venta,stock,stock_min,imagen,estado,destacado,marca,tipo_piel) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
        [x.id,x.codigo,x.nombre,x.categoria_id,x.descripcion,x.precio_compra,x.precio_venta,x.stock,x.stock_min,x.imagen,x.estado,x.destacado,x.marca,JSON.stringify(x.tipo_piel)]);
    for (const x of compras)
      await c.query('INSERT INTO compras (id,producto_id,proveedor_id,cantidad,precio,fecha,obs) VALUES (?,?,?,?,?,?,?)', [x.id,x.producto_id,x.proveedor_id,x.cantidad,x.precio,x.fecha,x.obs]);
    for (const x of ventas)
      await c.query('INSERT INTO ventas (id,producto_id,cliente_id,cantidad,precio,fecha,total) VALUES (?,?,?,?,?,?,?)', [x.id,x.producto_id,x.cliente_id,x.cantidad,x.precio,x.fecha,x.total]);
    for (const x of movimientos)
      await c.query('INSERT INTO movimientos (id,tipo,signo,producto_id,cantidad,fecha,usuario,obs) VALUES (?,?,?,?,?,?,?,?)', [x.id,x.tipo,x.signo,x.producto_id,x.cantidad,x.fecha,x.usuario,x.obs]);
    for (const p of pedidos) {
      await c.query('INSERT INTO pedidos (id,cliente_id,total,nota,fecha,estado,metodo_pago,comprobante) VALUES (?,?,?,?,?,?,?,?)', [p.id,p.cliente_id,p.total,p.nota,p.fecha,p.estado,p.metodo_pago,p.comprobante]);
      for (const it of p.items)
        await c.query('INSERT INTO pedido_items (pedido_id,producto_id,cantidad,precio,subtotal) VALUES (?,?,?,?,?)', [p.id,it.producto_id,it.cantidad,it.precio,it.subtotal]);
    }

    // Usuarios del sistema (contraseñas cifradas)
    await c.query('INSERT INTO users (nombre,email,password_hash,role,ref_id,activo) VALUES (?,?,?,?,?,1)',
      ['Administrador', 'admin@siwepe.com', hashPassword('admin1234'), 'admin', null]);
    await c.query('INSERT INTO users (nombre,email,password_hash,role,ref_id,activo) VALUES (?,?,?,?,?,1)',
      ['Karla Pineda', 'proveedor@bellezahn.com', hashPassword('proveedor123'), 'proveedor', 1]);

    await c.query('SET FOREIGN_KEY_CHECKS = 1');
    console.log('✅ Base de datos creada y poblada con datos de ejemplo.');
    console.log('   Admin:     admin@siwepe.com / admin1234');
    console.log('   Proveedor: proveedor@bellezahn.com / proveedor123');
    console.log('   Clientes:  Sofía Martínez / 2222  (y otros con su PIN)');
  } finally {
    c.release();
    process.exit(0);
  }
}

run().catch(err => { console.error('❌ Error al poblar la base:', err.message); process.exit(1); });
