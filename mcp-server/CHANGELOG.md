# Changelog

Formato basado en [Keep a Changelog](https://keepachangelog.com/es-ES/1.1.0/).
Este proyecto sigue [Versionado Semántico](https://semver.org/lang/es/).

## [Unreleased] — bifurcación multi-tenant

Este repo nace como bifurcación de `MCP_Tools4Foresight` (single-tenant, servía
el acervo único de una curadora) para convertirlo en **multi-tenant**: cada
persona tiene su propio banco de señales en tools4foresight y su propia API key
decide cuál se lee. Es un cambio de modelo de auth y de dato, no una ampliación
de features — la superficie de tools/resources/prompts se conserva igual.

### Cambiado

- **Cero credenciales dentro del servidor.** El servidor original llevaba
  **dos** credenciales propias: `T4F_API_KEY` (su clave contra la API,
  guardada en el despliegue) y `MCP_ACCESS_TOKEN` (el token que exigía a quien
  lo llamara). Las dos desaparecen. Ahora el único despliegue no guarda ninguna
  clave: el `Authorization: Bearer` que manda cada cliente **es su propia
  clave de tools4foresight**, se usa solo durante esa petición para construir
  un `T4FClient` y una caché nuevos, y muere con la respuesta. Ver
  `src/http-passthrough.ts` y `docs/ARCHITECTURE.md`.
- **Ya no hay acervo único ni paywall de suscripción.** El servidor original
  servía el contenido curado de pago de una sola persona a lectores externos.
  Aquí cada quien lee su propio banco: no hay contenido compartido, no hay
  planes ni Stripe de por medio.
- **`publishStatus` deja de ser un filtro secreto y pasa a ser un dato
  expuesto.** En el origen la API solo servía señales `published` y el campo
  estaba en la lista negra (insinuar que existía algo "pending" habría sido una
  fuga de catálogo). Aquí la persona es la curadora de su propio banco: ve el
  100% de su material, y `publishStatus` viaja como dato de curaduría
  («esto ya lo revisé» / «sigue en la bandeja»), filtrable con
  `?publishStatus=`.
- **Nueva regla de aislamiento: un id de otro tenant devuelve 404, nunca
  403.** Sustituye a la regla del servidor single-tenant ("un id no publicado
  devuelve 404 y no 403"), que ya no aplica porque no hay catálogo oculto al
  propio dueño.
- **No hay distribución por `npx`.** El servidor original se instalaba con
  `npx -y mcp-tools4foresight`, cada quien corriendo su propia copia con su
  clave en `T4F_API_KEY`. El modo soportado ahora es un único despliegue HTTP
  remoto compartido (`api/mcp.ts` en Vercel); `stdio` sigue existiendo, pero
  solo como herramienta de desarrollo/self-host para quien clone el repo.
- **`T4F_API_BASE_URL` ya no tiene default.** El servidor original apuntaba
  por defecto al acervo único (`tools4foresight.com/api/public/v1`); aquí un
  default equivocado mandaría la clave de un usuario a un host que no es el
  suyo, así que la variable es obligatoria.

### Pendiente

- Autenticación por OAuth 2.1 (`ProxyOAuthServerProvider`) en vez de una API
  key copiada a mano al header. El pass-through de esta versión ya es
  compatible con esa evolución: lo que cambiaría es de dónde sale el Bearer,
  no qué se hace con él. Ver la última sección de `docs/ARCHITECTURE.md`.

## [0.1.0] — versión original (single-tenant)

Primera versión del servidor MCP de solo lectura sobre el acervo único de
tools4foresight, previa a la bifurcación multi-tenant.

### Añadido

- **18 tools** de consulta: señales (`list_signals`, `search_signals`,
  `get_signal`, `get_signal_neighbors`), temas (`list_themes`, `get_theme`,
  `list_theme_signals`, `get_theme_history`, `list_macro_themes`), horizontes
  (`get_horizons_overview`, `get_horizon`), taxonomía (`list_categories`,
  `list_pestel_dimensions`, `get_corpus_overview`), grafo (`get_graph`),
  snapshots (`list_snapshots`, `get_snapshot`) y método
  (`explain_foresight_term`, que resuelve en local, sin red).
- **7 resources** (`foresight://overview`, `://glossary`, `://horizons`,
  `://signal/{id}`, `://theme/{id}`, `://horizon/{key}`, `://macro-theme/{id}`).
- **6 prompts** como guiones de conversación: `analizar_horizonte`,
  `informe_de_tema`, `radar_semanal`, `senales_debiles`, `comparar_temas`,
  `explorar_desde_senal`. Todos inyectan primero las reglas del dominio.
- **Tres entry points** sobre un mismo core: stdio (distribuido por `npx`),
  HTTP local para desarrollo y una función de Vercel con Streamable HTTP
  stateless.
- Cliente HTTP propio con reintentos (solo 429/5xx/red), timeout, errores
  traducidos a mensajes accionables para el modelo, y caché en memoria con TTL
  por tipo de dato y evicción LRU.
- Glosario del método como datos (`src/domain/glossary.ts`, 25 términos), que
  alimenta la tool, el resource y `docs/DOMAIN.md` desde una sola fuente.
- Documentación: `README.md`, `docs/{API,TOOLS,ARCHITECTURE,DOMAIN,DEPLOYMENT}.md`,
  `SECURITY.md`, `CONTRIBUTING.md`, `AGENTS.md`.

### Decidido

- **Superficie solo de consulta**: ni tools ni prompts hacen nada que un
  administrador haría. Los prompts son guiones sugeridos, no capacidades.
- **Sin acceso directo a Postgres**: todo pasa por la API pública
  `/api/public/v1` de tools4foresight, para que la frontera de seguridad viva en
  un solo sitio (`public-dto.ts`).
- **Se exponen `score` y `strength`**: el porcentaje de similitud no se le
  muestra a una persona, pero un agente lo necesita para ordenar y filtrar. La
  regla de uso va en la descripción de la tool.
