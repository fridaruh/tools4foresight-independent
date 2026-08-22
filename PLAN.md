# PLAN — tools4foresight multi-tenant

> Duplicar la parte **admin/curaduría** de `x-likes-curator` para que cualquier persona
> conecte su cuenta de X y construya su propio banco de señales. Sin vista de clientes,
> sin Stripe. Pensado para N usuarios desde el día uno.

Fecha: 2026-08-22 · Origen: `/Users/fridaruh/Documents/Proyectos/x-likes-curator`

---

## 0. Decisiones cerradas (respuestas de Frida)

| Tema | Decisión |
|---|---|
| Base de datos | **Neon** (Postgres + pgvector), proyecto nuevo. Prisma 7 + better-auth como el original. (Nota: el original NO está en Supabase, está en Neon) |
| Conexión X | **Una sola X App** de Frida (OAuth 2.0 PKCE). Los usuarios solo hacen "Conectar con X" |
| Cuota X por usuario | **Backfill 3 meses** (máx 3 páginas × 100 likes) al conectar + **1 corrida diaria de máx 2 páginas**. Cuota editable por usuario en DB |
| LLM foresight | **Claude, BYOK**: cada usuario guarda su `ANTHROPIC_API_KEY` (cifrada) |
| LLM resto (categorizar, PESTEL, TL;DR, impacto, por qué importa, nombrar temas) | **Ollama Cloud `gpt-oss:120b`** con la key de Frida |
| Embeddings | **OpenAI `text-embedding-3-small`** (1536 dims) con la key de Frida. Elimina la dependencia del Ollama local en la Mac |
| Visibilidad | **Privado**: cada quien ve solo su banco. `ownerId` + `publishStatus` dejan la puerta abierta |
| Alcance MVP | Catálogo + Análisis (`/`, `/enrich`) · Grafo (`/grafo`) · Horizontes (`/horizontes`) · Categorías/prompts editables por usuario · Sistema (`/conexion`) |
| Fuera | Landing de venta, `/senales`, `/categorias` member-view, favoritos, feedback, onboarding emails, Stripe, `/usuarios`, gate legacy `ADMIN_PASSWORD` |

---

## 1. Arquitectura objetivo

```
                ┌──────────── por usuario (tenant) ────────────┐
X API ─ingest─▶ liked_items(owner_id) ─fetch─▶ OG tags        │
                     ├─categorize (Ollama, key Frida)  ──▶ category (catálogo del usuario) + PESTEL
                     ├─analyze    (Ollama, key Frida)  ──▶ tldr / whyMatters / impact
                     ├─foresight  (Claude, key USUARIO) ──▶ foresight
                     ▼ usuario publica desde /enrich
                     ├─embed (OpenAI, key Frida)       ──▶ embedding vector(1536)
                     └─graph (por owner)               ──▶ semantic_links / clusters / snapshots / horizontes
                └───────────────────────────────────────────────┘

Cron Vercel (1 por etapa) ──▶ dispatcher ──▶ fan-out por tenant (Vercel Queues o self-invoke con waitUntil)
```

### Principios no negociables
1. **Toda tabla del pipeline tiene `owner_id`** y **todo query lo filtra** — incluido cada `$queryRaw`/`$executeRaw`.
2. **RLS en Postgres** como segunda barrera: los raw SQL del grafo no pasan por Prisma, así que una extensión de Prisma no basta. `SET LOCAL app.owner_id` en cada transacción de job.
3. **Los jobs son por tenant y con presupuesto de tiempo por tenant.** Un cron nunca itera N tenants en serie dentro de 300 s.
4. **Cuotas y contadores de uso por tenant** (X API, Ollama, OpenAI) persistidos en DB antes de gastar.
5. **Secretos por usuario cifrados** (AES-256-GCM con versión de clave en el blob) — mismo `token-crypto.ts` que ya existe, extendido.

---

## 2. Modelo de datos (Prisma)

