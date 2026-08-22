/*! SIWEPE · Operación comercial: caja, POS, promociones, importación y gastronomía. */
'use strict';

const express = require('express');
const multer = require('multer');
const { readSheet } = require('read-excel-file/node');
const { getPool } = require('./db');
const { requireAuth, requireRole } = require('./auth');

const router = express.Router();
const soloAdmin = [requireAuth, requireRole('admin')];
const lecturaNegocio = [requireAuth, requireRole('admin','proveedor')];
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024, files: 1 } });
const num = v => Number.isFinite(Number(v)) ? Number(v) : 0;
const arr = v => { if (Array.isArray(v)) return v; try { const x=JSON.parse(v||'[]'); return Array.isArray(x)?x:[]; } catch { return []; } };
const hoy = () => new Date().toISOString().slice(0,10);
const ahoraMysql = () => new Date().toISOString().slice(0,19).replace('T',' ');

function fallo(res,e){
  console.error('Operación comercial:', e && (e.stack||e.message)||e);
  res.status(e.status||500).json({error:e.status?e.message:'No se pudo completar la operación'});
}
function error(msg,status=400){ const e=new Error(msg); e.status=status; return e; }
function E(req){ const id=num(req.user&&req.user.empresa_id); if(!id) throw error('Tu usuario no está asociado a una empresa',403); return id; }
function texto(v,n=180){ return String(v||'').trim().slice(0,n); }

async function siguienteId(c,empresaId,clave,tabla){
  const [[m]]=await c.query('SELECT seq FROM app_meta WHERE empresa_id=? FOR UPDATE',[empresaId]);
  const seq=m&&m.seq&&typeof m.seq==='object'?m.seq:JSON.parse(m&&m.seq||'{}');
  const [[mx]]=await c.query(`SELECT COALESCE(MAX(id),0) m FROM \`${tabla}\` WHERE empresa_id=?`,[empresaId]);
  const id=Math.max(num(seq[clave]),num(mx.m))+1;
  seq[clave]=id;
  await c.query('UPDATE app_meta SET seq=? WHERE empresa_id=?',[JSON.stringify(seq),empresaId]);
  return id;
}

function variantesDe(p){ return arr(p.variantes).filter(v=>v&&v.id); }
function nombreVariante(v){
  if(!v) return '';
  if(v.nombre) return texto(v.nombre,180);
  const a=v.atributos||{};
  return Object.entries(a).filter(([,x])=>x).map(([k,x])=>`${k}: ${x}`).join(' · ').slice(0,180);
}
function normalizarVariante(v,i){
  const atributos={};
  for(const k of ['talla','color','presentacion']) if(texto(v&&v[k]||v&&v.atributos&&v.atributos[k],60)) atributos[k]=texto(v[k]||v.atributos[k],60);
  return {
    id:texto(v&&v.id,80)||`VAR-${String(i+1).padStart(3,'0')}`,
    sku:texto(v&&v.sku,80), atributos,
    precioCompra:Math.max(0,num(v&&v.precioCompra)), precioVenta:Math.max(0,num(v&&v.precioVenta)),
    stock:Math.max(0,Math.trunc(num(v&&v.stock))), stockInventario:Math.max(0,Math.trunc(num(v&&v.stockInventario))),
    stockMin:Math.max(0,Math.trunc(num(v&&v.stockMin))), activo:v&&v.activo!==false
  };
}

async function promocionesVigentes(c,empresaId){
  const [rows]=await c.query("SELECT * FROM promociones WHERE empresa_id=? AND estado='activo' AND inicia<=CURDATE() AND termina>=CURDATE()",[empresaId]);
  return rows.map(r=>({...r,objetivos:arr(r.objetivos)}));
}
function promoAplica(promo,p){
  if(promo.alcance==='todos') return true;
  if(promo.alcance==='categorias') return promo.objetivos.map(Number).includes(num(p.categoria_id));
  return promo.objetivos.map(Number).includes(num(p.id));
}
function calcularPrecio(p,precioBase,cantidad,promos){
  let mejor={precio:precioBase,promocion:null,ahorro:0};
  for(const pr of promos){
    if(cantidad<num(pr.cantidad_min)||!promoAplica(pr,p)) continue;
    let precio=precioBase;
    if(pr.tipo==='porcentaje') precio=precioBase*(1-Math.min(100,num(pr.valor))/100);
    else if(pr.tipo==='monto') precio=Math.max(0,precioBase-num(pr.valor));
    else if(pr.tipo==='precio_fijo') precio=Math.max(0,num(pr.valor));
    precio=+precio.toFixed(2);
    if(precio<mejor.precio) mejor={precio,promocion:{id:pr.id,nombre:pr.nombre,tipo:pr.tipo,valor:num(pr.valor)},ahorro:+((precioBase-precio)*cantidad).toFixed(2)};
  }
  return mejor;
}

