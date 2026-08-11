# Catálogo cruzado entre tiendas (`GET /api/marketplace`)

## Contexto y problema

Hoy el catálogo público (`GET /api/catalog?empresa=<slug-or-id>`) está aislado por tienda: solo devuelve los productos de UNA empresa. En la app móvil y en `siwepe.shop` se necesita poder navegar productos de TODAS las tiendas activas desde un solo lugar (una vista tipo "marketplace"), y que al tocar un producto se pueda entrar al perfil de la empresa dueña de ese producto.

Este es el **Spec A** de un pedido más grande, dividido en dos partes:
- **Spec A (este documento):** catálogo cruzado de solo lectura + navegación al perfil de empresa. No requiere autenticación, no toca el esquema, no toca el modelo de aislamiento por `empresa_id`.
- **Spec B (pendiente, próximo diseño):** cuenta única de cliente a nivel plataforma (login por correo en vez de nombre-por-empresa) y checkout/compra cruzando varias tiendas en un mismo pedido. Se diseña por separado porque implica una migración de esquema y de login más grande, y no es necesaria para resolver la navegación/descubrimiento de productos.

Este documento cubre solo el Spec A.

## Alcance

- Nueva ruta pública `GET /api/marketplace` que devuelve productos de **todas** las empresas con `estado='activa'`, filtrando productos con `estado='activo'`, cada uno con los datos básicos de su empresa embebidos.
- No se agrega paginación ni filtros (categoría, búsqueda, rubro) — la escala actual es de pocas decenas de tiendas/productos; el front puede filtrar client-side. Se puede agregar después si hace falta.
- No se agrega ninguna ruta nueva para "entrar al perfil de la empresa": se resuelve con la ruta ya existente `GET /api/catalog?empresa=<slug>`, usando el `slug` que viene embebido en cada producto de `/api/marketplace`.
- No se toca `schema.sql`, no hay migración, no se modifica `GET /api/catalog?empresa=X` (sigue siendo la vista de una tienda individual).
- Fuera de alcance (Spec B): cuenta de cliente global, carrito/checkout que compre de varias tiendas en un mismo flujo.

## Diseño

### Endpoint

```
GET /api/marketplace
```

Público, sin autenticación (igual que `/api/catalog`). Sin query params.

Query de datos: un `JOIN` entre `productos` y `empresas`, filtrando `empresas.estado='activa'` y `productos.estado='activo'`:

```sql
SELECT productos.*, empresas.id AS emp_id, empresas.slug, empresas.nombre AS emp_nombre,
       empresas.rubro, empresas.ciudad, empresas.logo AS emp_logo
FROM productos
JOIN empresas ON productos.empresa_id = empresas.id
WHERE empresas.estado = 'activa' AND productos.estado = 'activo'
```

### Forma de la respuesta

```json
{
  "productos": [
    {
      "id": 7,
      "codigo": "COD-01",
      "nombre": "Crema hidratante",
      "categoria_id": 2,
      "descripcion": "...",
      "precio_venta": 120,
      "stock": 5,
      "imagen": "data:image/...",
      "destacado": false,
      "marca": "...",
      "tipoPiel": [],
      "empresa": {
        "id": 3,
        "slug": "bellezahn",
        "nombre": "Bellezahn",
        "rubro": "Cosméticos",
        "ciudad": "Tegucigalpa",
        "logo": "data:image/..."
      }
    }
  ]
}
```

Notas sobre los campos:
- Reutiliza `mapProducto()` (definida en `server.js`) para el shape del producto, y le agrega la propiedad `empresa`.
- Se **omiten** `precio_compra` y `stock_min` — son datos internos del negocio (costo, umbral de reposición) que no deberían salir en una vista pública cruzada entre tiendas distintas. `categoria_id` se mantiene, pero **no** se resuelve el nombre de la categoría (no se hace `JOIN` con `categorias`) porque las categorías son propias de cada empresa y no aportan valor fuera de ese contexto en una vista cruzada; si el front necesita el nombre, puede pedirlo vía `/api/catalog?empresa=<slug>` al entrar al perfil de esa tienda.
- El objeto `empresa` usa los mismos campos que ya expone `GET /api/empresas` (listado público de "descubrir negocios"), para que el front no tenga que manejar dos formas distintas de representar una empresa.

### Navegación al perfil de empresa

No es una ruta nueva. El front (app móvil / siwepe.shop) usa `empresa.slug` de cada producto y llama a la ruta ya existente:

```
GET /api/catalog?empresa=<slug>
```

para mostrar el catálogo completo de esa tienda (lo que hoy ya funciona como "perfil/tienda individual").

### Manejo de errores

- Sin parámetros que validar → no hay casos 400/404 propios de esta ruta.
- Error de conexión/consulta a la base → `500 { error: e.message }`, igual que el resto de rutas públicas del archivo.
- Sin caché ni rate-limit adicional: es lectura pública sin autenticación, consistente con `/api/catalog` hoy (que tampoco lo tiene).

## Testing

No hay suite de tests automatizados en el proyecto. Verificación manual:
1. Levantar el server con al menos 2 empresas `activa` con productos `activo`.
2. `GET /api/marketplace` debe traer productos de ambas empresas, cada uno con su objeto `empresa` correcto.
3. Una empresa en estado `pendiente` no debe aparecer (ningún producto suyo).
4. Un producto con `estado` distinto de `activo` no debe aparecer.
5. Tomar el `slug` de un producto de la respuesta y confirmar que `GET /api/catalog?empresa=<slug>` devuelve el catálogo completo de esa empresa.
