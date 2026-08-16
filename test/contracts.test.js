const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { imagenWebValida } = require('../server');

const raiz = path.resolve(__dirname, '..');
const front = path.resolve(raiz, '..', 'SIWEPEE-main');
const pages = path.join(front, 'pages');
const leer = p => fs.readFileSync(p, 'utf8');

test('la validación de imágenes rechaza SVG y esquemas ejecutables', () => {
  assert.equal(imagenWebValida('https://cdn.example.com/producto.webp'), true);
  assert.equal(imagenWebValida('data:image/png;base64,aGVsbG8='), true);
  assert.equal(imagenWebValida('data:image/svg+xml;base64,PHN2Zz4='), false);
  assert.equal(imagenWebValida('javascript:alert(1)'), false);
});

test('el catálogo público no devuelve costo ni stock mínimo', () => {
  const server = leer(path.join(raiz, 'server.js'));
  assert.match(server, /const \{ precio_compra, stock_inventario, stock_min, publicado_alguna_vez, \.\.\.publico \} = mapProducto\(r\)/);
  assert.match(server, /estado='activo'/);
});

test('el estado completo exige admin, revisión y control de conflictos', () => {
  const server = leer(path.join(raiz, 'server.js'));
  assert.match(server, /app\.put\('\/api\/state', requireAuth, requireRole\('admin'\)/);
  assert.match(server, /_revision/);
  assert.match(server, /status\(409\)/);
});

test('la tienda usa autenticación global y checkout dedicado', () => {
  const tienda = leer(path.join(front, 'assets', 'js', 'tienda', 'main.js'));
  const checkout = leer(path.join(front, 'assets', 'js', 'commerce', 'checkout.js'));
  const datos = leer(path.join(front, 'assets', 'js', 'shared', 'data.js'));
  const html = leer(path.join(pages, 'tienda.html'));
  assert.match(tienda, /apiPost\('\/api\/auth\/login'/);
  assert.match(checkout, /apiPostAuth\('\/api\/pedidos\/checkout'/);
  assert.match(tienda, /siwepeCart\.deEmpresa/);
  assert.match(datos, /apiGet\('\/api\/clientes\/mi'/);
  assert.match(datos, /qs\.get\('e'\) \|\| qs\.get\('empresa'\) \|\| qs\.get\('tienda'\)/);
  assert.doesNotMatch(tienda, /cliente-login/);
  assert.doesNotMatch(tienda, /Esta cuenta no es una cuenta de cliente/);
  assert.match(html, /Acceso para tus compras/);
  assert.match(html, /Clientes y administradores pueden comprar/);
  assert.match(html, /Panel Administrador/);
  assert.match(html, /siwepe-logo\.png/);
  assert.match(html, /Una cuenta\.[\s\S]*Todas tus tiendas\./);
  assert.match(html, /id="sw-tienda-contexto"/);
  assert.match(html, /aria-label="Regresar a la tienda"/);
  assert.match(html, /data\.js\?v=\d/);
  assert.match(html, /main\.js\?v=\d/);
});

test('todas las páginas principales cargan la identidad institucional', () => {
  for (const nombre of ['index.html','descubrir.html','terminos.html','tienda.html','admin.html']) {
    const html = leer(path.join(pages, nombre));
    assert.match(html, /siwepe-mark\.png/, nombre);
    assert.match(html, /platform\.css/, nombre);
  }
  const perfil = leer(path.join(pages, 'perfil.html'));
  assert.match(perfil, /siwepe-mark\.png/);
  assert.match(perfil, /perfil\.css/);
});

test('los flujos principales conservan navegación y controles responsive', () => {
  const tiendaCss = leer(path.join(front, 'assets', 'css', 'tienda.css'));
  const adminCss = leer(path.join(front, 'assets', 'css', 'admin.css'));
  const plataformaCss = leer(path.join(front, 'assets', 'css', 'platform.css'));
  const tiendaHtml = leer(path.join(pages, 'tienda.html'));
  assert.match(tiendaCss, /\.t-header-nav\{display:flex;position:fixed/);
  assert.match(tiendaCss, /grid-template-columns:repeat\(2,minmax\(0,1fr\)\)/);
  assert.match(adminCss, /\.modal-overlay\{align-items:flex-end;padding:0/);
  assert.match(adminCss, /\.table-wrap table\{min-width:680px/);
  assert.match(plataformaCss, /\.nav-btn\.ghost\{display:inline-flex!important\}/);
  assert.match(tiendaHtml, /orientation:landscape/);
});

test('el esquema conserva trazabilidad de ventas y versión optimista', () => {
  const schema = leer(path.join(raiz, 'schema.sql'));
  assert.match(schema, /version\s+INT\s+NOT NULL DEFAULT 0/i);
  assert.match(schema, /pedido_id\s+INT/i);
  assert.match(schema, /estado\s+VARCHAR\(12\)\s+NOT NULL DEFAULT 'activa'/i);
});

test('galería, cuenta global e imágenes múltiples están conectadas de extremo a extremo', () => {
  const schema = leer(path.join(raiz, 'schema.sql'));
  const server = leer(path.join(raiz, 'server.js'));
  const datos = leer(path.join(front, 'assets', 'js', 'shared', 'data.js'));
  const tienda = leer(path.join(front, 'assets', 'js', 'tienda', 'main.js'));
  const admin = leer(path.join(front, 'assets', 'js', 'admin', 'main.js'));
  const tiendaHtml = leer(path.join(pages, 'tienda.html'));
  const adminHtml = leer(path.join(pages, 'admin.html'));
  assert.match(schema, /galeria\s+JSON/i);
  assert.match(schema, /imagenes\s+JSON/i);
  assert.match(server, /Cada producto admite hasta 6 imágenes/);
  assert.match(server, /La galería admite hasta 12 imágenes/);
  assert.match(server, /COALESCE\(pr\.imagen/);
  assert.match(datos, /DB\.config\.galeria/);
  assert.match(datos, /p\.imagenes/);
  assert.match(tienda, /function renderGaleriaTienda/);
  assert.match(tienda, /function cambiarImagenDetalle/);
  assert.match(admin, /function renderGaleriaAdmin/);
  assert.match(admin, /apiPut\('\/api\/galeria'/);
  assert.match(admin, /window\.__fpImgs/);
  assert.match(tiendaHtml, /id="tp-cuenta"/);
  assert.match(tiendaHtml, /id="tp-galeria"/);
  assert.match(tiendaHtml, /data-page="galeria"/);
  assert.match(adminHtml, /id="page-galeria"/);
});

test('la agenda manual de clientes queda aislada por empresa y no crea cuentas globales', () => {
  const schema = leer(path.join(raiz, 'schema.sql'));
  const server = leer(path.join(raiz, 'server.js'));
  const admin = leer(path.join(front, 'assets', 'js', 'admin', 'main.js'));
  const adminHtml = leer(path.join(pages, 'admin.html'));
  assert.match(schema, /CREATE TABLE IF NOT EXISTS clientes_empresa/i);
  assert.match(server, /app\.post\('\/api\/clientes-manuales', requireAuth, requireRole\('admin'\)/);
  assert.match(server, /WHERE empresa_id=\? AND id=\?/);
  assert.match(server, /origen:'manual'/);
  assert.match(admin, /function openFormClienteManual/);
  assert.match(admin, /apiPostAuth\('\/api\/clientes-manuales'/);
  assert.match(adminHtml, /Registrar cliente/);
});

test('el logo SIWEPE de la tienda vuelve al marketplace sin ejecutar cierre de sesión', () => {
  const tiendaHtml = leer(path.join(pages, 'tienda.html'));
  const tienda = leer(path.join(front, 'assets', 'js', 'tienda', 'main.js'));
  assert.match(tiendaHtml, /class="t-siwepe-home" href="index\.html"/);
  assert.match(tiendaHtml, /aria-label="Ir al inicio de SIWEPE"/);
  assert.doesNotMatch(tiendaHtml, /t-siwepe-home[^>]+onclick="salirTienda/);
  assert.match(tienda, /if\(page==='galeria'\)\s+renderGaleriaTienda/);
});

test('el portal de cliente conecta perfil, direcciones, seguridad y seguimiento global', () => {
  const schema = leer(path.join(raiz, 'schema.sql'));
  const server = leer(path.join(raiz, 'server.js'));
  const perfilHtml = leer(path.join(pages, 'perfil.html'));
  const perfilJs = leer(path.join(front, 'assets', 'js', 'perfil', 'main.js'));
  const tienda = leer(path.join(front, 'assets', 'js', 'tienda', 'main.js'));
  assert.match(schema, /direcciones\s+JSON/i);
  assert.match(schema, /direccion_entrega\s+VARCHAR/i);
  assert.match(server, /\/api\/clientes\/mi\/password/);
  assert.match(server, /normalizarDirecciones/);
  assert.match(perfilHtml, /data-view="pedidos"/);
  assert.match(perfilHtml, /data-view="direcciones"/);
  assert.match(perfilHtml, /data-view="seguridad"/);
  assert.match(perfilJs, /apiGet\('\/api\/mis-pedidos'/);
  assert.match(perfilJs, /function showOrder/);
  assert.match(tienda, /location\.href=`perfil\.html/);
});

test('carrito, checkout, confirmación y gestión de pedidos forman un flujo completo', () => {
  const server=leer(path.join(raiz,'server.js'));
  const data=leer(path.join(front,'assets','js','shared','data.js'));
  const cart=leer(path.join(front,'assets','js','commerce','cart.js'));
  const checkout=leer(path.join(front,'assets','js','commerce','checkout.js'));
  const perfil=leer(path.join(front,'assets','js','perfil','main.js'));
  const admin=leer(path.join(front,'assets','js','admin','main.js'));
  assert.match(data,/SIWEPE_CART_KEY/);
  assert.match(data,/empresa_id:Number\(x\.empresa_id\)/);
  assert.match(cart,/siwepeCart\.update/);
  assert.match(checkout,/entrega,detallePago/);
  assert.match(checkout,/siwepeCart\.clearEmpresa/);
  assert.match(server,/pago_estado/);
  assert.match(server,/preparando','listo','enviado/);
  assert.match(server,/mensajes\/admin/);
  assert.match(perfil,/Novedades del pedido/);
  assert.match(admin,/function verPedidoAdmin/);
  assert.match(admin,/function imprimirPedidoAdmin/);
});

test('el registro de empresa guía por tipo, categoría y descripción persistente', () => {
  const schema = leer(path.join(raiz, 'schema.sql'));
  const server = leer(path.join(raiz, 'server.js'));
  const index = leer(path.join(pages, 'index.html'));
  const admin = leer(path.join(front, 'assets', 'js', 'admin', 'main.js'));
  assert.match(schema, /tipos_negocio\s+JSON/i);
  assert.match(server, /normalizarTiposNegocio/);
  assert.match(index, /¿Qué vende tu negocio\?/);
  assert.match(index, /¿Cuál es la categoría de tu negocio\?/);
  assert.match(index, /CATEGORIAS_REGISTRO/);
  assert.match(index, /tiposNegocio:wzTipos/);
  assert.match(index, /Paso \$\{wzPaso\} de 5/);
  assert.match(admin, /perfil\.tiposNegocio/);
});

test('cada correo conserva una sola identidad y un rol estable', () => {
  const schema=leer(path.join(raiz,'schema.sql'));
  const db=leer(path.join(raiz,'db.js'));
  const server=leer(path.join(raiz,'server.js'));
  assert.match(schema, /email\s+VARCHAR\(120\) UNIQUE/i);
  assert.doesNotMatch(schema, /uq_users_email_role/i);
  assert.match(db, /_migrarCuentaUnicaPorCorreo/);
  assert.match(db, /UPDATE pedidos SET cliente_id=\?/);
  assert.match(db, /UPDATE ventas SET cliente_id=\?/);
  assert.match(server, /SELECT \* FROM users WHERE email=\? AND activo=1 LIMIT 1/);
  assert.match(server, /Esta cuenta es de cliente y no tiene acceso administrativo/);
  assert.match(server, /SELECT id FROM users WHERE email=\? LIMIT 1/);
});

test('el administrador puede comprar sin cambiar de rol ni abrir administración ajena', () => {
  const server=leer(path.join(raiz,'server.js'));
  const datos=leer(path.join(front,'assets','js','shared','data.js'));
  const adminMain=leer(path.join(front,'assets','js','admin','main.js'));
  const tiendaMain=leer(path.join(front,'assets','js','tienda','main.js'));
  const perfilMain=leer(path.join(front,'assets','js','perfil','main.js'));
  assert.match(server, /portal==='compras'[\s\S]{0,90}\['cliente','admin'\]/);
  assert.match(server, /app\.get\('\/api\/clientes\/mi', requireAuth, requireRole\('cliente','admin'\)/);
  assert.match(server, /app\.post\('\/api\/pedidos\/checkout', limitarIntentos\([^)]*\), requireAuth, requireRole\('cliente','admin'\)/);
  assert.match(datos, /role==='admin'&&opts&&opts\.asBuyer/);
  assert.match(tiendaMain, /portal:'compras'/);
  assert.match(tiendaMain, /bootstrapDB\(\{asBuyer:true\}\)/);
  assert.match(perfilMain, /\['cliente','admin'\]\.includes\(bsRole\(\)\)/);
  assert.match(adminMain, /portal:'admin'/);
});

test('la activación de empresa abre el panel con un código de sesión de un solo uso', () => {
  const schema=leer(path.join(raiz,'schema.sql'));
  const server=leer(path.join(raiz,'server.js'));
  const adminMain=leer(path.join(front,'assets','js','admin','main.js'));
  assert.match(schema, /CREATE TABLE IF NOT EXISTS onboarding_sessions/i);
  assert.match(server, /\/api\/auth\/onboarding/);
  assert.match(server, /o\.used_at IS NULL AND o\.expires_at>NOW\(\)/);
  assert.match(server, /onboarding=\$\{encodeURIComponent\(codigo\)\}/);
  assert.match(adminMain, /apiPost\('\/api\/auth\/onboarding'/);
});

test('el onboarding limita las categorías a dos y conserva una principal compatible', () => {
  const schema=leer(path.join(raiz,'schema.sql'));
  const server=leer(path.join(raiz,'server.js'));
  const index=leer(path.join(pages, 'index.html'));
  assert.match(schema, /rubros\s+JSON/i);
  assert.match(server, /rubros\.length>2/);
  assert.match(index, /Máximo 2 categorías/);
  assert.match(index, /rubros:rubrosFinales\(\)/);
  assert.doesNotMatch(index, /data-tipo="Servicios"/);
});

test('el acceso administrativo y el footer empresarial usan identidad y contacto público', () => {
  const schema = leer(path.join(raiz, 'schema.sql'));
  const server = leer(path.join(raiz, 'server.js'));
  const datos = leer(path.join(front, 'assets', 'js', 'shared', 'data.js'));
  const tienda = leer(path.join(front, 'assets', 'js', 'tienda', 'main.js'));
  const tiendaHtml = leer(path.join(pages, 'tienda.html'));
  const adminHtml = leer(path.join(pages, 'admin.html'));
  assert.match(schema, /contacto_publico\s+VARCHAR/i);
  assert.match(schema, /correo_publico\s+VARCHAR/i);
  assert.match(server, /contactoPublico:\s*empresa\.contacto_publico/);
  assert.match(datos, /DB\.empresa=(?:catalogo|data)\.empresa/);
  assert.match(tienda, /function renderFooterEmpresa/);
  assert.match(tiendaHtml, /id="t-company-footer"/);
  assert.match(adminHtml, /class="admin-login-shell"/);
  assert.match(adminHtml, /id="perfil-contacto"/);
  assert.match(adminHtml, /id="perfil-correo-publico"/);
  assert.doesNotMatch(tiendaHtml, /class="powered-by-siwepe"/);
});

test('el login administrativo no revive una versión anterior desde caché o historial', () => {
  const adminHtml=leer(path.join(pages, 'admin.html'));
  const adminMain=leer(path.join(front,'assets','js','admin','main.js'));
  const index=leer(path.join(pages, 'index.html'));
  assert.match(adminHtml,/Cache-Control[^>]*no-cache, no-store/i);
  assert.match(adminHtml,/addEventListener\('pageshow'/);
  assert.match(adminHtml,/ev\.persisted/);
  assert.match(adminMain,/location\.replace\(destino\.href\)/);
  assert.doesNotMatch(adminMain,/function cerrarSesionAdmin\(\)[\s\S]{0,260}location\.reload\(\)/);
  assert.match(index,/admin\.html\?login=1&amp;v=20260813\.12/);
});

test('compras, inventario publicado y ventas directas conservan trazabilidad separada', () => {
  const schema=leer(path.join(raiz,'schema.sql'));
  const db=leer(path.join(raiz,'db.js'));
  const server=leer(path.join(raiz,'server.js'));
  const adminHtml=leer(path.join(pages, 'admin.html'));
  const adminMain=leer(path.join(front,'assets','js','admin','main.js'));
  assert.match(schema,/stock_inventario\s+INT/i);
  assert.match(schema,/origen_stock\s+VARCHAR/i);
  assert.match(db,/function _migrarInventarioEstricto/);
  assert.match(server,/app\.post\('\/api\/inventario\/compras'/);
  assert.match(server,/app\.post\('\/api\/inventario\/transferir'/);
  assert.match(server,/app\.post\('\/api\/ventas\/directas'/);
  assert.match(server,/requiereConfirmacion:true/);
  assert.match(adminHtml,/id="page-inventario"/);
  assert.match(adminHtml,/data-page="inventario"/);
  assert.match(adminMain,/function renderInventario/);
  assert.match(adminMain,/confirmarInventario/);
});

test('los formularios conservan datos, aceptan precio cero y proveedores rápidos', () => {
  const schema=leer(path.join(raiz,'schema.sql'));
  const db=leer(path.join(raiz,'db.js'));
  const server=leer(path.join(raiz,'server.js'));
  const adminHtml=leer(path.join(pages, 'admin.html'));
  const adminMain=leer(path.join(front,'assets','js','admin','main.js'));
  const adminCss=leer(path.join(front,'assets','css','admin.css'));
  assert.match(schema,/origen\s+VARCHAR\(20\).*no_registrado/i);
  assert.match(db,/function _migrarOrigenProveedores/);
  assert.match(server,/proveedorNombre/);
  assert.match(server,/proveedorCreado/);
  assert.match(adminHtml,/data-prov-view="no_registrado"/);
  assert.match(adminMain,/function precioVacioEnCero/);
  assert.match(adminMain,/numVacioCero/);
  assert.match(adminMain,/quickCategoryPanel\('fc'\)/);
  assert.match(adminMain,/quickCategoryPanel\('fv'\)/);
  assert.match(adminCss,/\[hidden\]\{display:none!important\}/);
  assert.doesNotMatch(adminMain,/modal-overlay'\)\?\.addEventListener\('click'/);
  assert.doesNotMatch(adminMain,/btn-ghost[^\n]+closeModal/);
});

test('editar un producto permite repartir existencias entre tienda e inventario', () => {
  const adminMain=leer(path.join(front,'assets','js','admin','main.js'));
  assert.match(adminMain,/const totalExistencias=p\?\(\+p\.stock\|\|0\)\+\(\+p\.stock_inventario\|\|0\):0/);
  assert.match(adminMain,/id="fp-stock"[^>]+max="\$\{totalExistencias\}"/);
  assert.match(adminMain,/\$\('#fp-stock-inv'\)\.value=totalExistencias-publicado/);
  assert.match(adminMain,/Inventario → tienda · edición de producto/);
  assert.match(adminMain,/Tienda → inventario · edición de producto/);
});

test('la galería aplica límites de cantidad y peso en cliente y servidor', () => {
  const server=leer(path.join(raiz,'server.js'));
  const adminHtml=leer(path.join(pages, 'admin.html'));
  const adminMain=leer(path.join(front,'assets','js','admin','main.js'));
  assert.match(server,/galeria\.length>12/);
  assert.match(server,/22\*1024\*1024/);
  assert.match(adminHtml,/Hasta 12 fotos/);
  assert.match(adminHtml,/6 MB/);
  assert.match(adminMain,/file\.size>6\*1024\*1024/);
  assert.match(adminMain,/pesoEstimado>20\*1024\*1024/);
});

test('la navegación del panel queda vinculada antes de cualquier retorno del login', () => {
  const adminMain=leer(path.join(front,'assets','js','admin','main.js'));
  const init=adminMain.indexOf("document.addEventListener('DOMContentLoaded'");
  const bind=adminMain.indexOf('vincularControlesAdmin();',init);
  const loginReturn=adminMain.indexOf("get('login')",init);
  assert.ok(bind>init && bind<loginReturn);
  assert.match(adminMain,/Acción bloqueada en esta pestaña/);
});

test('la portada renovada ofrece categorías, footer completo y países ampliados', () => {
  const index=leer(path.join(pages, 'index.html'));
  assert.match(index,/class="home-category-grid"/);
  assert.match(index,/class="mega-footer footer"/);
  assert.match(index,/Ropa y calzado/);
  assert.match(index,/República Dominicana/);
  assert.match(index,/Argentina/);
  assert.match(index,/Alemania/);
  assert.doesNotMatch(index,/Una base seria para vender y crecer/);
});

test('los scripts inline de las páginas tienen sintaxis válida', () => {
  for (const nombre of ['index.html','descubrir.html','terminos.html','tienda.html','admin.html','perfil.html','carrito.html','checkout.html']) {
    const html = leer(path.join(pages, nombre));
    const scripts = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)].map(m => m[1]);
    for (const codigo of scripts) assert.doesNotThrow(() => new Function(codigo), `${nombre}: script inline inválido`);
  }
});

test('los recursos locales referenciados por las páginas existen', () => {
  for (const nombre of ['index.html','descubrir.html','terminos.html','tienda.html','admin.html','perfil.html','carrito.html','checkout.html']) {
    const html = leer(path.join(pages, nombre));
    const refs = [...html.matchAll(/(?:src|href)="([^"]+)"/gi)].map(m => m[1])
      .filter(x => !x.includes('${') && !/^(?:https?:|data:|mailto:|#|javascript:)/i.test(x))
      .map(x => x.split(/[?#]/)[0]).filter(Boolean);
    for (const ref of refs) assert.equal(fs.existsSync(path.resolve(pages, ref)), true, `${nombre}: falta ${ref}`);
  }
});
