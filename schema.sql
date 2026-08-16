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
  tipos_negocio JSON,
  rubro        VARCHAR(60),
  rubros       JSON,
  descripcion  VARCHAR(255),
  telefono     VARCHAR(40),
  ciudad       VARCHAR(80),
  pais         VARCHAR(60),
  logo         LONGTEXT,
  correo       VARCHAR(120),
  contacto_publico VARCHAR(120),
  correo_publico VARCHAR(120),
  estado       VARCHAR(16) NOT NULL DEFAULT 'pendiente',  -- pendiente | activa
  verify_token VARCHAR(80),
  visitas      INT NOT NULL DEFAULT 0,  -- veces que se abrió su tienda pública (GET /api/catalog) — para "destacadas"
  created_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Solicitudes de registro SIN confirmar todavía. Aquí espera la empresa
-- mientras el dueño no haya hecho clic en el enlace del correo. Al confirmar,
-- se convierte en una fila real de `empresas` + `users` y se borra de aquí.
-- Si nunca se confirma, nunca se crea la empresa ni la cuenta.
CREATE TABLE IF NOT EXISTS registros_pendientes (
  token         VARCHAR(80) PRIMARY KEY,
  nombre        VARCHAR(120) NOT NULL,
  tipos_negocio JSON,
  rubro         VARCHAR(60),
  rubros        JSON,
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

-- Código de un solo uso que entrega la sesión administrativa después de
-- confirmar el correo. Nunca se coloca el JWT real dentro de una URL.
CREATE TABLE IF NOT EXISTS onboarding_sessions (
  code       VARCHAR(80) PRIMARY KEY,
  user_id    INT NOT NULL,
  expires_at DATETIME NOT NULL,
  used_at    DATETIME,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  KEY idx_onboarding_user (user_id)
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
  galeria    JSON,
  pago       JSON,
  PRIMARY KEY (empresa_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Secuencias de id que usa el front-end (nuevoId): una fila por empresa
CREATE TABLE IF NOT EXISTS app_meta (
  empresa_id INT PRIMARY KEY,
  seq        JSON,
  version    INT NOT NULL DEFAULT 0
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Usuarios del sistema: una sola identidad por correo. Un admin conserva su
-- rol, pero también puede comprar y administrar sus datos de entrega.
-- El cliente es una cuenta GLOBAL (empresa_id=NULL), no ligada a una tienda.
CREATE TABLE IF NOT EXISTS users (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  nombre        VARCHAR(80)  NOT NULL,
  email         VARCHAR(120) UNIQUE,
  password_hash VARCHAR(120) NOT NULL,
  role          ENUM('admin','proveedor','cliente') NOT NULL DEFAULT 'cliente',
  empresa_id    INT,                       -- empresa a la que pertenece (NULL = admin de plataforma o cliente global)
  ref_id        INT,                       -- id de proveedor asociado (si aplica)
  telefono      VARCHAR(30),                -- datos personales y de entrega
  direccion     VARCHAR(160),               -- dirección principal de compra
  direcciones   JSON,                       -- libreta de direcciones del cliente global
  whatsapp      VARCHAR(24),                -- contacto para compras
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
  origen     VARCHAR(20) NOT NULL DEFAULT 'registrado', -- registrado | no_registrado
  estado     VARCHAR(12) NOT NULL DEFAULT 'activo',
  PRIMARY KEY (empresa_id, id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Agenda propia del emprendimiento. Estos registros NO crean una cuenta
-- SIWEPE ni una contraseña para el cliente; sirven para ventas y seguimiento
-- manual del negocio sin mezclar identidades globales.
CREATE TABLE IF NOT EXISTS clientes_empresa (
  id          INT AUTO_INCREMENT PRIMARY KEY,
  empresa_id  INT NOT NULL,
  nombre      VARCHAR(120) NOT NULL,
  telefono    VARCHAR(30),
  correo      VARCHAR(120),
  whatsapp    VARCHAR(24),
  direccion   VARCHAR(180),
  created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  KEY idx_cliente_empresa (empresa_id, nombre)
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
  stock         INT NOT NULL DEFAULT 0,       -- unidades publicadas en tienda
  stock_inventario INT NOT NULL DEFAULT 0,    -- unidades guardadas en almacén
  stock_min     INT NOT NULL DEFAULT 0,
  imagen        LONGTEXT,
  imagenes      JSON,
  estado        VARCHAR(12) NOT NULL DEFAULT 'activo',
  destacado     TINYINT NOT NULL DEFAULT 0,
  publicado_alguna_vez TINYINT NOT NULL DEFAULT 0,
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
  empresa_id        INT NOT NULL,
  id                INT NOT NULL,
  producto_id       INT,
  cliente_id        INT,          -- ya no se usa desde el front (venta directa = cliente sin cuenta); se deja por compatibilidad
  cliente_nombre     VARCHAR(120), -- venta directa/mostrador: nombre escrito a mano, no una cuenta SIWEPE
  cliente_identidad  VARCHAR(40),  -- opcional
  pedido_id          INT,          -- pedido de origen (NULL = venta directa)
  estado             VARCHAR(12) NOT NULL DEFAULT 'activa', -- activa | anulada
  origen_stock       VARCHAR(24) NOT NULL DEFAULT 'tienda', -- tienda | inventario | mixto
  stock_tienda_usado INT NOT NULL DEFAULT 0,
  stock_inventario_usado INT NOT NULL DEFAULT 0,
  cantidad    INT NOT NULL,
  precio      DECIMAL(12,2) NOT NULL,
  fecha       DATE NOT NULL,
  total       DECIMAL(12,2) NOT NULL,
  PRIMARY KEY (empresa_id, id),
  KEY idx_venta_pedido (empresa_id, pedido_id)
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
  pago_estado VARCHAR(24) NOT NULL DEFAULT 'pendiente',
  pago_referencia VARCHAR(80),
  comprobante LONGTEXT,
  destinatario VARCHAR(120),
  telefono_entrega VARCHAR(30),
  direccion_entrega VARCHAR(240),
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

-- ============================================================
--  VISTAS DE SOLO LECTURA — separan `users` visualmente por rol
--  para que no se vea todo mezclado en un cliente de MySQL.
--  IMPORTANTE: `users` sigue siendo la única tabla real (login,
--  checkout, sesión y "una cuenta por correo" dependen de eso).
--  Estas vistas son solo para mirar los datos más ordenados;
--  nunca escribas en ellas ni las trates como tablas separadas.
--  Nunca incluyen password_hash.
-- ============================================================
CREATE OR REPLACE VIEW v_administradores AS
  SELECT id, nombre, email, role, empresa_id, ref_id, activo, created_at
  FROM users WHERE role IN ('admin','proveedor');

CREATE OR REPLACE VIEW v_clientes AS
  SELECT id, nombre, email, telefono, direccion, whatsapp, activo, created_at
  FROM users WHERE role='cliente';
