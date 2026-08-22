/**
 * Onboarding: TODO el contenido en un solo archivo.
 *
 * La regla de este módulo es que ningún componente escriba copy. El tour, las
 * introducciones por módulo, las etiquetas de las acciones y la guía de
 * configuración salen de aquí; los componentes solo pintan. Cambiar un texto es
 * editar este archivo y nada más.
 *
 * El orden de `MODULE_INTROS` es el **ciclo de vida de una señal**, no el de la
 * navegación: Sistema → Catálogo → Categorías → Análisis → Grafo → Horizontes.
 * La nav empieza por Catálogo porque es la pantalla del día a día; la guía
 * empieza por Sistema porque sin conexión no hay nada que ver. De este orden
 * salen los "Paso N" y la numeración del widget.
 *
 * Capturas reales en public/onboarding/ (regenerar con `npm run seed:demo && npm run shots:onboarding`).
 */

export type ModuleKey =
  | "sistema"
  | "catalogo"
  | "categorias"
  | "analisis"
  | "grafo"
  | "horizontes";

/**
 * Iconos disponibles para el panel de respaldo (cuando falta la captura).
 * Se guardan como clave y no como componente para que este archivo siga siendo
 * datos puros: los tests y el server pueden importarlo sin arrastrar React.
 */
export type IconKey = ModuleKey | "guia" | "nav";

/**
 * Las señales que la app puede verificar sola. Una tarea con `fact` no se marca
 * a mano: se pregunta a la base de datos (`src/lib/onboarding/facts.ts`).
 *
 * `itemCount` y `publishedCount` son conteos; el resto son banderas. La guía
 * los reduce a booleano con `factSatisfied` (número > 0 = hecho).
 */
export type OnboardingFacts = {
  /** Hay un token de X guardado para el tenant. */
  xConnected: boolean;
  /** Señales en el catálogo. */
  itemCount: number;
  /** Señales publicadas (las que entran al grafo). */
  publishedCount: number;
  /** Hay al menos un tema semántico o un snapshot de grafo. */
  hasGraph: boolean;
  /**
   * Siempre `false`: "revisar tus categorías" no deja rastro verificable — todo
   * tenant nace con la plantilla de diez sembrada, así que contarlas no
   * distingue al que la revisó del que no. Queda en el tipo para el día en que
   * el catálogo guarde una marca de edición; hoy esa tarea es manual.
   */
  categoriesReviewed: boolean;
};

export type FactKey = keyof OnboardingFacts;

export const EMPTY_FACTS: OnboardingFacts = {
  xConnected: false,
  itemCount: 0,
  publishedCount: 0,
  hasGraph: false,
  categoriesReviewed: false,
};

/** Un conteo cuenta como hecho si es > 0; una bandera, si es true. */
export function factSatisfied(facts: OnboardingFacts, key: FactKey): boolean {
  const value = facts[key];
  return typeof value === "number" ? value > 0 : value;
}

/**
 * Acción real del módulo. Con `fact`, la guía la verifica contra la base y no
 * ofrece checkbox; sin `fact`, el usuario la marca a mano.
 */
export type ModuleAction = {
  /** `<modulo>:action` o `<modulo>:action-<sufijo>` si el módulo tiene varias. */
  id: string;
  label: string;
  fact?: FactKey;
};

export type ModuleIntro = {
  key: ModuleKey;
  /** Raíz exacta del módulo: solo ahí se dispara el modal de introducción. */
  route: string;
  title: string;
  description: string;
  /** Qué conviene tener a la mano ANTES de entrar al módulo. */
  antes?: string;
  /** Acción principal, a donde lleva el CTA del modal. */
  cta: { label: string; href: string };
  /** Captura real. Opcional: si falta, se pinta el panel negro con el icono. */
  screenshot?: string;
  icon: IconKey;
  actions: ModuleAction[];
};

