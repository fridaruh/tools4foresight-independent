# tools4foresight — x-likes-curator

**Señales, no ruido.** Los likes de X de Frida, extraídos, enriquecidos con el contenido
de los links, categorizados y analizados automáticamente; lo mejor se publica como
"señales" en [tools4foresight.com](https://tools4foresight.com) para usuarios registrados.

El repo tiene tres caras, todas bajo el mismo dominio y decididas por rol:

- **Landing (`/` sin sesión)** — la página de venta: muestra desclasificada, sección
  **02 / mapa semántico** con capturas reales del grafo, método, precio ($15 USD/mes)
  y FAQ. Vive en `src/components/LandingPage.tsx`; las capturas en `public/landing/`.
- **Admin (curaduría)** — pantallas internas donde se ingesta, enriquece, analiza,
  publica y se explora el grafo de cada like.
- **Member (señales)** — la vista para cuentas registradas: categorías, banco de
  señales, favoritos, feedback y perfil.

Para la descripción técnica de punta a punta (flujo del dato, modelo, cómo se
construye el mapa semántico, decisiones) ver [`WHATSTHIS.md`](./WHATSTHIS.md).

## Correr en local

```bash
cp .env.example .env   # y completar los valores
npx prisma migrate deploy
npm run dev
```

Base: Next.js 16 (App Router) + React 19 + Prisma 7 sobre Postgres con pgvector (Neon
en producción; dev y prod comparten la base, así que las migraciones van **después**
del deploy o son aditivas). Deploy en Vercel (proyecto `tools_4_foresight`): merge a
`main` dispara el deploy de producción.

## Pantallas

### Admin

| Ruta | Qué es |
|------|--------|
| `/` | Catálogo (01): tarjetas o lista, filtros por fecha del like y categoría, búsqueda, popup con el tweet completo. Sin sesión, esta misma ruta es la landing |
| `/enrich` | Análisis: tabla editable con TL;DR, por qué importa, impacto, **foresight**, notas y columnas custom. Guardado explícito por fila; editar una celda la marca `manual` y los jobs dejan de sobreescribirla |
| `/grafo` | Grafo semántico (03, **solo admin por ahora**): mapa force-directed de las señales publicadas, aristas por similitud coseno (pgvector). Color por **tema** (comunidades detectadas y bautizadas por el modelo, con toggle a familia de categoría), tamaño = número de conexiones (leyenda abajo a la derecha), vecindario resaltado al hover, títulos visibles al hacer zoom. Clic en un nodo abre un panel con la idea principal, sus señales más parecidas (navegables) y la explicación de su tema. No muestra % de similitud en ningún lado |
| `/horizontes` | Horizontes (04, solo admin): los temas del grafo leídos como tendencias. Horizonte **H1/H2/H3** sugerido por heurística y fijable a mano (`horizon_source=manual`), indicadores por tema (vitalidad, velocidad 30d, densidad, conectividad, novedad), temas muertos, corridas recientes y **exports CSV** (`temas`, `senales`, `historial`). Detalle en `PLANS`/`WHATSTHIS.md` |
| `/categorias` | Taxonomía: distribución de categorías, propuestas del modelo y clasificaciones dudosas |
| `/conexion` | Sistema: estado de la cuenta de X, disparo manual de los jobs y reintento de links fallidos |
| `/usuarios` | Dashboard de usuarios: registrados, activos (7 días), nuevos (30 días) y tabla con nombre, email, rol, alta, última actividad y favoritos |

### Member

| Ruta | Qué es |
|------|--------|
| `/categorias` | Tab 01 del member: las señales publicadas agrupadas por categoría (`member-view.tsx`). Es a donde cae un member al entrar a `/` |
| `/senales` | Tab 02: banco de señales publicadas (`publishStatus: "published"`). Ficha en orden: título → tweet → TL;DR → preview → por qué importa → impacto, con botón de favorito arriba a la derecha |
| `/senales/favoritos` | Las señales que el usuario marcó con el corazón |
| `/perfil` | Editar nombre, email y contraseña (o crearla si siempre entró por magic link). Se llega desde el círculo de cuenta en la nav |
| `/login`, `/registro` | Entrar / crear cuenta. Ver "Cuentas y roles" |
| `/privacidad`, `/terminos` | Legales, públicas |

La barra lateral de `/senales` lleva los links de navegación y el recuadro de feedback
(se guarda en la tabla `feedback` con el usuario y la ruta desde donde se mandó).

## Cuentas y roles

Auth con **better-auth** (`src/lib/auth.ts`), dos formas de entrar con el mismo email:

- **Email + contraseña** (mínimo 8 caracteres) — registro abierto en `/registro`.
- **Magic link** (10 min de vigencia) — enviado con Resend.

El rol vive como additional field de better-auth con `input: false`: todo signup crea un
`member`, nadie puede auto-asignarse `admin`. Los members ven `/senales`; el admin ve
además las pantallas de curaduría. El paywall de $15/mes que anuncia la landing **aún no
tiene Stripe**: hoy todo member tiene acceso completo. Queda un gate temporal de Fase 0 (`ADMIN_PASSWORD`,
cookie sin usuario detrás) que se retirará cuando ya no haga falta.

Los correos salen como **"Tools 4 Foresight"** (`src/lib/email-from.ts`, sobre la
dirección de `MAGIC_LINK_FROM_EMAIL`).

## Suscripción (Stripe)

Un member necesita suscripción vigente para leer el banco (`/senales`, `/categorias`,
`/api/liked-items`, `/api/categories`); sin ella aterriza en `/suscripcion`. El admin
no paga. Si `STRIPE_SECRET_KEY` está vacío los pagos quedan apagados y todos los
members pasan (comportamiento previo a esta fase).

- **Planes**: $15 USD/mes con **14 días de prueba registrando tarjeta**
  (`payment_method_collection: always`; si al terminar el trial no hay tarjeta la
  suscripción se cancela sola) o $150 USD/año, que se cobra al contratar. Quien ya tuvo
  una suscripción (o la cortesía) no recibe segundo trial. Los CTAs de la landing llevan a
  `/suscripcion?plan=…`; sin sesión pasa por `/registro` (enlace a `/login` conservando
  el destino) y vuelve con el plan preseleccionado. Tras pagar, directo a `/senales`.
- **Cortesía**: la migración `20260821130000_gift_annual_access` dio un año de acceso a
  los members registrados antes del paywall (`subscription_id = gift:annual:<id>`, sin
  suscripción en Stripe). `hasAccess()` revisa su vencimiento porque ningún webhook lo
  expira; en `/usuarios` aparecen como "cortesía · anual".
- **Precios**: se buscan por `lookup_key` (`t4f_monthly` / `t4f_annual`) y se crean
  solos en la cuenta de Stripe la primera vez que alguien abre el checkout
  (`src/lib/stripe.ts`). `STRIPE_PRICE_MONTHLY` / `STRIPE_PRICE_ANNUAL` los sobreescriben.
- **Flujo**: `POST /api/billing/checkout` → Stripe Checkout (hosted) → vuelve a
  `/suscripcion?checkout=ok`, que sincroniza la suscripción sin esperar al webhook.
  `POST /api/billing/portal` abre el Customer Portal (cambiar plan, tarjeta, cancelar).
- **Webhook**: `POST /api/billing/webhook` (fuera del proxy, firmado con
  `STRIPE_WEBHOOK_SECRET`) escucha `checkout.session.completed` y
  `customer.subscription.created/updated/deleted` y espeja estado, plan, fin de
  periodo y cancelación programada en `users` (`src/lib/subscription.ts`).
- **Acceso**: `trialing`, `active` y `past_due` (Stripe reintenta el cobro unos días)
  dan acceso; `canceled`, `unpaid`, `paused` no. `getAccess()` en
  `src/lib/require-admin.ts`.
- **Local**: `stripe listen --forward-to localhost:3000/api/billing/webhook`.

## Jobs

Todos corren por cron (`vercel.json`, autenticados con `CRON_SECRET`) y los cuatro de
contenido también se disparan a mano desde `/conexion`.

| Endpoint | Cron (UTC) | Qué hace |
|----------|------------|----------|
| `POST /api/jobs/ingest-likes` | 06:00 | Trae likes nuevos de la X API y pagina el backfill |
| `POST /api/jobs/fetch-content` | 06:30 | Lee los OG tags de los links de cada tweet |
| `POST /api/jobs/categorize` | 07:00 | Clasifica lo que quedó sin categoría (Ollama) |
| `POST /api/jobs/analyze` | 07:30 | Genera lo que falte de TL;DR, impacto, por qué importa (Ollama) y foresight (Claude) |
| `POST /api/jobs/onboarding-emails` | 15:00 | Manda el correo de onboarding que le toque a cada member |

Además, `POST /api/jobs/onboarding-preview` (auth propia con
`ONBOARDING_PREVIEW_SECRET`) manda los 7 correos de la secuencia a un buzón de prueba
para revisarlos sin crear usuarios.

`POST /api/jobs/embed` (misma auth con `CRON_SECRET`) existe pero **no está en
`vercel.json`**: embebe las señales publicadas y recalcula `semantic_links` para el
grafo, detecta los temas (comunidades sobre las aristas, bautizadas con el modelo de
chat de ollama.com — nombre + por qué van juntas, con caché por membresía en
`semantic_clusters`), y necesita un Ollama con modelo de embeddings — ollama.com no hostea ninguno,
así que se corre desde una máquina con Ollama local (`ollama pull embeddinggemma`,
`ollama serve`, `next dev` y `curl -X POST localhost:3000/api/jobs/embed -H
"Authorization: Bearer $CRON_SECRET"`) contra la base de Neon. Detalles en
`src/lib/jobs/embed.ts` y `src/lib/jobs/clusters.ts`; umbrales ajustables por env
(`SEMANTIC_LINK_THRESHOLD`, `SEMANTIC_LINK_TOP_K`, `SEMANTIC_CLUSTER_MIN_SIZE`, ver
`.env.example`). La página `/grafo` solo lee lo precalculado: abrirla no llama a ningún modelo.

`POST /api/jobs/graph` (cron diario `0 8 * * *`, sí en `vercel.json`) rehace todo lo
**derivado** de los embeddings existentes sin embeber nada: aristas, temas con linaje,
vitalidad (vida media 30 días, `GRAPH_HALF_LIFE_DAYS`), indicadores, horizonte sugerido y
un snapshot (`graph_snapshots`). También corre tras publicar/despublicar una señal
(`after()` en el PATCH de `/api/liked-items/[id]`), al final del job de embeddings y como
quinto paso del botón de Sistema. Lógica en `src/lib/jobs/graph.ts`.

## Análisis con IA

Dos modelos, cuatro campos (`src/lib/jobs/analyze.ts`):

- **TL;DR, impacto y por qué importa** — Ollama (`gpt-oss:120b` por default, ver la
  sección de categorización).
- **Foresight** — Claude (`claude-opus-5`, `src/lib/foresight.ts`): un párrafo en
  español (≤100 palabras) sobre cómo la señal puede cambiar el desarrollo de la IA y la
  interacción humano-máquina. Entra directo al cambio ("Esto puede…"), sin abrir con
  "Sí/No". **Solo se ve en el back** (`/enrich`), no en la vista de member. El request
  lleva `cache_control` en el system prompt y fallback a `claude-opus-4-8`.

Reglas compartidas por los cuatro campos:

- Solo se genera lo que está en `null`; editar a mano marca la columna `*Source:
  "manual"` y el job no la vuelve a tocar.
- Los prompts tienen defaults en código (`src/lib/analysis-prompts.ts`) y overrides en
  la tabla `prompt_settings`, editables vía `/api/prompts`.
- Si Claude rechaza un item (clasificadores de seguridad), el job lo reintenta a diario;
  la salida es escribir el foresight a mano en `/enrich`.

## Onboarding por correo

Secuencia por member (`src/lib/jobs/onboarding.ts`, plantillas en
`src/lib/onboarding-emails.ts`): **bienvenida** al crear la cuenta (hook de better-auth,
un fallo de Resend nunca rompe el signup) y luego **día 1, 3, 7 y 14**, cada paso con
una ventana de gracia — a quien se registró antes de que existiera la secuencia no le
llegan correos viejos. Aparte, **reactivación** (una sola vez) a quien lleva 10+ días
sin sesión con cuenta de 14+ días, solo si hay señales nuevas que mostrarle. La tabla
`onboarding_emails` (unique `userId+step`) garantiza máximo un envío por paso, y la
corrida diaria manda a lo sumo un correo por usuario.

## Las tres fechas de un item

La X API **no expone cuándo ocurrió el like**, solo el orden. Por eso hay tres campos y
no uno (ver `prisma/schema.prisma`):

- `tweetCreatedAt` — **exacto**. Sale del snowflake ID del tweet, sin gastar llamadas a la API.
- `detectedAt` — **exacto**. El momento del polling que lo trajo.
- `likedAt` — **estimación** acotada entre la corrida anterior y la actual, y nunca antes
  de que el tweet existiera. Es sobre lo que filtra la UI, y se muestra siempre con `~` y
  un tooltip que lo dice.

## Categorización — por qué gpt-oss:120b

Corre por Ollama (`src/lib/categorize.ts`). El modelo se elige con `OLLAMA_MODEL`.

### El catálogo

Vive en `src/config/categories.ts` — nombre, descripción y ejemplos few-shot de cada
categoría, todo texto que va literal al prompt. Editarlo no requiere tocar el pipeline.

Arrancó con 4 categorías generales y el **55% de los likes cayó en "Otros"**: el problema no
era el modelo, era que el catálogo no cubría lo que Frida realmente guarda. Se analizó una
muestra de 150 items de "Otros" y se agregaron 6 categorías (aprobadas 2026-07-27). Los
ejemplos few-shot de esas 6 son likes reales, no inventados: un few-shot con el vocabulario
de quien usa la app clasifica mejor que uno genérico.

Las categorías nuevas conviven con las originales en vez de reemplazarlas, y las
descripciones marcan las fronteras que se pisan (`Personal & Pop-Culture` vs `Movies`,
`Developer Tools & Projects` vs `AI Docs/Updates`, `Startup & Business` vs `AI News`).

**Después de editar el catálogo hay que recorrer todo de nuevo.** No hay endpoint para eso a
propósito — borrar categorías es destructivo y no debe estar a un click. Se hace con SQL,
respetando las correcciones manuales:

```sql
UPDATE liked_items
SET category = NULL, category_confidence = NULL,
    category_reasoning = NULL, categorized_at = NULL
WHERE category_source = 'auto';
```

Y luego se llama `POST /api/jobs/categorize` hasta que devuelva `remaining: 0` (~700 items
por corrida, unos 25 min para 4k).

Se midieron 6 modelos contra 24 likes reales, mismo prompt y `temperature: 0`, lote de 24:

| Modelo | Tiempo | Resultado |
|--------|--------|-----------|
| **gpt-oss:120b** | **23s** | **elegido** — 21/24 de acuerdo con el modelo más grande de la lista |
| gpt-oss:20b | 19s | casi igual de bueno; se equivoca en items ambiguos. Es el fallback que sí corre en una Mac (13.8 GB) |
| deepseek-v4-flash | 13s | abusa de "Otros": manda ahí tooling de IA que sí tiene categoría |
| qwen3.5:397b | 71–97s | calidad similar a gpt-oss:120b y 3-4× más lento |
| minimax-m2.5 | 27s | omite el campo `category` |
| nemotron-3-nano:30b | 45s | mete todo lo relacionado con IA en "AI News" |
| gemma4:31b | >300s | timeout |

Dos hallazgos que están codificados en el prompt y valen para cualquier modelo que se pruebe
después:

- **Los items se numeran con un `index` chico, no con el `tweetId`.** Los IDs de X son
  snowflakes de 19 dígitos; varios modelos los emiten como `number` de JSON, que pierde
  precisión arriba de 2^53. Con `tweetId`, gpt-oss:120b falló el match en el 100% de los items.
- **`format` con JSON schema no se respeta al pie de la letra.** Unos envuelven en ` ```json `,
  otros devuelven el arreglo pelado en vez de `{results: [...]}`. El parser acepta las tres formas.

### Usar un modelo verdaderamente local

`OLLAMA_HOST` apunta por default a Ollama Cloud (`https://ollama.com`), que es lo único
alcanzable desde las funciones de Vercel. Para correr contra una instancia local:

```bash
OLLAMA_HOST=http://127.0.0.1:11434
OLLAMA_MODEL=gpt-oss:20b
```

## Diseño

La identidad es **AI The New Sexy**: [`DESIGN.md`](./DESIGN.md) es el brand book y
[`DESIGN_TOKENS.md`](./DESIGN_TOKENS.md) documenta cómo se implementa en esta app
(tokens de `globals.css`, tipografía, secciones).

## Variables de entorno

Ver `.env.example`. Resumen por área: `DATABASE_URL` (Postgres), `X_API_*` /
`X_OAUTH_*` / `TOKEN_ENCRYPTION_KEY` (X API), `OLLAMA_*` (categorización y análisis),
`ANTHROPIC_API_KEY` (foresight), `AUTH_SECRET` / `RESEND_API_KEY` /
`MAGIC_LINK_FROM_EMAIL` (cuentas y correos), `CRON_SECRET` (jobs),
`ONBOARDING_PREVIEW_SECRET` (preview de correos), `STRIPE_SECRET_KEY` /
`STRIPE_WEBHOOK_SECRET` (suscripciones), `ADMIN_PASSWORD` (gate legacy de
Fase 0), `OLLAMA_EMBED_*` / `SEMANTIC_*` (grafo semántico, opcionales con defaults).
