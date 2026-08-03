# Belle Stock — Backend (Node.js + MySQL)

Backend con **Express** + **MySQL** que sirve la tienda y el admin, y expone la API
con **login por roles** (admin, proveedor, cliente), contraseñas cifradas (bcrypt)
y sesión con **JWT**.

## Requisitos

- **Node.js 18+** (probado con 22)
- **MySQL 8** (o MariaDB) corriendo en tu compu

## Puesta en marcha (una sola vez)

1. Instala y arranca MySQL. Anota tu usuario y contraseña (por defecto `root`).

2. En una terminal, entra a la carpeta del servidor:
   ```bash
   cd server
   ```

3. Copia el archivo de configuración y ponle tus datos de MySQL:
   ```bash
   cp .env.example .env
   ```
   Abre `.env` y edita `DB_USER`, `DB_PASSWORD` (y `DB_HOST`/`DB_PORT` si hace falta).
   Cambia también `JWT_SECRET` por una frase larga tuya.

4. Instala las dependencias:
   ```bash
   npm install
   ```

5. (Opcional) Deja la base vacía y lista para empezar de cero:
   ```bash
   npm run reset
   ```
   El servidor también crea la base, las tablas y un admin por defecto la primera
   vez que arranca si la base está vacía.

## Arrancar el servidor

```bash
npm start
```

Verás:
```
🌸 Belle Stock backend en http://localhost:3000
   Tienda: http://localhost:3000/tienda.html
   Admin:  http://localhost:3000/admin.html
```

Abre **http://localhost:3000/tienda.html** en el navegador. ¡Ya está todo conectado
a MySQL!

> Importante: ahora la web se abre desde **http://localhost:3000** (el servidor Node),
> ya no con Live Server en el puerto 5500. Si abres los `.html` por Live Server,
> el front intentará hablar con el backend en `http://localhost:3000` igualmente.

## Cuentas de acceso

| Rol       | Cómo entra                        | Credenciales                         |
|-----------|-----------------------------------|--------------------------------------|
| Admin     | tienda.html → pestaña **Admin**   | `admin@siwepe.com` / `admin1234`     |
| Proveedor | tienda.html → pestaña **Admin**   | `proveedor@bellezahn.com` / `proveedor123` |
| Cliente   | tienda.html → **Soy cliente**     | `Sofía Martínez` / `2222` (u otros)  |

El **cliente puede navegar la tienda sin iniciar sesión**; solo se le pide cuenta
al confirmar el pedido.

## Cómo está armado

- `server.js` — servidor Express: sirve la web y expone la API.
- `db.js` — conexión a MySQL (pool) y creación del esquema.
- `schema.sql` — tablas normalizadas (identificador primario `id` en cada una).
- `reset.js` — deja la base vacía (solo config + admin) para empezar de cero.
- `auth.js` — cifrado de contraseñas (bcrypt) y tokens (JWT) + control de roles.

### Endpoints principales

- `POST /api/auth/login` — admin/proveedor (email + contraseña)
- `POST /api/auth/cliente-login` — cliente (nombre + PIN)
- `POST /api/auth/register` — registro de cliente
- `GET  /api/catalog` — catálogo público (para navegar sin sesión)
- `GET  /api/state` — estado completo (requiere sesión)
- `PUT  /api/state` — guardar cambios (requiere sesión)

## Pendiente de endurecer (segunda etapa)

Para llegar rápido a "todo conectado", el guardado envía el estado completo.
El siguiente paso de seguridad es pasar a **endpoints por recurso** con permisos
por rol (que un cliente solo pueda crear/cancelar sus pedidos, etc.) y una vista
propia y limitada para el rol **proveedor**.