async function turnoAbierto(c,empresaId,bloquear=false){
  const [[t]]=await c.query(`SELECT * FROM turnos_caja WHERE empresa_id=? AND estado='abierto' ORDER BY id DESC LIMIT 1${bloquear?' FOR UPDATE':''}`,[empresaId]);
  return t||null;
}
async function resumenTurno(c,empresaId,t){
  const [[x]]=await c.query(`SELECT
    COALESCE(SUM(CASE WHEN metodo='efectivo' AND tipo IN ('venta','entrada') THEN monto ELSE 0 END),0) entradas,
    COALESCE(SUM(CASE WHEN metodo='efectivo' AND tipo IN ('salida','retiro') THEN monto ELSE 0 END),0) salidas,
    COALESCE(SUM(CASE WHEN tipo='venta' THEN monto ELSE 0 END),0) ventas,
    COUNT(*) operaciones
    FROM movimientos_caja WHERE empresa_id=? AND turno_id=?`,[empresaId,t.id]);
  return {...t,fondo_inicial:num(t.fondo_inicial),entradas:num(x.entradas),salidas:num(x.salidas),ventas:num(x.ventas),operaciones:num(x.operaciones),efectivoEsperado:+(num(t.fondo_inicial)+num(x.entradas)-num(x.salidas)).toFixed(2)};
}
async function insertarMovimientoCaja(c,empresaId,turno,tipo,metodo,monto,descripcion,referencia,userId){
  const id=await siguienteId(c,empresaId,'movimientoCaja','movimientos_caja');
  await c.query('INSERT INTO movimientos_caja (empresa_id,id,turno_id,tipo,metodo,monto,descripcion,referencia,fecha,usuario_id) VALUES (?,?,?,?,?,?,?,?,?,?)',
    [empresaId,id,turno.id,tipo,metodo,monto,descripcion,referencia||null,ahoraMysql(),userId]);
  return id;
}

/* ───────── Caja, turnos y arqueo ───────── */
router.get('/caja',...lecturaNegocio,async(req,res)=>{ try{
  const empresaId=E(req), c=getPool();
  const t=await turnoAbierto(c,empresaId);
  const [historial]=await c.query("SELECT * FROM turnos_caja WHERE empresa_id=? AND estado='cerrado' ORDER BY id DESC LIMIT 30",[empresaId]);
  const [movimientos]=t?await c.query('SELECT * FROM movimientos_caja WHERE empresa_id=? AND turno_id=? ORDER BY id DESC',[empresaId,t.id]):[[]];
  res.json({turno:t?await resumenTurno(c,empresaId,t):null,movimientos,historial:historial.map(x=>({...x,fondo_inicial:num(x.fondo_inicial),efectivo_esperado:num(x.efectivo_esperado),efectivo_contado:num(x.efectivo_contado),diferencia:num(x.diferencia)}))});
}catch(e){fallo(res,e);} });

router.post('/caja/abrir',...soloAdmin,async(req,res)=>{ const c=await getPool().getConnection(); try{
  const empresaId=E(req); await c.beginTransaction();
  if(await turnoAbierto(c,empresaId,true)) throw error('Ya existe un turno de caja abierto',409);
  const fondo=Math.max(0,num(req.body.fondoInicial));
  const id=await siguienteId(c,empresaId,'turnoCaja','turnos_caja');
  await c.query('INSERT INTO turnos_caja (empresa_id,id,usuario_id,usuario_nombre,apertura,fondo_inicial,estado,notas) VALUES (?,?,?,?,?,?,\'abierto\',?)',
    [empresaId,id,req.user.id,texto(req.user.nombre||'Administrador',120),ahoraMysql(),fondo,texto(req.body.notas,255)||null]);
  await c.commit(); res.status(201).json({ok:true,id});
}catch(e){await c.rollback().catch(()=>{});fallo(res,e);}finally{c.release();} });

router.post('/caja/movimientos',...soloAdmin,async(req,res)=>{ const c=await getPool().getConnection(); try{
  const empresaId=E(req), tipo=texto(req.body.tipo,20), metodo=texto(req.body.metodo||'efectivo',20), monto=num(req.body.monto);
  if(!['entrada','salida','retiro'].includes(tipo)) throw error('Tipo de movimiento inválido');
  if(!(monto>0)) throw error('El monto debe ser mayor que cero');
  if(metodo!=='efectivo') throw error('Los movimientos manuales de caja deben ser en efectivo');
  const descripcion=texto(req.body.descripcion,180); if(!descripcion) throw error('Describe el movimiento');
  await c.beginTransaction(); const turno=await turnoAbierto(c,empresaId,true); if(!turno) throw error('Abre un turno de caja primero',409);
  const id=await insertarMovimientoCaja(c,empresaId,turno,tipo,metodo,monto,descripcion,texto(req.body.referencia,80),req.user.id);
  await c.commit(); res.status(201).json({ok:true,id});
}catch(e){await c.rollback().catch(()=>{});fallo(res,e);}finally{c.release();} });