### Tablas nuevas
```prisma
// Un tenant = un User. Mantengo role para "platform_admin" (Frida) vs "user".
model User { ... role String @default("user") ... }

model UserSecret {            // BYOK + futuros
  userId    String @map("user_id")
  provider  String             // "anthropic"
  encrypted String             // v1.<iv>.<tag>.<ct>
  last4     String             // para mostrar "sk-…abcd"
  verifiedAt DateTime? @map("verified_at")
  @@id([userId, provider])
}

model UserQuota {             // límites y contadores
  userId            String   @id @map("user_id")
  xPagesPerDay      Int      @default(2)
  xBackfillPages    Int      @default(3)
  xBackfillMonths   Int      @default(3)
  analyzeItemsPerDay Int     @default(150)
  xPagesUsedToday   Int      @default(0)
  analyzeUsedToday  Int      @default(0)
  windowResetAt     DateTime @map("window_reset_at")
  pipelineEnabled   Boolean  @default(true)
}

model UsageEvent {            // auditoría de costo por tenant
  id        String   @id @default(uuid())
  userId    String   @map("user_id")
  kind      String   // x_page | ollama_call | anthropic_call | openai_embed | fetch
  units     Int
  tokensIn  Int?     @map("tokens_in")
  tokensOut Int?     @map("tokens_out")
  createdAt DateTime @default(now())
  @@index([userId, createdAt(sort: Desc)])
}

model Category {              // reemplaza src/config/categories.ts
  id          String   @id @default(uuid())
  ownerId     String   @map("owner_id")
  name        String
  description String
  examples    String[] @default([])
  position    Int      @default(0)
  isFallback  Boolean  @default(false)   // "Otros"
  @@unique([ownerId, name])
}

model JobRun {                // estado de cada corrida por tenant (reemplaza el "remaining" global)
  id         String   @id @default(uuid())
  ownerId    String   @map("owner_id")
  job        String   // ingest | fetch | categorize | analyze | embed | graph
  status     String   // queued | running | ok | error | budget
  startedAt  DateTime?
  finishedAt DateTime?
  processed  Int      @default(0)
  remaining  Int      @default(0)
  error      String?
  @@index([ownerId, job, startedAt(sort: Desc)])
}
```

### Tablas existentes que cambian
| Tabla | Cambio |
|---|---|
| `XAuthToken` | `+ userId @unique` FK → User. `xUserId` deja de ser `@unique` global → `@@unique([userId])`; índice en `xUserId` |
| `IngestionCursor` | `+ userId @unique` FK. Una fila por tenant, se crea al conectar X |
| `LikedItem` | `+ ownerId` FK. `tweetId @unique` → `@@unique([ownerId, tweetId])`. Índices: `[ownerId, likedAt desc]`, `[ownerId, fetchStatus]`, `[ownerId, publishStatus]`, `[ownerId, category]`. `embedding vector(1536)` |
| `SemanticLink` | `+ ownerId`; `@@unique([ownerId, itemAId, itemBId])` |
| `SemanticCluster` | `+ ownerId` + índice |
| `GraphSnapshot` / `GraphSnapshotCluster` / `GraphSnapshotMember` | `+ ownerId` |
| `CustomFieldDefinition` | `fieldKey @unique` → `@@unique([ownerId, fieldKey])` |
| `PromptSetting` | PK `key` → `@@id([ownerId, key])` |
| **Eliminadas** | `Favorite`, `Feedback`, `OnboardingEmail`, columnas `stripe*`/`subscription*` de `User` |

### RLS (migración SQL a mano, después de `prisma migrate`)
```sql
ALTER TABLE liked_items ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON liked_items
  USING (owner_id = current_setting('app.owner_id', true)::text);
-- repetir para semantic_links, semantic_clusters, graph_snapshot*, categories,
-- custom_field_definitions, liked_item_custom_fields, prompt_settings, ingestion_cursor, x_auth_tokens
```
El rol de la app (`DATABASE_URL`) **no** debe ser owner de las tablas (owner bypassa RLS). Crear rol `t4f_app` con `NOBYPASSRLS`; migraciones con el rol owner vía `DIRECT_URL`.

---

## 3. Fases y tareas

Cada tarea lleva: archivos, criterio de aceptación y **modelo de Claude Code recomendado para implementarla** (ver §5 para la lógica de elección). Estimación en "sesiones" ≈ bloques de trabajo de Claude Code.

