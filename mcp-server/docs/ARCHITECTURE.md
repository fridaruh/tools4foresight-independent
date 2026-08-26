# Arquitectura

## El flujo completo

```
  Agente de Ana                      Agente de Beto
     │  Authorization: Bearer <clave de Ana>   │  Bearer <clave de Beto>
     │                                          │
     └──────────────┬───────────────────────────┘
                    ▼   MCP · Streamable HTTP (stateless)
  ┌─────────────────────────────────────────────┐
  │  MCP_T4F_Multitenant  (UN despliegue)       │
  │  · cero credenciales dentro ·               │
  │                                             │
  │   api/mcp.ts   src/http.ts   src/stdio.ts   │  ← el 1º es el soportado;
  │        └────────────┼─────────────┘         │    los otros dos, desarrollo
  │                     ▼                       │
  │            http-passthrough.ts              │  ← extrae el Bearer de ESTA petición
  │                     ▼                       │
  │            createServer(config)             │  ← un McpServer POR PETICIÓN
  │        tools · resources · prompts          │
  │                     ▼                       │
  │      T4FClient  (+ caché de instancia)      │  ← nace y muere con la petición
  └───────────────────┼─────────────────────────┘
                      │  HTTPS + Bearer <la clave de quien llamó>
                      ▼
  ┌─────────────────────────────────────────────┐
  │  tools4foresight  (Next.js 16, en Vercel)   │
  │                                             │
  │   /api/public/v1/**  ← 17 route handlers    │
  │        withPublicApi()                      │  ← clave → ownerId, rate limit
  │        public-dto.ts                        │  ← LA FRONTERA DE DATOS
  │        withOwner(ownerId, …)                │  ← + RLS en Postgres
  │                   ▼                         │
  │              Prisma 7                       │
  └───────────────────┼─────────────────────────┘
                      ▼
              Postgres (Neon) + pgvector
```

## Decisiones registradas

### Por qué pass-through y no una credencial en el servidor

Es **la** decisión de este repo. El servidor single-tenant del que nace llevaba
dentro la clave contra la API y exigía un token propio a quien lo llamara. Eso
funcionaba porque el acervo era uno solo.

Aquí cada persona tiene su banco y la API key **es la identidad del banco**. Una
credencial compartida dentro del despliegue significaría que todo el mundo lee el
banco de una sola persona: no es una imprudencia, es un fallo funcional.

Así que el `Authorization` entrante se pasa tal cual a la API, y el servidor no
guarda nada. Lo que se gana, además de que funcione: nada que robar del
despliegue, revocación individual y atribución real por usuario.

Un corolario: **una clave presente pero inválida no se juzga aquí**. Solo la API
sabe a qué dueño resuelve una clave; adivinarlo en el MCP produciría dos verdades
distintas sobre quién eres. Se manda y se propaga su 401.

### Por qué un cliente y una caché por petición

Es donde podría filtrarse un tenant a otro desde este lado. La caché es un campo
de instancia de `T4FClient`, que se crea dentro de `createServer`, que se llama
por petición: **dos tenants no comparten ninguna estructura de datos en memoria**.
No hay un solo `Map`, `let` ni singleton a nivel de módulo en `src/`.

El coste es real y aceptado: cada petición MCP paga sus fallos de caché. La
alternativa —un `Map<apiKey, T4FClient>` global— ahorraría red y sería
exactamente el agujero que este diseño existe para hacer imposible.

Fijado en la cabecera de `src/http-passthrough.ts` y protegido por
`tests/tenant-isolation.test.ts`.

### Por qué HTTP y no Postgres directo

El MCP podría conectarse a Neon con un rol de solo lectura y ahorrarse un salto.
No lo hace por tres razones, y en multi-tenant la primera pesa el doble:

1. **La frontera queda en un solo sitio.** Con acceso directo a la base, cada
   consulta nueva del MCP tendría que acordarse sola de filtrar por dueño — y la
   que se olvidara filtraría el banco de todo el mundo. Con la API de por medio,
   `withOwner()` + RLS deciden qué se ve y `public-dto.ts` decide qué existe
   fuera.
2. **La credencial que viaja es revocable y acotada.** Una API key se revoca
   desde `/perfil`; una cadena de conexión a Postgres, no.
3. **El MCP se puede desplegar donde sea** sin acceso de red a la base.

El precio es un salto de red extra, que la caché por petición amortigua dentro de
una misma conversación.

### Por qué un core y tres entry points

`server.ts` construye el `McpServer` completo; `api/mcp.ts`, `src/http.ts` y
`src/stdio.ts` solo eligen transporte. Los dos primeros comparten además
`http-passthrough.ts`, o sea la misma auth: si el modo remoto se probara en local
con otra, el despliegue acabaría con la auth que nadie probó, y lo que quedaría
sin probar es justo el aislamiento entre personas.

`stdio.ts` es la excepción consciente: sirve a una sola persona, la que lanzó el
proceso, así que lee su clave de `T4F_API_KEY`. Es una herramienta de desarrollo
y no se publica en npm.

### Por qué stateless en Vercel

