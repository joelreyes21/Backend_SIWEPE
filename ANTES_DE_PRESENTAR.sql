-- ════════════════════════════════════════════════════════════════════════════
-- SIWEPE · Dejar las tiendas presentables antes de la defensa
-- Correr en MySQL Workbench sobre la base SIWEPE. Es seguro y reversible.
-- ════════════════════════════════════════════════════════════════════════════

-- ── 1. ANTES: mirá cómo está cada tienda ────────────────────────────────────
-- "visibles" son los que el cliente realmente ve (activos y con unidades
-- publicadas). "destacados_visibles" son los que salen en la vitrina.
SELECT e.nombre AS tienda,
       COUNT(*)                                                   AS productos,
       SUM(p.estado='activo' AND p.stock > 0)                     AS visibles,
       SUM(p.estado='activo' AND p.stock > 0 AND p.destacado = 1) AS destacados_visibles,
       SUM(p.stock_inventario)                                    AS unidades_en_bodega
FROM SIWEPE.productos p
JOIN SIWEPE.empresas e ON e.id = p.empresa_id
GROUP BY e.id, e.nombre
ORDER BY visibles ASC;

-- ── 2. Publicar lo que está guardado en bodega ──────────────────────────────
-- Los productos importados con "Stock tienda = 0" quedan invisibles aunque
-- tengan unidades en inventario. Esto los saca a la tienda.
UPDATE SIWEPE.productos
SET stock = stock + stock_inventario,
    stock_inventario = 0,
    publicado_alguna_vez = 1
WHERE estado = 'activo' AND stock_inventario > 0;

-- ── 3. Destacar todo lo que ya tiene unidades publicadas ────────────────────
UPDATE SIWEPE.productos
SET destacado = 1
WHERE estado = 'activo' AND stock > 0;

-- ── 4. DESPUÉS: verificá que quedaron visibles ──────────────────────────────
SELECT e.nombre AS tienda,
       COUNT(*)                                                   AS productos,
       SUM(p.estado='activo' AND p.stock > 0)                     AS visibles,
       SUM(p.estado='activo' AND p.stock > 0 AND p.destacado = 1) AS destacados_visibles
FROM SIWEPE.productos p
JOIN SIWEPE.empresas e ON e.id = p.empresa_id
GROUP BY e.id, e.nombre
ORDER BY visibles DESC;

-- ── 5. Si queda alguno sin stock en ningún lado, acá salen ──────────────────
-- Estos no se arreglan solos: nunca tuvieron unidades. Ponéles cantidad a mano
-- desde el panel, o dejalos fuera de la demo.
SELECT e.nombre AS tienda, p.codigo, p.nombre AS producto
FROM SIWEPE.productos p
JOIN SIWEPE.empresas e ON e.id = p.empresa_id
WHERE p.estado = 'activo' AND p.stock <= 0 AND p.stock_inventario <= 0
ORDER BY e.nombre, p.nombre;
