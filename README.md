# SIWEPE API

Backend multiempresa de SIWEPE. Expone una API JSON para el marketplace, las tiendas públicas y el panel administrativo. Usa Express, MySQL, bcrypt y JWT.

## Desarrollo local

Requisitos: Node.js 18+ y MySQL 8/MariaDB.

```bash
cp .env.example .env
npm install
npm start
```

El API queda en `http://localhost:3000`. El frontend es un proyecto separado: servilo desde `SIWEPEE-main` en `http://localhost:5500`, uno de los orígenes permitidos por defecto.

Antes de desplegar, configura como mínimo una contraseña MySQL real, un `JWT_SECRET` largo y único, `CORS_ORIGINS`, `SITE_URL` y las credenciales de correo. El servidor no crea usuarios con contraseñas conocidas. Una empresa y su cuenta administradora se crean mediante el registro verificado; para preparar manualmente una instalación vacía se pueden usar `BOOTSTRAP_ADMIN_EMAIL` y `BOOTSTRAP_ADMIN_PASSWORD`.

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
