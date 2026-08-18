-- ============================================================================
-- SIWEPE · RESET TOTAL de la plataforma
-- © 2026 Joel Reyes. Todos los derechos reservados.
--
-- ⚠️  ADVERTENCIA: esto BORRA ABSOLUTAMENTE TODO (todas las tiendas, productos,
--     pedidos, ventas, usuarios, clientes, configuración...) y deja SOLO tu
--     cuenta como id 1 (super administrador de plataforma). ES IRREVERSIBLE.
--
-- CÓMO USARLO:
--   1. Abrí este script en MySQL Workbench conectado a la MISMA base que usa
--      la API en Railway (importante: si estás en otra base, no se refleja).
--   2. Ejecutá TODO (rayo / Ctrl+Shift+Enter).
--   3. Al final vas a ver una fila: id=1, jr4419543@gmail.com, super_admin=1.
--   4. En el sitio hacé Cmd+Shift+R (recarga forzada) para ver todo limpio.
--
--   Tu login queda:  correo jr4419543@gmail.com   /   clave Joel2004_
-- ============================================================================

SET FOREIGN_KEY_CHECKS = 0;

TRUNCATE TABLE mensajes;
TRUNCATE TABLE pedido_items;
TRUNCATE TABLE pedidos;
TRUNCATE TABLE movimientos;
TRUNCATE TABLE ventas;
TRUNCATE TABLE compras;
TRUNCATE TABLE productos;
TRUNCATE TABLE clientes_empresa;
TRUNCATE TABLE proveedores;
TRUNCATE TABLE categorias;
TRUNCATE TABLE config;
TRUNCATE TABLE app_meta;
TRUNCATE TABLE registros_pendientes;
TRUNCATE TABLE password_resets;
TRUNCATE TABLE onboarding_sessions;
TRUNCATE TABLE empresas;
TRUNCATE TABLE users;

SET FOREIGN_KEY_CHECKS = 1;

-- Asegura la columna super_admin por si aún no desplegaste el backend nuevo
-- (MySQL 8). Si tu MySQL fuera 5.7 y da error acá, borrá esta línea y agregá
-- la columna a mano una sola vez.
ALTER TABLE users ADD COLUMN IF NOT EXISTS super_admin TINYINT NOT NULL DEFAULT 0;

-- Reinicia el contador para que tu cuenta sea el id 1
ALTER TABLE users AUTO_INCREMENT = 1;

-- Tu perfil: id 1, super administrador de plataforma (contraseña Joel2004_ ya encriptada)
INSERT INTO users (nombre, email, password_hash, role, super_admin, empresa_id, activo)
VALUES ('Joel Reyes', 'jr4419543@gmail.com',
        '$2a$10$pEhKfF79ILyM/tVHgqnMEuZAOEOJWczf23Hde9uXrmxs.bCl7c2UO',
        'admin', 1, NULL, 1);

-- Confirmación
SELECT id, nombre, email, role, super_admin, empresa_id FROM users;
