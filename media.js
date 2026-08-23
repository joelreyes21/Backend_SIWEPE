/*! SIWEPE · almacenamiento de imágenes en Cloudflare R2 */
const crypto = require('crypto');
const { S3Client, PutObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const sharp = require('sharp');

const TIPOS = Object.freeze({
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
});
const MAX_INPUT_BYTES = 4 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 500 * 1024;
const MAX_DIMENSION = 1920;

let cliente;
let avisoPendienteMostrado = false;

function configuracion() {
  const cfg = {
    accessKeyId: String(process.env.R2_ACCESS_KEY_ID || '').trim(),
    secretAccessKey: String(process.env.R2_SECRET_ACCESS_KEY || '').trim(),
    endpoint: String(process.env.R2_ENDPOINT || '').trim().replace(/\/$/, ''),
    bucket: String(process.env.R2_BUCKET_NAME || '').trim(),
    region: String(process.env.R2_REGION || 'auto').trim() || 'auto',
    publicBaseUrl: String(process.env.R2_PUBLIC_BASE_URL || '').trim().replace(/\/$/, ''),
  };
  const credenciales = !!(cfg.accessKeyId && cfg.secretAccessKey && cfg.endpoint && cfg.bucket);
  return { ...cfg, credenciales, listo: !!(credenciales && cfg.publicBaseUrl) };
}

function obtenerCliente(cfg = configuracion()) {
  if (!cfg.credenciales) return null;
  if (!cliente) {
    cliente = new S3Client({
      region: cfg.region,
      endpoint: cfg.endpoint,
      credentials: { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey },
    });
  }
  return cliente;
}

function dataUri(v) {
  if (typeof v !== 'string') return null;
  const m = /^data:(image\/(?:png|jpe?g|webp|gif));base64,([a-z0-9+/=\r\n]+)$/i.exec(v);
  if (!m) return null;
  const mime = m[1].toLowerCase() === 'image/jpg' ? 'image/jpeg' : m[1].toLowerCase();
  const body = Buffer.from(m[2].replace(/\s/g, ''), 'base64');
  if (!body.length || body.length > MAX_INPUT_BYTES || !TIPOS[mime]) {
    const e = new Error('La imagen supera 4 MB o tiene un formato no permitido.');
    e.status = 413;
    throw e;
  }
  return { mime, body, extension: TIPOS[mime] };
}

/* R2 recibe siempre una variante web liviana y homogénea. La orientación EXIF
   se corrige antes de medir; después se reduce calidad y, sólo si hace falta,
   dimensiones hasta quedar alrededor de 500 KB. Los logos simples suelen
   quedar muy por debajo de 100 KB y no se rellenan artificialmente. */
async function optimizarImagen(imagen) {
  const base = sharp(imagen.body, { animated: false, limitInputPixels: 40_000_000 })
    .rotate()
    .resize({ width: MAX_DIMENSION, height: MAX_DIMENSION, fit: 'inside', withoutEnlargement: true });
  const intentos = [
    { quality: 82, width: MAX_DIMENSION },
    { quality: 74, width: 1800 },
    { quality: 68, width: 1600 },
    { quality: 62, width: 1400 },
    { quality: 58, width: 1200 },
    { quality: 54, width: 1000 },
    { quality: 50, width: 800 },
    { quality: 46, width: 640 },
  ];
  let salida;
  try {
    for (const intento of intentos) {
      salida = await base.clone()
        .resize({ width: intento.width, height: intento.width, fit: 'inside', withoutEnlargement: true })
        .webp({ quality: intento.quality, effort: 5, smartSubsample: true })
        .toBuffer();
      if (salida.length <= MAX_OUTPUT_BYTES) break;
    }
  } catch (_) {
    const e = new Error('El archivo no contiene una imagen válida o está dañado.');
    e.status = 400;
    throw e;
  }
  return { mime: 'image/webp', extension: 'webp', body: salida };
}

function segmento(v, fallback) {
  const limpio = String(v == null ? '' : v).toLowerCase().trim()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64);
  return limpio || fallback;
}

function urlPublica(base, key) {
  return `${base}/${key.split('/').map(encodeURIComponent).join('/')}`;
}

async function persistirImagenWeb(v, opciones = {}) {
  if (v == null || v === '' || /^https:\/\//i.test(String(v))) return v || '';
  const entrada = dataUri(v);
  if (!entrada) return v;
  const imagen = await optimizarImagen(entrada);

  const cfg = configuracion();
  // Permite desplegar el código antes de conectar img.siwepe.shop. Mientras
  // falte la URL pública se conserva el comportamiento anterior en MySQL.
  if (!cfg.listo) {
    if (cfg.credenciales && !avisoPendienteMostrado) {
      console.warn('R2 tiene credenciales, pero falta R2_PUBLIC_BASE_URL; las imágenes nuevas seguirán en formato heredado.');
      avisoPendienteMostrado = true;
    }
    return `data:${imagen.mime};base64,${imagen.body.toString('base64')}`;
  }

  // Este bucket se expondrá por img.siwepe.shop: sólo admite material
  // comercial público. Comprobantes y documentos privados nunca llaman a
  // esta función y requieren un almacenamiento privado independiente.
  const propietario = `public/empresas/${segmento(opciones.empresaId, 'empresa')}`;
  const carpeta = segmento(opciones.carpeta, 'general');
  const fecha = new Date().toISOString().slice(0, 7);
  const key = `${propietario}/${carpeta}/${fecha}/${crypto.randomUUID()}.${imagen.extension}`;
  await obtenerCliente(cfg).send(new PutObjectCommand({
    Bucket: cfg.bucket,
    Key: key,
    Body: imagen.body,
    ContentType: imagen.mime,
    CacheControl: 'public, max-age=31536000, immutable',
    Metadata: { origen: 'siwepe' },
  }));
  return urlPublica(cfg.publicBaseUrl, key);
}

async function probarConexionR2() {
  const cfg = configuracion();
  if (!cfg.credenciales) {
    const e = new Error('Faltan credenciales de R2 en el servidor.');
    e.status = 503;
    throw e;
  }
  const key = `verificacion/${crypto.randomUUID()}.txt`;
  const c = obtenerCliente(cfg);
  await c.send(new PutObjectCommand({ Bucket: cfg.bucket, Key: key, Body: Buffer.from('SIWEPE R2 OK'), ContentType: 'text/plain' }));
  await c.send(new DeleteObjectCommand({ Bucket: cfg.bucket, Key: key }));
  return { bucket: cfg.bucket, region: cfg.region, publicBaseConfigured: !!cfg.publicBaseUrl };
}

module.exports = { configuracion, dataUri, optimizarImagen, persistirImagenWeb, probarConexionR2 };
