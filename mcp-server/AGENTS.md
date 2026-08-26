# Reglas para agentes que trabajen en este repo

Este es el servidor MCP de solo lectura de tools4foresight. Antes de tocar nada,
lee `docs/ARCHITECTURE.md` y `docs/API.md`.

## Invariantes

1. **Es de SOLO LECTURA y para EXPLORAR.** Nunca agregues una tool, un resource
   o un método de cliente que escriba, modifique o borre algo. Nada de
   operaciones de administración (publicar, editar análisis, recalcular el
   grafo): eso vive en tools4foresight. Si una tarea parece pedirlo, pregunta
   antes. Los **prompts** son guiones de conversación y no dan capacidades: si
   agregas uno, que solo encadene tools de lectura.
2. **`stdout` es el canal JSON-RPC en stdio.** Todo log va a `stderr`. Un
   `console.log` rompe el protocolo.
3. **No inventes campos.** El contrato es `docs/API.md`. Si un campo no está ahí,
   la API no lo devuelve, por muy razonable que suene.
4. **Cero dependencias nuevas** sin una razón explícita: solo
   `@modelcontextprotocol/sdk` y `zod`.
5. **Imports internos con extensión `.js`** (`moduleResolution: NodeNext`).
6. Toda tool nueva necesita **test** y una sección en **`docs/TOOLS.md`**.

## Vocabulario del dominio (no lo traiciones)

- Una **señal** es contenido curado guardado como indicio de futuro.
- Un **tema** es un linaje que persiste entre corridas; puede **morir** y
  **resucitar**. Un tema muerto es un **fósil**, no un borrado: se dice "fósil",
  nunca "eliminado".
- **`likedAt` es una estimación**: se muestra siempre con `~`.
- **El porcentaje de similitud no se le muestra a una persona**: se usa
  `strength` (fuerte/media/débil). El `score` es para el razonamiento del agente.
- Los **ids de macro-tema no son estables** entre corridas.

El glosario completo vive en `src/domain/glossary.ts` y se rinde en
`docs/DOMAIN.md`. Es la fuente única: no dupliques definiciones.