export const MODULE_INTROS: ModuleIntro[] = [
  {
    key: "sistema",
    screenshot: "/onboarding/sistema.png",
    route: "/conexion",
    title: "Paso 1 · Sistema",
    icon: "sistema",
    description:
      "Aquí vive la conexión con X, tus cuotas del día y el estado de cada corrida del pipeline.",
    antes: "Ten a la mano tu cuenta de X.",
    cta: { label: "Conectar mi cuenta de X", href: "/conexion" },
    actions: [{ id: "sistema:action", label: "Conecta tu cuenta de X", fact: "xConnected" }],
  },
  {
    key: "catalogo",
    screenshot: "/onboarding/catalogo.png",
    route: "/",
    title: "Paso 2 · Catálogo",
    icon: "catalogo",
    description:
      "Todo lo que le diste like en X, tal cual llega: tweet, autor, link y fecha estimada del like. La primera ingesta trae hasta tres meses de historial; después entra lo nuevo cada mañana.",
    antes:
      'Si acabas de conectar X, dispara la primera corrida desde Sistema con "Correr mi pipeline" en vez de esperar a las 06:00 UTC.',
    cta: { label: "Ver mi catálogo", href: "/" },
    actions: [
      { id: "catalogo:action", label: "Ten tu primera señal en el catálogo", fact: "itemCount" },
    ],
  },
  {
    key: "categorias",
    screenshot: "/onboarding/categorias.png",
    route: "/categorias",
    title: "Paso 3 · Categorías",
    icon: "categorias",
    description:
      "Tu catálogo de categorías es lo que el modelo usa para clasificar. Arranca con una plantilla de diez; edítala con tu vocabulario y tus ejemplos y la siguiente corrida clasifica mejor. Arriba ves de dónde vienen tus señales: dominios y cuentas.",
    antes:
      "Piensa en 5–8 temas que de verdad sigues. Una categoría con buena descripción y dos ejemplos reales vale más que diez genéricas.",
    cta: { label: "Revisar mis categorías", href: "/categorias" },
    // Manual: ver el comentario de `categoriesReviewed`.
    actions: [{ id: "categorias:action", label: "Revisa o edita tu catálogo de categorías" }],
  },
  {
    key: "analisis",
    screenshot: "/onboarding/analisis.png",
    route: "/enrich",
    title: "Paso 4 · Análisis",
    icon: "analisis",
    description:
      "La mesa de trabajo: por cada señal el modelo escribe TL;DR, impacto y por qué importa. Edita cualquier celda y queda marcada como manual: ningún job la vuelve a pisar. Publicar una señal es lo que la mete al grafo.",
    antes:
      "Publica solo lo que de verdad es una señal. Lo descartado no se borra: sale de esta tabla y deja de gastar llamadas.",
    cta: { label: "Abrir la tabla de análisis", href: "/enrich" },
    actions: [
      { id: "analisis:action", label: "Publica tu primera señal", fact: "publishedCount" },
    ],
  },
  {
    key: "grafo",
    screenshot: "/onboarding/grafo.png",
    route: "/grafo",
    title: "Paso 5 · Grafo",
    icon: "grafo",
    description:
      "Tus señales publicadas como mapa: cada nodo es una señal, cada arista una similitud fuerte, cada color un tema detectado y bautizado por el modelo. Se recalcula solo cada mañana o cuando lo pides desde Sistema.",
    antes:
      "Con menos de ~10 señales publicadas el grafo se ve vacío; es normal. Los temas aparecen cuando hay grupos de tres o más señales parecidas.",
    cta: { label: "Ver mi grafo", href: "/grafo" },
    actions: [
      { id: "grafo:action", label: "Recalcula el grafo por primera vez", fact: "hasGraph" },
    ],
  },
  {
    key: "horizontes",
    screenshot: "/onboarding/horizontes.png",
    route: "/horizontes",
    title: "Paso 6 · Horizontes",
    icon: "horizontes",
    description:
      "Los temas del grafo leídos como tendencias: vitalidad, velocidad, densidad y un horizonte sugerido H1/H2/H3 que puedes fijar a mano. También exporta todo a CSV.",
    antes:
      "El horizonte sugerido es una heurística; fíjalo tú cuando sepas más que el modelo. Lo fijado a mano no se vuelve a tocar.",
    cta: { label: "Ver mis horizontes", href: "/horizontes" },
    // Manual: fijar un horizonte o exportar un CSV no deja marca distinguible.
    actions: [
      { id: "horizontes:action", label: "Fija un horizonte a mano o exporta un CSV" },
    ],
  },
];

export type TaskKind = "tour" | "intro" | "action";

export type GuideTask = {
  /** `<modulo>:<tipo>` — el tipo se resuelve por convención en `taskKind`. */
  id: string;
  label: string;
  kind: TaskKind;
  href?: string;
  module?: ModuleKey;
  fact?: FactKey;
};

export type GuideSection = {
  key: string;
  title: string;
  tasks: GuideTask[];
};

