-- EmpMonitor Postgres edition schema.
-- Designed for Neon free tier (0.5 GB): activity is stored pre-aggregated per hour,
-- screenshots live in object storage / disk (only ~100 bytes of metadata per image here).

CREATE TABLE IF NOT EXISTS admins (
  id            SERIAL PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL DEFAULT '',
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'admin' CHECK (role IN ('admin','viewer')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS settings (
  key        TEXT PRIMARY KEY,
  value      JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS departments (
  id   SERIAL PRIMARY KEY,
  name TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS employees (
  id            SERIAL PRIMARY KEY,
  name          TEXT NOT NULL,
  email         TEXT,
  department_id INT REFERENCES departments(id) ON DELETE SET NULL,
  active        BOOLEAN NOT NULL DEFAULT true,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS devices (
  id              SERIAL PRIMARY KEY,
  uuid            UUID NOT NULL UNIQUE,
  name            TEXT NOT NULL,
  hostname        TEXT NOT NULL DEFAULT '',
  os              TEXT NOT NULL DEFAULT '',
  os_version      TEXT NOT NULL DEFAULT '',
  agent_version   TEXT NOT NULL DEFAULT '',
  os_user         TEXT NOT NULL DEFAULT '',
  employee_id     INT REFERENCES employees(id) ON DELETE SET NULL,
  policy_override JSONB NOT NULL DEFAULT '{}'::jsonb,
  status          TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
  token_version   INT NOT NULL DEFAULT 1,
  enrolled_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen       TIMESTAMPTZ,
  last_ip         TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS enroll_tokens (
  id          SERIAL PRIMARY KEY,
  code        TEXT NOT NULL UNIQUE,
  label       TEXT NOT NULL DEFAULT '',
  employee_id INT REFERENCES employees(id) ON DELETE SET NULL,
  uses_left   INT,            -- NULL = unlimited (fleet / mass-deployment key)
  expires_at  TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS productivity_rules (
  id       SERIAL PRIMARY KEY,
  kind     TEXT NOT NULL CHECK (kind IN ('app','domain')),
  pattern  TEXT NOT NULL,
  category SMALLINT NOT NULL CHECK (category IN (-1,0,1)), -- -1 unproductive, 0 neutral, 1 productive
  UNIQUE (kind, pattern)
);

-- Per device, per org-local hour: active/idle seconds + first/last activity.
CREATE TABLE IF NOT EXISTS activity_device (
  day         DATE NOT NULL,
  hour        SMALLINT NOT NULL,
  device_id   INT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  employee_id INT,
  active_s    INT NOT NULL DEFAULT 0,
  idle_s      INT NOT NULL DEFAULT 0,
  first_at    TIMESTAMPTZ NOT NULL,
  last_at     TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (day, device_id, hour)
);

-- Per device, per org-local hour, per app/domain: active seconds.
CREATE TABLE IF NOT EXISTS activity_app (
  day         DATE NOT NULL,
  hour        SMALLINT NOT NULL,
  device_id   INT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  employee_id INT,
  app         TEXT NOT NULL,
  domain      TEXT NOT NULL DEFAULT '',
  seconds     INT NOT NULL DEFAULT 0,
  PRIMARY KEY (day, device_id, hour, app, domain)
);
CREATE INDEX IF NOT EXISTS activity_app_emp_idx ON activity_app (employee_id, day);
CREATE INDEX IF NOT EXISTS activity_device_emp_idx ON activity_device (employee_id, day);

CREATE TABLE IF NOT EXISTS screenshots (
  id          BIGSERIAL PRIMARY KEY,
  device_id   INT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  employee_id INT,
  taken_at    TIMESTAMPTZ NOT NULL,
  storage_key TEXT NOT NULL UNIQUE,
  bytes       INT NOT NULL DEFAULT 0,
  width       SMALLINT NOT NULL DEFAULT 0,
  height      SMALLINT NOT NULL DEFAULT 0,
  app         TEXT NOT NULL DEFAULT '',
  domain      TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS screenshots_device_time_idx ON screenshots (device_id, taken_at DESC);
CREATE INDEX IF NOT EXISTS screenshots_time_idx ON screenshots (taken_at DESC);
CREATE INDEX IF NOT EXISTS screenshots_emp_time_idx ON screenshots (employee_id, taken_at DESC);

CREATE TABLE IF NOT EXISTS audit_log (
  id         BIGSERIAL PRIMARY KEY,
  at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  admin_id   INT,
  action     TEXT NOT NULL,
  detail     JSONB NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS audit_log_at_idx ON audit_log (at DESC);
