/**
 * Aislamiento por tenant: las dos barreras.
 *
 * ┌─ Barrera 1 (Postgres) ─ RLS ─────────────────────────────────────────────┐
 * │ Cada tabla de tenant tiene una política que compara su columna de dueño   │
 * │ contra `current_setting('app.owner_id')`. Ese setting lo fija `withOwner`  │
 * │ y SOLO vive dentro de una transacción.                                     │
 * └───────────────────────────────────────────────────────────────────────────┘
 * ┌─ Barrera 2 (aplicación) ─ tenantClient ──────────────────────────────────┐
 * │ Una extensión de Prisma que inyecta `ownerId`/`userId` en el `where` y el  │
 * │ `data` de todas las operaciones de los modelos de tenant, para que un      │
 * │ query mal escrito falle en vacío en vez de leer de más.                    │
 * └───────────────────────────────────────────────────────────────────────────┘
 *
 * REGLA DURA — raw SQL:
 *   Todo `$queryRaw` / `$executeRaw` sobre tablas de tenant DEBE ir DENTRO de
 *   `withOwner()`. La extensión de Prisma no puede reescribir SQL crudo; lo único
 *   que protege esos queries es la política de RLS, y la política solo ve el
 *   `app.owner_id` que puso `withOwner`. Fuera de `withOwner`, un `$queryRaw`
 *   devuelve **cero filas** (no un error): es fácil confundirlo con "no hay datos".
 *
 * REGLA DURA — el pooler de Neon:
 *   DATABASE_URL apunta al pooler (pgbouncer, transaction mode). Ahí una conexión
 *   se recicla entre requests, así que `set_config(..., false)` (nivel sesión) es
 *   inservible y además peligroso: el contexto de un usuario podría filtrarse a la
 *   request de otro. Por eso `withOwner` usa siempre `set_config(..., true)`
 *   (LOCAL a la transacción), que sí funciona a través del pooler.
 *   Consecuencia: **toda lectura de tenant** —jobs, route handlers y páginas
 *   (Server Components)— pasa por `withOwner()` o por `tenantClient()`.
 *   `tenantClient()` no fija el contexto de Postgres; filtra en la aplicación, así
 *   que sirve para queries de Prisma sueltas pero NO habilita raw SQL.
 *
 * TABLAS SIN RLS, Y POR QUÉ (revisión de seguridad, PLAN 5.4):
 *   - `users`, `sessions`, `accounts`, `verifications`: son de better-auth. Las
 *     dos últimas tienen `user_id`, pero ponerles la política de tenant sería
 *     circular: `getSession()` corre ANTES de que exista un `app.owner_id` que
 *     fijar — es justamente el query que descubre quién es el usuario. Se
 *     acceden solo a través de better-auth (`auth.api.*`) o, en los tres puntos
 *     que lo necesitan (`/api/perfil`, `/api/perfil/password`, `/perfil`),
 *     con un `where` que siempre lleva el `userId` de la sesión.
 *   - `rate_limits`, `platform_flags`: no son de tenant, son de la plataforma.
 *     No guardan nada de nadie (un contador por IP/email, un flag global).
 *   - `_prisma_migrations`: metadata de Prisma.
 * Toda tabla del PIPELINE con `owner_id`/`user_id` sí tiene política — la lista
 * es exactamente `TENANT_MODEL_FIELD` de abajo, y `scripts/qa-tenant-isolation.ts`
 * la verifica contra la DB en cada corrida de `npm run qa`.
 *
 * Nota sobre el rol de la base: el runtime se conecta como `t4f_app`, que NO tiene
 * BYPASSRLS. Si alguien apunta DATABASE_URL a `neondb_owner` (que en Neon sí tiene
 * BYPASSRLS y no se le puede quitar), la barrera 1 desaparece en silencio.
 * Ver scripts/setup-app-role.ts y scripts/qa-tenant-isolation.ts.
 */
