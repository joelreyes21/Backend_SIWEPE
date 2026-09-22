-- ════════════════════════════════════════════════════════════════════════════
-- SIWEPE · Revisar (y si querés, borrar) la cuenta "Prueba" id=15
-- Correr en MySQL Workbench sobre la base SIWEPE.
-- Los pasos 1 y 2 solo MIRAN. El 3 borra: leelo antes de correrlo.
-- ════════════════════════════════════════════════════════════════════════════

-- ── 1. ¿Quién es y qué empresa creó? ────────────────────────────────────────
SELECT u.id, u.nombre, u.email, u.role, u.created_at,
       e.id AS empresa_id, e.slug, e.nombre AS empresa,
       e.ciudad, e.pais, e.telefono, e.estado
FROM SIWEPE.users u
LEFT JOIN SIWEPE.empresas e ON e.id = u.empresa_id
WHERE u.id = 15;

-- ── 2. ¿Alcanzó a cargar algo? ──────────────────────────────────────────────
-- Si todo da 0, es una cuenta vacía y borrarla no se lleva nada por delante.
SELECT
  (SELECT COUNT(*) FROM SIWEPE.productos  WHERE empresa_id = 13) AS productos,
  (SELECT COUNT(*) FROM SIWEPE.pedidos    WHERE empresa_id = 13) AS pedidos,
  (SELECT COUNT(*) FROM SIWEPE.ventas     WHERE empresa_id = 13) AS ventas,
  (SELECT COUNT(*) FROM SIWEPE.clientes   WHERE empresa_id = 13) AS clientes,
  (SELECT COUNT(*) FROM SIWEPE.categorias WHERE empresa_id = 13) AS categorias;

-- ── 3. BORRAR ───────────────────────────────────────────────────────────────
-- Solo si el paso 2 dio todo en 0 y confirmaste que no es de nadie del equipo.
-- Quitá los "-- " del inicio de cada línea para ejecutarlas.
-- Van en este orden para no dejar filas huérfanas.

-- DELETE FROM SIWEPE.app_meta   WHERE empresa_id = 13;
-- DELETE FROM SIWEPE.config     WHERE empresa_id = 13;
-- DELETE FROM SIWEPE.categorias WHERE empresa_id = 13;
-- DELETE FROM SIWEPE.users      WHERE id = 15;
-- DELETE FROM SIWEPE.empresas   WHERE id = 13;

-- ── 4. Alternativa sin borrar: dejarla fuera del marketplace ────────────────
-- La empresa deja de verse en Descubrir, pero no se pierde nada.
-- UPDATE SIWEPE.empresas SET estado = 'inactiva' WHERE id = 13;

-- ── 5. ¿Hay más cuentas con nombre sospechoso? ──────────────────────────────
SELECT u.id, u.nombre, u.email, u.role, u.created_at, e.nombre AS empresa
FROM SIWEPE.users u
LEFT JOIN SIWEPE.empresas e ON e.id = u.empresa_id
WHERE u.nombre NOT LIKE '% %'                    -- sin apellido
   OR LOWER(u.nombre) REGEXP 'prueba|test|demo|ejemplo|asdf|qwerty|admin|usuario'
ORDER BY u.created_at DESC;
