/**
 * Tool de dominio (#18 del catálogo, docs/PLAN.md §2.6).
 *
 * `explain_foresight_term` es LOCAL: no toca la red ni pasa por `ctx.client`.
 * Resuelve contra `src/domain/glossary.ts`, que es data pura en el propio
 * paquete. Úsala para explicar bien el mapa en vez de inventar la definición
 * de un término — es la que evita que un agente diga "tema eliminado" cuando
 * la palabra correcta del dominio es "fósil".
 */
import * as z from "zod/v4";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { READ_ONLY, guarded, toolResult, type ToolContext } from "./context.js";
import { GLOSSARY, GLOSSARY_KEYS, lookupTerm, type GlossaryEntry } from "../domain/glossary.js";

// `z.enum` exige a nivel de TIPOS una tupla no vacía (`[string, ...string[]]`),
// pero `GLOSSARY_KEYS` se declara como `readonly string[]` (sale de
// `Object.keys(GLOSSARY)`, que TypeScript no puede angostar a tupla). En
// runtime sabemos que nunca está vacío: `GLOSSARY` es un literal estático de
// 25 entradas definido en el mismo módulo, así que el cast es seguro por
// construcción — se documenta en vez de esconderlo detrás de un `as any`.
const TERM_KEYS = GLOSSARY_KEYS as [string, ...string[]];
const TERM = z.enum(TERM_KEYS);

/** DTO -> markdown de una entrada del glosario, con fórmula y constantes si las tiene. */
function renderTerm(entry: GlossaryEntry): string {
  const lines = [`## ${entry.term}`, "", `> ${entry.short}`, "", entry.long];

  if (entry.formula) {
    lines.push("", "**Fórmula:**", "```", entry.formula, "```");
  }

  if (entry.constants && entry.constants.length > 0) {
    lines.push("", "**Constantes reales:**");
    for (const c of entry.constants) {
      lines.push(`- **${c.name}**: \`${c.value}\` (${c.source})`);
    }
  }

  if (entry.related.length > 0) {
    lines.push("", `**Relacionado:** ${entry.related.join(", ")}`);
  }

  return lines.join("\n");
}

export function registerDomainTools(server: McpServer, _ctx: ToolContext): void {
  server.registerTool(
    "explain_foresight_term",
    {
      title: "Explica un término del método",
      description:
        "Explica un término del método de foresight (señal, tema, vitalidad, fósil, horizonte, velocidad, " +
        "densidad, conectividad, novedad, puente, macro-tema, PESTEL, snapshot, huérfana, entre otros: 25 " +
        "términos en total). ÚSALA PARA EXPLICAR BIEN EL MAPA EN VEZ DE INVENTAR LA DEFINICIÓN — evita, por " +
        "ejemplo, decir 'tema eliminado' cuando la palabra correcta del dominio es 'fósil' (un tema fósil no " +
        "se borra: se conserva íntegro y puede resucitar). No hace ninguna llamada de red: resuelve en local " +
        "contra el glosario del servidor.",
      inputSchema: {
        term: TERM.describe(
          "La clave del término a explicar (ej. 'vitalidad', 'fosil', 'H2'). Usa una de las claves del enum.",
        ),
      },
      annotations: READ_ONLY,
    },
    guarded(async ({ term }) => {
      // Búsqueda directa por clave exacta primero (el caso normal: `term` ya
      // viene validado por el `z.enum` de arriba). Si por lo que sea no
      // aparece ahí, se cae a `lookupTerm`, que tolera acentos y mayúsculas
      // ("FOSIL", "fósil", "fosil" resuelven al mismo término) — no se asume
      // a ciegas que el enum y el glosario están sincronizados.
      const entry = GLOSSARY[term] ?? lookupTerm(term);
      if (!entry) {
        throw new Error(
          `No existe el término "${term}" en el glosario de foresight. Términos disponibles: ${GLOSSARY_KEYS.join(", ")}.`,
        );
      }
      return toolResult(renderTerm(entry), { data: entry });
    }),
  );
}
