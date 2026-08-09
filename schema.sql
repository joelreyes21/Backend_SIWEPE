-- SIWEPE · © 2026 Joel Reyes. Todos los derechos reservados. · Prohibida su reproduccion o distribucion sin autorizacion.
-- ============================================================
--  SIWEPE — Esquema de base de datos (MySQL) · MULTI-EMPRESA
--  Cada tabla del negocio lleva `empresa_id`: los datos de una
--  empresa están aislados de los de las demás. La clave primaria
--  de las tablas con id asignado por la app es COMPUESTA
--  (empresa_id, id), así el id sólo tiene que ser único DENTRO de
--  cada empresa (dos empresas pueden tener su propio producto id=1).
--
--  El login de admin/proveedor usa la tabla `users` (email + clave
--  cifrada) y cada usuario guarda su `empresa_id`. El cliente entra
--  con nombre + PIN, único por empresa.
-- ============================================================

-- Catálogo de empresas (cada tienda registrada en la plataforma)
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

-- Solicitudes de registro SIN confirmar todavía. Aquí espera la empresa
-- mientras el dueño no haya hecho clic en el enlace del correo. Al confirmar,
-- se convierte en una fila real de `empresas` + `users` y se borra de aquí.
-- Si nunca se confirma, nunca se crea la empresa ni la cuenta.
CREATE TABLE IF NOT EXISTS registros_pendientes (
  token         VARCHAR(80) PRIMARY KEY,
  nombre        VARCHAR(120) NOT NULL,
  rubro         VARCHAR(60),
  descripcion   VARCHAR(255),
  telefono      VARCHAR(40),
  ciudad        VARCHAR(80),
  pais          VARCHAR(60),
  logo          LONGTEXT,
  correo        VARCHAR(120) NOT NULL,
  dueno         VARCHAR(120) NOT NULL,
  password_hash VARCHAR(120) NOT NULL,
  created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  KEY idx_reg_correo (correo)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Tokens de recuperación de contraseña (login admin/proveedor por correo).
-- Vencen a las 2 horas; se borran al usarse (ver /api/auth/reset).
CREATE TABLE IF NOT EXISTS password_resets (
  token      VARCHAR(80) PRIMARY KEY,
  user_id    INT NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  KEY idx_pwreset_user (user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Configuración del negocio: UNA fila por empresa
CREATE TABLE IF NOT EXISTS config (
  empresa_id INT          NOT NULL,
  nombre     VARCHAR(80)  NOT NULL DEFAULT 'SIWEPE',
  logo       LONGTEXT,
  moneda     VARCHAR(8)   NOT NULL DEFAULT 'L',
  tema       VARCHAR(20)  NOT NULL DEFAULT 'cielo',
  pin_admin  VARCHAR(12)  NOT NULL DEFAULT '1234',
  banners    JSON,
  pago       JSON,
  PRIMARY KEY (empresa_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Secuencias de id que usa el front-end (nuevoId): una fila por empresa
CREATE TABLE IF NOT EXISTS app_meta (
  empresa_id INT PRIMARY KEY,
  seq        JSON
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Usuarios del sistema (admin/proveedor por email+clave; el cliente va en `clientes`)
CREATE TABLE IF NOT EXISTS users (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  nombre        VARCHAR(80)  NOT NULL,
  email         VARCHAR(120) UNIQUE,
  password_hash VARCHAR(120) NOT NULL,
  role          ENUM('admin','proveedor','cliente') NOT NULL DEFAULT 'cliente',
  empresa_id    INT,                       -- empresa a la que pertenece (NULL = admin de plataforma)
  ref_id        INT,                       -- id de cliente/proveedor asociado (si aplica)
  activo        TINYINT NOT NULL DEFAULT 1,
  created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS categorias (
  empresa_id  INT NOT NULL,
  id          INT NOT NULL,
  nombre      VARCHAR(80) NOT NULL,
  descripcion VARCHAR(255),
  estado      VARCHAR(12) NOT NULL DEFAULT 'activo',
  PRIMARY KEY (empresa_id, id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS proveedores (
  empresa_id INT NOT NULL,
  id         INT NOT NULL,
  nombre     VARCHAR(80) NOT NULL,
  telefono   VARCHAR(30),
  correo     VARCHAR(120),
  empresa    VARCHAR(80),
  direccion  VARCHAR(160),
  whatsapp   VARCHAR(24),
  estado     VARCHAR(12) NOT NULL DEFAULT 'activo',
  PRIMARY KEY (empresa_id, id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS clientes (
  empresa_id INT NOT NULL,
  id         INT NOT NULL,
  nombre     VARCHAR(80) NOT NULL,
  telefono   VARCHAR(30),
  correo     VARCHAR(120),
  direccion  VARCHAR(160),
  whatsapp   VARCHAR(24),
  pin        VARCHAR(60) NOT NULL DEFAULT '0000',
  registrado TINYINT NOT NULL DEFAULT 1,
  PRIMARY KEY (empresa_id, id),
  KEY idx_cli_nombre (empresa_id, nombre)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS productos (
  empresa_id    INT NOT NULL,
  id            INT NOT NULL,
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
  PRIMARY KEY (empresa_id, id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS compras (
  empresa_id   INT NOT NULL,
  id           INT NOT NULL,
  producto_id  INT,
  proveedor_id INT,
  cantidad     INT NOT NULL,
  precio       DECIMAL(12,2) NOT NULL,
  fecha        DATE NOT NULL,
  obs          VARCHAR(255),
  PRIMARY KEY (empresa_id, id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS ventas (
  empresa_id  INT NOT NULL,
  id          INT NOT NULL,
  producto_id INT,
  cliente_id  INT,
  cantidad    INT NOT NULL,
  precio      DECIMAL(12,2) NOT NULL,
  fecha       DATE NOT NULL,
  total       DECIMAL(12,2) NOT NULL,
  PRIMARY KEY (empresa_id, id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS movimientos (
  empresa_id  INT NOT NULL,
  id          INT NOT NULL,
  tipo        VARCHAR(12) NOT NULL,   -- entrada | salida | ajuste
  signo       VARCHAR(1),             -- para ajustes: + o -
  producto_id INT,
  cantidad    INT NOT NULL,
  fecha       DATE NOT NULL,
  usuario     VARCHAR(80),
  obs         VARCHAR(255),
  PRIMARY KEY (empresa_id, id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS pedidos (
  empresa_id  INT NOT NULL,
  id          INT NOT NULL,
  cliente_id  INT,
  total       DECIMAL(12,2) NOT NULL DEFAULT 0,
  nota        VARCHAR(255),
  fecha       DATE NOT NULL,
  estado      VARCHAR(16) NOT NULL DEFAULT 'pendiente',
  metodo_pago VARCHAR(20),
  comprobante LONGTEXT,
  PRIMARY KEY (empresa_id, id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS pedido_items (
  id          INT AUTO_INCREMENT PRIMARY KEY,
  empresa_id  INT NOT NULL,
  pedido_id   INT NOT NULL,
  producto_id INT,
  cantidad    INT NOT NULL,
  precio      DECIMAL(12,2) NOT NULL,
  subtotal    DECIMAL(12,2) NOT NULL,
  KEY idx_item_ped (empresa_id, pedido_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS mensajes (
  empresa_id INT NOT NULL,
  id         INT NOT NULL,
  pedido_id  INT NOT NULL,
  autor      VARCHAR(16) NOT NULL,   -- cliente | admin
  texto      TEXT NOT NULL,
  fecha      DATETIME NOT NULL,
  leido      TINYINT NOT NULL DEFAULT 0,
  PRIMARY KEY (empresa_id, id),
  KEY idx_msg_ped (empresa_id, pedido_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
