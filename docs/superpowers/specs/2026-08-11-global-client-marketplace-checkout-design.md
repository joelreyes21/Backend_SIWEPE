# Cuenta global de cliente + checkout cruzando tiendas (Spec B)

## Contexto y problema

Este es el **Spec B** del pedido de marketplace, segunda mitad tras [Spec A](./2026-08-11-marketplace-catalog-design.md) (`GET /api/marketplace`, ya implementado). Spec A resolvió la navegación de productos de todas las tiendas; este documento resuelve la parte que faltaba: que un cliente pueda comprar productos de varias tiendas distintas con una sola cuenta.

Hoy un cliente (login por nombre+contraseña) pertenece a UNA sola empresa: la tabla `clientes` tiene clave primaria compuesta `(empresa_id, id)`, y todos sus pedidos/mensajes quedan aislados a esa empresa vía el modelo de "estado completo" (`GET`/`PUT /api/state`). Ese modelo asume que un cliente = una empresa, lo cual ya no encaja si el cliente puede comprar de cualquier tienda del marketplace.

## Alcance

- Cuenta de cliente única a nivel plataforma, identificada por correo (no por nombre-por-empresa).
- Checkout que puede generar pedidos en varias empresas a partir de un solo carrito, con semántica todo-o-nada.
- Listado de "mis pedidos" cruzando todas las empresas donde el cliente compró.
- Chat de pedidos (cliente↔admin) migrado a rutas propias, ya que deja de vivir en `/api/state` para el cliente.
- Migración de esquema simple (sin preservar datos históricos de `clientes` — proyecto en etapa temprana, confirmado con el usuario).
- El directorio de clientes que ve el admin/proveedor en `/api/state` deja de ser una tabla propia que administra — pasa a **derivarse** de sus pedidos (ver sección dedicada más abajo). Esto es un cambio necesario descubierto durante el diseño, no un extra: la tabla `clientes` que hoy alimenta ese directorio es la misma que se elimina para globalizar el login.
- Fuera de alcance: rutas o lógica del lado admin para responder mensajes (no cambian); verificación por correo para el registro de cliente (se decidió no agregarla); validación de stock disponible en el checkout (el sistema no la tiene hoy tampoco, se mantiene así).

## Diseño

### Modelo de datos

El cliente pasa a ser una fila más en `users`, con `role='cliente'` y `empresa_id=NULL` (no pertenece a una sola tienda, igual que el admin de plataforma). Esto:

- Reutiliza el login/JWT/`auth.js` existentes — `POST /api/auth/login` (correo+contraseña) sirve para admin, proveedor y cliente por igual. **Se elimina `POST /api/auth/cliente-login`** (nombre+PIN).
- Habilita recuperación de contraseña por correo (`/api/auth/olvide` / `/api/auth/reset`) para clientes sin código nuevo — ya opera sobre `users`.
- `pedidos.cliente_id` y `ventas.cliente_id` pasan a apuntar al `id` global de `users` (antes apuntaban al `id` compuesto de la vieja `clientes`). Un pedido sigue perteneciendo a una sola empresa (`pedidos.empresa_id`); lo que cambia es que el mismo cliente puede tener pedidos en muchas empresas.
- **`schema.sql`:** se elimina la tabla `clientes`. `users` gana tres columnas nullable (solo pobladas cuando `role='cliente'`): `telefono VARCHAR(30)`, `direccion VARCHAR(160)`, `whatsapp VARCHAR(24)`. El contacto por correo ya no necesita campo aparte — `users.email` cumple login + contacto.
- **`db.js` — nuevo migrador `_migrarClienteGlobal(pool)`**, mismo patrón que `_migrarMultiEmpresa()` (chequea antes de alterar, idempotente):

```js
async function _migrarClienteGlobal(pool) {
  const [tc] = await pool.query("SHOW COLUMNS FROM users LIKE 'telefono'");
  if (!tc.length) {
    await pool.query(
      "ALTER TABLE users ADD COLUMN telefono VARCHAR(30) NULL, " +
      "ADD COLUMN direccion VARCHAR(160) NULL, ADD COLUMN whatsapp VARCHAR(24) NULL"
    );
  }
  const [ct] = await pool.query("SHOW TABLES LIKE 'clientes'");
  if (ct.length) {
    console.warn('Migrando cuentas de cliente a users (cuenta global): eliminando tabla clientes vieja.');
    await pool.query('DROP TABLE clientes');
  }
}
```

Se llama desde `initDb()`, junto a `_migrarMultiEmpresa()`. No hay `FOREIGN KEY` declarada hoy sobre `pedidos.cliente_id`/`ventas.cliente_id` en `schema.sql`, así que no hay conflicto de constraint al reapuntar su significado.

