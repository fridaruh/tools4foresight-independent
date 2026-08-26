/**
 * Prompts MCP: guiones de conversación sugeridos.
 *
 * Un prompt no da ninguna capacidad extra —no puede hacer nada que las tools no
 * hagan ya— y este servidor sigue siendo de solo lectura. Lo que aportan es
 * evitar que cada persona reinvente el orden correcto de llamadas para las
 * preguntas que se repiten ("¿qué está creciendo?", "¿qué murió este mes?").
 *
 * Cada uno inyecta primero las reglas del dominio, para que el modelo no tenga
 * que descubrirlas leyendo la salida.
 */
import * as z from "zod/v4";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

/**
 * Las trampas del dominio, en un solo sitio. Repetirlas seis veces garantizaría
 * que con el tiempo divergen entre sí.
 */
const DOMAIN_RULES = [
  "Reglas del banco de señales de la persona con la que hablas (respétalas al redactar):",
  "",
  "- La fecha en que se guardó una señal (`likedAt`) es una ESTIMACIÓN, no un dato: la API de X",
  "  no expone cuándo ocurrió un like. Muéstrala siempre con `~` (ej. «~25 ago 2026»).",
  "- Un tema es un LINAJE que persiste entre corridas. Un tema muerto es un FÓSIL, no un borrado:",
  "  se conserva y puede resucitar. Nunca digas «eliminado» ni «se perdió».",
  "- NO le muestres a una persona el porcentaje de similitud entre señales: usa `strength`",
  "  (fuerte/media/débil). El `score` numérico es solo para tu razonamiento interno.",
  "- Los ids de macro-tema NO son estables entre corridas: no los cites como referencia duradera.",
  "- `publishStatus` es un dato de curaduría («esto ya lo revisé»), no un filtro: la persona ve\n  todo su banco, publicado o no.",
  "- Si dudas de un término del método, llama a `explain_foresight_term` en vez de improvisar.",
].join("\n");

function guion(...pasos: string[]) {
  return {
    messages: [
      { role: "user" as const, content: { type: "text" as const, text: DOMAIN_RULES } },
      { role: "user" as const, content: { type: "text" as const, text: pasos.join("\n") } },
    ],
  };
}

