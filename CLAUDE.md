# CLAUDE.md — Reglas del repo tools4foresight

Decisiones de arquitectura que cada feature debe respetar.

## 1. Todo query a tablas tenant lleva ownerId

Cada tabla con `owner_id` está protegida por RLS (Row-Level Security) en Postgres. Además, existe una barrera de aplicación (`tenantClient`) que inyecta el `ownerId` en los queries ORM.

**Raw SQL va dentro de `withOwner`:**

```typescript
// ✓ Correcto
const items = await withOwner(userId, (tx) =>
  tx.$queryRaw`SELECT id FROM liked_items WHERE owner_id = ${userId} AND publish_status = 'published'`
);

// ✗ Incorrecto — raw SQL fuera de withOwner devuelve 0 filas
const items = await prisma.$queryRaw`SELECT * FROM liked_items WHERE id = '123'`;
```

**Prisma ORM:** usa `tenantClient(ownerId)` para queries automatizadas:

```typescript
import { tenantClient } from "@/lib/tenant-db";

const tx = tenantClient(userId);
const items = await tx.likedItem.findMany({
  where: { publishStatus: "published" },
});
// El tenantClient ya inyecta owner_id = userId en el WHERE
```

**Modelos de tenant** (que tienen `owner_id` o `user_id`):

- likedItem, likedItemCustomField, customFieldDefinition
- category, semanticLink, semanticCluster
- graphSnapshot, graphSnapshotCluster, graphSnapshotMember
- promptSetting, jobRun
- ingestionCursor, xAuthToken, userSecret, userQuota, usageEvent

Ver `src/lib/tenant-db.ts` → `TENANT_MODEL_FIELD`.

**Tablas SIN RLS, y por qué:** `users`, `sessions`, `accounts`, `verifications`,
`api_keys`, `rate_limits`, `platform_flags`.

`api_keys` es la excepción que hay que entender antes de tocarla: `resolveApiKey()`
(`src/lib/api-keys.ts`) es **el query que descubre quién es el tenant** cuando la
credencial es un `Bearer` y no una cookie. Corre antes de que exista un
`app.owner_id` que fijar, así que con una política de RLS encima devolvería cero
filas siempre y nadie podría autenticarse contra `/api/public/v1` ni contra el MCP —
exactamente el mismo argumento circular que ya aplica a las tablas de better-auth.

La compensación no es opcional: **todo** acceso a `api_keys` usa el `prisma` global
(no `tenantClient`, que no la conoce) y lleva `userId` en el `where`, sin excepción.
La única lectura sin `userId` es la del `keyHash`, y ese hash ES la credencial.
`scripts/qa-tenant-isolation.ts` verifica que la lista de tablas sin política sea
exactamente la declarada, para que ninguna excepción sea un hueco silencioso.

## 2. No mantener transacciones abiertas durante llamadas LLM/HTTP

Las transacciones de Postgres (especialmente con el pooler de Neon) tienen timeout y limitan concurrencia. Una llamada a Claude o X API puede tardar segundos.

**Patrón:**

```typescript
// ✓ Correcto: datos dentro de la transacción, LLM fuera
const items = await withOwner(userId, (tx) =>
  tx.likedItem.findMany({ take: 10 })
);

for (const item of items) {
  const foresight = await generateForesight(item); // LLM fuera
  await withOwner(userId, (tx) =>
    tx.likedItem.update({
      where: { id: item.id },
      data: { foresight },
    })
  );
}

// ✗ Incorrecto: LLM dentro de la transacción
const result = await withOwner(userId, async (tx) => {
  const items = await tx.likedItem.findMany();
  return Promise.all(
    items.map(async (item) => {
      const foresight = await generateForesight(item); // ← MAL
      return tx.likedItem.update(/* ... */);
    })
  );
});
```

## 3. Jobs implementan JobFn y corren por tenant

Cada job (ingest, fetch, categorize, analyze, embed, graph) exporta una función que cumple el contrato `JobFn`:

```typescript
export const ingestLikes: JobFn = async (ctx: JobContext): Promise<JobResult> => {
  const { ownerId, budgetMs, startedAt, runId, trigger } = ctx;

  if (budgetExceeded(ctx)) {
    return { ok: true, processed: 0, remaining: 0, stoppedOnBudget: true };
  }

  // Trabajo del job...
  // Todo acceso a datos de tenant: withOwner(ownerId, ...) o tenantClient(ownerId)

  return {
    ok: true,
    processed: itemsProcessed,
    remaining: itemsRemaining,
    stoppedOnBudget: false,
  };
};
```

**El dispatcher** (`src/lib/jobs/dispatcher.ts`) enumera tenants y lanza `/api/jobs/<job>/run?owner=…` — el job nunca elige para sí mismo sobre qué tenant trabajar.

## 4. Nunca ANTHROPIC_API_KEY global

Cada usuario trae su propia clave (cifrada en `user_secrets`). Nunca almacenar una key global en `.env`.

**Patrón:**

```typescript
// ✓ Correcto
const apiKey = await getAnthropicApiKey(userId);
const client = new Anthropic({ apiKey });
const msg = await client.messages.create({ /* ... */ });

// ✗ Incorrecto
const globalClient = new Anthropic(); // Usa process.env.ANTHROPIC_API_KEY global
```

Ver `src/lib/foresight.ts` para la implementación.

## 5. Correr `npm run qa` antes de commitear cambios en jobs o schema

QA unificado ejecuta todos los tests:

```bash
npm run qa
```

Debe estar 100% verde antes de mergear.

- `qa:tenant` — aislamiento RLS
- `qa:quota` — cuota atómica
- `qa:graph` — grafo por tenant
- `qa:jobs` — jobs aceptados
- `qa:dispatch` — dispatcher
- `qa:ui` — UI smoke
- `qa:cats` — categorías

## 6. Next.js 16: leer `node_modules/next/dist/docs` antes de usar APIs

Next.js 16 tiene breaking changes respecto a versiones anteriores. Las convenciones, APIs y file structure pueden diferir de los datos de entrenamiento.

Antes de usar cualquier API de Next (App Router, middleware, server components, route handlers, etc.):

```bash
# Leer la documentación oficial en el node_modules
cat node_modules/next/dist/docs/[tema]

# O en el browser: https://nextjs.org/docs
```

Comunes en este proyecto:

- `next/navigation` — `useRouter`, `usePathname`, `useSearchParams`
- Route handlers (`src/app/api/*/route.ts`) — `NextRequest`, `NextResponse`
- Server Components — por defecto, async components
- Middleware — `middleware.ts` en el root de `src/app`

<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

## Otras notas

- **Database:** Neon (Postgres + pgvector). `DATABASE_URL` usa rol `t4f_app` (sin BYPASSRLS); `DIRECT_URL` usa owner.
- **Auth:** better-auth. Session en cookies, user context via `requireUserApi()` / `requireUserPage()`.
- **Schema changes:** Migrations con Prisma. En CI corre contra un branch de Neon, nunca contra prod.
- **Roles:** `user` (defecto) vs `platform_admin` (Frida, solo `/admin`).
- **Secrets:** AES-256-GCM con versioning (`v1.` prefix). Ver `src/lib/token-crypto.ts`.
- **Rate limits:** tabla `rate_limits` en Postgres (INSERT ... ON CONFLICT).
