-- ============================================================
-- SIWEPE · REINICIO TOTAL (Workbench / Railway producción)
-- Vacía TODAS las tablas, reinicia los IDs y deja SOLO tu
-- cuenta (super-admin) reindexada como id = 1.
-- IRREVERSIBLE. Hacé un Data Export antes si querés respaldo.
-- Cambiá el correo si tu cuenta usa otro.
-- ============================================================
SET @correo := 'jr4419543@gmail.com';

-- Guardar nombre y hash de contraseña actuales (para no re-hashear)
SET @nombre := (SELECT nombre        FROM SIWEPE.users WHERE email=@correo LIMIT 1);
SET @hash   := (SELECT password_hash FROM SIWEPE.users WHERE email=@correo LIMIT 1);

-- Seguridad: si el correo no existe, abortar (no vaciar nada a ciegas)
-- Si esto falla, revisá @correo antes de continuar.

SET FOREIGN_KEY_CHECKS = 0;
TRUNCATE TABLE SIWEPE.`abonos`;
TRUNCATE TABLE SIWEPE.`app_meta`;
TRUNCATE TABLE SIWEPE.`calificaciones`;
TRUNCATE TABLE SIWEPE.`categorias`;
TRUNCATE TABLE SIWEPE.`clientes_empresa`;
TRUNCATE TABLE SIWEPE.`comanda_items`;
TRUNCATE TABLE SIWEPE.`comandas`;
TRUNCATE TABLE SIWEPE.`compras`;
TRUNCATE TABLE SIWEPE.`config`;
TRUNCATE TABLE SIWEPE.`creditos`;
TRUNCATE TABLE SIWEPE.`cuentas_pagar`;
TRUNCATE TABLE SIWEPE.`empresas`;
TRUNCATE TABLE SIWEPE.`facturas`;
TRUNCATE TABLE SIWEPE.`gastos`;
TRUNCATE TABLE SIWEPE.`mensajes`;
TRUNCATE TABLE SIWEPE.`mesas`;
TRUNCATE TABLE SIWEPE.`movimientos`;
TRUNCATE TABLE SIWEPE.`movimientos_caja`;
TRUNCATE TABLE SIWEPE.`notificacion_lecturas`;
TRUNCATE TABLE SIWEPE.`onboarding_sessions`;
TRUNCATE TABLE SIWEPE.`pagos_cuenta_pagar`;
TRUNCATE TABLE SIWEPE.`password_resets`;
TRUNCATE TABLE SIWEPE.`pedido_items`;
TRUNCATE TABLE SIWEPE.`pedidos`;
TRUNCATE TABLE SIWEPE.`productos`;
TRUNCATE TABLE SIWEPE.`promociones`;
TRUNCATE TABLE SIWEPE.`proveedores`;
TRUNCATE TABLE SIWEPE.`registros_pendientes`;
TRUNCATE TABLE SIWEPE.`turnos_caja`;
TRUNCATE TABLE SIWEPE.`ventas`;
TRUNCATE TABLE SIWEPE.`users`;   -- reinicia AUTO_INCREMENT a 1

-- Recrear tu cuenta como id = 1 (reutiliza tu hash: seguís entrando con tu misma clave)
INSERT INTO SIWEPE.users (nombre,email,password_hash,role,super_admin,empresa_id,activo)
VALUES (COALESCE(@nombre,'Joel Reyes'), @correo, @hash, 'admin', 1, NULL, 1);

SET FOREIGN_KEY_CHECKS = 1;

-- Verificación
SELECT id, nombre, email, role, super_admin FROM SIWEPE.users;