router.post('/caja/cerrar',...soloAdmin,async(req,res)=>{ const c=await getPool().getConnection(); try{
  const empresaId=E(req), contado=num(req.body.efectivoContado); if(contado<0) throw error('El efectivo contado no puede ser negativo');
  await c.beginTransaction(); const turno=await turnoAbierto(c,empresaId,true); if(!turno) throw error('No hay un turno abierto',409);
  const resumen=await resumenTurno(c,empresaId,turno), diferencia=+(contado-resumen.efectivoEsperado).toFixed(2);
  await c.query("UPDATE turnos_caja SET cierre=?,efectivo_esperado=?,efectivo_contado=?,diferencia=?,estado='cerrado',notas=CONCAT_WS(' · ',NULLIF(notas,''),NULLIF(?,'')) WHERE empresa_id=? AND id=?",
    [ahoraMysql(),resumen.efectivoEsperado,contado,diferencia,texto(req.body.notas,255),empresaId,turno.id]);
  await c.commit(); res.json({ok:true,efectivoEsperado:resumen.efectivoEsperado,efectivoContado:contado,diferencia});
}catch(e){await c.rollback().catch(()=>{});fallo(res,e);}finally{c.release();} });

/* ───────── POS multiproducto ───────── */
async function resolverLinea(c,empresaId,linea,promos,consumir){
  const productoId=num(linea.productoId), cantidad=Math.trunc(num(linea.cantidad));
  if(!productoId||cantidad<=0) throw error('Hay un producto o cantidad inválida');
  const [[p]]=await c.query("SELECT * FROM productos WHERE empresa_id=? AND id=? AND estado='activo' FOR UPDATE",[empresaId,productoId]);
  if(!p) throw error('Uno de los productos ya no está disponible',404);
  let variantes=variantesDe(p), variante=null, precioBase=num(p.precio_venta), tienda=num(p.stock), inventario=num(p.stock_inventario);
  if(texto(linea.varianteId,80)){
    variante=variantes.find(v=>String(v.id)===String(linea.varianteId)&&v.activo!==false);
    if(!variante) throw error(`La variante de ${p.nombre} ya no está disponible`,409);
    precioBase=num(variante.precioVenta); tienda=num(variante.stock); inventario=num(variante.stockInventario);
  } else if(variantes.length){ throw error(`Selecciona una variante de ${p.nombre}`,400); }
  if(cantidad>tienda+inventario) throw error(`Stock insuficiente para ${p.nombre}. Disponible: ${tienda+inventario}`,409);
  const usaTienda=Math.min(tienda,cantidad), usaInventario=cantidad-usaTienda;
  if(usaInventario>0&&!linea.permitirInventario) throw error(`La venta requiere ${usaInventario} unidad(es) de inventario para ${p.nombre}`,409);
  const calc=calcularPrecio(p,precioBase,cantidad,promos);
  if(consumir){
    if(variante){
      variante.stock=tienda-usaTienda; variante.stockInventario=inventario-usaInventario;
      variantes=variantes.map(v=>String(v.id)===String(variante.id)?variante:v);
      const totalTienda=variantes.reduce((s,v)=>s+num(v.stock),0), totalInv=variantes.reduce((s,v)=>s+num(v.stockInventario),0);
      await c.query('UPDATE productos SET variantes=?,stock=?,stock_inventario=?,publicado_alguna_vez=1 WHERE empresa_id=? AND id=?',[JSON.stringify(variantes),totalTienda,totalInv,empresaId,p.id]);
    }else await c.query('UPDATE productos SET stock=stock-?,stock_inventario=stock_inventario-?,publicado_alguna_vez=1 WHERE empresa_id=? AND id=?',[usaTienda,usaInventario,empresaId,p.id]);
  }
  return {producto:p,variante,cantidad,precio:calc.precio,subtotal:+(calc.precio*cantidad).toFixed(2),promocion:calc.promocion,ahorro:calc.ahorro,usaTienda,usaInventario};
}

router.post('/pos/cotizar',...soloAdmin,async(req,res)=>{ const c=await getPool().getConnection(); try{
  const empresaId=E(req), promos=await promocionesVigentes(c,empresaId), items=[];
  for(const x of arr(req.body.items)) items.push(await resolverLinea(c,empresaId,{...x,permitirInventario:true},promos,false));
  res.json({items:items.map(x=>({productoId:x.producto.id,nombre:x.producto.nombre,varianteId:x.variante&&x.variante.id,varianteNombre:nombreVariante(x.variante),cantidad:x.cantidad,precio:x.precio,subtotal:x.subtotal,promocion:x.promocion,ahorro:x.ahorro,usaTienda:x.usaTienda,usaInventario:x.usaInventario})),total:+items.reduce((s,x)=>s+x.subtotal,0).toFixed(2)});
}catch(e){fallo(res,e);}finally{c.release();} });

