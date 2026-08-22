-- Tabla de rate limit distribuida en Postgres (sin RLS, tabla global).
-- Se usa con INSERT ... ON CONFLICT para evitar race conditions.
CREATE TABLE rate_limits (
  key TEXT PRIMARY KEY,
  count INT NOT NULL DEFAULT 0,
  window_start TIMESTAMPTZ NOT NULL
);

-- Índice para limpiar entradas antiguas (no es crítico, se puede agregar más adelante)
CREATE INDEX rate_limits_window_start ON rate_limits (window_start);
