const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { dataUri } = require('../media');

test('R2 acepta imágenes web permitidas y rechaza contenido ejecutable', () => {
  const png = dataUri('data:image/png;base64,aG9sYQ==');
  assert.equal(png.mime, 'image/png');
  assert.equal(png.extension, 'png');
  assert.equal(png.body.toString(), 'hola');
  assert.equal(dataUri('data:image/svg+xml;base64,PHN2Zz48L3N2Zz4='), null);
});

test('R2 publica sólo material comercial y no comprobantes privados', () => {
  const media = fs.readFileSync(path.join(__dirname, '..', 'media.js'), 'utf8');
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.match(media, /public\/empresas\//);
  assert.match(server, /persistirImagenWeb\(g\.imagen,\{empresaId:E,carpeta:'galeria'\}\)/);
  assert.match(server, /materializar\(p\.imagen,'productos'\)/);
  assert.doesNotMatch(server, /persistirImagenWeb\([^\n]+comprobantes/);
  assert.doesNotMatch(server, /materializar\(p\.comprobante/);
});

test('el logo se sube sólo cuando la empresa ya tiene un identificador', () => {
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const registro = server.slice(
    server.indexOf("app.post('/api/empresas'"),
    server.indexOf("app.get('/api/empresas'", server.indexOf("app.post('/api/empresas'")),
  );
  assert.doesNotMatch(registro, /persistirImagenWeb/);
  assert.match(server, /const empresaId = ins\.insertId;\s*const logoFinal = await persistirImagenWeb\(r\.logo/);
  assert.match(server, /app\.put\('\/api\/empresas\/mi'[\s\S]+const logoFinal = await persistirImagenWeb\(logo, \{ empresaId/);
});