### Fase 0 — Scaffold y limpieza (1 sesión)
| # | Tarea | Detalle | Modelo CC |
|---|---|---|---|
| 0.1 | Copiar repo base | `rsync` de `x-likes-curator` → `tools4foresight` excluyendo `node_modules .next .git .vercel .env* tsconfig.tsbuildinfo public/landing skills .agents .hermes`. `git init`. | Haiku 4.5 |
| 0.2 | Borrar lo fuera de alcance | Eliminar: `src/components/{LandingPage,FavoritesBoard,FavoriteToggle,FavoriteButton,FeedbackBox,SubscriptionPanel,SenalesSidebar,SignalCounter}.tsx`, `src/app/{senales,suscripcion,usuarios,categorias/member-view.tsx,metodologia}`, `src/app/api/{billing,favoritos,feedback,jobs/onboarding-*}`, `src/lib/{stripe,subscription,subscription-emails,onboarding-emails,jobs/onboarding,admin-session}.ts`, `RESEARCH.md`, `WHATSTHIS.md`. Quitar deps `stripe`. Build debe pasar (puede quedar código muerto temporal). | Haiku 4.5 |
| 0.3 | Quitar gate legacy | Borrar `ADMIN_SESSION_COOKIE` de `proxy.ts`, `cron-auth.ts`, `require-admin.ts`, `login/page.tsx`. | Haiku 4.5 |
| 0.4 | Neon nuevo + env | Crear proyecto Neon, `CREATE EXTENSION vector`, rol `t4f_app` sin bypass RLS. `.env.example` nuevo con: `DATABASE_URL` (app), `DIRECT_URL` (owner, migraciones), `X_OAUTH_*`, `TOKEN_ENCRYPTION_KEY`, `OLLAMA_API_KEY/HOST/MODEL`, `OPENAI_API_KEY`, `AUTH_SECRET`, `RESEND_API_KEY`, `MAGIC_LINK_FROM_EMAIL`, `CRON_SECRET`, `NEXT_PUBLIC_APP_URL`. Sin `ANTHROPIC_API_KEY` global. | Haiku 4.5 |

**Aceptación:** `npm run build` pasa; `/login` y `/registro` funcionan contra el Neon nuevo.

### Fase 1 — Esquema multi-tenant (2 sesiones)
| # | Tarea | Detalle | Modelo CC |
|---|---|---|---|
| 1.1 | Reescribir `schema.prisma` | Todo §2. **Migración inicial única** (`prisma migrate dev --name init_multitenant`), no heredar las 20 migraciones viejas. | Sonnet 5 |
| 1.2 | Migración RLS | `prisma/migrations/<ts>_rls/migration.sql` a mano con políticas + `ALTER ... FORCE ROW LEVEL SECURITY`. | Sonnet 5 |
| 1.3 | Helper de tenant en Prisma | `src/lib/tenant-db.ts`: `withOwner(ownerId, fn)` → `$transaction` que ejecuta `SELECT set_config('app.owner_id', $1, true)` y luego `fn(tx)`. Todos los jobs y routes pasan por aquí. Extensión `$extends` que además inyecta `where.ownerId` en `findMany/updateMany/deleteMany` de los modelos tenant (cinturón + tirantes). | Opus 5 |
| 1.4 | Semilla de categorías | `src/lib/seed-categories.ts`: al crear usuario (hook `databaseHooks.user.create.after` de better-auth) insertar las 10 categorías de Frida **sin sus ejemplos personales** (ejemplos genéricos, 2 por categoría) como plantilla + `UserQuota` default + `PromptSetting` vacío. | Haiku 4.5 |
| 1.5 | Roles | `role: "user" | "platform_admin"`. `requireUserPage/Api()` → devuelve `{ userId }`; `requirePlatformAdmin()` solo para `/admin` futuro. Reemplazar todos los `requireAdminPage/Api`. | Haiku 4.5 |

**Aceptación:** test de integración: dos usuarios, cada uno inserta un `liked_item`; `SELECT` con `app.owner_id` del otro devuelve 0 filas incluso con `$queryRaw`.

