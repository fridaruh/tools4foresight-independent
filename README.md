# tools4foresight

Cada usuario conecta su cuenta de X y construye su propio banco de señales privado, enriquecido con análisis de IA.

**Señales, no ruido.** Los likes de X se extraen, se enriquecen automáticamente (contenido, categorías, análisis de foresight), se categorizan, se publican selectivamente, y se exploran en un grafo semántico interactivo.

## Stack

- **Framework:** Next.js 16 (App Router)
- **Base de datos:** PostgreSQL + pgvector (Neon), con RLS y mejor-auth
- **ORM:** Prisma 7
- **Auth:** better-auth (email + contraseña, magic link)
- **LLMs:**
  - **Ollama Cloud** (`gpt-oss:120b`) para análisis y categorización (key de Frida)
  - **Claude** (BYOK por usuario) para foresight — cada usuario guarda su `ANTHROPIC_API_KEY`
  - **OpenAI** (`text-embedding-3-small`) para embeddings (key de Frida)
- **Email:** Resend
- **Deploy:** Vercel (crons, serverless)
- **Design:** Next.js + Tailwind CSS, tokens y marca "AI The New Sexy"

## Correr en local

```bash
# Copiar variables de entorno
cp .env.example .env
# (completar los valores con credenciales reales o dummies para desarrollo)

# Crear rol de app en Neon (solo una vez, si DATABASE_URL apunta a Neon)
npm run db:app-role

# Aplicar migraciones
npx prisma migrate deploy

# Iniciar servidor de desarrollo
npm run dev
```

La app está en `http://localhost:3000`.

## Variables de entorno

Ver `.env.example` para un template completo. Resumen:

| Variable | Qué es | Quién lo proporciona |
|----------|--------|---------------------|
| `DATABASE_URL` | Conexión a Postgres (pooler, rol `t4f_app`) | Neon |
| `DIRECT_URL` | Conexión para migraciones (no pooler, rol owner) | Neon |
| `X_OAUTH_CLIENT_ID`, `X_OAUTH_CLIENT_SECRET` | OAuth de X App | Twitter Developer Portal |
| `X_OAUTH_REDIRECT_URI` | Callback del OAuth | app (ej. `http://localhost:3000/api/auth/x/callback`) |
| `TOKEN_ENCRYPTION_KEY` | AES-256-GCM para cifrar secrets de usuario | generar: `openssl rand -base64 32` |
| `OLLAMA_API_KEY` | Key de Ollama Cloud | Ollama Cloud (key de Frida) |
| `OLLAMA_HOST` | URL de Ollama | Ollama Cloud (`https://ollama.com`) |
| `OLLAMA_MODEL` | Modelo LLM | `gpt-oss:120b` |
| `OPENAI_API_KEY` | Key de OpenAI | OpenAI (key de Frida) |
| `AUTH_SECRET` | Secret de better-auth | generar: `openssl rand -base64 32` |
| `RESEND_API_KEY` | Key de Resend | Resend |
| `MAGIC_LINK_FROM_EMAIL` | Email del que salen los magic links | Resend (verified domain) |
| `CRON_SECRET` | Secret para autenticar crons de Vercel | generar: `openssl rand -base64 32` |
| `NEXT_PUBLIC_APP_URL` | URL pública de la app (para crons y links) | Vercel domain o custom |

## Clave de Anthropic para usuario final

Cada usuario guarda su propia **clave de Anthropic** en `/conexion` (Sistema):

