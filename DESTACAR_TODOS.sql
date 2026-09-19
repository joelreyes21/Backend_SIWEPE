-- Marca como DESTACADO todos los productos existentes de todas las tiendas.
-- Correr en MySQL Workbench (base SIWEPE). Reversible: para revertir, poner destacado=0.
UPDATE SIWEPE.productos SET destacado = 1;

-- Verificación: cuántos quedaron destacados
SELECT COUNT(*) AS productos_destacados FROM SIWEPE.productos WHERE destacado = 1;