/**
 * El tipo de una tarea sale de su id, no de una tabla aparte: `bienvenida:tour`,
 * `grafo:intro`, `sistema:action-key`. Cualquier sufijo que empiece con `action`
 * es una acción, para que un módulo pueda tener más de una.
 */
export function taskKind(taskId: string): TaskKind {
  const suffix = taskId.split(":")[1] ?? "";
  if (suffix === "tour") return "tour";
  if (suffix === "intro") return "intro";
  return "action";
}

/** El módulo de una tarea (`grafo:intro` → `grafo`). */
export function taskModule(taskId: string): string {
  return taskId.split(":")[0] ?? "";
}

/** Mapa `taskId → fact`, derivado de las acciones de cada módulo. */
export const TASK_FACTS: Record<string, FactKey> = Object.fromEntries(
  MODULE_INTROS.flatMap((m) =>
    m.actions.filter((a) => a.fact).map((a) => [a.id, a.fact as FactKey]),
  ),
);

export const GUIDE_SECTIONS: GuideSection[] = [
  {
    key: "bienvenida",
    title: "Bienvenida",
    tasks: [{ id: "bienvenida:tour", label: "Completa el tour", kind: "tour" }],
  },
  ...MODULE_INTROS.map(
    (m): GuideSection => ({
      key: m.key,
      // El "Paso N" lo pinta el widget con su propia numeración.
      title: m.title.replace(/^Paso \d+ · /, ""),
      tasks: [
        {
          id: `${m.key}:intro`,
          label: "Introducción",
          kind: "intro" as const,
          module: m.key,
          href: m.route,
        },
        ...m.actions.map((a) => ({
          id: a.id,
          label: a.label,
          kind: "action" as const,
          module: m.key,
          href: m.cta.href,
          fact: a.fact,
        })),
      ],
    }),
  ),
];

export type TourStep = {
  title: string;
  /** Globo de diálogo del primer paso. */
  bubble?: string;
  /** Fragmento del globo que va en Signal Orange. */
  bubbleHighlight?: string;
  /** Captura real. Opcional: si falta, se pinta el panel negro con el icono. */
  image?: string;
  /** Etiqueta del panel de respaldo cuando falta la captura. */
  imageLabel?: string;
  icon?: IconKey;
  /** Lista numerada del ciclo de vida de una señal (paso 2). */
  flow?: string[];
  description: string;
  cta: string;
};

export const TOUR_STEPS: TourStep[] = [
  {
    title: "¡Hola! Bienvenido a Tools 4 Foresight",
    bubble: "Tu banco de señales en menos de 5 minutos",
    bubbleHighlight: "5 minutos",
    description:
      'Tools 4 Foresight convierte lo que le das like en X en señales de foresight: categorizadas, analizadas y conectadas en un mapa de temas. Te enseño cómo funciona en un par de minutos. Dale a "Siguiente" cuando quieras.',
    cta: "Siguiente",
  },
  {
    title: "Así fluye una señal en Tools 4 Foresight",
    flow: [
      "Conecta tu cuenta de X en Sistema",
      "La ingesta trae tus likes al Catálogo",
      "El modelo categoriza cada señal con tu catálogo de Categorías",
      "En Análisis revisas TL;DR, impacto y por qué importa, y publicas lo que vale",
      "El Grafo agrupa lo publicado en temas por similitud",
      "Horizontes lee esos temas como tendencias H1 · H2 · H3",
    ],
    description:
      "Las pestañas siguen el ciclo de vida de una señal, en este orden. La guía te va llevando paso por paso; no necesitas memorizarlo.",
    cta: "Siguiente",
  },
  {
    title: "Tu guía, siempre a mano",
    image: "/onboarding/tour-guia.png",
    imageLabel: "Guía de configuración",
    icon: "guia",
    description:
      'Abajo a la derecha tienes esta misma guía, siempre clicable, para saber qué hacer en cada momento. Cada "Ver" te lleva a la pantalla exacta donde se hace la tarea. Si la cierras, puedes volver a abrirla desde el icono de ayuda, arriba a la derecha.',
    cta: "Siguiente",
  },
  {
    title: "Tus herramientas",
    image: "/onboarding/tour-nav.png",
    imageLabel: "Navegación",
    icon: "nav",
    description:
      "Arriba tienes las pestañas, ordenadas igual que el flujo: Catálogo, Análisis, Grafo, Horizontes, Categorías y Sistema. Empieza por Sistema: ahí conectas tu cuenta de X.",
    cta: "Empezar",
  },
];