### Fase 2 — Conexión X por usuario + cuotas (2 sesiones)
| # | Tarea | Detalle | Modelo CC |
|---|---|---|---|
| 2.1 | OAuth ligado a sesión | `api/auth/x/login`: exigir sesión; `state = base64url(userId + "." + nonce + "." + HMAC(AUTH_SECRET))`. `callback`: verificar HMAC, que `userId` del state == sesión actual; `upsert xAuthToken where userId`. Si `xUserId` ya pertenece a OTRO usuario → error "esa cuenta de X ya está conectada a otro usuario". Redirigir a `/conexion?x_connected=1`. | Sonnet 5 |
| 2.2 | `getValidAccessToken(userId)` | `x-client.ts`: parámetro obligatorio, `findUnique({ where: { userId } })`. Refresh con lock optimista (`updatedAt` check) para evitar doble refresh concurrente. | Sonnet 5 |
| 2.3 | Manejo de 429 y 402 | `x-client.ts`: leer `x-rate-limit-remaining` / `x-rate-limit-reset`; lanzar `XRateLimited { resetAt }` y `XCreditsDepleted`. `ingest-likes` guarda `lastStatus` y `retryAfter` en el cursor del tenant; el dispatcher salta tenants con `retryAfter > now`. Créditos agotados = flag **global** `platform_flags.x_credits_depleted` + banner para todos. | Sonnet 5 |
| 2.4 | Cuotas | `src/lib/quota.ts`: `reserve(userId, kind, n)` atómico (`UPDATE ... WHERE used + n <= limit RETURNING`), reset diario por `windowResetAt`. `ingest-likes(userId)`: `MAX_PAGES = min(quota.xPagesPerDay - used, backfillPending ? xBackfillPages : 2)`; `BACKFILL_WINDOW_MONTHS` desde `UserQuota`. Cada página → `UsageEvent`. | Opus 5 |
| 2.5 | Desconectar X | `DELETE /api/auth/x` → borra token, **no** borra items. Botón en `/conexion`. | Haiku 4.5 |
| 2.6 | Rate limit distribuido | Reemplazar `rate-limit.ts` (Map en memoria) por Upstash Redis (Vercel Marketplace) o, si no se quiere otra dependencia, tabla `rate_limits` en Postgres con `INSERT ... ON CONFLICT`. Usado en login, magic link, OAuth start. | Haiku 4.5 |

**Aceptación:** dos cuentas de X distintas conectadas a dos usuarios; `ingest` de A nunca toca B; con `xPagesPerDay=1` la segunda corrida del día devuelve `status: budget`.