export function registerPrompts(server: McpServer): void {
  server.registerPrompt(
    "analizar_horizonte",
    {
      title: "Analizar un horizonte",
      description: "Lectura de un horizonte completo: qué está madurando y qué se está apagando.",
      argsSchema: { horizonte: z.string().describe("H1, H2 o H3.") },
    },
    ({ horizonte }) =>
      guion(
        `Analiza el horizonte ${horizonte} del mapa de foresight.`,
        "",
        "Sigue este orden:",
        `1. \`get_horizon\` con horizon="${horizonte}" para ver sus temas vivos y macro-temas.`,
        "2. Identifica los 3 temas con mayor velocidad (likes de los últimos 30 días vs. los 30 previos).",
        "3. `get_theme_history` de esos 3, para ver su trayectoria real y no solo la foto de hoy.",
        "4. Si algún tema te resulta opaco, `list_theme_signals` para leer de qué va.",
        "",
        "Cierra con: qué está madurando, qué se está apagando, y qué te sorprende de la comparación",
        "entre la foto actual y la trayectoria. Distingue lo que dicen los datos de tus hipótesis.",
      ),
  );

  server.registerPrompt(
    "informe_de_tema",
    {
      title: "Informe ejecutivo de un tema",
      description: "Ficha completa de un tema: qué es, sus señales clave, su trayectoria y sus puentes.",
      argsSchema: { tema: z.string().describe("El id del tema, o su nombre para buscarlo.") },
    },
    ({ tema }) =>
      guion(
        `Prepara un informe ejecutivo del tema: ${tema}`,
        "",
        "Sigue este orden:",
        `1. Si "${tema}" no parece un id, usa \`list_themes\` con q="${tema}" para localizarlo.`,
        "2. `get_theme` para su resumen y sus cuatro indicadores (velocidad, densidad, conectividad, novedad).",
        "3. `list_theme_signals` ordenado por vitalidad, para las señales que lo sostienen hoy.",
        "4. `get_theme_history` para su trayectoria.",
        "5. Si su conectividad es alta o tiene temas puente, `get_signal_neighbors` sobre una de sus",
        "   señales centrales para ver con qué se está enlazando fuera del tema.",
        "",
        "Estructura el informe en: qué es · por qué importa ahora · señales clave · trayectoria ·",
        "con qué hace puente · qué vigilar. Explica cada indicador en lenguaje llano la primera vez.",
      ),
  );

  server.registerPrompt(
    "radar_semanal",
    {
      title: "Radar de los últimos días",
      description: "Qué entró, qué cambió de horizonte y qué murió en el periodo reciente.",
      argsSchema: { dias: z.string().optional().describe("Cuántos días atrás mirar. Por defecto 7.") },
    },
    ({ dias }) => {
      const n = dias?.trim() || "7";
      return guion(
        `Arma el radar de los últimos ${n} días.`,
        "",
        "Sigue este orden:",
        "1. `get_corpus_overview` para saber cuándo fue la última corrida del grafo (si es vieja, dilo:",
        "   el mapa puede estar desactualizado y eso condiciona todo lo demás).",
        `2. \`list_signals\` con from = hace ${n} días, para lo que entró.`,
        `3. \`list_snapshots\` del periodo, y \`get_snapshot\` del más antiguo y del más reciente.`,
        "4. Compara los dos snapshots: qué temas crecieron, cuáles cambiaron de horizonte, cuáles",
        "   pasaron a fósil y cuáles resucitaron.",
        "",
        "Cierra con tres listas cortas: **entró**, **se movió**, **se apagó**. Si un tema pasó a fósil,",
        "di que quedó como fósil (puede resucitar), no que desapareció.",
      );
    },
  );

  server.registerPrompt(
    "senales_debiles",
    {
      title: "Rastrear señales débiles",
      description: "Recorre H3 buscando lo pequeño y novedoso, y propone hipótesis de crecimiento.",
      argsSchema: { categoria: z.string().optional().describe("Acota a una categoría.") },
    },
    ({ categoria }) =>
      guion(
        "Rastrea las señales débiles del mapa" + (categoria ? ` dentro de la categoría "${categoria}".` : "."),
        "",
        "Sigue este orden:",
        '1. `get_horizon` con horizon="H3": ahí viven las hipótesis a vigilar.',
        "2. `get_theme` de los temas con mayor **novedad** (distancia al centro del mapa) aunque sean chicos:",
        "   novedad alta + tamaño chico es justo el perfil de una señal débil interesante.",
        "3. `list_theme_signals` de los más prometedores para leer de qué van de verdad.",
        "4. `get_signal_neighbors` sobre alguna señal suelta, por si conecta con algo de H1 o H2 que",
        "   todavía no se ve como tema.",
        "",
        "Para cada candidata: qué es, por qué podría importar, qué tendría que pasar para que creciera,",
        "y qué la mataría. Marca claramente qué es dato y qué es hipótesis tuya.",
      ),
  );

  server.registerPrompt(
    "comparar_temas",
    {
      title: "Comparar dos temas",
      description: "Contrasta indicadores de dos temas y busca las señales puente entre ellos.",
      argsSchema: {
        tema_a: z.string().describe("Primer tema (id o nombre)."),
        tema_b: z.string().describe("Segundo tema (id o nombre)."),
      },
    },
    ({ tema_a, tema_b }) =>
      guion(
        `Compara los temas "${tema_a}" y "${tema_b}".`,
        "",
        "Sigue este orden:",
        "1. Localiza ambos con `list_themes` si no te dieron ids.",
        "2. `get_theme` de cada uno: contrasta tamaño, vitalidad, horizonte y los cuatro indicadores.",
        "3. `get_theme_history` de los dos, para comparar trayectorias y no solo el estado de hoy.",
        "4. `list_theme_signals` de ambos y, sobre las señales más vitales de uno,",
        "   `get_signal_neighbors` para encontrar las que enlazan con el otro: esas son los puentes.",
        "",
        "Cierra con: en qué se parecen, en qué divergen, cuál va por delante y qué los conecta.",
        "Presenta la comparación de indicadores en una tabla.",
      ),
  );

  server.registerPrompt(
    "explorar_desde_senal",
    {
      title: "Explorar el grafo desde una señal",
      description: "Parte de una señal y camina dos saltos por el mapa semántico.",
      argsSchema: { senal: z.string().describe("El id de la señal, o texto para buscarla.") },
    },
    ({ senal }) =>
      guion(
        `Explora el mapa partiendo de: ${senal}`,
        "",
        "Sigue este orden:",
        `1. Si "${senal}" no es un id, localízala con \`search_signals\`.`,
        "2. `get_signal` para leerla entera (TL;DR, por qué importa, impacto).",
        "3. `get_signal_neighbors` — primer salto.",
        "4. `get_signal_neighbors` sobre los 2 o 3 vecinos más cercanos — segundo salto.",
        "5. `get_theme` de los temas que vayan apareciendo, para situar el vecindario en el mapa.",
        "",
        "Cuenta el recorrido como una narración: de qué trata el vecindario, si cruza de un tema a otro,",
        "y qué idea aparece al mirar el conjunto que no se ve en la señal de partida.",
        "Describe la cercanía como fuerte/media/débil, nunca con un porcentaje.",
      ),
  );
}