import { prisma } from "@/lib/prisma";
import type { Prisma } from "@/generated/prisma/client";

/** El cliente que recibe el callback de `withOwner`: un `tx` de Prisma. */
export type TenantTx = Prisma.TransactionClient;

/** Tope por defecto de una transacción de tenant. Los jobs largos suben el suyo. */
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_WAIT_MS = 10_000;

export type WithOwnerOptions = {
  /** Tope de la transacción. Un job de grafo puede necesitar 120_000. */
  timeoutMs?: number;
  /** Cuánto esperar por una conexión del pool antes de fallar. */
  maxWaitMs?: number;
};

/**
 * Corre `fn` dentro de una transacción con `app.owner_id = ownerId`.
 *
 * Todo lo que pase por `tx` —incluido `tx.$queryRaw`— queda acotado al tenant por
 * las políticas de RLS. Es la única forma segura de correr SQL crudo.
 *
 *   const items = await withOwner(userId, (tx) =>
 *     tx.$queryRaw`SELECT id FROM liked_items WHERE publish_status = 'published'`
 *   );
 */
export async function withOwner<T>(
  ownerId: string,
  fn: (tx: TenantTx) => Promise<T>,
  opts: WithOwnerOptions = {},
): Promise<T> {
  assertOwnerId(ownerId);
  return prisma.$transaction(
    async (tx) => {
      // Parametrizado ($executeRaw, no Unsafe): el ownerId viene de una sesión,
      // pero interpolarlo a mano en SQL sería una inyección esperando a pasar.
      // El tercer argumento `true` = LOCAL: se descarta al cerrar la transacción.
      await tx.$executeRaw`SELECT set_config('app.owner_id', ${ownerId}, true)`;
      return fn(tx);
    },
    {
      timeout: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      maxWait: opts.maxWaitMs ?? DEFAULT_MAX_WAIT_MS,
    },
  );
}

/**
 * Corre `fn` con `app.bypass_rls = 'on'`: ve y escribe en TODOS los tenants.
 *
 * Usos legítimos, y ninguno más:
 *   - sembrar un usuario recién creado (src/lib/seed-tenant.ts), cuando todavía no
 *     hay sesión desde la cual fijar `app.owner_id`;
 *   - el panel de plataforma / los scripts de operación (platform_admin, Fase 5);
 *   - el dispatcher de crons, para enumerar tenants elegibles.
 *
 * Nunca en un route handler que atienda a un usuario final.
 */
export async function withPlatformBypass<T>(
  fn: (tx: TenantTx) => Promise<T>,
  opts: WithOwnerOptions = {},
): Promise<T> {
  return prisma.$transaction(
    async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.bypass_rls', 'on', true)`;
      return fn(tx);
    },
    {
      timeout: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      maxWait: opts.maxWaitMs ?? DEFAULT_MAX_WAIT_MS,
    },
  );
}

function assertOwnerId(ownerId: string): void {
  if (typeof ownerId !== "string" || ownerId.trim() === "") {
    throw new Error("withOwner: ownerId vacío — nunca correr un query de tenant sin dueño");
  }
}

// ---------------------------------------------------------------------------
// tenantClient: la barrera de aplicación
// ---------------------------------------------------------------------------

/**
 * Modelo de Prisma -> nombre del campo que guarda al dueño.
 * Si agregas un modelo de tenant al schema, agrégalo AQUÍ y a la migración de RLS.
 */
export const TENANT_MODEL_FIELD = {
  likedItem: "ownerId",
  likedItemCustomField: "ownerId",
  customFieldDefinition: "ownerId",
  category: "ownerId",
  semanticLink: "ownerId",
  semanticCluster: "ownerId",
  macroCluster: "ownerId",
  graphSnapshot: "ownerId",
  graphSnapshotCluster: "ownerId",
  graphSnapshotMember: "ownerId",
  promptSetting: "ownerId",
  jobRun: "ownerId",
  ingestionCursor: "userId",
  xAuthToken: "userId",
  userQuota: "userId",
  usageEvent: "userId",
} as const;