### Fase 3 — Pipeline por tenant (4 sesiones) — la fase crítica
| # | Tarea | Detalle | Modelo CC |
|---|---|---|---|
| 3.1 | Firma común de jobs | `src/lib/jobs/types.ts`: `type JobFn = (ctx: { ownerId; tx; budgetMs; runId }) => Promise<{ processed; remaining; stoppedOnBudget }>`. Cada job escribe su `JobRun`. | Sonnet 5 |
| 3.2 | `ingest-likes(ctx)` | Cursor por tenant; `likedAt` estimado con el item más viejo **del tenant**; `maxLikeRank/minLikeRank` por tenant; `createMany` con `ownerId`. Declarar `maxDuration = 120`. | Sonnet 5 |
| 3.3 | `fetch-content(ctx)` | `take 15 where ownerId`; añadir rate-limit por dominio (máx 3 concurrentes por host) y `robots`-friendly UA con URL del proyecto. | Haiku 4.5 |
| 3.4 | Categorías desde DB | `categorize.ts`: `buildSystemPrompt(categories: Category[])`; catálogo del tenant cargado una vez por corrida. `jobs/categorize.ts`: `findMany where ownerId`; el `UPDATE ... FROM unnest` matchea por `(owner_id, tweet_id)`. Fallback = la categoría `isFallback` del tenant. | Sonnet 5 |
| 3.5 | PESTEL por tenant | Mismo patrón; se ejecuta con el tiempo restante del job categorize **del mismo tenant**. | Haiku 4.5 |
| 3.6 | `analyze(ctx)` | `ANALYSIS_WINDOW` y `findMany` por owner; prompts de `prompt_settings` del tenant cargados una vez por corrida (no por item); `countPending` reutiliza el conjunto ya leído. Respeta `analyzeItemsPerDay`. Etapas Ollama (tldr/impact/whyMatters) y luego foresight **solo si el tenant tiene key Anthropic verificada**; si no, se salta sin error. | Sonnet 5 |
| 3.7 | Foresight BYOK | `foresight.ts`: `getAnthropicClient(userId)` → descifra `UserSecret`, `new Anthropic({ apiKey })` **por llamada** (sin singleton; cache LRU por userId con TTL 5 min OK). `max_tokens: 1024` (hoy 16000, desperdicio). Model default `claude-sonnet-5` con `fallbacks: "default"`; el usuario puede elegir `claude-opus-5` en ajustes. Contabilizar `usage.input_tokens/output_tokens` en `UsageEvent`. Manejar 401 → marcar secreto `verifiedAt = null` y avisar en `/conexion`. | Sonnet 5 |
| 3.8 | Embeddings OpenAI | `embeddings.ts`: `POST https://api.openai.com/v1/embeddings` (`text-embedding-3-small`, `dimensions: 1536`, batch 64, fetch nativo, sin SDK). Hash incluye nombre de modelo. `jobs/embed.ts`: por owner, sólo `published`. **Entra al cron** (ya no depende de la Mac). | Sonnet 5 |
| 3.9 | `refreshGraph(ctx)` por owner | `graph.ts` (537 líneas): parametrizar **cada** SQL con `owner_id`: `recomputeLinks` (DELETE/INSERT acotados, CROSS JOIN LATERAL con `b.owner_id = a.owner_id`), centroide global → centroide del tenant, cuantiles de horizonte sobre clusters del tenant, `updateMany clusterId=null where ownerId`, snapshot con `ownerId`. Transacción con `SET LOCAL app.owner_id`. Bautizo de clusters con Ollama (key Frida), máx 25 miembros. | **Opus 5** |
| 3.10 | Debounce del grafo | El PATCH de publicar ya NO llama `refreshGraph` en `after()`. Marca `graphDirtyAt` en `UserQuota`/`JobRun`; el cron `graph` procesa solo tenants dirty. Botón "Recalcular grafo ahora" en `/conexion` con cooldown 10 min. | Haiku 4.5 |
| 3.11 | Dispatcher + fan-out | `api/jobs/<job>/route.ts` (cron): autentica `CRON_SECRET`, enumera tenants elegibles (`pipelineEnabled`, X conectado, sin `retryAfter`, con trabajo pendiente — una query por job), y por cada uno hace `fetch(self/api/jobs/<job>/run?owner=…)` con header `CRON_SECRET` **sin esperar** (`waitUntil` de `@vercel/functions`), máx 20 en paralelo. `…/run` es la función por tenant con `maxDuration=300` y `budgetMs=240000`. Si Vercel Queues está disponible en el plan, usarlo en vez del self-fetch (misma interfaz). | **Opus 5** |
| 3.12 | `/api/sync` por tenant | "Correr mi pipeline" encadena ingest→fetch→categorize→analyze para el owner de la sesión, con cooldown 30 min por tenant. | Haiku 4.5 |
| 3.13 | `process-item`, `refetch`, PATCH `[id]`, GET `[id]` | Todos: `findFirst({ where: { id, ownerId } })`; 404 si no es suyo. GET `[id]` hoy no tiene guard — añadirlo. | Haiku 4.5 |

**Aceptación:** con 3 tenants sembrados (uno con 1 000 items, dos con 50), el cron de `analyze` completa a los chicos aunque el grande corte por presupuesto; `semantic_links` de A no cambia cuando B publica; `UsageEvent` refleja cada llamada externa.