router.post('/pos/ventas',...soloAdmin,async(req,res)=>{ const c=await getPool().getConnection(); try{
  const empresaId=E(req), metodo=texto(req.body.metodoPago||'efectivo',24);
  if(!['efectivo','transferencia','otro'].includes(metodo)) throw error('Método de pago inválido; tarjeta todavía no está habilitada');
  const lineas=arr(req.body.items); if(!lineas.length) throw error('Agrega al menos un producto');
  await c.beginTransaction(); const turno=await turnoAbierto(c,empresaId,true); if(!turno) throw error('Debes abrir un turno de caja antes de vender',409);
  const promos=await promocionesVigentes(c,empresaId), calculadas=[];
  for(const x of lineas) calculadas.push(await resolverLinea(c,empresaId,x,promos,true));
  const total=+calculadas.reduce((s,x)=>s+x.subtotal,0).toFixed(2), ticket=`POS-${hoy().replace(/-/g,'')}-${Date.now().toString().slice(-6)}`;
  for(const x of calculadas){
    const id=await siguienteId(c,empresaId,'venta','ventas');
    await c.query(`INSERT INTO ventas (empresa_id,id,producto_id,cliente_nombre,cliente_identidad,estado,origen_stock,stock_tienda_usado,stock_inventario_usado,ticket,variante_id,variante_nombre,metodo_pago,turno_caja_id,cantidad,precio,fecha,total)
      VALUES (?,?,?,?,?,'activa',?,?,?,?,?,?,?,?,?,?,?,?)`,[empresaId,id,x.producto.id,texto(req.body.clienteNombre||'Cliente de mostrador',120),texto(req.body.clienteIdentidad,40)||null,x.usaInventario?(x.usaTienda?'mixto':'inventario'):'tienda',x.usaTienda,x.usaInventario,ticket,x.variante&&x.variante.id||null,nombreVariante(x.variante)||null,metodo,turno.id,x.cantidad,x.precio,hoy(),x.subtotal]);
    const movId=await siguienteId(c,empresaId,'movimiento','movimientos');
    await c.query("INSERT INTO movimientos (empresa_id,id,tipo,producto_id,cantidad,fecha,usuario,obs) VALUES (?,?, 'salida',?,?,?,?,?)",[empresaId,movId,x.producto.id,x.cantidad,hoy(),texto(req.user.nombre||'Admin',80),`POS ${ticket}${x.variante?' · '+nombreVariante(x.variante):''}`]);
  }
  await insertarMovimientoCaja(c,empresaId,turno,'venta',metodo,total,`Venta ${ticket}`,ticket,req.user.id);
  await c.query('UPDATE app_meta SET version=version+1 WHERE empresa_id=?',[empresaId]); await c.commit();
  res.status(201).json({ok:true,ticket,total,cambio:metodo==='efectivo'?Math.max(0,+(num(req.body.recibido)-total).toFixed(2)):0});
}catch(e){await c.rollback().catch(()=>{});fallo(res,e);}finally{c.release();} });

/* ───────── Promociones ───────── */
router.get('/promociones',...lecturaNegocio,async(req,res)=>{try{const [rows]=await getPool().query('SELECT * FROM promociones WHERE empresa_id=? ORDER BY id DESC',[E(req)]);res.json({promociones:rows.map(x=>({...x,valor:num(x.valor),objetivos:arr(x.objetivos),cantidad_min:num(x.cantidad_min)}))});}catch(e){fallo(res,e);}});
router.post('/promociones',...soloAdmin,async(req,res)=>{const c=await getPool().getConnection();try{
  const empresaId=E(req), b=req.body||{}, nombre=texto(b.nombre,120), tipo=texto(b.tipo,24), alcance=texto(b.alcance,20), valor=num(b.valor), objetivos=arr(b.objetivos).map(Number).filter(Boolean), cantidad=Math.max(1,Math.trunc(num(b.cantidadMin)||1));
  if(!nombre) throw error('Escribe el nombre de la promoción'); if(!['porcentaje','monto','precio_fijo'].includes(tipo)) throw error('Tipo de promoción inválido');
  if(!(valor>0)||(tipo==='porcentaje'&&valor>100)) throw error('Valor de promoción inválido'); if(!['todos','productos','categorias'].includes(alcance)) throw error('Alcance inválido');
  if(alcance!=='todos'&&!objetivos.length) throw error('Selecciona productos o categorías'); if(!/^\d{4}-\d{2}-\d{2}$/.test(b.inicia)||!/^\d{4}-\d{2}-\d{2}$/.test(b.termina)||b.termina<b.inicia) throw error('Rango de fechas inválido');
  await c.beginTransaction(); const id=await siguienteId(c,empresaId,'promocion','promociones');
  await c.query('INSERT INTO promociones (empresa_id,id,nombre,tipo,valor,alcance,objetivos,cantidad_min,inicia,termina,estado) VALUES (?,?,?,?,?,?,?,?,?,?,?)',[empresaId,id,nombre,tipo,valor,alcance,JSON.stringify(objetivos),cantidad,b.inicia,b.termina,b.estado==='inactivo'?'inactivo':'activo']);
  await c.commit();res.status(201).json({ok:true,id});
}catch(e){await c.rollback().catch(()=>{});fallo(res,e);}finally{c.release();}});
router.put('/promociones/:id',...soloAdmin,async(req,res)=>{try{
  const b=req.body||{}, tipo=texto(b.tipo,24), alcance=texto(b.alcance,20), valor=num(b.valor), objetivos=arr(b.objetivos).map(Number).filter(Boolean);
  if(!texto(b.nombre,120)||!['porcentaje','monto','precio_fijo'].includes(tipo)||!(valor>0)||(tipo==='porcentaje'&&valor>100)) throw error('Datos de promoción inválidos');
  if(!['todos','productos','categorias'].includes(alcance)||(alcance!=='todos'&&!objetivos.length)||!b.inicia||!b.termina||b.termina<b.inicia) throw error('Alcance o vigencia inválidos');
  const [r]=await getPool().query('UPDATE promociones SET nombre=?,tipo=?,valor=?,alcance=?,objetivos=?,cantidad_min=?,inicia=?,termina=?,estado=? WHERE empresa_id=? AND id=?',[texto(b.nombre,120),tipo,valor,alcance,JSON.stringify(objetivos),Math.max(1,Math.trunc(num(b.cantidadMin)||1)),b.inicia,b.termina,b.estado==='inactivo'?'inactivo':'activo',E(req),num(req.params.id)]);
  if(!r.affectedRows) throw error('Promoción no encontrada',404);res.json({ok:true});
}catch(e){fallo(res,e);}});
router.delete('/promociones/:id',...soloAdmin,async(req,res)=>{try{await getPool().query('DELETE FROM promociones WHERE empresa_id=? AND id=?',[E(req),num(req.params.id)]);res.json({ok:true});}catch(e){fallo(res,e);}});

