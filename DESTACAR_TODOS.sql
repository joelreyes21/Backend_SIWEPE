-- Marca como DESTACADO todos los productos que YA existen, de todas las tiendas.
-- Las importaciones nuevas ya entran destacadas solas: esto es solo para
-- ponerle el sello a lo que se cargó antes del cambio.
-- Correr en MySQL Workbench (base SIWEPE). Para revertir: destacado = 0.

UPDATE SIWEPE.productos SET destacado = 1;

-- ── Verificación ────────────────────────────────────────────────────────────
SELECT COUNT(*) AS productos_destacados
FROM SIWEPE.productos
WHERE destacado = 1;

-- OJO: estar destacado NO basta para aparecer en la tienda. La vitrina solo
-- muestra productos activos CON unidades publicadas. Esta consulta lista los
-- que quedarán invisibles porque tienen 0 publicado (aunque haya stock en
-- bodega): se publican desde Inventario → Publicar.
SELECT e.nombre AS tienda, p.codigo, p.nombre AS producto,
       p.stock AS publicado_en_tienda, p.stock_inventario AS en_bodega
FROM SIWEPE.productos p
JOIN SIWEPE.empresas e ON e.id = p.empresa_id
WHERE p.destacado = 1 AND p.estado = 'activo' AND p.stock <= 0
ORDER BY e.nombre, p.nombre;

-- Si querés publicar de una vez TODO lo que está en bodega (mueve las unidades
-- de inventario a la tienda), descomentá estas dos líneas y corrélas:
-- UPDATE SIWEPE.productos SET stock = stock + stock_inventario, stock_inventario = 0
-- WHERE estado = 'activo' AND stock_inventario > 0;
