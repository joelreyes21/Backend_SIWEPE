# AGENTS.md

## Proyecto

API JSON multiempresa de SIWEPE con Express y MySQL. El frontend vive en `../SIWEPEE-main` y se publica por separado.

## Comandos

- `npm start`: inicia el API.
- `npm run dev`: inicia con recarga de Node.
- `npm test`: ejecuta contratos y controles de seguridad.
- `npm run check`: sintaxis del backend y pruebas.
- `npm run reset -- --empresa=<slug>`: reinicia sólo la empresa indicada y exige `RESET_CONFIRM=BORRAR:<slug>`. No truncar tablas compartidas.

## Reglas de arquitectura

- `auth.js` revalida en la base a cada usuario autenticado. Los JWT vencen en 7 días por defecto.
- Cliente, administrador y proveedor usan `POST /api/auth/login` con correo y contraseña. Los clientes se registran en `users` mediante `POST /api/auth/register` y su cuenta es global.
- Toda consulta de negocio debe incluir `empresa_id`. No confiar en IDs enviados por el cliente sin verificar pertenencia.
- El cliente usa endpoints dedicados de checkout, historial, cancelación, perfil y chat. Nunca usa `/api/state`.
- `GET /api/state` es de consulta para admin/proveedor. `PUT /api/state` es sólo admin y exige `_revision` para evitar sobreescrituras concurrentes.
- Cambios de estado de pedido e inventario pasan por `PATCH /api/pedidos/:pedidoId/estado` y deben permanecer transaccionales.
- El catálogo público nunca expone `precio_compra` ni `stock_min`.
- Imágenes web deben pasar por `exigirImagenWeb`; no aceptar SVG ni esquemas ejecutables.
- No añadir credenciales predeterminadas. La preparación opcional usa variables `BOOTSTRAP_ADMIN_*`.

Mantener comentarios y mensajes visibles en español, actualizar pruebas cuando cambie un contrato y no reintroducir login por PIN ni escritura de proveedor.
