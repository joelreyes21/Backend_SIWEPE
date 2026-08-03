-- ============================================================
--  BELLE STOCK — Esquema de base de datos (MySQL)
--  Base normalizada. Identificador primario: id (INT) en cada tabla.
--  El login de administrador/proveedor usa la tabla `users` (con
--  contraseña cifrada). El cliente entra con nombre + PIN.
-- ============================================================

-- Configuración del negocio (una sola fila, id = 1)
CREATE TABLE IF NOT EXISTS config (
  id        TINYINT      PRIMARY KEY DEFAULT 1,
  nombre    VARCHAR(80)  NOT NULL DEFAULT 'Belle Stock',
  logo      LONGTEXT,
  moneda    VARCHAR(8)   NOT NULL DEFAULT 'L',
  tema      VARCHAR(20)  NOT NULL DEFAULT 'rosado',
  pin_admin VARCHAR(12)  NOT NULL DEFAULT '1234',
  banners   JSON,
  pago      JSON
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Secuencias de id que usa el front-end (nuevoId)
CREATE TABLE IF NOT EXISTS app_meta (
  id  TINYINT PRIMARY KEY DEFAULT 1,
  seq JSON
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Usuarios del sistema (roles: admin, proveedor, cliente)
CREATE TABLE IF NOT EXISTS users (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  nombre        VARCHAR(80)  NOT NULL,
  email         VARCHAR(120) UNIQUE,
  password_hash VARCHAR(120) NOT NULL,
  role          ENUM('admin','proveedor','cliente') NOT NULL DEFAULT 'cliente',
  ref_id        INT,                       -- id de cliente/proveedor asociado
  activo        TINYINT NOT NULL DEFAULT 1,
  created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS categorias (
  id          INT PRIMARY KEY,
  nombre      VARCHAR(80) NOT NULL,
  descripcion VARCHAR(255),
  estado      VARCHAR(12) NOT NULL DEFAULT 'activo'
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS proveedores (
  id        INT PRIMARY KEY,
  nombre    VARCHAR(80) NOT NULL,
  telefono  VARCHAR(30),
  correo    VARCHAR(120),
  empresa   VARCHAR(80),
  direccion VARCHAR(160),
  whatsapp  VARCHAR(24),
  estado    VARCHAR(12) NOT NULL DEFAULT 'activo'
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS clientes (
  id         INT PRIMARY KEY,
  nombre     VARCHAR(80) NOT NULL,
  telefono   VARCHAR(30),
  correo     VARCHAR(120),
  direccion  VARCHAR(160),
  whatsapp   VARCHAR(24),
  pin        VARCHAR(60) NOT NULL DEFAULT '0000',
  registrado TINYINT NOT NULL DEFAULT 1
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS productos (
  id            INT PRIMARY KEY,
  codigo        VARCHAR(40),
  nombre        VARCHAR(120) NOT NULL,
  categoria_id  INT,
  descripcion   TEXT,
  precio_compra DECIMAL(12,2) NOT NULL DEFAULT 0,
  precio_venta  DECIMAL(12,2) NOT NULL DEFAULT 0,
  stock         INT NOT NULL DEFAULT 0,
  stock_min     INT NOT NULL DEFAULT 0,
  imagen        LONGTEXT,
  estado        VARCHAR(12) NOT NULL DEFAULT 'activo',
  destacado     TINYINT NOT NULL DEFAULT 0,
  marca         VARCHAR(80),
  tipo_piel     JSON,
  CONSTRAINT fk_prod_cat FOREIGN KEY (categoria_id) REFERENCES categorias(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS compras (
  id           INT PRIMARY KEY,
  producto_id  INT,
  proveedor_id INT,
  cantidad     INT NOT NULL,
  precio       DECIMAL(12,2) NOT NULL,
  fecha        DATE NOT NULL,
  obs          VARCHAR(255),
  CONSTRAINT fk_compra_prod FOREIGN KEY (producto_id) REFERENCES productos(id) ON DELETE SET NULL,
  CONSTRAINT fk_compra_prov FOREIGN KEY (proveedor_id) REFERENCES proveedores(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS ventas (
  id          INT PRIMARY KEY,
  producto_id INT,
  cliente_id  INT,
  cantidad    INT NOT NULL,
  precio      DECIMAL(12,2) NOT NULL,
  fecha       DATE NOT NULL,
  total       DECIMAL(12,2) NOT NULL,
  CONSTRAINT fk_venta_prod FOREIGN KEY (producto_id) REFERENCES productos(id) ON DELETE SET NULL,
  CONSTRAINT fk_venta_cli  FOREIGN KEY (cliente_id) REFERENCES clientes(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS movimientos (
  id          INT PRIMARY KEY,
  tipo        VARCHAR(12) NOT NULL,   -- entrada | salida | ajuste
  signo       VARCHAR(1),             -- para ajustes: + o -
  producto_id INT,
  cantidad    INT NOT NULL,
  fecha       DATE NOT NULL,
  usuario     VARCHAR(80),
  obs         VARCHAR(255),
  CONSTRAINT fk_mov_prod FOREIGN KEY (producto_id) REFERENCES productos(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS pedidos (
  id          INT PRIMARY KEY,
  cliente_id  INT,
  total       DECIMAL(12,2) NOT NULL DEFAULT 0,
  nota        VARCHAR(255),
  fecha       DATE NOT NULL,
  estado      VARCHAR(16) NOT NULL DEFAULT 'pendiente',
  metodo_pago VARCHAR(20),
  comprobante LONGTEXT,
  CONSTRAINT fk_ped_cli FOREIGN KEY (cliente_id) REFERENCES clientes(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS pedido_items (
  id          INT AUTO_INCREMENT PRIMARY KEY,
  pedido_id   INT NOT NULL,
  producto_id INT,
  cantidad    INT NOT NULL,
  precio      DECIMAL(12,2) NOT NULL,
  subtotal    DECIMAL(12,2) NOT NULL,
  CONSTRAINT fk_item_ped FOREIGN KEY (pedido_id) REFERENCES pedidos(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS mensajes (
  id        INT PRIMARY KEY,
  pedido_id INT NOT NULL,
  autor     VARCHAR(16) NOT NULL,   -- cliente | admin
  texto     TEXT NOT NULL,
  fecha     DATETIME NOT NULL,
  leido     TINYINT NOT NULL DEFAULT 0
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS empresas (
  id           INT AUTO_INCREMENT PRIMARY KEY,
  slug         VARCHAR(90) UNIQUE,
  nombre       VARCHAR(120) NOT NULL,
  rubro        VARCHAR(60),
  descripcion  VARCHAR(255),
  telefono     VARCHAR(40),
  ciudad       VARCHAR(80),
  pais         VARCHAR(60),
  logo         LONGTEXT,
  correo       VARCHAR(120),
  estado       VARCHAR(16) NOT NULL DEFAULT 'pendiente',  -- pendiente | activa
  verify_token VARCHAR(80),
  created_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
