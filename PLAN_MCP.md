# Plan — MCP multi-tenant sobre el banco de señales de cada persona

> Portar la capa `/api/public/v1` + el servidor MCP de `x-likes-curator` /
> `MCP_Tools4Foresight` (single-tenant, el acervo de Frida) a `tools4foresight`
> (multi-tenant, un banco por persona).

## 0. La inversión central

En el origen, la API key **prueba que pagaste** para leer *un* acervo.
Aquí, la API key **es la identidad del banco**: resuelve a un `ownerId` y todo
lo que se lee pasa por `withOwner(ownerId, …)`. No hay contenido compartido.

Tres consecuencias duras:

1. **Se elimina `T4F_PUBLIC_API_KEYS`** (claves de entorno). Una clave sin dueño
   no tiene banco que leer; mantenerla sería una puerta sin tenant. La única
   fuente de claves es la tabla `api_keys`.
2. **Se elimina `PUBLISHED_ONLY`.** La persona ES la curadora de su banco: ve el
   100% de su material, publicado o no. `publishStatus` deja de ser un filtro
   secreto y pasa a ser **un campo expuesto** en los DTOs (dato útil: "esto ya lo
   revisé"). `ownerId`, en cambio, entra a la lista negra: nunca sale.
3. **El MCP remoto no lleva credencial dentro.** El `Bearer` del cliente ES su
   clave de tools4foresight; se pasa por request. Sin `MCP_ACCESS_TOKEN`, sin
   clave compartida, sin caché compartida entre tenants.

## 1. Decisiones tomadas

| Decisión | Elegido |
|---|---|
| Repo MCP | **Bifurcar**: `MCP_T4F_Multitenant` (nuevo, `git init`). `MCP_Tools4Foresight` queda intacto sirviendo a x-likes-curator. |
| Alcance de datos | **Todo su banco siempre**. Sin filtro de `publishStatus`. |
| Transporte | **HTTP remoto pass-through**, único modo soportado. `stdio` se conserva solo como herramienta de desarrollo (Inspector), no se publica en npm. |

## 2. `api_keys` NO lleva RLS — y por qué

Es la excepción que el propio `tenant-db.ts` ya documenta para las tablas de
better-auth: `resolveApiKey()` es **el query que descubre quién es el tenant**.
Corre antes de que exista un `app.owner_id` que fijar; con una política de RLS
encima devolvería cero filas siempre. Igual que `sessions`/`accounts`/
`verifications`:

- `api_keys` **no** entra en `TENANT_MODEL_FIELD`.
- **No** se le crea política de RLS.
- A cambio, **todo** acceso lleva `userId` en el `where`, sin excepción, y
  `scripts/qa-public-api.ts` lo verifica.

Esta excepción se documenta en el comentario de cabecera de `tenant-db.ts`
junto a las otras tres, y en `CLAUDE.md`.

## 3. Control de acceso

En el origen: `ownerHasAccess()` = admin o suscripción Stripe vigente.
Aquí **no hay Stripe ni paywall**. El equivalente es mínimo:

```
la clave existe && !revokedAt && el usuario existe  →  ownerId
```

Sin gradiente. Si más adelante hay planes, el punto de enganche es esa función y
solo esa.

## 4. Rate limit

El origen usa un `Map` en memoria por instancia (deuda conocida: best-effort).
Aquí ya existe `rate_limits` en Postgres → el límite pasa a ser **global**, lo
que salda esa deuda de gratis.

Requiere **extender `src/lib/rate-limit.ts`**: hoy su `isRateLimited(key)` es
`async` y tiene 5min/5 hardcodeados. Necesita aceptar `{ windowMs, max }` por
llamada, **conservando los defaults actuales** para no tocar a los llamadores
existentes (login, magic link).

Buckets: `120/min` normal y `10/min` para `/graph` y
`/snapshots/[id]?includeMembers`, agrupados por **`ownerId`**, no por clave —
si no, alguien multiplicaría su cuota generando claves.

## 5. Fases

### Fase 1 — Fundamentos (bloquea todo lo demás)
- `prisma/schema.prisma`: modelo `ApiKey` + relación en `User` + migración.
- `src/lib/api-keys.ts`: port sin Stripe.
- `src/lib/rate-limit.ts`: parametrizar ventana/tope.
- `src/lib/public-api-auth.ts`: única fuente = `api_keys`; resuelve a `ownerId`.
- `src/lib/public-api-response.ts`: `withPublicApi` inyecta `ownerId` al handler.
- `src/lib/public-cursor.ts`: port literal.
- `src/lib/public-rate-limit.ts`: bucket por `ownerId`.
- `src/lib/tenant-db.ts` + `CLAUDE.md`: documentar la excepción de `api_keys`.

### Fase 2 — La frontera de datos
- `src/lib/public-dto.ts`: selects + mappers. `publishStatus` expuesto,
  `ownerId` y `embedding` prohibidos. Campos nuevos de este schema: `tags`.
- `src/lib/public-query.ts`: sin `PUBLISHED_ONLY`; filtro opcional `status`.
- `src/lib/public-horizons.ts`: agregaciones dentro de `withOwner`.

### Fase 3 — 17 route handlers (4 grupos en paralelo)
Todos `withOwner(ownerId, …)`. Nunca `prisma` global sobre tablas de tenant.
- **Señales** (3): `signals`, `signals/[id]`, `signals/[id]/neighbors`
- **Temas** (5): `themes`, `themes/[id]`, `themes/[id]/signals`,
  `themes/[id]/history`, `macro-themes`
- **Horizontes/taxonomía** (5): `horizons`, `horizons/[key]`, `categories`,
  `pestel`, `meta`
- **Grafo/snapshots/salud** (4): `graph`, `snapshots`, `snapshots/[id]`, `health`

### Fase 4 — Superficie de usuario y QA
- `src/app/api/perfil/api-keys/route.ts` (GET/POST/DELETE).
- `src/components/ApiKeysManager.tsx` + montarlo en `/perfil`.
- `scripts/qa-public-api.ts`: **dos tenants, una clave cada uno; la clave de A
  jamás devuelve una fila de B** en ninguno de los 17 endpoints. Enganchado a
  `npm run qa`.

### Fase 5 — El fork del MCP
`MCP_T4F_Multitenant` (copia de `MCP_Tools4Foresight`, `git init` limpio):
- `api/mcp.ts`: extrae el `Bearer` entrante → `loadConfigForRequest()` → un
  `T4FClient` (y su caché) **por request**. Cero estado entre tenants.
- Borrar `src/http-auth.ts` y `MCP_ACCESS_TOKEN`.
- `src/config.ts`: `apiKey` deja de ser obligatoria a nivel proceso.
- Tools/instrucciones/glosario: "el acervo de Frida" → "tu propio banco".
- Docs reescritas: README, ARCHITECTURE, DEPLOYMENT, SECURITY, TOOLS.