### Registro y login

- `POST /api/auth/register` cambia de forma: `{ nombre, correo, password, telefono?, direccion?, whatsapp? }` (ya no pide `pin` ni `empresa`). Valida `password` ≥ 8 caracteres (mismo umbral que `/api/auth/reset`) y correo único en `users` (mismo chequeo que ya existe para `/api/users`). Crea la fila en `users` con `role='cliente'`, `empresa_id=NULL`, `ref_id=NULL`, y devuelve `{ token, user }` — mismo shape que `/api/auth/login`. **Sin verificación por correo** (decidido: menos fricción, no maneja nada sensible del lado cliente).
- `POST /api/auth/login` (ya existe, sin cambios de código) ahora también autentica clientes, porque son filas de `users` como cualquier otra.
- `POST /api/auth/cliente-login` se elimina.
- `PUT /api/clientes/mi` se mantiene en la misma ruta, pero pasa a actualizar la propia fila de `users` (`nombre`, `telefono`, `correo`/`email`, `direccion`, `whatsapp`) en vez de una fila de `clientes`. Si cambia `email`, se revalida unicidad (409 si ya está en uso).

### Checkout cruzando tiendas

```
POST /api/pedidos/checkout   (requireAuth, requireRole('cliente'))
Body: { items: [{ empresa_id, producto_id, cantidad }], nota?, metodoPago?, comprobante? }
```

- Agrupa los `items` por `empresa_id`.
- Dentro de **una única transacción** (todo-o-nada, confirmado): para cada grupo, valida que la empresa esté `estado='activa'`, resuelve `precio_venta` server-side desde `productos` de esa empresa (nunca confía en precio enviado por el cliente — mismo patrón que `guardarEstadoCliente` hoy). Si algún item no resuelve a un producto válido/activo de la empresa indicada, o un grupo queda sin items válidos, se aborta el checkout completo (rollback, `400` con detalle de qué falló) — no se crea ningún pedido parcial.
- Si todo resuelve: crea **un `pedido` por cada empresa** involucrada (con sus `pedido_items`), usando el contador `app_meta.seq` de cada empresa (mismo `FOR UPDATE` que ya usa el registro de cliente hoy para evitar colisión de ids concurrente). `cliente_id` en cada pedido es el `id` global del usuario logueado (`req.user.id`).
- No se valida stock disponible — el sistema no lo hace hoy tampoco en la creación de pedidos (se maneja aparte, vía `movimientos`/ventas registradas por el admin); se mantiene ese comportamiento.
- Responde `{ pedidos: [...] }`, cada uno con su `empresa` embebida (mismo shape `{ id, slug, nombre, rubro, ciudad, logo }` que ya usa `/api/marketplace`).

### Mis pedidos

```
GET /api/mis-pedidos   (requireAuth, requireRole('cliente'))
```

`SELECT * FROM pedidos WHERE cliente_id=?` — **sin** filtrar por `empresa_id`, trayendo pedidos de todas las tiendas donde compró. Se resuelven sus `pedido_items` y se mapean con `mapPedidos()` (ya existe en `server.js`), agregando el objeto `empresa` embebido en cada pedido (mismo patrón que checkout/marketplace).

### Chat de pedidos

```
GET  /api/pedidos/:empresaId/:pedidoId/mensajes   (requireAuth, requireRole('cliente'))
POST /api/pedidos/:empresaId/:pedidoId/mensajes   { texto }   (requireAuth, requireRole('cliente'))
```

Reemplazan la porción de chat que hoy vive dentro de `guardarEstadoCliente`. Antes de leer/escribir, valida `SELECT id FROM pedidos WHERE empresa_id=:empresaId AND id=:pedidoId AND cliente_id=<req.user.id>` — si no matchea (no existe o es de otro cliente), `404` genérico (mismo mensaje para ambos casos, para no filtrar existencia de pedidos ajenos). Un mensaje nuevo del cliente siempre se guarda con `autor='cliente'` (nunca puede hacerse pasar por `'admin'`, igual que hoy). El lado admin (leer/responder mensajes vía `/api/state`) no cambia.

### Directorio de clientes del admin/proveedor (derivado, no gestionado)

Hoy `GET /api/state` para admin/proveedor lee `SELECT * FROM clientes WHERE empresa_id=?` (incluye el PIN hasheado) y `guardarEstadoCompleto()` borra/reinserta esa tabla completa a partir del payload — es el mismo mecanismo que el admin usa para dar de alta clientes a mano y resetear su PIN. Al eliminar `clientes`, ese directorio se **deriva** en su lugar:

- `GET /api/state` (admin/proveedor): el campo `clientes` de la respuesta pasa a calcularse con `SELECT DISTINCT users.id, users.nombre, users.email AS correo, users.telefono, users.direccion, users.whatsapp FROM users JOIN pedidos ON pedidos.cliente_id = users.id WHERE pedidos.empresa_id = ? AND users.role = 'cliente'` — es decir, todo cliente que tenga al menos un pedido en esa empresa. Ya no incluye `pin` (no existe más de ese lado). Un cliente que se registró pero nunca compró en esa empresa no aparece — es la consecuencia esperada de que ya no hay una relación de "alta" cliente↔empresa, solo la de haber comprado.
- `guardarEstadoCompleto()`: se quita `'clientes'` del loop de `DELETE FROM ... WHERE empresa_id=?` (línea con la lista de tablas) y se elimina por completo el bloque `for (const x of db.clientes || [])` que insertaba filas en `clientes`. Si el front todavía manda `db.clientes` en el payload (código viejo sin actualizar), simplemente se ignora — no rompe nada, solo deja de tener efecto.
- El admin **ya no puede** dar de alta un cliente a mano ni resetearle la contraseña — el cliente se registra solo (`POST /api/auth/register`) y gestiona su propia contraseña (`PUT /api/clientes/mi`, `/api/auth/olvide`+`/api/auth/reset`). Esto es una pérdida de funcionalidad real respecto a hoy (antes el admin podía "resetear el PIN" de un cliente que se lo pedía en persona); se acepta como parte de este diseño porque el login ahora vive fuera del control de una sola empresa.

### `/api/state` para el rol cliente

`GET`/`PUT /api/state` dejan de aceptar `role='cliente'`: responden `403 { error: 'Los clientes ya no usan /api/state; usá /api/marketplace, /api/catalog, /api/pedidos/checkout, /api/mis-pedidos' }`. Esto es lo que habilita el resto del diseño — sin este corte, `guardarEstadoCliente` seguiría asumiendo "un cliente = una empresa" en conflicto con el modelo nuevo. El comportamiento para `admin`/`proveedor` no cambia.

### Manejo de errores

- `POST /api/pedidos/checkout`: `400` si `items` viene vacío o no es array; `400` con detalle de qué empresa/producto falló si algún item no resuelve (aborta todo, rollback, sin crear pedidos); `500` para errores de DB.
- `GET`/`POST /api/pedidos/:empresaId/:pedidoId/mensajes`: `404` genérico si el pedido no existe o no pertenece al cliente logueado.
- `POST /api/auth/register` (cliente): `409` si el correo ya está en uso; `400` si falta nombre/correo o la contraseña tiene menos de 8 caracteres.
- `PUT /api/clientes/mi`: `409` si el nuevo correo ya está en uso por otro usuario.
- `GET`/`PUT /api/state` con `role='cliente'`: `403` con el mensaje de arriba.

## Testing

Sin suite automatizada (mismo estado que Spec A) — verificación manual:
1. Registrar 2 clientes nuevos vía `POST /api/auth/register` (correo+contraseña) y loguear con `POST /api/auth/login`.
2. Confirmar `POST /api/auth/cliente-login` ya no existe (404/ruta no encontrada).
3. Crear productos en 2 empresas `activa` distintas (vía admin de cada una).
4. `POST /api/pedidos/checkout` con items de ambas empresas en un solo carrito → confirmar que se crean 2 pedidos (uno por empresa), cada uno con precios recalculados server-side.
5. `GET /api/mis-pedidos` del cliente que hizo el checkout → debe traer ambos pedidos, cada uno con su `empresa` correcta.
6. Probar el chat: `POST` y luego `GET /api/pedidos/:empresaId/:pedidoId/mensajes` sobre uno de los pedidos creados; confirmar que otro cliente no puede ver esos mensajes (404 al intentar con su propio token).
7. Repetir el checkout del paso 4 pero con un `producto_id` inválido en uno de los grupos → confirmar que NINGÚN pedido se crea (todo-o-nada) y la respuesta indica el error.
8. Loguear como cliente y llamar `GET /api/state` → confirmar `403` con el mensaje orientando a las rutas nuevas.
9. Loguear como el admin de una de las 2 empresas del paso 4 y llamar `GET /api/state` → el campo `clientes` debe traer al cliente que compró ahí (sin `pin`). Loguear como admin de una empresa donde ese cliente NO compró → no debe aparecer en su `clientes`.
