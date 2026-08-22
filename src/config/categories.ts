// Plantilla de categorías con la que arranca CADA usuario nuevo.
//
// Ya no es "el catálogo de la app": desde la Fase 1 el catálogo vive en la tabla
// `categories`, una copia por tenant, y el usuario lo edita desde /categorias. Este
// archivo es solo la semilla que src/lib/seed-tenant.ts inserta al crear la cuenta.
//
// Por eso los ejemplos son genéricos y neutrales: son un few-shot de arranque para
// alguien que todavía no tiene señales, no los likes de nadie en particular. Cuando
// el usuario ajuste descripciones y ejemplos a su vocabulario, la clasificación
// mejora — ese es el punto de que sean editables.
//
// Fase 3 (hecho): el pipeline (src/lib/categorize.ts, src/lib/jobs/categorize.ts) ya
// NO importa nada de aquí — lee el catálogo por tenant con src/lib/categories.ts
// (loadCategories, dentro de withOwner). Este archivo queda como plantilla de seed
// nada más: solo debe importarlo src/lib/seed-tenant.ts. CATEGORY_NAMES /
// FALLBACK_CATEGORY / isKnownCategory se mantienen exportados porque UI de fases
// anteriores (api/categories, /categorias) todavía los usa para ordenar opciones;
// esas pantallas migrarán a leer `categories` de la DB en Fase 4 (PLAN 4.3).

export type CategoryDefinition = {
  name: string;
  /** Qué entra aquí. Va literal al prompt: escribirlo para el modelo. */
  description: string;
  /** 2 ejemplos por categoría. Texto corto tipo tweet. */
  examples: string[];
  /** La categoría a la que cae lo que no calza en ninguna otra. Solo una. */
  isFallback?: boolean;
};

export const CATEGORIES: CategoryDefinition[] = [
  {
    name: "AI News",
    description:
      "Noticias y lanzamientos de IA: modelos nuevos, rondas de inversión de empresas de IA, movimientos del sector, resultados de benchmarks. Es la noticia en sí; si el item explica cómo usar algo, va en AI Docs/Updates.",
    examples: [
      "Un laboratorio anuncia su nuevo modelo insignia, disponible hoy en su API",
      "Una empresa de IA levanta una ronda y triplica su valuación en seis meses",
    ],
  },
  {
    name: "AI Docs/Updates",
    description:
      "Documentación técnica, changelogs, releases, tutoriales y guías de implementación de herramientas de IA. Lo que te enseña a usar algo de IA. Si el proyecto no tiene que ver con IA, va en Developer Tools & Projects.",
    examples: [
      "Nueva guía en la documentación: cómo cachear prompts, con ejemplos por lenguaje",
      "El conector oficial de esta herramienta ya permite crear y editar flujos",
    ],
  },
  {
    name: "Developer Tools & Projects",
    description:
      "Herramientas de código, librerías, CLIs, repos open source y proyectos que alguien construyó, cuando el tema central NO es la IA. Incluye el clásico 'hice esto y aquí está el link'.",
    examples: [
      "Hice una CLI diminuta para descargar videos; se instala con un comando",
      "Publiqué un servidor open source, self-hosted y sin dependencias de terceros",
    ],
  },
  {
    name: "Startup & Business",
    description:
      "Negocio y producto: lanzamientos de empresa, métricas y revenue, levantamiento de capital, contrataciones, marca y reflexiones de emprendedor. Si la empresa es de IA y la nota es la noticia del modelo, va en AI News.",
    examples: [
      "Lanzamos hace ocho días y hoy cruzamos el primer millón de ingresos recurrentes",
      "La mayoría de los negocios locales todavía no tiene sitio web; ahí hay un mercado",
    ],
  },
  {
    name: "Personal & Pop-Culture",
    description:
      "Memes, chistes, videos virales, anécdotas personales, música, celebridades y comentario ligero del día a día. La cobertura de cine y series (estrenos, tráilers, críticas) va en Movies; el comentario personal sobre una película o serie sí se queda aquí. Libros y novelas no son cine: se quedan aquí.",
    examples: [
      "Hoy aprendí que la confianza con la que dices algo pesa más que el contenido",
      "Fui por un café y me encontré con alguien que solo conocía por internet",
    ],
  },
  {
    name: "Community Events & Conferences",
    description:
      "Meetups, hackathones, charlas, conferencias y networking: convocatorias, participaciones y recuentos. Lo que tiene fecha y lugar.",
    examples: [
      "El sábado doy una charla en la conferencia local; nos vemos ahí",
      "Se viene el evento anual: buen momento para agendar café con gente del sector",
    ],
  },
  {
    name: "Social Commentary",
    description:
      "Política, sociedad, género e identidad, salud mental, religión y temas de fondo. Opinión sobre el mundo, no sobre tecnología ni sobre la vida personal de quien publica.",
    examples: [
      "Entre respetar la forma y respetar a la persona, la persona gana siempre",
      "El acceso a salud mental sigue siendo un privilegio y no un servicio básico",
    ],
  },
  {
    name: "Crypto/Web3",
    description: "Criptomonedas, NFTs, DeFi, blockchains y tooling de web3.",
    examples: [
      "Una plataforma empieza a pagar a creadores en stablecoins en dos países más",
      "Para quien construye en web3: el feed es ruido, las conversaciones offline son la señal",
    ],
  },
  {
    name: "Movies",
    description:
      "Cine y series: estrenos, tráilers, críticas, premios, reparto y recomendaciones. Libros y novelas no cuentan como cine — esos van en Personal & Pop-Culture.",
    examples: [
      "Ya salió el tráiler de la tercera parte y se estrena a fin de año",
      "Recomiéndenme una serie para maratonear el fin de semana",
    ],
  },
  {
    name: "Otros",
    description:
      "Lo que no calza en ninguna categoría existente y tampoco justifica una nueva. Usarla es el último recurso, no el default: si un item calza aunque sea parcialmente en otra categoría, esa gana.",
    examples: [
      "Buenos días a todos menos a quienes no usan modo oscuro",
      "Recordatorio de que hoy es martes y eso es todo lo que tengo",
    ],
    isFallback: true,
  },
];

/** Nombre de la categoría de fallback; nunca debe faltar del catálogo. */
export const FALLBACK_CATEGORY =
  CATEGORIES.find((c) => c.isFallback)?.name ?? "Otros";

export const CATEGORY_NAMES = CATEGORIES.map((c) => c.name);

export function isKnownCategory(name: string): boolean {
  return CATEGORY_NAMES.includes(name);
}
