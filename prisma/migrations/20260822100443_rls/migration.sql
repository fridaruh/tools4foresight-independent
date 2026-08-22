-- Row Level Security: la segunda barrera del aislamiento por tenant (PLAN §1.2).
--
-- Por qué existe: el grafo y los embeddings se escriben con $queryRaw/$executeRaw,
-- que no pasan por la extensión de Prisma que inyecta ownerId. Si un raw SQL se
-- olvida del owner, Postgres corta.
--
-- Cómo se activa en runtime: src/lib/tenant-db.ts -> withOwner(ownerId, fn) abre una
-- transacción y hace `SELECT set_config('app.owner_id', <ownerId>, true)`. El `true`
-- final es LOCAL: muere con la transacción, así que es seguro con el pooler de Neon
-- (pgbouncer en transaction mode). FUERA de una transacción set_config NO sirve: la
-- conexión se recicla entre requests.
--
-- Escape hatch: `app.bypass_rls = 'on'` (withPlatformBypass) para el seed de un
-- usuario nuevo y para el panel de plataforma. También es LOCAL a la transacción.
--
-- IMPORTANTE (rol de la app): en Neon el rol `neondb_owner` tiene el atributo
-- BYPASSRLS y NO se puede quitar (`ALTER ROLE ... NOBYPASSRLS` -> "permission
-- denied to alter role"). FORCE ROW LEVEL SECURITY no alcanza: BYPASSRLS le gana a
-- FORCE. Por eso el runtime se conecta con un rol aparte SIN BYPASSRLS (`t4f_app`,
-- ver scripts/setup-app-role.ts y DATABASE_URL) y las migraciones siguen yendo con
-- `neondb_owner` por DIRECT_URL. FORCE queda igual como cinturón extra por si algún
-- día el rol de la app llega a ser dueño de las tablas.

DO $$
DECLARE
  -- Tablas de tenant cuya columna de dueño es owner_id.
  owner_tables text[] := ARRAY[
    'liked_items',
    'liked_item_custom_fields',
    'custom_field_definitions',
    'categories',
    'semantic_links',
    'semantic_clusters',
    'graph_snapshots',
    'graph_snapshot_clusters',
    'graph_snapshot_members',
    'prompt_settings',
    'job_runs'
  ];
  -- Tablas 1:1 (o N:1) con el usuario, cuya columna de dueño es user_id.
  user_tables text[] := ARRAY[
    'ingestion_cursor',
    'x_auth_tokens',
    'user_secrets',
    'user_quotas',
    'usage_events'
  ];
  t text;
  col text;
BEGIN
  FOREACH t IN ARRAY (owner_tables || user_tables) LOOP
    col := CASE WHEN t = ANY(owner_tables) THEN 'owner_id' ELSE 'user_id' END;

    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);

    -- USING filtra lo que se lee/actualiza/borra; WITH CHECK impide escribir una
    -- fila con un dueño distinto al del contexto. current_setting(..., true)
    -- devuelve NULL si nadie fijó el contexto: NULL = texto -> NULL -> la fila no
    -- pasa. Sin withOwner() no se ve ni se escribe nada.
    EXECUTE format($pol$
      CREATE POLICY tenant_isolation ON %I
        USING (
          %I = current_setting('app.owner_id', true)
          OR current_setting('app.bypass_rls', true) = 'on'
        )
        WITH CHECK (
          %I = current_setting('app.owner_id', true)
          OR current_setting('app.bypass_rls', true) = 'on'
        )
    $pol$, t, col, col);
  END LOOP;
END
$$;

-- Privilegios del rol de la app sobre lo que ya existe y sobre lo que creen las
-- migraciones futuras. Va condicionado a que el rol exista para que la migración
-- corra igual en una DB donde todavía no se creó (scripts/setup-app-role.ts).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 't4f_app') THEN
    GRANT USAGE ON SCHEMA public TO t4f_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO t4f_app;
    GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO t4f_app;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public
      GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO t4f_app;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public
      GRANT USAGE, SELECT ON SEQUENCES TO t4f_app;
  END IF;
END
$$;