`WebStandardStreamableHTTPServerTransport` sin `sessionIdGenerator`. La razón
original sigue valiendo: en Vercel cada petición puede caer en una instancia
distinta, así que una sesión guardada en memoria se perdería a mitad de
conversación y el fallo sería intermitente — lo peor de depurar. Sin sesión no
hay sesión que perder.

Y ahora hay una segunda razón que la refuerza: sin sesiones no hay estado de
conversación que sobreviva entre peticiones y, por tanto, nada que pueda quedarse
asociado al tenant equivocado.

Lo que se pierde: resumabilidad y notificaciones del servidor fuera del ciclo de
una petición. No hace falta ninguna de las dos: todas las tools son lecturas
cortas.

### Por qué Streamable HTTP y no SSE

SSE es el transporte legacy del protocolo. Streamable HTTP es el actual y el
único que se implementa aquí.

### Por qué `T4F_API_BASE_URL` no tiene default

El servidor original tenía uno (`https://tools4foresight.com/api/public/v1`,
el acervo único). Aquí no: el despliegue multi-tenant es el proyecto de Vercel
`tools4foresight-app` y su dominio final no está fijado todavía.

Un default equivocado es peor que un arranque fallido. En el mejor caso da 401
confusos; en el peor **manda la clave de un usuario a un host que no es el suyo**.
Así que la variable es obligatoria y el mensaje de error dice exactamente qué
poner. Cuando el dominio esté fijo, se puede reconsiderar — no antes.

### Por qué el cursor es compuesto `(likedAt, id)`

`likedAt` es una **estimación** con empates frecuentes: varios ítems históricos
comparten fecha. Un cursor sobre un campo no único **se salta las filas
empatadas** que quedaron del otro lado del corte. El par `(likedAt, id)` sí es
un orden total, así que "la fila siguiente" está definida sin ambigüedad.

Las listas que no ordenan por `likedAt` (temas, snapshots) usan un cursor por id
con un prefijo distinto (`v1i` en vez de `v1`), para que pegar un cursor del
endpoint equivocado dé un 400 claro en vez de una página silenciosamente mal.

### Por qué la caché es un `Map` en memoria y no Redis

El perfil de uso es un agente haciendo lecturas repetidas dentro de una misma
conversación. Un `Map` con TTL y evicción LRU cubre eso con cero dependencias y
cero infraestructura. Los TTL van por tipo de dato: taxonomía 10 min, grafo y
temas 5 min, señales 1 min, y un snapshot por id es **inmutable** (es una foto
del pasado, nunca cambia).

Una caché compartida (Redis) es además justo lo que NO se quiere aquí sin
particionar por dueño con mucho cuidado: hoy el aislamiento sale gratis porque
cada caché muere con su petición.

### Por qué `score` y `strength` conviven

La regla de producto es que **al lector humano no se le muestra el porcentaje de
similitud**: un 0.63 se lee como una precisión que el método no tiene, y la
conversación se va al número en vez de a la relación.

Pero eso es una regla de presentación, no de seguridad. Un **agente** necesita el
float para ordenar vecinos y poner umbrales; ocultárselo lo obligaría a inventar
heurísticas peores. Así que viajan los dos, y la instrucción de cuál usar al
redactar vive **en la descripción de la tool**, que es donde un modelo la
obedece — no en un README que no lee nadie.

### Por qué un id de otro tenant devuelve 404 y no 403

Un 403 significa "existe algo detrás de ese id, pero no te dejo verlo". En
multi-tenant eso permitiría a cualquiera con una clave válida **sondear ids y
descubrir qué existe en el banco de otras personas**: nombres de temas no, pero
sí su existencia y su cantidad, que ya es demasiado.

Con 404, el banco ajeno es indistinguible de la nada — mismo código, mismo
mensaje. Para un cliente, "no es tuyo" y "no existe" son literalmente lo mismo.

Es la versión multi-tenant de la regla que el servidor single-tenant aplicaba al
material sin publicar ("un id no publicado devuelve 404, no 403"). Aquella ya no
aplica: la persona ve el 100% de su banco y no hay catálogo oculto a su propio
dueño. Esta la sustituye y es más importante, porque lo que protege ya no es
material sin revisar sino los datos de terceros.

## Deudas conocidas

- **El rate limit lo aplica la API**, agrupando por dueño (no por clave: si fuera
  por clave, cualquiera multiplicaría su cuota generando claves). Este servidor
  solo propaga el 429 con su `Retry-After`.
- **El SDK de MCP arrastra `express`, `hono`, `ajv` y `jose`** como dependencias.
  Engorda el bundle de la función de Vercel. No hay nada que hacer desde este
  lado.
- **La auth es por API key, no OAuth.** Lo natural más adelante es OAuth 2.1 con
  el `ProxyOAuthServerProvider` del SDK, para que el cliente MCP obtenga un token
  contra tools4foresight sin que la persona tenga que copiar y pegar una clave.
  El pass-through de hoy es compatible con esa evolución: lo que cambia es de
  dónde sale el Bearer, no qué se hace con él.