1. Ir a [console.anthropic.com](https://console.anthropic.com)
2. API Keys → Create Key
3. Copiar la clave (ej. `sk-ant-...`)
4. Pegarla en el input de `/conexion`
5. La clave se cifra con AES-256-GCM y se guarda en `user_secrets`
6. Solo se usa en el servidor para llamadas a Claude — nunca sale al cliente
7. Si la clave es inválida, se marca `verifiedAt = null` y el usuario ve un error

El usuario solo paga por los tokens que gasta en sus propios foresights.

## Pantallas

| Ruta | Qué es | Requiere sesión |
|------|--------|-----------------|
| `/` | Catálogo (likes conectados a X, categorizados) | Opcional |
| `/enrich` | Análisis: TL;DR, impacto, foresight, notas | Sí |
| `/grafo` | Grafo semántico de señales publicadas | Sí |
| `/horizontes` | Tendencias detectadas por análisis del grafo | Sí |
| `/categorias` | CRUD de categorías + distribución | Sí |
| `/conexion` | Sistema: X conectado, key Anthropic, cuotas, jobs | Sí |
| `/perfil` | Perfil: nombre, email, contraseña | Sí |
| `/admin` | Panel de plataforma (solo platform_admin) | Sí + admin |
| `/login`, `/registro` | Auth | No |

## Jobs y crons

Seis etapas de pipeline, cada una con su cron horario UTC:

| Etapa | Cron | Qué hace | Budget |
|-------|------|----------|--------|
| **ingest** | 06:00 UTC | Trae likes nuevos de X API; maneja backfill | 100 s |
| **fetch** | 06:30 UTC | Lee OG tags de los links | 50 s |
| **categorize** | 07:00 UTC | Clasifica items sin categoría (Ollama) | 240 s |
| **analyze** | 07:30 UTC | Genera TL;DR, impacto, foresight | 240 s |
| **embed** | 08:00 UTC | Embebe items publicados (OpenAI) | 240 s |
| **graph** | 08:30 UTC | Recalcula grafo semántico, detecta temas | 240 s |
| **alerts** | 09:00 UTC | Envía alertas a Frida (créditos, errores) | — |

### Dispatcher y fan-out

Cada cron pega a `/api/jobs/<job>` (dispatcher):

1. Enumera tenants elegibles para el job (RLS bypass, `withPlatformBypass`)
2. Lanza `POST /api/jobs/<job>/run?owner=<userId>` en paralelo (máx `VERCEL_MAX_FANOUT`)
3. Devuelve en cuanto se lanzan; el fan-out sigue vivo con `waitUntil`

Cada `/…/run` es una función aparte con 300 s, presupuesto de tiempo por tenant.

### Cuotas por usuario

`user_quotas` registra límites diarios configurables (admin puede editarlos):

- `xPagesPerDay` — máx páginas de X por día (default 2)
- `xBackfillPages` — máx páginas al conectar por primera vez (default 3)
- `xBackfillMonths` — meses de backfill (default 3)
- `analyzeItemsPerDay` — máx items analizados/día (default 150)

Cada job verifica y decrementa. `UsageEvent` registra cada llamada a APIs externas (X, Ollama, OpenAI, Anthropic).

## Aislamiento de tenant (RLS)

**Barrera 1 — PostgreSQL:** Cada tabla de tenant tiene una política de RLS que compara `owner_id` contra `current_setting('app.owner_id')`.

**Barrera 2 — Aplicación:** `tenantClient(ownerId)` inyecta el owner en todos los queries ORM de modelos tenant.

**Regla dura:** Todo raw SQL sobre tablas tenant DEBE ir dentro de `withOwner(ownerId, fn)`:

```typescript
const items = await withOwner(userId, (tx) =>
  tx.$queryRaw`SELECT id FROM liked_items WHERE publish_status = 'published'`
);
```

Fuera de `withOwner`, las políticas devuelven 0 filas.

**Rol de la app:** `DATABASE_URL` debe usar el rol `t4f_app` (sin `BYPASSRLS`). Si apunta a `neondb_owner` (que sí tiene bypass), el RLS desaparece en silencio. Script: `npm run db:app-role`.

## QA

```bash
npm run qa
```

Ejecuta secuencialmente todos los scripts `qa:*` del package.json e imprime un resumen PASS/FAIL:

- `qa:tenant` — aislamiento de RLS
- `qa:quota` — reserva atómica de cuota
- `qa:graph` — grafo por tenant
- `qa:jobs` — aceptación de jobs
- `qa:dispatch` — fan-out del dispatcher
- `qa:ui` — smoke tests de UI
- `qa:cats` — categorías por tenant

En CI (GitHub Actions): corre en postgres, aplica migraciones, typechecks con tsc, lint, build, y QA.

Credenciales necesarias en CI: `DATABASE_URL` y `DIRECT_URL` apuntan a un branch de Neon **de prueba** (nunca producción).

## Deploy

En Vercel:

1. Proyecto: `tools4foresight-app` (o crear uno nuevo con `vercel link`)
2. Conectar repo a Vercel
3. Variables de entorno: copiar todas de `.env.example` → Project settings → Environment Variables
4. Merge a `main` dispara deploy automático
5. Crons de `vercel.json` se registran automáticamente
6. Logs en Vercel dashboard → Deployments → Logs

Database: Neon. Plan **Starter** permite hasta 10 conexiones simultáneas; con el pooler de Neon es suficiente para Vercel.

## Diseño

Marca: **"AI The New Sexy"** — identidad definida en `DESIGN.md`.

Tokens (colores, tipografía, espaciado): `DESIGN_TOKENS.md` y `src/app/globals.css`.

## Desarrollo

- `src/lib/tenant-db.ts` — aislamiento por tenant
- `src/lib/jobs/types.ts` — contrato común de jobs
- `src/lib/jobs/dispatcher.ts` — dispatcher y fan-out
- `src/lib/jobs/runner.ts` — ejecutor de jobs
- `src/lib/require-user.ts` — middleware de auth

Antes de commitear cambios en jobs o schema: `npm run qa`.

Ver `CLAUDE.md` para reglas internas del repo.

## Usuario demo y capturas del onboarding

Las capturas de `public/onboarding/` las pintan el tour y las introducciones por módulo. Para rehacerlas cuando cambie una pantalla:

```bash
npm run seed:demo          # (re)crea demo@individual.local con 43 señales, 18 publicadas y un grafo de 3 temas
npm run shots:onboarding   # levanta next dev en :3123, entra como demo y captura las 8 imágenes
```

El usuario demo no se borra al final para poder repetir las capturas. Contraseña en `scripts/seed-demo.ts`.
