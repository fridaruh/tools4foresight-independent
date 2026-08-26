# Contribuir

## Preparar el entorno

```bash
npm install
cp .env.example .env
# pon T4F_API_BASE_URL (tu instancia de tools4foresight, local o remota) y,
# solo para stdio, T4F_API_KEY con tu propia clave — la generas tú mismo en
# /perfil de esa instancia, nadie te la da. src/http.ts (modo HTTP local) no
# lee esta variable: es pass-through igual que el despliegue remoto.
npm test
npm run typecheck
```

Para probar el servidor a mano:

```bash
npm run dev:stdio      # transporte stdio, el de Claude Code / Desktop
npm run dev:http       # servidor HTTP local
npm run inspect        # MCP Inspector, la forma más rápida de ver las tools
```

## La regla que rompe todo si se olvida

**En transporte stdio, `stdout` es el canal JSON-RPC.** Un solo `console.log`
suelto en cualquier archivo que se cargue desde `src/stdio.ts` inyecta texto en
medio del protocolo y el cliente MCP se desconecta con un error de parseo que no
apunta a la línea culpable.

Todo log va a **`stderr`**: `console.error`, o el logger de `src/config.ts`.

## Agregar una tool

Seis pasos, en este orden:

1. **DTO** — si la API devuelve algo nuevo, añádelo a `src/client/types.ts`,
   copiando la forma de `docs/API.md`. Si `docs/API.md` no lo documenta, primero
   se documenta ahí.
2. **Cliente** — un método en `src/client/http-client.ts` con su TTL de caché.
3. **Tool** — en el archivo de `src/tools/` que le corresponda por tema.
4. **Formato** — la función que convierte el DTO a markdown, en `src/format/`.
5. **Test** — en `tests/`, con un cliente falso. Sin red.
6. **Documentación** — una sección en `docs/TOOLS.md` y una línea en
   `CHANGELOG.md`.

## Cómo se escribe una descripción de tool

La descripción es un prompt: es lo único que el modelo lee para decidir si usar la
tool y cómo interpretar lo que devuelve. Que diga:

- **Qué es** en el vocabulario del dominio ("una *señal* es una pieza de contenido
  guardada como indicio de futuro"), no en el de la base de datos.
- **Cuándo usar esta y no otra**.
- **Las trampas**: que `likedAt` es estimada, que un fósil no es un borrado, que
  los ids de macro-tema no son estables, que el `score` no se le muestra a una
  persona.

Una regla puesta en la descripción de la tool se obedece; la misma regla en un
README no la lee nadie.

## Estilo

- Comentarios en español, explicando **el porqué**, no el qué.
- TypeScript estricto. Nada de `any`, ni en tests.
- Imports internos con extensión `.js` (`moduleResolution: NodeNext`).
- Cero dependencias de runtime más allá del SDK de MCP y zod. `fetch`, `Map` y
  `node:http` son nativos y alcanzan.