/* ───────── Importación Excel/CSV ───────── */
const encabezados={codigo:'codigo',sku:'codigo',nombre:'nombre',producto:'nombre',categoria:'categoria','categoría':'categoria',descripcion:'descripcion','descripción':'descripcion','precio compra':'precioCompra',costo:'precioCompra','precio venta':'precioVenta',precio:'precioVenta','stock tienda':'stock','publicado':'stock','stock inventario':'stockInventario',inventario:'stockInventario','stock minimo':'stockMin','stock mínimo':'stockMin',marca:'marca',estado:'estado','generar codigo':'generarCodigo'};
function limpioHeader(x){return String(x||'').trim().toLowerCase().replace(/[_-]+/g,' ').replace(/\s+/g,' ');}
function leerCsv(textoCsv){const filas=[],fila=[];let campo='',comillas=false;const pushCampo=()=>{fila.push(campo);campo='';},pushFila=()=>{pushCampo();if(fila.some(x=>String(x).trim()))filas.push(fila.splice(0));else fila.length=0;};for(let i=0;i<textoCsv.length;i++){const ch=textoCsv[i];if(ch==='"'){if(comillas&&textoCsv[i+1]==='"'){campo+='"';i++;}else comillas=!comillas;}else if(ch===','&&!comillas)pushCampo();else if((ch==='\n'||ch==='\r')&&!comillas){if(ch==='\r'&&textoCsv[i+1]==='\n')i++;pushFila();}else campo+=ch;}if(campo.length||fila.length)pushFila();return filas;}
async function leerArchivo(buffer,nombre){
  const datos=/\.csv$/i.test(nombre)?leerCsv(buffer.toString('utf8').replace(/^\uFEFF/,'')):await readSheet(buffer);
  if(!datos.length) throw error('El archivo no contiene filas');
  const headers={};datos[0].forEach((valor,col)=>{const k=encabezados[limpioHeader(valor)];if(k)headers[col]=k;});
  if(!Object.values(headers).includes('nombre')) throw error('La hoja necesita una columna Nombre o Producto');
  const filas=[];
  for(let n=1;n<datos.length&&filas.length<1000;n++){const row=datos[n],x={};for(const [col,k] of Object.entries(headers))x[k]=row[Number(col)]==null?'':String(row[Number(col)]).trim();if(Object.values(x).some(Boolean))filas.push({fila:n+1,codigo:texto(x.codigo,40),nombre:texto(x.nombre,120),categoria:texto(x.categoria,80),descripcion:texto(x.descripcion,1000),precioCompra:num(x.precioCompra),precioVenta:num(x.precioVenta),stock:Math.max(0,Math.trunc(num(x.stock))),stockInventario:Math.max(0,Math.trunc(num(x.stockInventario))),stockMin:Math.max(0,Math.trunc(num(x.stockMin))),marca:texto(x.marca,80),estado:String(x.estado||'activo').toLowerCase()==='inactivo'?'inactivo':'activo',generarCodigo:/^(si|sí|yes|1|true)$/i.test(x.generarCodigo||'')});}
  return filas;
}
router.post('/importaciones/productos/preview',...soloAdmin,upload.single('archivo'),async(req,res)=>{try{if(!req.file)throw error('Selecciona un archivo .xlsx o .csv');if(!/\.(xlsx|csv)$/i.test(req.file.originalname))throw error('Formato no admitido; utiliza .xlsx o .csv');const filas=await leerArchivo(req.file.buffer,req.file.originalname);const errores=[];filas.forEach(x=>{if(!x.nombre)errores.push({fila:x.fila,mensaje:'Falta el nombre'});if(x.precioCompra<0||x.precioVenta<0)errores.push({fila:x.fila,mensaje:'Los precios no pueden ser negativos'});});res.json({filas,errores,total:filas.length});}catch(e){fallo(res,e);}});
router.post('/importaciones/productos/aplicar',...soloAdmin,async(req,res)=>{const c=await getPool().getConnection();try{
  const empresaId=E(req), filas=arr(req.body.filas);if(!filas.length||filas.length>1000)throw error('La importación debe contener entre 1 y 1000 productos');
  await c.beginTransaction();const [cats]=await c.query('SELECT id,nombre FROM categorias WHERE empresa_id=?',[empresaId]);const mapa=new Map(cats.map(x=>[x.nombre.toLowerCase(),x.id]));let creados=0,categoriasCreadas=0;
  for(const f of filas){const nombre=texto(f.nombre,120);if(!nombre)throw error(`Falta el nombre en la fila ${f.fila||'desconocida'}`);let catNombre=texto(f.categoria||'Sin categoría',80),catId=mapa.get(catNombre.toLowerCase());if(!catId){catId=await siguienteId(c,empresaId,'categoria','categorias');await c.query("INSERT INTO categorias (empresa_id,id,nombre,descripcion,estado) VALUES (?,?,?,'Importada desde Excel','activo')",[empresaId,catId,catNombre]);mapa.set(catNombre.toLowerCase(),catId);categoriasCreadas++;}
    const id=await siguienteId(c,empresaId,'producto','productos'), codigo=texto(f.codigo,40)||`PROD-${String(id).padStart(4,'0')}`, barcode=f.generarCodigo?`SWP-${empresaId}-${id}`:null;
    await c.query(`INSERT INTO productos (empresa_id,id,codigo,nombre,categoria_id,descripcion,precio_compra,precio_venta,stock,stock_inventario,stock_min,estado,destacado,publicado_alguna_vez,marca,codigo_barras,variantes,imagenes,tipo_piel)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,0,?,?,?,?,?,?)`,[empresaId,id,codigo,nombre,catId,texto(f.descripcion,1000),Math.max(0,num(f.precioCompra)),Math.max(0,num(f.precioVenta)),Math.max(0,Math.trunc(num(f.stock))),Math.max(0,Math.trunc(num(f.stockInventario))),Math.max(0,Math.trunc(num(f.stockMin))),f.estado==='inactivo'?'inactivo':'activo',num(f.stock)>0?1:0,texto(f.marca,80),barcode,JSON.stringify([]),JSON.stringify([]),JSON.stringify([])]);creados++;}
  await c.query('UPDATE app_meta SET version=version+1 WHERE empresa_id=?',[empresaId]);await c.commit();res.status(201).json({ok:true,creados,categoriasCreadas});
}catch(e){await c.rollback().catch(()=>{});fallo(res,e);}finally{c.release();}});