### Fase 4 — UI por usuario (3 sesiones)
| # | Tarea | Detalle | Modelo CC |
|---|---|---|---|
| 4.1 | `/` cockpit | Landing mínima sin sesión (1 pantalla: qué es + "Entrar"). Con sesión: catálogo del usuario (`LikedItemsBoard` filtrado por owner). Si no hay X conectado → empty state con CTA a `/conexion`. | Sonnet 5 |
| 4.2 | `/conexion` (Sistema) | Estado de X (+ conectar/desconectar), **ajustes de IA**: input para `ANTHROPIC_API_KEY` (se guarda cifrada, se muestra `last4`, botón "Probar" hace un `messages.create` de 5 tokens), selector de modelo foresight; cuotas del día (usadas/límite); botones de jobs por tenant; últimos `JobRun`. | Sonnet 5 |
| 4.3 | `/categorias` editable | CRUD de `Category` (nombre, descripción, ejemplos, orden, fallback) + distribución + propuestas del modelo. Botón "Re-categorizar todo (auto)" con confirmación: `UPDATE ... SET category=NULL WHERE owner_id=$1 AND category_source='auto'` (el original lo hacía por SQL a mano; aquí sí va a un click porque es por tenant). | Sonnet 5 |
| 4.4 | `/enrich` | Sin cambios funcionales; queries por owner; custom fields por owner. | Haiku 4.5 |
| 4.5 | `/grafo`, `/horizontes`, exports CSV | Queries por owner; `PATCH /api/clusters/[id]` verifica dueño. | Haiku 4.5 |
| 4.6 | Prompts | `AnalysisPromptsEditor` y `/api/prompts` por `[ownerId,key]`; botón "restaurar default". | Haiku 4.5 |
| 4.7 | `/perfil` | Nombre, email, contraseña + **borrar cuenta** (cascade: tokens, secretos, items, grafo). | Haiku 4.5 |
| 4.8 | Nav | `TopNav` sin secciones member; orden: Catálogo · Análisis · Grafo · Horizontes · Categorías · Sistema. | Haiku 4.5 |

**Aceptación:** recorrido completo de un usuario nuevo: registro → conectar X → pegar key Anthropic → "Correr mi pipeline" → ver señales categorizadas → publicar 5 → recalcular grafo → ver grafo y horizontes. Cero datos de otro usuario visibles en ninguna pantalla ni endpoint.

### Fase 5 — Operación y hardening (2 sesiones)
| # | Tarea | Detalle | Modelo CC |
|---|---|---|---|
| 5.1 | Panel `/admin` (platform_admin) | Lista de tenants, uso por tenant (X páginas, tokens Ollama/OpenAI/Anthropic), editar `UserQuota`, `pipelineEnabled`, flag global de créditos X. | Sonnet 5 |
| 5.2 | Alertas | Email (Resend) a Frida cuando: créditos X agotados, error 5 corridas seguidas de un tenant, gasto OpenAI/Ollama diario > umbral. | Haiku 4.5 |
| 5.3 | Tests de aislamiento | Script `scripts/tenant-isolation.test.ts` (vitest): para cada tabla tenant, cross-read y cross-write fallan con RLS. Corre en CI. | Sonnet 5 |
| 5.4 | Seguridad | Revisar: CSRF del OAuth (state HMAC), rotación de `TOKEN_ENCRYPTION_KEY` (prefijo `v1.` en blobs + script de re-cifrado), headers de rate-limit, logs sin secretos. `/security-review`. | Opus 5 |
| 5.5 | `vercel.json` | Crons: `ingest 06:00`, `fetch 06:30`, `categorize 07:00`, `analyze 07:30`, `embed 08:00`, `graph 08:30`. Todos dispatchers. `maxDuration` explícito en todos. | Haiku 4.5 |
| 5.6 | Docs | `README.md` nuevo (cómo correr, variables, cómo obtener key Anthropic para el usuario final), `CLAUDE.md` con reglas: "todo query lleva ownerId", "raw SQL va dentro de `withOwner`". | Haiku 4.5 |

---

## 4. Modelos en **runtime** (lo que paga cada quien)

| Etapa | Modelo | Quién paga | Por qué | Config |
|---|---|---|---|---|
| Categorizar + PESTEL | `gpt-oss:120b` (Ollama Cloud) | Frida | Decisión de Frida; ya benchmarkeado (21/24) | lotes de 20, `temperature 0` |
| TL;DR / impacto / por qué importa | `gpt-oss:120b` | Frida | ídem | 1 llamada por campo, 90 s timeout |
| Nombrar temas del grafo | `gpt-oss:120b` | Frida | Llamada rara (solo si cambió `membersHash`) | ≤25 miembros |
| **Foresight** | **`claude-sonnet-5`** default, `claude-opus-5` opcional | **Usuario (BYOK)** | 100 palabras de prosa; Sonnet 5 cuesta 40 % de Opus y está en precio intro hasta 2026-08-31. `max_tokens: 1024` en vez de 16000. `fallbacks: "default"` por refusals. Sin `cache_control` (prompt < 1024 tokens, no cachea) | 1 llamada por item |
| Embeddings | `text-embedding-3-small` (OpenAI) | Frida | ~$0.02/1M tokens; 1536 dims | lotes de 64 |
| Verificar key del usuario | `claude-haiku-4-5` | Usuario | ping de 5 tokens | 1 vez al guardar |

