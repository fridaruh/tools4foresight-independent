# Despliegue

**Un solo despliegue atiende a todas las personas.** No hay que desplegar uno
por usuario y no hay que darle de alta a nadie: quien tenga una clave de la
instancia de tools4foresight contra la que apunta este servidor, la manda en la
cabecera y lee su propio banco.

## Antes de nada: cero secretos dentro

Esta es la diferencia con el servidor single-tenant del que nace este repo, y es
la decisión que sostiene todo lo demás.

Allí había **dos credenciales**: una clave del servidor contra la API (guardada
en el despliegue) y un token que el servidor exigía a quien lo llamara. Aquí
**hay una sola credencial y no es del servidor: es del usuario**.

| Qué | Dónde vive | Quién la tiene |
|---|---|---|
| API key de tools4foresight | En el cliente MCP de cada persona, en su header `Authorization` | Cada persona, la suya |
| *(nada más)* | — | El despliegue no guarda ninguna credencial |

Consecuencia práctica: **no hay ninguna variable de entorno secreta que poner en
Vercel.** Si te encuentras poniendo una clave de API en el despliegue, algo se
entendió al revés — esa clave serviría el banco de una sola persona a todo el
que diera con la URL, que es exactamente lo que este diseño existe para impedir.

Lo que sí lleva el despliegue es configuración de operador, no secreta:
`T4F_API_BASE_URL` (obligatoria) y los ajustes opcionales de timeout, reintentos,
caché y log. Ver [`.env.example`](../.env.example).

## 1. Desplegar

Este servidor vive en `mcp-server/` dentro del repo de tools4foresight, pero es
un **proyecto de Vercel aparte** del de la app: se despliega con este directorio
como raíz, no con la raíz del repo.

```bash
cd mcp-server
vercel link          # proyecto NUEVO, distinto del de la app

# La ÚNICA obligatoria. Debe terminar en /api/public/v1 y ser https.
vercel env add T4F_API_BASE_URL production
# valor para la instancia oficial:
#   https://individual.tools4foresight.com/api/public/v1

vercel deploy --prod
vercel domains add mcp.individual.tools4foresight.com
```

Sobre el nombre: `mcp.tools4foresight.com` **ya está tomado** por el servidor de
la otra herramienta, la que sirve un acervo único. Esta es la instancia donde
cada persona tiene su propio banco, así que su MCP cuelga de su propia app —
`individual.tools4foresight.com` → `mcp.individual.tools4foresight.com`. Son dos
servidores distintos y las claves no son intercambiables.

`vercel.json` fija `maxDuration: 60` para `api/mcp.ts` y desactiva la detección
de framework (`framework: null` + un `buildCommand` que no hace nada): sin eso,
Vercel toma el `package.json` por el arranque de un servidor y la función muere
con *"Invalid export found in module server.js"*.

El runtime invoca la función con la firma de Node (`req`, `res`), no con un
`Request` web como el que espera el transporte MCP. `src/node-adapter.ts` hace de
puente y acepta las dos formas, así que el handler funciona con o sin esa
detección.

## 2. Cada persona genera su clave

En **`/perfil` → "Conecta tus agentes"** de la instancia de tools4foresight.
La clave sale **una sola vez**, empieza por `t4f_` y va tal cual en la cabecera
del cliente MCP.

Esa clave **es la identidad del banco**: resuelve al dueño y todo lo que se lee
pasa por ese dueño. Quien la tenga lee ese banco entero, así que se trata como
una contraseña: no se comparte, no se pega en un repo, no se manda por chat. Si
se filtra, se revoca desde `/perfil` y se genera otra; nadie más se ve afectado
porque no hay claves compartidas.

## 3. Conectar un agente

```json
{
  "mcpServers": {
    "tools4foresight": {
      "type": "http",
      "url": "https://mcp.individual.tools4foresight.com/api/mcp",
      "headers": { "Authorization": "Bearer t4f_tu-api-key-personal" }
    }
  }
}
```

En Claude Code:

```bash
claude mcp add --transport http tools4foresight \
  https://mcp.individual.tools4foresight.com/api/mcp \
  --header "Authorization: Bearer t4f_tu-api-key-personal"
```

## 4. Prueba de humo

**Sin cabecera debe dar 401**, con un mensaje que diga qué poner:

```bash
curl -s -X POST https://mcp.individual.tools4foresight.com/api/mcp | jq .
# {"error":{"code":"unauthorized","message":"Falta la cabecera Authorization: Bearer …"}}
```

**Con una clave inválida, el 401 lo da la API de tools4foresight**, no este
servidor: aquí no se adivina si una clave es buena. Se ve como un error de tool
dentro de la respuesta MCP, no como un 401 HTTP.

**Con tu clave real**, un `initialize` del protocolo debe responder:

```bash
curl -s -X POST https://mcp.individual.tools4foresight.com/api/mcp \
  -H "Authorization: Bearer $T4F_API_KEY" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"curl","version":"0"}}}'
```

**La prueba que de verdad importa** es la de aislamiento, y necesita dos claves
de dos cuentas distintas: pide `list_signals` con cada una y comprueba que los
ids no se solapan. Si aparece un id de la cuenta A con la clave de B, hay una
fuga y el despliegue no debe usarse. (En el repo, `tests/tenant-isolation.test.ts`
fija el invariante del lado del servidor MCP; la verificación equivalente del
lado de la API vive en `scripts/qa-public-api.ts` de tools4foresight.)

Y con el Inspector, que es la forma cómoda de ver las 18 tools:

```bash
npx @modelcontextprotocol/inspector
# transporte: Streamable HTTP
# URL: https://mcp.individual.tools4foresight.com/api/mcp
# header: Authorization: Bearer <tu API key de tools4foresight>
```

## Probar el modo remoto en local

```bash
T4F_API_BASE_URL=http://localhost:3000/api/public/v1 npm run dev:http
npx @modelcontextprotocol/inspector   # http://127.0.0.1:3333/mcp
# header: Authorization: Bearer <tu API key>
```

Corre el **mismo** transporte stateless y el **mismo** pass-through que Vercel, a
propósito: probar en local con otra auth y desplegar con la de verdad escondería
los bugs justo hasta producción — y aquí lo que quedaría sin probar es el
aislamiento entre personas.

`npm run dev:stdio` también existe, pero es otra cosa: un proceso para una sola
persona que sí lee `T4F_API_KEY` del entorno. Sirve para desarrollar, no para
desplegar.

## Rotar claves

No hay rotación del lado del servidor porque no hay claves del lado del servidor.
Cada persona revoca y regenera la suya en `/perfil`, y solo se afecta a sí misma.

## Deuda conocida

- **Rate limit**: lo aplica la API de tools4foresight, agrupando por dueño y no
  por clave (si fuera por clave, cualquiera multiplicaría su cuota generando
  claves). Este servidor solo propaga el 429 con su `Retry-After`.
- **El SDK de MCP arrastra `express`, `hono`, `ajv` y `jose`** como dependencias.
  Engorda el bundle de la función de Vercel. No hay nada que hacer desde este
  lado.
