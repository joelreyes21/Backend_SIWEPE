# SIWEPE API

Backend multiempresa de SIWEPE. Expone una API JSON para el marketplace, las tiendas públicas y el panel administrativo. Usa Express, MySQL, bcrypt y JWT.

## Desarrollo local

Requisitos: Node.js 18+ y MySQL 8/MariaDB.

```bash
cp .env.example .env
npm install
npm start
```

El API queda en `http://localhost:3000`. El frontend es un proyecto separado (`../SIWEPEE-main`, estático, sin servidor propio) que en producción siempre habla con el backend de Railway — si lo abrís localmente con algún servidor estático genérico (Live Server, `npx serve`, etc.), agregá ese origen a `CORS_ORIGINS` (por defecto ya incluye `http://localhost:5500` y `http://127.0.0.1:5500`).

Antes de desplegar, configura como mínimo una contraseña MySQL real, un `JWT_SECRET` largo y único, `CORS_ORIGINS`, `SITE_URL` y las credenciales de correo. El servidor no crea usuarios con contraseñas conocidas. Una empresa y su cuenta administradora se crean mediante el registro verificado; para preparar manualmente una instalación vacía se pueden usar `BOOTSTRAP_ADMIN_EMAIL` y `BOOTSTRAP_ADMIN_PASSWORD`.

## Despliegue en Railway

El código ya está preparado para Railway: `db.js` detecta solo las variables `MYSQL*`/`DATABASE_URL` que Railway inyecta automáticamente al conectar un plugin de MySQL — no hay que tocar código, solo configurar variables en el dashboard del servicio.

1. **Servicio del backend**: conectá el repo de GitHub (`joelreyes21/Backend_SIWEPE`) como servicio en Railway. Railway detecta `package.json` y corre `npm start` solo.
2. **Base de datos**: agregá el plugin de MySQL de Railway al mismo proyecto. Railway inyecta `MYSQLHOST`, `MYSQLPORT`, `MYSQLUSER`, `MYSQLPASSWORD`, `MYSQLDATABASE` (o `DATABASE_URL`) automáticamente — `db.js` los usa sin configuración extra.
3. **Variables que hay que agregar a mano** en el servicio del backend (pestaña *Variables*):

   | Variable | Valor |
   |---|---|
   | `JWT_SECRET` | una frase larga y única — nunca la del `.env.example` |
   | `CORS_ORIGINS` | el/los dominios reales del frontend, separados por coma |
   | `SITE_URL` | la URL pública del frontend (a donde redirige tras verificar correo o resetear contraseña) |
   | `PUBLIC_API_URL` | la URL pública que Railway le da a este servicio (para armar el link de verificación de correo) |
   | `RESEND_API_KEY` | opcional — sin esto, el link de verificación solo queda en los logs, no se manda correo real |
   | `MAIL_FROM` | opcional, remitente de los correos |

4. Después de desplegar, confirmá que `assets/js/shared/data.js` (`API_BASE`, en `SIWEPEE-main`) apunte a la URL pública que Railway le asignó a este servicio — si Railway genera una URL nueva, ese es el único lugar del frontend que hay que actualizar.

## Comandos

```bash
npm start          # servidor
npm run dev        # servidor con recarga
npm test           # contratos y controles de seguridad
npm run check      # sintaxis + pruebas
```

El reinicio es intencionalmente seguro y sólo afecta una empresa:

```bash
RESET_CONFIRM=BORRAR:mi-slug npm run reset -- --empresa=mi-slug
```

Conserva usuarios, clientes globales y configuración. Nunca trunca tablas compartidas.

## Flujos principales

- `POST /api/empresas`: solicitud de empresa con verificación de correo.
- `POST /api/auth/register` y `POST /api/auth/login`: cuenta global de cliente por correo y contraseña.
- `GET /api/catalog`: catálogo público sin costos internos.
- `POST /api/pedidos/checkout`: pedido con precios recalculados por el servidor.
- `GET /api/mis-pedidos`: historial global del cliente.
- `PATCH /api/pedidos/:id/estado`: aprobación/cancelación transaccional por administradores.
- `GET|POST /api/pedidos/:empresaId/:pedidoId/mensajes`: chat del cliente con control de pertenencia.
- `GET /api/state`: vista completa de una empresa para admin/proveedor.
- `PUT /api/state`: escritura administrativa con revisión optimista; el proveedor es de consulta.

## Modelo de seguridad

- Contraseñas con bcrypt y JWT de duración configurable (7 días por defecto).
- El middleware revalida usuario activo, rol y empresa en cada solicitud autenticada.
- Separación por `empresa_id` y controles de pertenencia para clientes y pedidos.
- CORS restringido, Helmet y límites de solicitudes.
- Imágenes limitadas a HTTPS o datos JPG/PNG/WEBP/GIF; SVG y esquemas ejecutables se rechazan.
- El catálogo público no expone `precio_compra` ni `stock_min`.
- Los cambios de pedidos e inventario se ejecutan dentro de transacciones MySQL.

Consulta `.env.example` para todas las variables disponibles y `schema.sql` para el modelo de datos.