Costo estimado por usuario activo (300 likes backfill + ~10/día): Ollama ≈ 1 300 llamadas/mes (costo Frida, depende de plan Ollama Cloud); OpenAI embeddings ≈ $0.01/mes; Anthropic (Sonnet 5) ≈ 300 × ~900 tokens ≈ $0.6 el primer mes, luego centavos — lo paga el usuario.

---

## 5. Modelos de Claude Code por tarea — criterio

Los costos de API (por 1M tokens): Haiku 4.5 $1/$5 · Sonnet 5 $3/$15 · Opus 5 $5/$25 · Fable 5 $10/$50.

| Usa | Cuándo | Tareas de este plan |
|---|---|---|
| **Haiku 4.5** | Trabajo mecánico con instrucciones precisas: borrar archivos, renombrar, añadir `where ownerId` en routes simples, UI sin lógica nueva, docs, config. | 0.1–0.4, 1.4, 1.5, 2.5, 2.6, 3.3, 3.5, 3.10, 3.12, 3.13, 4.4–4.8, 5.2, 5.5, 5.6 |
| **Sonnet 5** | Lógica nueva acotada a 1-3 archivos, refactors con criterio, UI con estado, tests. | 1.1, 1.2, 2.1–2.3, 3.1, 3.2, 3.4, 3.6–3.8, 4.1–4.3, 5.1, 5.3 |
| **Opus 5** | Donde un error cuesta datos cruzados entre usuarios o deuda estructural: aislamiento de tenant en Prisma, cuotas atómicas, el grafo (SQL raw denso), el dispatcher/fan-out, revisión de seguridad. | 1.3, 2.4, 3.9, 3.11, 5.4 |
| **Fable 5** | No hace falta para implementar. Úsalo solo para revisar el diseño de §1–§2 antes de empezar y para el `/code-review` final de Fase 3. | Revisión de diseño, review final |

Regla práctica: empieza cada fase con una sesión Sonnet/Opus que deja la estructura y los contratos (`types.ts`, helpers), y delega lo repetitivo a Haiku con la referencia de un archivo ya migrado como patrón ("haz en `refetch/route.ts` lo mismo que en `process/route.ts`").

---

## 6. Orden y dependencias

```
F0 ─▶ F1 ─▶ F2 ─▶ F3 ─▶ F4 ─▶ F5
            │      └─ 3.9 y 3.11 son el camino crítico; 3.3/3.5/3.10/3.12/3.13 pueden ir en paralelo
            └─ 2.6 puede ir en cualquier momento
```
Total estimado: **14 sesiones** de Claude Code. Fase 3 es la mitad del esfuerzo.

## 7. Riesgos que quedan abiertos

1. **Ollama Cloud con la key de Frida es el costo variable no acotado.** `analyzeItemsPerDay` lo controla por tenant; el panel `/admin` + alerta 5.2 lo vigilan. Si crece, el siguiente paso natural es mover esas etapas a Claude BYOK (Haiku 4.5) — el código de 3.7 ya deja `getAnthropicClient(userId)` listo para eso.
2. **X App compartida**: los rate limits app-level de `liked_tweets` se reparten entre todos. Con cuota 2 páginas/día/tenant, ~75 tenants = 150 req/día, muy por debajo del límite; vigilar con `UsageEvent kind=x_page`.
3. **Límite de funciones concurrentes en Vercel** (plan Hobby/Pro) acota el fan-out; el dispatcher debe leer `VERCEL_MAX_FANOUT` (default 10).
4. **Neon pool**: N funciones en paralelo × Prisma. Usar el pooler (`-pooler` host) y `connection_limit=3` por función.
