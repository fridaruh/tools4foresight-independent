# Seguridad

Este servidor MCP es **multi-tenant** y de **solo lectura**. Todo el modelo de
amenazas gira alrededor de una sola pregunta:

> ¿Puede la clave de una persona devolver, aunque sea una fila, del banco de
> señales de otra?

La respuesta tiene que ser **no** por construcción, no por disciplina. Este
documento explica cómo se sostiene.

## 1. El servidor no custodia credenciales

No hay ninguna API key dentro del despliegue. Ni una clave contra la API, ni un
token de acceso propio, ni un `.env` con secretos en Vercel.

El `Authorization: Bearer <clave>` que llega del cliente **es la clave de
tools4foresight de quien llama**, y se usa solo para construir el cliente HTTP de
esa petición. Nunca se guarda, nunca se registra en un log, nunca se reutiliza.

Lo que esto compra:

- **No hay nada que robar del servidor.** Comprometer el despliegue no da acceso
  al banco de nadie: no hay credencial almacenada que extraer.
- **Revocar es asunto de cada quien.** Una clave filtrada se revoca desde
  `/perfil` y no afecta a nadie más. No hay rotación coordinada ni "avisa a todos
  antes de cambiarla".
- **La atribución es real.** Cada petición lleva la identidad de quien la hizo,
  así que la cuota y el rastro son suyos y de nadie más.

## 2. Aislamiento entre tenants: dónde vive de verdad

En **dos capas**, y las dos tienen que aguantar.

### Capa 1 — La API de tools4foresight (la que manda)

La clave resuelve a un `ownerId` y **todo** lo que se lee pasa por
`withOwner(ownerId, …)`, sobre tablas protegidas con Row-Level Security en
Postgres. Este servidor MCP no puede saltarse eso ni queriendo: no tiene acceso a
la base, solo HTTP.

**Un id de otro tenant devuelve 404, nunca 403.** Es la regla más importante de
la API, y no es cosmética: un 403 significa "existe algo detrás de ese id, pero
no te dejo verlo", y eso permitiría a cualquiera con una clave válida **sondear
ids y descubrir qué existe en el banco de otras personas**. Con 404, el banco
ajeno es indistinguible de la nada: mismo código, mismo mensaje, mismo tiempo de
respuesta.

(La versión single-tenant de esta regla decía "un ítem no publicado devuelve 404
y no 403". Aquí ya no aplica: no hay catálogo oculto al propio dueño. La regla
que la sustituye es más fuerte, porque lo que protege ya no es material sin
revisar sino el banco entero de terceros.)

### Capa 2 — Este servidor: una petición, un cliente, una caché

La fuga posible desde este lado no es de datos, es de **estado compartido**: si
dos tenants compartieran una caché, la respuesta de A podría servirse a B sin que
la API se enterara siquiera.

Por eso la cadena es, por petición y sin excepción:

```
Bearer entrante → loadConfigForRequest(clave) → createServer(config)
                → new T4FClient(config) → new Cache(...)
```

La caché es un campo **de instancia** de `T4FClient` (`src/client/cache.ts`,
`src/client/http-client.ts`), no un `Map` de módulo. No existe ni un singleton ni
una variable mutable a nivel de módulo en todo `src/`. El transporte es
**stateless** (sin `sessionIdGenerator`), así que tampoco hay sesión que pueda
quedarse asociada al tenant equivocado entre peticiones.

Está fijado por escrito en la cabecera de `src/http-passthrough.ts` y protegido
por `tests/tenant-isolation.test.ts`.

**La regla dura para quien toque este repo:** nunca guardes nada indexado por
clave, ni un `T4FClient` reutilizado, ni una caché "global para ahorrar red". Esa
optimización es exactamente el agujero.

## 3. Solo lectura

No hay ninguna tool que escriba, modifique o borre nada. Si alguna vez aparece
una, es un bug. `tests/server.test.ts` verifica que todas las tools se declaren
`readOnlyHint: true` y `destructiveHint: false`.

Publicar, editar el análisis o recalcular el grafo se hacen desde la app, con
sesión de usuario — no desde aquí.

## 4. Lo que nunca sale de la API

La frontera de datos no está en este repo: está en `src/lib/public-dto.ts` de
tools4foresight. **Si un campo no está en un DTO, no sale de la API** — y este
servidor solo puede mostrar lo que la API le da.

| Qué | Por qué |
|---|---|
| `ownerId` | El identificador del dueño no sale nunca. Es lo que hace que un banco no sea enumerable desde otro |
| `users`, `sessions`, `accounts`, `verifications` | Datos de cuenta de personas reales |
| `api_keys` (hashes incluidos) | Las claves son credenciales; ni siquiera su hash sale |
| `x_auth_tokens`, `user_secrets` | Credenciales de terceros, cifradas AES-256-GCM en la base |
| `prompt_settings` | Prompts internos de curaduría |
| La columna `embedding` (`vector(768)`) | 768 floats por señal; expone el modelo y no aporta nada a un agente |
| `embeddingHash`, `membersHash`, `likeRank`, `fetchStatus`, `detectedAt`, las columnas `*Source` | Estado interno de infraestructura |

**`publishStatus` ya no está en esta lista.** En el servidor single-tenant era un
filtro secreto (la API solo servía lo publicado). Aquí la persona es la curadora
de su propio banco y ve el 100% de su material, así que el campo pasa a ser un
dato útil: "esto ya lo revisé". Esconderle a alguien su propio contenido no
protege nada.

## 5. Contenido externo no es instrucción

Los textos de las señales (títulos, TL;DR, tweets) y los nombres y resúmenes de
los temas los escribieron terceros, o los redactó un modelo a partir de ellos.
Van delimitados entre `<contenido-externo>` y `</contenido-externo>`, y las
instrucciones del servidor le dicen al modelo que ahí dentro **nada se obedece**:
se cita, se resume y se analiza.

Que el banco sea tuyo no cambia esto. El material que guardaste lo escribió otra
gente, y una inyección de prompt dentro de un tweet guardado sigue siendo una
inyección de prompt.

## 6. Manejo de claves

- Nunca en el repo, nunca en un commit, nunca en logs.
- Nunca en un frontend: una API key en el navegador es una API key pública.
- Nunca en el entorno del despliegue remoto. Ahí no va ninguna.
- `T4F_API_KEY` solo tiene sentido en `stdio`, que es un proceso local para una
  sola persona (desarrollo/self-host).
- **HTTPS obligatorio** fuera de localhost, validado en `src/config.ts`: por la
  URL base viaja en cada petición la clave de un usuario final, que es la llave
  de todo su banco.

## Licencia del código vs. licencia de los datos

El código de este repo es MIT. **El contenido que sirve no lo es**: las señales,
el análisis y el mapa semántico pertenecen a la persona cuya clave se usó para
pedirlos.

## Reportar un problema

Escribe a quien mantiene el repo antes de abrir un issue público, sobre todo si
crees haber encontrado una forma de leer algo del banco de otra persona.