/* ───────── Recordatorios internos de cobro ───────── */
router.get('/notificaciones',...lecturaNegocio,async(req,res)=>{try{
  const empresaId=E(req);const [rows]=await getPool().query(`SELECT c.id,c.cliente_nombre,c.concepto,c.vence,c.monto-COALESCE(SUM(a.monto),0) saldo,l.leido_at
    FROM creditos c LEFT JOIN abonos a ON a.empresa_id=c.empresa_id AND a.credito_id=c.id
    LEFT JOIN notificacion_lecturas l ON l.empresa_id=c.empresa_id AND l.user_id=? AND l.clave=CONCAT('cobro:',c.id,':',COALESCE(c.vence,''))
    WHERE c.empresa_id=? AND c.estado='pendiente' AND c.vence IS NOT NULL AND c.vence<=DATE_ADD(CURDATE(),INTERVAL 3 DAY)
    GROUP BY c.id,c.cliente_nombre,c.concepto,c.vence,c.monto,l.leido_at HAVING saldo>0 ORDER BY c.vence`,[req.user.id,empresaId]);
  const notificaciones=rows.map(x=>({clave:`cobro:${x.id}:${x.vence||''}`,tipo:x.vence<hoy()?'vencida':'proxima',titulo:x.vence<hoy()?'Cuenta vencida':'Cobro próximo',texto:`${x.cliente_nombre} debe ${num(x.saldo).toFixed(2)} · ${x.concepto||'Cuenta por cobrar'}`,vence:x.vence,creditoId:x.id,leida:!!x.leido_at}));res.json({notificaciones,noLeidas:notificaciones.filter(x=>!x.leida).length});
}catch(e){fallo(res,e);}});
router.put('/notificaciones/:clave/leida',...soloAdmin,async(req,res)=>{try{await getPool().query('INSERT INTO notificacion_lecturas (empresa_id,user_id,clave,leido_at) VALUES (?,?,?,NOW()) ON DUPLICATE KEY UPDATE leido_at=NOW()',[E(req),req.user.id,texto(req.params.clave,120)]);res.json({ok:true});}catch(e){fallo(res,e);}});

