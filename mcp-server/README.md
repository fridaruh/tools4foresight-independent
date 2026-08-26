# MCP T4F Multitenant

Servidor **MCP de solo lectura** sobre **tu propio banco de señales** de
tools4foresight. Le da a tu agente el mismo mapa que ves tú: las señales que
guardaste, el grafo semántico que salió de ellas, los temas con su historia y
los tres horizontes.

Es **multi-tenant**: un solo despliegue atiende a todas las personas. La API key
que mandas en la cabecera **es tu identidad** — resuelve a tu cuenta y solo
devuelve lo tuyo. El servidor **no guarda ninguna credencial**.

**No escribe nada.** No hay una sola herramienta que modifique, publique o borre
algo. Ver [`SECURITY.md`](./SECURITY.md).

## Qué puede hacer un agente con esto

- «¿Cuál es el estado de mi mapa?» → panorama de H1/H2/H3 con sus macro-temas.
- «¿Qué temas están creciendo y cuáles se apagan?» → serie temporal por tema.
- «Resume mi tema de agentes de IA» → ficha con sus cuatro indicadores y sus señales.
- «¿Qué se parece a esta señal?» → vecinos semánticos, sin salir de tu mapa.
- «¿Qué señales débiles tengo en H3?» → temas chicos con novedad alta.
- «¿Qué murió este mes?» → fósiles, comparando snapshots.
- «¿Qué guardé y todavía no he revisado?» → `publishStatus` es un dato, no un filtro.

## Conectarlo

Necesitas tu **API key**: la generas en **`/perfil` → "Conecta tus agentes"** de
tu instancia de tools4foresight. Sale una sola vez.

Va en la cabecera `Authorization` de tu cliente MCP:

```json
{
  "mcpServers": {
    "tools4foresight": {
      "type": "http",
      "url": "https://<el-despliegue-mcp>/api/mcp",
      "headers": { "Authorization": "Bearer t4f_tu-api-key-personal" }
    }
  }
}
```

En Claude Code:

```bash
claude mcp add --transport http tools4foresight \
  https://<el-despliegue-mcp>/api/mcp \
  --header "Authorization: Bearer t4f_tu-api-key-personal"
```

Hay un ejemplo completo en [`.mcp.json.example`](./.mcp.json.example), y cómo
levantar el despliegue en [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md).

> **No hay `npx`.** Este paquete no se publica en npm: el modo soportado es el
> despliegue HTTP remoto. `stdio` sigue existiendo (`npm run dev:stdio`) como
> herramienta de desarrollo para quien clone el repo, no como forma de usarlo.

## Variables de entorno (del despliegue, no tuyas)

Ninguna es una credencial. La clave de cada persona viaja por cabecera y no se
guarda en ningún lado.

| Variable | Obligatoria | Default | Qué es |
|---|---|---|---|
| `T4F_API_BASE_URL` | **sí** | — (a propósito) | URL base de la API pública de tu instancia, terminada en `/api/public/v1`. Sin default: uno malo mandaría claves de usuarios al host equivocado |
| `T4F_TIMEOUT_MS` | no | `15000` | Timeout por petición |
| `T4F_RETRIES` | no | `2` | Reintentos en 429/5xx/red. Nunca se reintenta un 401 |
| `T4F_CACHE_TTL_MS` | no | `60000` | `0` desactiva la caché. La caché vive dentro del cliente de cada petición: nunca se comparte entre personas |
| `T4F_LOG_LEVEL` | no | `error` | `silent`, `error` o `debug`. Siempre a `stderr` |
| `MCP_PORT` | no | `3333` | Puerto del servidor HTTP **local** (desarrollo) |
| `T4F_API_KEY` | solo en `stdio` | — | Camino de desarrollo/self-host. **No la pongas en el despliegue remoto** |

## Las 18 tools

Referencia completa con ejemplos en [`docs/TOOLS.md`](docs/TOOLS.md).

| Tema | Tools |
|---|---|
| Señales | `list_signals`, `search_signals`, `get_signal`, `get_signal_neighbors` |
| Temas | `list_themes`, `get_theme`, `list_theme_signals`, `get_theme_history`, `list_macro_themes` |
| Horizontes | `get_horizons_overview`, `get_horizon` |
| Taxonomía | `list_categories`, `list_pestel_dimensions`, `get_corpus_overview` |
| Grafo | `get_graph` |
| Snapshots | `list_snapshots`, `get_snapshot` |
| Método | `explain_foresight_term` |

Más 7 **resources**, para adjuntar contexto a mano desde Claude Desktop o Cursor:
`foresight://overview`, `://glossary`, `://horizons`, `://signal/{id}`,
`://theme/{id}`, `://horizon/{key}` y `://macro-theme/{id}`.

Y 6 **prompts** —guiones de conversación sugeridos, que no dan ninguna capacidad
extra— para las preguntas que se repiten: `analizar_horizonte`,
`informe_de_tema`, `radar_semanal`, `senales_debiles`, `comparar_temas` y
`explorar_desde_senal`.

Este servidor es **para explorar**: publicar, editar el análisis o recalcular el
grafo se siguen haciendo desde la app de tools4foresight, y nada de eso se expone
aquí.

## Cuatro cosas que conviene saber antes de leer la salida

1. **La fecha de una señal es una estimación.** La API de X no expone cuándo
   ocurrió un like, solo el orden. Por eso `likedAt` se muestra siempre con `~`.
2. **Un tema muerto es un fósil, no un borrado.** Se conserva y puede resucitar.
   Nada se elimina del mapa.
3. **El porcentaje de similitud no se le muestra a una persona.** Un 0.63 se lee
   como una precisión que el método no tiene. Se usa `strength`
   (fuerte/media/débil); el `score` crudo está disponible para el razonamiento del
   agente.
4. **Ves el 100% de tu banco.** No hay filtro de "solo publicadas": tú eres quien
   lo curó. `publishStatus` viaja como dato útil ("esto ya lo revisé"), nunca
   como una puerta cerrada.

El glosario completo del método está en [`docs/DOMAIN.md`](docs/DOMAIN.md) y se
puede consultar en vivo con `explain_foresight_term`.

## Documentación

| Documento | Para qué |
|---|---|
| [`docs/TOOLS.md`](docs/TOOLS.md) | Cada tool, con entrada y salida de ejemplo |
| [`docs/API.md`](docs/API.md) | Contrato de la API pública multi-tenant que consume |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | Cómo está armado y por qué |
| [`docs/DOMAIN.md`](docs/DOMAIN.md) | Glosario del método de foresight |
| [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) | Desplegar el servidor (una vez, para todos) |
| [`SECURITY.md`](./SECURITY.md) | Aislamiento entre bancos y qué nunca se expone |
| [`CONTRIBUTING.md`](./CONTRIBUTING.md) | Cómo agregar una tool |

## Licencia

El código es MIT. **El contenido que sirve no lo es**: las señales y el mapa que
devuelve son de la persona cuya clave se usó para pedirlos.