export type TenantModel = keyof typeof TENANT_MODEL_FIELD;

const TENANT_MODELS = Object.keys(TENANT_MODEL_FIELD) as TenantModel[];

function isTenantModel(model: string | undefined): model is TenantModel {
  return model !== undefined && (TENANT_MODELS as string[]).includes(model);
}

type AnyArgs = Record<string, unknown>;

function withOwnerWhere(args: AnyArgs, field: string, ownerId: string): AnyArgs {
  const where = (args.where as AnyArgs | undefined) ?? {};
  return { ...args, where: { ...where, [field]: ownerId } };
}

function withOwnerData(args: AnyArgs, field: string, ownerId: string): AnyArgs {
  const data = args.data;
  if (Array.isArray(data)) {
    return { ...args, data: data.map((row) => ({ ...(row as AnyArgs), [field]: ownerId })) };
  }
  if (data && typeof data === "object") {
    return { ...args, data: { ...(data as AnyArgs), [field]: ownerId } };
  }
  return args;
}

/**
 * Un cliente de Prisma "atado" a un tenant.
 *
 * - `create` / `createMany` / `upsert.create`: escriben el dueño, no hay forma de
 *   crear una fila ajena aunque el caller se olvide.
 * - `findMany` / `findFirst` / `count` / `update*` / `delete*` / `aggregate`:
 *   agregan el dueño al `where`.
 * - `findUnique` / `findUniqueOrThrow` se reescriben a `findFirst` /
 *   `findFirstOrThrow`: un `findUnique` no admite filtros extra, así que buscar
 *   por id sin poder exigir el dueño sería exactamente el bug que queremos evitar.
 *
 * Lo que NO hace: fijar `app.owner_id`. Para raw SQL usa `withOwner()`.
 */
export function tenantClient(ownerId: string) {
  assertOwnerId(ownerId);

  return prisma.$extends({
    name: "tenant-scope",
    query: {
      $allModels: {
        async $allOperations({ model, operation, args, query }) {
          const modelKey = model ? model.charAt(0).toLowerCase() + model.slice(1) : undefined;
          if (!isTenantModel(modelKey)) return query(args);

          const field = TENANT_MODEL_FIELD[modelKey];
          const a = (args ?? {}) as AnyArgs;

          // findUnique no admite filtros fuera de la clave única, así que no hay
          // forma de exigirle el dueño: lo degradamos a findFirst, que sí.
          if (operation === "findUnique" || operation === "findUniqueOrThrow") {
            const op = operation === "findUnique" ? "findFirst" : "findFirstOrThrow";
            const delegates = prisma as unknown as Record<
              string,
              Record<string, (x: unknown) => Promise<unknown>>
            >;
            return delegates[modelKey][op](withOwnerWhere(a, field, ownerId));
          }

          let next: AnyArgs = a;
          switch (operation) {
            case "create":
            case "createMany":
            case "createManyAndReturn":
              next = withOwnerData(a, field, ownerId);
              break;

            case "upsert":
              next = withOwnerData(withOwnerWhere(a, field, ownerId), field, ownerId);
              break;

            case "findFirst":
            case "findFirstOrThrow":
            case "findMany":
            case "count":
            case "aggregate":
            case "groupBy":
            case "update":
            case "updateMany":
            case "updateManyAndReturn":
            case "delete":
            case "deleteMany":
              next = withOwnerWhere(a, field, ownerId);
              break;

            default:
              // $queryRaw y compañía no pasan por aquí (no tienen `model`); si
              // apareciera una operación nueva, mejor dejarla intacta que romperla.
              next = a;
          }

          return query(next as Parameters<typeof query>[0]);
        },
      },
    },
  });
}

export type TenantClient = ReturnType<typeof tenantClient>;