/* ───────── Módulo gastronómico ───────── */
router.get('/gastronomia',...lecturaNegocio,async(req,res)=>{try{const empresaId=E(req),p=getPool();const [mesas]=await p.query('SELECT * FROM mesas WHERE empresa_id=? ORDER BY id',[empresaId]);const [comandas]=await p.query("SELECT * FROM comandas WHERE empresa_id=? AND estado NOT IN ('cerrada','cancelada') ORDER BY id DESC",[empresaId]);const [items]=comandas.length?await p.query('SELECT * FROM comanda_items WHERE empresa_id=? AND comanda_id IN (?) ORDER BY id',[empresaId,comandas.map(x=>x.id)]):[[]];res.json({mesas,comandas:comandas.map(x=>({...x,total:num(x.total),items:items.filter(i=>i.comanda_id===x.id).map(i=>({...i,precio:num(i.precio),subtotal:num(i.subtotal)}))}))});}catch(e){fallo(res,e);}});
router.post('/gastronomia/mesas',...soloAdmin,async(req,res)=>{const c=await getPool().getConnection();try{const empresaId=E(req),nombre=texto(req.body.nombre,80);if(!nombre)throw error('Escribe el nombre de la mesa');await c.beginTransaction();const id=await siguienteId(c,empresaId,'mesa','mesas');await c.query("INSERT INTO mesas (empresa_id,id,nombre,capacidad,estado) VALUES (?,?,?,?, 'libre')",[empresaId,id,nombre,Math.max(1,Math.trunc(num(req.body.capacidad)||2))]);await c.commit();res.status(201).json({ok:true,id});}catch(e){await c.rollback().catch(()=>{});fallo(res,e);}finally{c.release();}});
router.patch('/gastronomia/mesas/:id',...soloAdmin,async(req,res)=>{try{const estado=texto(req.body.estado,12);if(estado&&!['libre','ocupada','inactiva'].includes(estado))throw error('Estado inválido');const campos=[],vals=[];if(texto(req.body.nombre,80)){campos.push('nombre=?');vals.push(texto(req.body.nombre,80));}if(req.body.capacidad!=null){campos.push('capacidad=?');vals.push(Math.max(1,Math.trunc(num(req.body.capacidad))));}if(estado){campos.push('estado=?');vals.push(estado);}if(!campos.length)throw error('No hay cambios');vals.push(E(req),num(req.params.id));await getPool().query(`UPDATE mesas SET ${campos.join(',')} WHERE empresa_id=? AND id=?`,vals);res.json({ok:true});}catch(e){fallo(res,e);}});
router.post('/gastronomia/comandas',...soloAdmin,async(req,res)=>{const c=await getPool().getConnection();try{const empresaId=E(req),tipo=req.body.tipo==='llevar'?'llevar':'mesa',mesaId=tipo==='mesa'?num(req.body.mesaId):null;await c.beginTransaction();if(tipo==='mesa'){const [[m]]=await c.query("SELECT * FROM mesas WHERE empresa_id=? AND id=? AND estado='libre' FOR UPDATE",[empresaId,mesaId]);if(!m)throw error('La mesa no está disponible',409);}const id=await siguienteId(c,empresaId,'comanda','comandas'),numero=`COM-${String(id).padStart(4,'0')}`;await c.query("INSERT INTO comandas (empresa_id,id,numero,mesa_id,tipo,cliente_nombre,estado,total,notas,abierta_at) VALUES (?,?,?,?,?,?,'abierta',0,?,?)",[empresaId,id,numero,mesaId,tipo,texto(req.body.clienteNombre,120)||null,texto(req.body.notas,255)||null,ahoraMysql()]);if(mesaId)await c.query("UPDATE mesas SET estado='ocupada' WHERE empresa_id=? AND id=?",[empresaId,mesaId]);await c.commit();res.status(201).json({ok:true,id,numero});}catch(e){await c.rollback().catch(()=>{});fallo(res,e);}finally{c.release();}});
router.post('/gastronomia/comandas/:id/items',...soloAdmin,async(req,res)=>{const c=await getPool().getConnection();try{const empresaId=E(req),comandaId=num(req.params.id),productoId=num(req.body.productoId),cantidad=Math.max(1,Math.trunc(num(req.body.cantidad)||1));await c.beginTransaction();const [[com]]=await c.query("SELECT * FROM comandas WHERE empresa_id=? AND id=? AND estado IN ('abierta','enviada','preparando') FOR UPDATE",[empresaId,comandaId]);if(!com)throw error('La comanda no admite más productos',409);const [[p]]=await c.query("SELECT * FROM productos WHERE empresa_id=? AND id=? AND estado='activo'",[empresaId,productoId]);if(!p)throw error('Producto no disponible');let variante=null;if(texto(req.body.varianteId,80)){variante=variantesDe(p).find(v=>String(v.id)===String(req.body.varianteId)&&v.activo!==false);if(!variante)throw error('Variante no disponible');}else if(variantesDe(p).length)throw error('Selecciona una variante');const precio=num(variante?variante.precioVenta:p.precio_venta),subtotal=+(precio*cantidad).toFixed(2);await c.query("INSERT INTO comanda_items (empresa_id,comanda_id,producto_id,variante_id,variante_nombre,nombre,cantidad,precio,subtotal,nota,estado) VALUES (?,?,?,?,?,?,?,?,?,?, 'pendiente')",[empresaId,comandaId,p.id,variante&&variante.id||null,nombreVariante(variante)||null,p.nombre,cantidad,precio,subtotal,texto(req.body.nota,180)||null]);await c.query('UPDATE comandas SET total=(SELECT COALESCE(SUM(subtotal),0) FROM comanda_items WHERE empresa_id=? AND comanda_id=?) WHERE empresa_id=? AND id=?',[empresaId,comandaId,empresaId,comandaId]);await c.commit();res.status(201).json({ok:true});}catch(e){await c.rollback().catch(()=>{});fallo(res,e);}finally{c.release();}});
router.patch('/gastronomia/comandas/:id/estado',...soloAdmin,async(req,res)=>{try{const estado=texto(req.body.estado,16);if(!['enviada','preparando','lista','cancelada'].includes(estado))throw error('Estado de comanda inválido');const empresaId=E(req),id=num(req.params.id);await getPool().query('UPDATE comandas SET estado=? WHERE empresa_id=? AND id=? AND estado NOT IN (\'cerrada\',\'cancelada\')',[estado,empresaId,id]);if(estado==='cancelada')await getPool().query("UPDATE mesas m JOIN comandas c ON c.empresa_id=m.empresa_id AND c.mesa_id=m.id SET m.estado='libre' WHERE c.empresa_id=? AND c.id=?",[empresaId,id]);res.json({ok:true});}catch(e){fallo(res,e);}});
router.patch('/gastronomia/items/:id/estado',...soloAdmin,async(req,res)=>{try{const estado=texto(req.body.estado,16);if(!['pendiente','preparando','listo','servido'].includes(estado))throw error('Estado inválido');await getPool().query('UPDATE comanda_items SET estado=? WHERE empresa_id=? AND id=?',[estado,E(req),num(req.params.id)]);res.json({ok:true});}catch(e){fallo(res,e);}});
router.post('/gastronomia/comandas/:id/cerrar',...soloAdmin,async(req,res)=>{const c=await getPool().getConnection();try{const empresaId=E(req),id=num(req.params.id),metodo=texto(req.body.metodoPago||'efectivo',24);if(!['efectivo','transferencia','otro'].includes(metodo))throw error('Método de pago inválido');await c.beginTransaction();const turno=await turnoAbierto(c,empresaId,true);if(!turno)throw error('Abre un turno de caja antes de cobrar',409);const [[com]]=await c.query("SELECT * FROM comandas WHERE empresa_id=? AND id=? AND estado NOT IN ('cerrada','cancelada') FOR UPDATE",[empresaId,id]);if(!com)throw error('Comanda no disponible',409);const [items]=await c.query('SELECT * FROM comanda_items WHERE empresa_id=? AND comanda_id=? FOR UPDATE',[empresaId,id]);if(!items.length)throw error('La comanda está vacía');const promos=await promocionesVigentes(c,empresaId),calculadas=[];for(const it of items)calculadas.push(await resolverLinea(c,empresaId,{productoId:it.producto_id,varianteId:it.variante_id,cantidad:it.cantidad,permitirInventario:!!req.body.permitirInventario},promos,true));const total=+calculadas.reduce((s,x)=>s+x.subtotal,0).toFixed(2),ticket=`GAS-${com.numero}`;for(const x of calculadas){const ventaId=await siguienteId(c,empresaId,'venta','ventas');await c.query(`INSERT INTO ventas (empresa_id,id,producto_id,cliente_nombre,estado,origen_stock,stock_tienda_usado,stock_inventario_usado,ticket,variante_id,variante_nombre,metodo_pago,turno_caja_id,cantidad,precio,fecha,total) VALUES (?,?,?,?,'activa',?,?,?,?,?,?,?,?,?,?,?,?)`,[empresaId,ventaId,x.producto.id,com.cliente_nombre||'Cliente restaurante',x.usaInventario?(x.usaTienda?'mixto':'inventario'):'tienda',x.usaTienda,x.usaInventario,ticket,x.variante&&x.variante.id||null,nombreVariante(x.variante)||null,metodo,turno.id,x.cantidad,x.precio,hoy(),x.subtotal]);}await insertarMovimientoCaja(c,empresaId,turno,'venta',metodo,total,`Comanda ${com.numero}`,ticket,req.user.id);await c.query("UPDATE comandas SET estado='cerrada',total=?,cerrada_at=? WHERE empresa_id=? AND id=?",[total,ahoraMysql(),empresaId,id]);if(com.mesa_id)await c.query("UPDATE mesas SET estado='libre' WHERE empresa_id=? AND id=?",[empresaId,com.mesa_id]);await c.query('UPDATE app_meta SET version=version+1 WHERE empresa_id=?',[empresaId]);await c.commit();res.json({ok:true,ticket,total});}catch(e){await c.rollback().catch(()=>{});fallo(res,e);}finally{c.release();}});

module.exports = router;
