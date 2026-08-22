/**
 * Usuario de demo para las capturas del onboarding (Onboarding.md §10, receta 1).
 *
 *   npm run seed:demo
 *
 * Crea (o recrea) `demo@individual.local` con una contraseña conocida y le
 * siembra un tenant COMPLETO y creíble: X conectada, key de Anthropic ficticia,
 * 43 señales (40 de likes + 3 enlaces manuales) con categoría, PESTEL, TL;DR,
 * impacto, por qué importa y foresight, 18 publicadas con embedding sintético y
 * un grafo ya corrido con tres temas. Con eso, las seis pantallas de la app se
 * ven pobladas y las capturas enseñan "así se usa" en vez de estados vacíos.
 *
 * Idempotente por la vía dura: si el usuario existe, se BORRA (cascade se lleva
 * todo su tenant) y se vuelve a crear. Así una segunda corrida no acumula
 * señales duplicadas ni temas fantasma, y la captura es siempre la misma.
 *
 * Por qué se crea con `auth.api.signUpEmail` y no con un INSERT: el hash de la
 * contraseña lo decide better-auth (scrypt con su propio formato). Adivinarlo a
 * mano es la clase de detalle que se rompe en silencio en la siguiente versión
 * de la librería; pasar por la API garantiza que el login del script de capturas
 * funcione. El hook `databaseHooks.user.create.after` corre `seedTenant`, así que
 * el catálogo de categorías y la cuota quedan sembrados; igual se vuelve a
 * llamar explícitamente porque es idempotente y no queremos depender del hook.
 *
 * NADA de esto es un secreto real: el token de X y la key de Anthropic son
 * cadenas inventadas que se cifran con token-crypto para que las columnas tengan
 * la forma correcta. Nunca poner aquí una credencial de verdad.
 *
 * El grafo: se corre `runGraph` contra un mock local de Ollama (misma técnica que
 * scripts/qa-graph-tenant.ts) en vez de contra ollama.com. Es más robusto (no
 * depende de la red ni de créditos) y además deja nombres de tema decididos por
 * nosotros, que es justo lo que una captura necesita.
 */
import "dotenv/config";
import { createServer, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";

// Igual que en qa-graph-tenant.ts: los módulos del grafo congelan estos umbrales
// al importarse, así que hay que fijarlos ANTES del `await import()` de más
// abajo. Con 6 señales por grupo y embeddings de soporte disjunto, el detector
// encuentra exactamente tres comunidades.
process.env.SEMANTIC_LINK_THRESHOLD = "0.55";
process.env.SEMANTIC_LINK_TOP_K = "8";
process.env.SEMANTIC_CLUSTER_MIN_SIZE = "3";
process.env.GRAPH_HALF_LIFE_DAYS = "30";

import { prisma } from "../src/lib/prisma";
import { withOwner, withPlatformBypass, type TenantTx } from "../src/lib/tenant-db";
import { seedTenant } from "../src/lib/seed-tenant";
import { auth } from "../src/lib/auth";
import { encryptToken } from "../src/lib/token-crypto";
import { MANUAL_SOURCE, MANUAL_LIKED_AT_SOURCE } from "../src/lib/manual-link";
import type { JobContext } from "../src/lib/jobs/types";

export const DEMO_EMAIL = "demo@individual.local";
export const DEMO_PASSWORD = "DemoIndividual2026!";
const DEMO_NAME = "Frida (demo)";

const EMBED_DIMS = 1536;
/** Cuántos grupos temáticos forman los embeddings sintéticos. */
const GROUPS = 3;

const DAY_MS = 86_400_000;
const TWITTER_EPOCH_MS = 1288834974657n;

// ---------------------------------------------------------------------------
// Utilidades
// ---------------------------------------------------------------------------

const now = new Date();

function daysAgo(days: number, hour = 10, minute = 0): Date {
  const d = new Date(now.getTime() - days * DAY_MS);
  d.setHours(hour, minute, 0, 0);
  return d;
}

/** Id de tweet con la forma real: snowflake con la época de Twitter. */
function snowflakeFor(date: Date, seq: number): string {
  const ms = BigInt(date.getTime()) - TWITTER_EPOCH_MS;
  return ((ms << 22n) | BigInt(seq % 4_194_304)).toString();
}

function log(message: string): void {
  console.log(message);
}

// ---------------------------------------------------------------------------
// Los datos de demo
// ---------------------------------------------------------------------------

type Group = 0 | 1 | 2;

type DemoItem = {
  handle: string;
  author: string;
  text: string;
  url: string;
  title: string;
  description: string;
  category: string;
  confidence: number;
  pestel: string[];
  tldr: string;
  impact: string;
  whyMatters: string;
  foresight?: string;
  /** Si está definido, la señal se publica y entra al grafo en ese grupo. */
  group?: Group;
  /** Días atrás del like (se reparten en la ventana de 60 días). */
  age: number;
};

/**
 * 40 señales. Las 18 con `group` son las publicadas y forman los tres temas que
 * el grafo tiene que encontrar:
 *   0 → Agentes y tool use   1 → Open-source y modelos locales   2 → Regulación
 * El resto queda en "pendientes", que es lo que la pantalla de Análisis muestra
 * por defecto: sin ellas esa captura saldría vacía.
 */
const DEMO_ITEMS: DemoItem[] = [
  // ── Grupo 0 · Agentes y tool use ──────────────────────────────────────────
  {
    handle: "swyx",
    author: "shawn @swyx",
    text: "El salto de este año no es el modelo, es el harness: agentes que planean, llaman herramientas, se equivocan y se corrigen solos dentro del mismo loop.",
    url: "https://www.anthropic.com/engineering/building-effective-agents",
    title: "Building effective agents",
    description:
      "Patrones de diseño para agentes: cuándo basta un workflow con pasos fijos y cuándo hace falta un loop autónomo con herramientas.",
    category: "AI Docs/Updates",
    confidence: 0.93,
    pestel: ["technological", "economic"],
    tldr: "Un agente útil no es un modelo más grande, es un loop bien diseñado: plan, llamada a herramienta, verificación y reintento. La guía separa los casos que se resuelven con un workflow determinista de los que de verdad necesitan autonomía.",
    impact:
      "Baja la barrera para construir agentes que sirvan en producción y mueve la competencia del tamaño del modelo al diseño del entorno de ejecución. Los equipos que ya tienen herramientas bien documentadas parten con ventaja.",
    whyMatters:
      "Marca el punto en que los agentes dejan de ser demo y entran a flujos de trabajo reales. Si el diferencial es el harness y no el modelo, la ventaja competitiva se vuelve replicable en meses, no en años.",
    foresight:
      "En 18 meses la pregunta de compra no será qué modelo usas sino qué herramientas expones y con qué garantías. Espera catálogos de herramientas certificadas y auditoría de llamadas como requisito de compliance.",
    group: 0,
    age: 3,
  },
  {
    handle: "simonw",
    author: "Simon Willison",
    text: "Llevo una semana dándole acceso a mi terminal a un agente con permisos acotados. La parte interesante no es lo que hace bien: es lo que hace cuando se topa con un error inesperado.",
    url: "https://simonwillison.net/2026/agent-tool-use-notes/",
    title: "Notas sobre agentes con acceso a herramientas reales",
    description:
      "Bitácora de una semana usando un agente con permisos de shell acotados: qué falla, qué sorprende y qué barandales hacen falta.",
    category: "AI Docs/Updates",
    confidence: 0.88,
    pestel: ["technological", "social"],
    tldr: "Una bitácora de campo de agentes con acceso a shell: los aciertos son aburridos y los fallos, instructivos. El recuento de errores importa más que el de tareas completadas.",
    impact:
      "Da un vocabulario concreto para hablar de permisos, sandbox y reintentos, que es donde se están rompiendo hoy las integraciones de agentes en empresas.",
    whyMatters:
      "La adopción de agentes se va a decidir en la confianza operativa, no en los benchmarks. Documentar los modos de falla es lo que permite acotarlos.",
    foresight:
      "El patrón de sandbox por defecto y permisos declarados se va a estandarizar igual que pasó con los permisos de las apps móviles. Quien no lo adopte va a quedar fuera de las compras corporativas.",
    group: 0,
    age: 7,
  },
  {
    handle: "karpathy",
    author: "Andrej Karpathy",
    text: "El modelo ya no es el producto. El producto es el entorno: qué herramientas ve, qué memoria conserva y cómo se le corta cuando se va por la tangente.",
    url: "https://www.youtube.com/watch?v=agentic-loops-2026",
    title: "Loops agénticos: por qué el contexto pesa más que los parámetros",
    description:
      "Charla de 40 minutos sobre por qué el diseño del contexto y del conjunto de herramientas domina hoy el desempeño de un agente.",
    category: "AI News",
    confidence: 0.9,
    pestel: ["technological"],
    tldr: "El desempeño de un agente depende más de cómo se le arma el contexto y qué herramientas ve que de cuántos parámetros tiene. La charla propone medir agentes por su entorno, no por su modelo.",
    impact:
      "Reordena la inversión: menos presupuesto a entrenar y más a instrumentación, memoria y evaluación. Cambia qué perfiles contrata un equipo de IA.",
    whyMatters:
      "Si el entorno es el diferencial, el foso competitivo de los laboratorios grandes se estrecha y la ventaja pasa a quien conoce mejor su propio dominio.",
    group: 0,
    age: 11,
  },
  {
    handle: "_akhaliq",
    author: "AK",
    text: "Nuevo paper: agentes que aprenden a usar herramientas nuevas leyendo su documentación, sin fine-tuning. 61% de éxito en APIs que nunca vieron.",
    url: "https://arxiv.org/abs/2603.04821",
    title: "Learning tool use from documentation alone",
    description:
      "Los autores muestran que un agente puede integrar APIs desconocidas leyendo su documentación en tiempo de ejecución, sin reentrenamiento.",
    category: "AI News",
    confidence: 0.86,
    pestel: ["technological", "economic"],
    tldr: "Un agente que lee la documentación de una API en tiempo de ejecución logra 61% de éxito en herramientas que nunca vio. No hace falta fine-tuning para ampliar su repertorio.",
    impact:
      "Si se sostiene fuera del laboratorio, elimina el costo marginal de integrar una herramienta nueva y convierte a la documentación en superficie de producto.",
    whyMatters:
      "El cuello de botella de los agentes hoy es la integración, no el razonamiento. Quitar ese cuello cambia la velocidad a la que un agente se vuelve útil en una empresa.",
    foresight:
      "Escribir documentación pensada para que la lea una máquina se va a volver una práctica de producto con su propio rol. Los SDKs van a competir por legibilidad automática, no solo humana.",
    group: 0,
    age: 16,
  },
  {
    handle: "emollick",
    author: "Ethan Mollick",
    text: "Le pedimos a 200 profesionales que resolvieran su trabajo con un agente. Lo revelador: los que mejor resultado obtuvieron fueron los que más lo interrumpieron.",
    url: "https://www.oneusefulthing.org/p/agentes-y-supervision-humana",
    title: "Supervisar a un agente es una habilidad, no un trámite",
    description:
      "Experimento con 200 profesionales usando agentes en su trabajo real: la calidad correlaciona con la frecuencia de intervención humana.",
    category: "Social Commentary",
    confidence: 0.79,
    pestel: ["social", "economic"],
    tldr: "En un experimento con 200 profesionales, quienes interrumpieron y corrigieron más al agente obtuvieron mejores resultados. Supervisar resulta ser la habilidad que separa a los usuarios efectivos.",
    impact:
      "Contradice la promesa de delegación total y sugiere que el retorno de los agentes depende de entrenar a las personas, no solo de comprar licencias.",
    whyMatters:
      "Define dónde va a estar el trabajo humano en los próximos años: en el punto de control, no en la ejecución. Eso reescribe descripciones de puesto completas.",
    foresight:
      "Van a aparecer certificaciones de supervisión de agentes igual que hubo certificaciones de ofimática. La brecha de productividad no será entre quien usa IA y quien no, sino entre quien sabe corregirla y quien no.",
    group: 0,
    age: 22,
  },
  {
    handle: "swyx",
    author: "shawn @swyx",
    text: "MCP se comió el ecosistema en un año. Ya no discutimos si hay un protocolo común de herramientas: discutimos quién escribe los servidores.",
    url: "https://github.com/modelcontextprotocol/servers",
    title: "modelcontextprotocol/servers",
    description:
      "Repositorio de referencia con servidores MCP para conectar modelos a herramientas, datos y sistemas internos.",
    category: "Developer Tools & Projects",
    confidence: 0.91,
    pestel: ["technological", "economic"],
    tldr: "El protocolo común para conectar modelos con herramientas dejó de estar en disputa y el debate pasó a quién mantiene los servidores. El repositorio funciona como catálogo de facto.",
    impact:
      "Estandarizar la capa de herramientas abarata cambiar de proveedor de modelo y le quita poder de amarre a cada laboratorio.",
    whyMatters:
      "Un protocolo compartido es lo que convierte una tecnología en infraestructura. A partir de aquí, la competencia se mueve hacia arriba en la pila.",
    foresight:
      "En dos años los servidores de herramientas se van a parecer a los paquetes de npm: miles, mal mantenidos, y con una cadena de suministro que va a ser el siguiente frente de seguridad.",
    group: 0,
    age: 29,
  },

  // ── Grupo 1 · Open-source y modelos locales ───────────────────────────────
  {
    handle: "hardmaru",
    author: "hardmaru",
    text: "Los pesos abiertos ya no van un año atrás: van un trimestre. Y para la mayoría de las tareas de producción, un trimestre no se nota.",
    url: "https://huggingface.co/blog/open-weights-gap-2026",
    title: "La brecha entre pesos abiertos y modelos cerrados se cierra",
    description:
      "Análisis comparativo de benchmarks: los modelos de pesos abiertos alcanzan hoy en un trimestre lo que antes tardaban un año.",
    category: "AI News",
    confidence: 0.89,
    pestel: ["technological", "economic"],
    tldr: "Los modelos de pesos abiertos alcanzan a los cerrados en un trimestre en vez de un año, y en la mayoría de tareas de producción esa diferencia deja de ser perceptible.",
    impact:
      "Presiona los precios de las APIs cerradas y vuelve viable montar la inferencia en casa para cargas de trabajo estables.",
    whyMatters:
      "Cambia la estructura de costos de cualquier producto con IA dentro. Lo que hoy es gasto variable por token puede volverse gasto fijo de infraestructura.",
    foresight:
      "Espera que las empresas medianas partan su carga: modelo abierto local para el 80% del volumen y API cerrada solo para lo difícil. El proveedor cerrado se vuelve especialista, no plataforma.",
    group: 1,
    age: 5,
  },
  {
    handle: "simonw",
    author: "Simon Willison",
    text: "Corriendo un modelo de 30B en la laptop, sin red, respondiendo en 40 tokens/s. Hace dos años esto era una demo de conferencia.",
    url: "https://ollama.com/blog/local-inference-2026",
    title: "Inferencia local: lo que cabe hoy en una laptop",
    description:
      "Mediciones de throughput de modelos de 8B a 70B corriendo en hardware de consumo, con y sin cuantización.",
    category: "AI Docs/Updates",
    confidence: 0.87,
    pestel: ["technological", "environmental"],
    tldr: "Un modelo de 30B corre hoy sin red en una laptop de consumo a 40 tokens por segundo. El artículo mide throughput por tamaño y nivel de cuantización.",
    impact:
      "Habilita casos de uso con datos que no pueden salir de la máquina: legal, salud, gobierno. También baja el consumo energético por consulta frente al viaje al centro de datos.",
    whyMatters:
      "La privacidad deja de ser una promesa contractual y pasa a ser una propiedad física del despliegue. Eso desbloquea sectores enteros que hoy no pueden usar IA en la nube.",
    foresight:
      "El diferencial de los portátiles en tres años va a anunciarse en tokens por segundo, no en gigahercios. Y va a aparecer una categoría de software que solo funciona offline como argumento de venta.",
    group: 1,
    age: 9,
  },
  {
    handle: "ylecun",
    author: "Yann LeCun",
    text: "Publicar pesos no es filantropía: es la única forma conocida de que miles de personas encuentren los fallos que tu equipo de 50 no va a encontrar.",
    url: "https://arxiv.org/abs/2602.11934",
    title: "Open weights as a safety mechanism",
    description:
      "Argumento técnico a favor de la publicación de pesos como método de auditoría distribuida frente a la evaluación interna cerrada.",
    category: "Social Commentary",
    confidence: 0.82,
    pestel: ["technological", "political"],
    tldr: "El paper defiende la publicación de pesos como mecanismo de seguridad: la auditoría distribuida encuentra fallos que ningún equipo interno de 50 personas va a encontrar.",
    impact:
      "Da munición técnica al lado abierto de la discusión regulatoria, que hasta ahora argumentaba sobre todo desde la competencia y no desde la seguridad.",
    whyMatters:
      "Reencuadra el debate: si abrir es más seguro que cerrar, las propuestas de restringir la publicación pierden su justificación principal.",
    group: 1,
    age: 14,
  },
  {
    handle: "rasbt",
    author: "Sebastian Raschka",
    text: "Guía completa de fine-tuning con LoRA en una sola GPU de 24 GB, con los números de memoria de cada paso. Sin humo.",
    url: "https://github.com/rasbt/LLMs-from-scratch",
    title: "LLMs from scratch — fine-tuning eficiente",
    description:
      "Repositorio con implementaciones paso a paso de entrenamiento y fine-tuning de modelos de lenguaje, con presupuesto de memoria explícito.",
    category: "Developer Tools & Projects",
    confidence: 0.9,
    pestel: ["technological"],
    tldr: "Una guía práctica de fine-tuning con LoRA en una GPU de 24 GB, con el presupuesto de memoria de cada paso documentado. El repositorio implementa todo desde cero.",
    impact:
      "Hace accesible la especialización de modelos a equipos sin clúster, que era el argumento más fuerte a favor de las APIs cerradas.",
    whyMatters:
      "Especializar un modelo abierto con datos propios es la vía más directa a una ventaja defendible. Bajar su costo cambia quién puede intentarlo.",
    foresight:
      "El fine-tuning va a dejar de ser un proyecto para volverse un paso del pipeline de datos, ejecutado semanalmente y sin supervisión humana.",
    group: 1,
    age: 20,
  },
  {
    handle: "dotcsv",
    author: "Carlos Santana",
    text: "Probé los tres modelos abiertos del mes en el mismo banco de pruebas en español. El resultado no es el que esperaba: el más pequeño gana en instrucciones largas.",
    url: "https://www.youtube.com/watch?v=modelos-abiertos-espanol",
    title: "Modelos abiertos en español: comparativa del mes",
    description:
      "Comparativa en vídeo de tres modelos de pesos abiertos evaluados sobre tareas en español, con el banco de pruebas publicado.",
    category: "AI News",
    confidence: 0.84,
    pestel: ["technological", "social"],
    tldr: "Una comparativa de tres modelos abiertos sobre tareas en español encuentra que el más pequeño gana en seguimiento de instrucciones largas. El banco de pruebas está publicado.",
    impact:
      "Rompe la heurística de elegir por tamaño y expone lo poco que se evalúa en español, donde los rankings en inglés no predicen bien.",
    whyMatters:
      "Casi toda la evidencia pública sobre qué modelo usar viene de tareas en inglés. Sin evaluación local, las decisiones de arquitectura se toman a ciegas.",
    foresight:
      "Van a proliferar bancos de pruebas por idioma y por sector, mantenidos por comunidades y no por laboratorios. Ahí es donde se van a decidir las compras regionales.",
    group: 1,
    age: 26,
  },
  {
    handle: "jeremyphoward",
    author: "Jeremy Howard",
    text: "La cuantización de 4 bits dejó de costar calidad medible en tareas de resumen y extracción. Eso es la mitad del hardware para el mismo trabajo.",
    url: "https://huggingface.co/blog/quantization-quality-2026",
    title: "Cuantización de 4 bits: dónde sí y dónde no cuesta calidad",
    description:
      "Evaluación por tipo de tarea del efecto de la cuantización agresiva sobre la calidad de salida de modelos abiertos.",
    category: "AI Docs/Updates",
    confidence: 0.85,
    pestel: ["technological", "environmental"],
    tldr: "La cuantización de 4 bits ya no degrada de forma medible las tareas de resumen y extracción, aunque sí las de razonamiento largo. Eso permite la mitad de hardware para el mismo trabajo.",
    impact:
      "Reduce a la mitad el costo y el consumo de servir modelos abiertos en el tipo de tarea que más volumen tiene en las empresas.",
    whyMatters:
      "El grueso del uso corporativo de IA es resumir y extraer, no razonar. Si eso corre cuantizado, el argumento económico de la nube se debilita.",
    foresight:
      "En dos años la decisión por defecto para cargas de volumen va a ser un modelo abierto cuantizado en infraestructura propia, con la nube reservada a picos.",
    group: 1,
    age: 34,
  },

  // ── Grupo 2 · Regulación y gobernanza de IA ───────────────────────────────
  {
    handle: "mmitchell_ai",
    author: "Margaret Mitchell",
    text: "Entran en vigor las obligaciones de transparencia para modelos de propósito general. Lo importante no es la multa: es que por primera vez hay que documentar los datos.",
    url: "https://digital-strategy.ec.europa.eu/en/policies/ai-act-gpai-obligations",
    title: "Obligaciones de transparencia para modelos de propósito general",
    description:
      "Entrada en vigor de los requisitos de documentación de datos de entrenamiento y evaluación de riesgo para modelos GPAI en la UE.",
    category: "Social Commentary",
    confidence: 0.92,
    pestel: ["legal", "political"],
    tldr: "Las obligaciones de transparencia para modelos de propósito general ya son exigibles en la UE: hay que documentar datos de entrenamiento y evaluación de riesgo. La sanción importa menos que el precedente documental.",
    impact:
      "Obliga a construir trazabilidad de datos donde hoy no existe, y esa trazabilidad es cara de reconstruir hacia atrás.",
    whyMatters:
      "Es el primer requisito regulatorio que toca el proceso de entrenamiento y no solo el uso. Cambia qué se puede entrenar, no solo qué se puede desplegar.",
    foresight:
      "El expediente técnico del modelo se va a volver un activo negociable en fusiones y adquisiciones, igual que las patentes. Quien no lo tenga va a valer menos.",
    group: 2,
    age: 2,
  },
  {
    handle: "random_walker",
    author: "Arvind Narayanan",
    text: "Las evaluaciones de riesgo que están presentando las empresas se parecen sospechosamente entre sí. Cuando el regulador no define el método, el método lo define la consultora.",
    url: "https://www.ft.com/content/ai-risk-assessments-convergence",
    title: "Las evaluaciones de riesgo de IA convergen hacia la plantilla",
    description:
      "Revisión de los primeros expedientes públicos de evaluación de riesgo: estructura casi idéntica y proveedores repetidos.",
    category: "Social Commentary",
    confidence: 0.8,
    pestel: ["legal", "economic"],
    tldr: "Los primeros expedientes públicos de evaluación de riesgo de IA son casi idénticos entre sí y salen de un puñado de consultoras. Sin método definido por el regulador, la plantilla se vuelve el estándar.",
    impact:
      "Crea un mercado de cumplimiento antes de que exista una métrica de seguridad, con el riesgo de fijar prácticas mediocres como norma.",
    whyMatters:
      "Lo que se estandarice ahora va a ser muy difícil de cambiar después. La ventana para influir en el método es corta.",
    foresight:
      "Espera una segunda ola regulatoria dedicada a auditar a los auditores, igual que ocurrió en contabilidad tras los escándalos de los 2000.",
    group: 2,
    age: 8,
  },
  {
    handle: "emollick",
    author: "Ethan Mollick",
    text: "El borrador de reglas sobre contenido generado no distingue entre 'lo escribió una IA' y 'lo revisó una persona'. Esa distinción es todo el problema.",
    url: "https://www.theverge.com/2026/ai-disclosure-rules-draft",
    title: "El borrador de reglas de divulgación de contenido generado",
    description:
      "Análisis del borrador que obligaría a etiquetar contenido generado por IA, y de la zona gris del contenido asistido.",
    category: "Social Commentary",
    confidence: 0.78,
    pestel: ["legal", "social"],
    tldr: "El borrador de reglas de etiquetado no distingue entre contenido generado y contenido asistido revisado por una persona. Esa zona gris cubre casi todo el uso real.",
    impact:
      "Un etiquetado binario aplicado a un espectro continuo produce o bien sobre-etiquetado inútil o bien incumplimiento generalizado.",
    whyMatters:
      "Define cómo se va a poder publicar cualquier cosa en los próximos años. Una regla mal calibrada aquí afecta a medios, educación y publicidad a la vez.",
    group: 2,
    age: 15,
  },
  {
    handle: "mmitchell_ai",
    author: "Margaret Mitchell",
    text: "Primera sentencia que trata los datos de entrenamiento como una cadena de suministro con responsabilidad solidaria. Vale la pena leerla entera.",
    url: "https://www.nytimes.com/2026/03/ai-training-data-ruling.html",
    title: "Una sentencia trata los datos de entrenamiento como cadena de suministro",
    description:
      "Resolución judicial que extiende la responsabilidad sobre el origen de los datos a quien despliega el modelo, no solo a quien lo entrena.",
    category: "Social Commentary",
    confidence: 0.87,
    pestel: ["legal", "economic"],
    tldr: "Una sentencia extiende la responsabilidad sobre el origen de los datos de entrenamiento a quien despliega el modelo y no solo a quien lo entrena. Es la primera vez que se aplica lógica de cadena de suministro.",
    impact:
      "Convierte la procedencia de los datos en un requisito contractual entre proveedor y cliente, con garantías e indemnizaciones de por medio.",
    whyMatters:
      "Traslada el riesgo legal hacia abajo en la cadena, justo hacia las empresas que menos capacidad tienen de verificarlo.",
    foresight:
      "Los contratos de IA empresarial van a incluir cláusulas de procedencia de datos como estándar en 12 meses, y los seguros van a empezar a cotizar ese riesgo.",
    group: 2,
    age: 21,
  },
  {
    handle: "random_walker",
    author: "Arvind Narayanan",
    text: "Un regulador acaba de pedir acceso al log de decisiones de un sistema automatizado. La empresa no lo tenía. Ese es el estado real de la gobernanza hoy.",
    url: "https://www.wired.com/story/ai-audit-logs-regulator/",
    title: "Cuando el regulador pide el log y no existe",
    description:
      "Caso de una inspección en la que la empresa no pudo aportar la traza de decisiones de su sistema automatizado.",
    category: "Social Commentary",
    confidence: 0.81,
    pestel: ["legal", "political"],
    tldr: "En una inspección, una empresa no pudo aportar el registro de decisiones de su sistema automatizado porque nunca lo guardó. El caso expone la distancia entre la política escrita y la práctica.",
    impact:
      "Convierte el registro de decisiones en un requisito de ingeniería con retroactividad imposible: lo que no se guardó, no se puede reconstruir.",
    whyMatters:
      "La gobernanza de IA se va a decidir en detalles de instrumentación, no en documentos de principios. Y esa instrumentación hay que ponerla antes de que la pidan.",
    foresight:
      "El registro inmutable de decisiones automatizadas va a pasar de buena práctica a requisito de auditoría en dos ciclos regulatorios, arrastrando al mercado de observabilidad.",
    group: 2,
    age: 30,
  },
  {
    handle: "dotcsv",
    author: "Carlos Santana",
    text: "Resumen de las tres propuestas regulatorias que están sobre la mesa en Latinoamérica. Ninguna copia a Europa, y eso es más interesante de lo que suena.",
    url: "https://www.oecd.org/digital/ai-policy-latam-2026.pdf",
    title: "Tres marcos de gobernanza de IA en Latinoamérica",
    description:
      "Comparativa de las propuestas regulatorias en discusión en la región y de sus diferencias con el enfoque europeo por niveles de riesgo.",
    category: "Social Commentary",
    confidence: 0.76,
    pestel: ["political", "legal"],
    tldr: "Las tres propuestas regulatorias en discusión en Latinoamérica no replican el modelo europeo por niveles de riesgo, sino que parten de derechos digitales y compras públicas.",
    impact:
      "Abre la posibilidad de marcos más simples de cumplir para empresas locales, pero también de fragmentación entre países vecinos.",
    whyMatters:
      "La región es un mercado grande de despliegue y pequeño de entrenamiento. Cómo regule define si importa tecnología o construye capacidad propia.",
    foresight:
      "Va a surgir un bloque regulatorio regional propio en tres años, con la compra pública como palanca principal en vez de la sanción.",
    group: 2,
    age: 41,
  },

  // ── Pendientes (no publicadas): pueblan la cola de Análisis ───────────────
  {
    handle: "levelsio",
    author: "Pieter Levels",
    text: "Cinco productos, un solo servidor, cero empleados. La foto de la cuenta de infraestructura de este mes: 61 dólares.",
    url: "https://techcrunch.com/2026/03/solo-founders-ai-stack/",
    title: "El stack del fundador en solitario en 2026",
    description:
      "Repaso a las herramientas con las que fundadores individuales sostienen varios productos sin equipo.",
    category: "Startup & Business",
    confidence: 0.83,
    pestel: ["economic", "social"],
    tldr: "Un fundador en solitario sostiene cinco productos con un servidor y 61 dólares al mes de infraestructura. El artículo desglosa las herramientas que lo hacen posible.",
    impact:
      "Reduce el capital mínimo para lanzar un producto de software a casi cero, lo que multiplica la competencia en nichos pequeños.",
    whyMatters:
      "Si lanzar deja de ser caro, el diferencial vuelve a ser la distribución y la confianza, no la capacidad de construir.",
    foresight:
      "El número de productos por fundador va a seguir subiendo hasta que el cuello de botella sea la atención al cliente, que es lo único que todavía no se delega bien.",
    age: 1,
  },
  {
    handle: "GergelyOrosz",
    author: "Gergely Orosz",
    text: "Encuesta a 1.200 ingenieros: el 71% usa asistentes a diario y el 44% dice que revisa menos el código de sus compañeros que hace un año.",
    url: "https://newsletter.pragmaticengineer.com/p/ai-code-review-2026",
    title: "Qué le pasó a la revisión de código",
    description:
      "Resultados de una encuesta sobre uso de asistentes de código y su efecto sobre las prácticas de revisión entre pares.",
    category: "Developer Tools & Projects",
    confidence: 0.88,
    pestel: ["social", "technological"],
    tldr: "Una encuesta a 1.200 ingenieros encuentra que el 71% usa asistentes a diario y que el 44% revisa menos el código de sus compañeros que hace un año.",
    impact:
      "Si se escribe más código y se revisa menos, la deuda técnica se acumula en un lugar nuevo: en lo que nadie leyó nunca.",
    whyMatters:
      "La revisión entre pares no era solo control de calidad, era transferencia de conocimiento. Perderla tiene un costo que tarda años en aparecer.",
    foresight:
      "En tres años vamos a ver incidentes graves atribuidos a código que ningún humano leyó, y una reacción de sobrecorrección con revisión obligatoria.",
    age: 4,
  },
  {
    handle: "karpathy",
    author: "Andrej Karpathy",
    text: "Nuevo modelo multimodal disponible en la API desde hoy. Lo interesante está en el precio por imagen, no en el benchmark.",
    url: "https://openai.com/index/multimodal-api-update/",
    title: "Actualización de la API multimodal",
    description:
      "Anuncio de disponibilidad general del modelo multimodal con nueva estructura de precios por imagen procesada.",
    category: "AI News",
    confidence: 0.94,
    pestel: ["technological", "economic"],
    tldr: "El modelo multimodal pasa a disponibilidad general con una nueva estructura de precios por imagen. El cambio de precio pesa más que la mejora de benchmark.",
    impact:
      "Abarata los flujos que procesan documentos escaneados y capturas, que es donde más volumen hay en operaciones internas.",
    whyMatters:
      "El precio por imagen es lo que decide si digitalizar archivo histórico es un proyecto viable o una nota al pie del presupuesto.",
    age: 6,
  },
  {
    handle: "hardmaru",
    author: "hardmaru",
    text: "Los centros de datos de IA ya consumen más electricidad que algunos países medianos. El gráfico de la proyección a 2030 da vértigo.",
    url: "https://www.nature.com/articles/ai-datacenter-energy-2026",
    title: "El consumo eléctrico de los centros de datos de IA",
    description:
      "Estudio con proyecciones de demanda eléctrica de la infraestructura de IA hasta 2030 y su efecto sobre las redes locales.",
    category: "AI News",
    confidence: 0.86,
    pestel: ["environmental", "political"],
    tldr: "Los centros de datos de IA superan ya el consumo eléctrico de países medianos, y la proyección a 2030 implica una presión sobre las redes locales difícil de absorber.",
    impact:
      "Convierte la disponibilidad de energía en el factor limitante del crecimiento de la IA, por delante de los chips.",
    whyMatters:
      "Donde haya energía barata y limpia se va a instalar la infraestructura. Es una decisión de política industrial disfrazada de decisión técnica.",
    foresight:
      "La negociación por acceso a red va a ser el cuello de botella de los despliegues antes de 2029, y va a haber moratorias municipales.",
    age: 10,
  },
  {
    handle: "simonw",
    author: "Simon Willison",
    text: "Una librería de 300 líneas para hacer búsquedas semánticas sobre SQLite. Sin servidor, sin índice externo, sin dependencias.",
    url: "https://github.com/asg017/sqlite-vec",
    title: "sqlite-vec",
    description:
      "Extensión de SQLite para búsqueda vectorial sin servicios externos, pensada para aplicaciones locales y embebidas.",
    category: "Developer Tools & Projects",
    confidence: 0.92,
    pestel: ["technological"],
    tldr: "Una extensión de 300 líneas añade búsqueda vectorial a SQLite sin servidor, índice externo ni dependencias. Sirve para aplicaciones locales y embebidas.",
    impact:
      "Elimina una pieza de infraestructura completa de las arquitecturas pequeñas de recuperación aumentada.",
    whyMatters:
      "La complejidad operativa es lo que mata los proyectos internos. Quitar un servicio del diagrama cambia si el proyecto llega a producción.",
    age: 12,
  },
  {
    handle: "swyx",
    author: "shawn @swyx",
    text: "Las evaluaciones se están volviendo el verdadero producto de las empresas de IA aplicada. Nadie compra un prompt; compran la garantía de que no se rompe.",
    url: "https://www.latent.space/p/evals-as-product",
    title: "Las evaluaciones como producto",
    description:
      "Ensayo sobre cómo los conjuntos de evaluación privados se convirtieron en el activo defendible de las empresas de IA aplicada.",
    category: "Startup & Business",
    confidence: 0.81,
    pestel: ["economic", "technological"],
    tldr: "En IA aplicada, el activo defendible dejó de ser el prompt y pasó a ser el conjunto de evaluaciones privado que garantiza que el sistema no se rompe.",
    impact:
      "Reordena la valoración de las startups de IA: se mira la calidad del banco de pruebas antes que la arquitectura.",
    whyMatters:
      "Es la respuesta a la pregunta de qué queda cuando el modelo se puede cambiar por otro en una tarde.",
    foresight:
      "Los conjuntos de evaluación por dominio se van a comprar y vender como se compran bases de datos hoy, con licencias por uso.",
    age: 13,
  },
  {
    handle: "emollick",
    author: "Ethan Mollick",
    text: "Un estudio con 3.000 estudiantes: los que usaron un tutor con IA mejoraron, pero solo cuando el tutor se negaba a dar la respuesta directa.",
    url: "https://www.nature.com/articles/ai-tutoring-rct-2026",
    title: "Tutoría con IA: el efecto depende de que no responda",
    description:
      "Ensayo controlado con 3.000 estudiantes comparando tutores con IA que dan la respuesta contra los que guían sin darla.",
    category: "Social Commentary",
    confidence: 0.85,
    pestel: ["social", "political"],
    tldr: "Un ensayo con 3.000 estudiantes muestra que la tutoría con IA mejora el aprendizaje solo cuando el sistema se niega a dar la respuesta directa.",
    impact:
      "El diseño pedagógico resulta más determinante que la capacidad del modelo, lo que cambia qué hay que comprar y qué hay que configurar.",
    whyMatters:
      "Sin esta restricción, la herramienta produce la sensación de aprender sin el aprendizaje. Es un fallo difícil de detectar hasta el examen.",
    foresight:
      "Las compras educativas van a empezar a exigir evidencia de ensayo controlado, no demostraciones. Eso deja fuera a la mayoría de los proveedores actuales.",
    age: 17,
  },
  {
    handle: "dotcsv",
    author: "Carlos Santana",
    text: "Explico en 12 minutos por qué la generación de vídeo pasó de curiosidad a herramienta de producción este trimestre.",
    url: "https://www.youtube.com/watch?v=video-gen-produccion",
    title: "Generación de vídeo: de la curiosidad a la producción",
    description:
      "Vídeo explicativo sobre los avances en consistencia temporal y control de cámara que hicieron usable la generación de vídeo.",
    category: "AI News",
    confidence: 0.83,
    pestel: ["technological", "economic"],
    tldr: "La generación de vídeo cruzó el umbral de uso profesional gracias a la consistencia temporal y al control de cámara, no a la resolución.",
    impact:
      "Reduce el costo de la producción audiovisual publicitaria de forma abrupta y presiona a toda la cadena de producción intermedia.",
    whyMatters:
      "Es el primer formato caro que se abarata de golpe. Lo que pase aquí anticipa lo que va a pasar en otros oficios creativos.",
    age: 18,
  },
  {
    handle: "GergelyOrosz",
    author: "Gergely Orosz",
    text: "El mercado laboral de ingeniería se partió en dos: junior en caída libre, senior con experiencia en sistemas distribuidos disputadísimo.",
    url: "https://newsletter.pragmaticengineer.com/p/tech-job-market-2026",
    title: "El mercado laboral técnico se parte en dos",
    description:
      "Análisis del mercado de contratación en tecnología con datos de ofertas por nivel de seniority.",
    category: "Startup & Business",
    confidence: 0.87,
    pestel: ["economic", "social"],
    tldr: "El mercado de contratación técnica se polarizó: las vacantes junior caen mientras las senior con experiencia en sistemas distribuidos se disputan.",
    impact:
      "Rompe la escalera de formación del sector: sin puestos junior no se fabrican seniors dentro de cinco años.",
    whyMatters:
      "Es un problema de oferta futura que ninguna empresa individual tiene incentivo para resolver. Suele terminar en intervención pública.",
    foresight:
      "Para 2030 va a haber escasez aguda de perfiles medios y programas de formación financiados por consorcios de empresas, no por universidades.",
    age: 23,
  },
  {
    handle: "_akhaliq",
    author: "AK",
    text: "Paper del día: memoria de largo plazo para agentes usando compresión jerárquica del historial. 100k turnos sin degradación.",
    url: "https://arxiv.org/abs/2602.09117",
    title: "Hierarchical memory compression for long-horizon agents",
    description:
      "Método de compresión jerárquica que permite a un agente mantener coherencia a lo largo de cien mil turnos de conversación.",
    category: "AI News",
    confidence: 0.84,
    pestel: ["technological"],
    tldr: "Un método de compresión jerárquica del historial permite a un agente mantener coherencia a lo largo de 100.000 turnos sin degradación medible.",
    impact:
      "Habilita asistentes que acompañan un proyecto durante meses en vez de reiniciarse cada sesión.",
    whyMatters:
      "La memoria persistente es lo que separa una herramienta de un colaborador. También es lo que convierte la privacidad en un problema serio.",
    foresight:
      "La memoria de largo plazo va a forzar una discusión sobre portabilidad: quién es dueño del historial cuando cambias de proveedor.",
    age: 24,
  },
  {
    handle: "rasbt",
    author: "Sebastian Raschka",
    text: "Escribí una explicación visual de la atención con ventana deslizante. Si nunca te cuadró por qué funciona, empieza por aquí.",
    url: "https://magazine.sebastianraschka.com/p/sliding-window-attention",
    title: "Atención con ventana deslizante, explicada visualmente",
    description:
      "Explicación con diagramas del mecanismo de atención con ventana deslizante y de su efecto sobre el costo de contexto largo.",
    category: "AI Docs/Updates",
    confidence: 0.89,
    pestel: ["technological"],
    tldr: "Una explicación visual del mecanismo de atención con ventana deslizante y de por qué reduce el costo del contexto largo sin perder coherencia local.",
    impact:
      "Material de formación que baja la curva de entrada a quien tiene que decidir arquitectura sin ser investigador.",
    whyMatters:
      "Entender el mecanismo es lo que permite anticipar dónde va a fallar. Sin eso, las decisiones se toman por moda.",
    age: 27,
  },
  {
    handle: "ylecun",
    author: "Yann LeCun",
    text: "Predecir el siguiente token nunca fue el objetivo, era el andamio. El siguiente paso son modelos del mundo, y ya hay resultados.",
    url: "https://deepmind.google/discover/blog/world-models-2026/",
    title: "Modelos del mundo: primeros resultados fuera del laboratorio",
    description:
      "Reporte de avances en modelos que predicen dinámicas del entorno en vez de secuencias de texto, con aplicaciones en robótica.",
    category: "AI News",
    confidence: 0.82,
    pestel: ["technological"],
    tldr: "Los modelos que predicen dinámicas del entorno en vez de secuencias de texto muestran primeros resultados fuera del laboratorio, sobre todo en robótica.",
    impact:
      "Abre una vía de progreso que no depende de más datos de internet, que es el recurso que se está agotando.",
    whyMatters:
      "Si el escalado de texto se estanca, la siguiente curva de mejora va a venir de aquí. Conviene saber leerla desde ahora.",
    foresight:
      "La robótica de propósito general va a tener su momento de inflexión cuando estos modelos bajen de costo, probablemente a finales de la década.",
    age: 28,
  },
  {
    handle: "mmitchell_ai",
    author: "Margaret Mitchell",
    text: "Publicamos la tarjeta de modelo con las limitaciones que encontramos, incluidas las que no supimos arreglar. Ojalá se vuelva costumbre.",
    url: "https://huggingface.co/blog/model-cards-limitations",
    title: "Tarjetas de modelo que documentan lo que no funciona",
    description:
      "Propuesta de formato de documentación de modelos que incluye limitaciones conocidas sin resolver.",
    category: "AI Docs/Updates",
    confidence: 0.8,
    pestel: ["social", "legal"],
    tldr: "Una propuesta de tarjeta de modelo que documenta explícitamente las limitaciones sin resolver, no solo las capacidades medidas.",
    impact:
      "Cambia el incentivo de la documentación: de material de marketing a instrumento de gestión de riesgo.",
    whyMatters:
      "Lo que no está documentado se descubre en producción. Normalizar la publicación de fallos es lo que hace utilizable una tecnología en contextos serios.",
    age: 31,
  },
  {
    handle: "karpathy",
    author: "Andrej Karpathy",
    text: "Hackathon de agentes el mes que viene, presencial y sin patrocinios de laboratorios. La lista de mentores está muy bien.",
    url: "https://lu.ma/agent-hackathon-2026",
    title: "Hackathon de agentes autónomos",
    description:
      "Convocatoria a un hackathon presencial de dos días sobre agentes, con mentores independientes y sin patrocinio de laboratorios.",
    category: "Community Events & Conferences",
    confidence: 0.9,
    pestel: ["social"],
    tldr: "Convocatoria a un hackathon presencial de dos días sobre agentes autónomos, con mentores independientes y sin patrocinio de laboratorios.",
    impact:
      "Los eventos sin patrocinio de proveedor son de los pocos lugares donde se comparan herramientas sin sesgo comercial.",
    whyMatters:
      "Es donde se ve qué funciona de verdad antes de que llegue al material de marketing.",
    age: 33,
  },
  {
    handle: "swyx",
    author: "shawn @swyx",
    text: "Conferencia de ingeniería de IA: las charlas ya no son sobre modelos, son sobre operación. Buena señal de madurez del campo.",
    url: "https://www.ai.engineer/summit",
    title: "AI Engineer Summit",
    description:
      "Programa de la cumbre de ingeniería de IA, dominado por charlas de operación, evaluación y despliegue.",
    category: "Community Events & Conferences",
    confidence: 0.88,
    pestel: ["social", "economic"],
    tldr: "El programa de la cumbre de ingeniería de IA está dominado por charlas de operación, evaluación y despliegue en vez de investigación de modelos.",
    impact:
      "Señala que el campo pasó de la fase de descubrimiento a la de industrialización, con lo que eso implica para los perfiles que se contratan.",
    whyMatters:
      "El contenido de las conferencias es un indicador adelantado de dónde va a estar el trabajo en 18 meses.",
    age: 36,
  },
  {
    handle: "simonw",
    author: "Simon Willison",
    text: "Recordatorio incómodo: si tu agente puede leer correo y navegar, alguien puede escribirte un correo que reprograme a tu agente.",
    url: "https://simonwillison.net/2026/prompt-injection-still-unsolved/",
    title: "La inyección de prompts sigue sin resolverse",
    description:
      "Repaso al estado del problema de inyección de prompts en agentes con acceso a contenido externo no confiable.",
    category: "Developer Tools & Projects",
    confidence: 0.91,
    pestel: ["technological", "legal"],
    tldr: "La inyección de prompts sigue sin solución general: cualquier agente que lea contenido externo puede ser reprogramado por ese contenido.",
    impact:
      "Es el obstáculo principal para desplegar agentes con permisos reales en entornos corporativos, y no hay parche a la vista.",
    whyMatters:
      "Toda la promesa de los agentes autónomos depende de resolver esto. Mientras no se resuelva, la autonomía real queda acotada a entornos cerrados.",
    foresight:
      "La solución práctica va a ser arquitectónica y no del modelo: separación estricta de canales de confianza, igual que se resolvió la inyección de SQL.",
    age: 38,
  },
  {
    handle: "hardmaru",
    author: "hardmaru",
    text: "Colección de arte generativo entrenada solo con obras de dominio público. El resultado es más interesante que el debate que provocó.",
    url: "https://www.theverge.com/2026/public-domain-generative-art",
    title: "Arte generativo entrenado solo con dominio público",
    description:
      "Proyecto artístico entrenado exclusivamente con obras de dominio público y la discusión sobre estética y procedencia que abrió.",
    category: "Personal & Pop-Culture",
    confidence: 0.72,
    pestel: ["social", "legal"],
    tldr: "Un proyecto de arte generativo entrenado exclusivamente con obras de dominio público abre una discusión sobre estética y procedencia de los datos.",
    impact:
      "Demuestra que se puede construir con datos limpios, lo que debilita el argumento de que la calidad exige datos de origen dudoso.",
    whyMatters:
      "Es un contraejemplo útil en una discusión que suele plantearse como disyuntiva entre calidad y legalidad.",
    age: 43,
  },
  {
    handle: "emollick",
    author: "Ethan Mollick",
    text: "La adopción de IA en empresas se parece a la del correo electrónico: años de nada aparente y después todo a la vez.",
    url: "https://www.oneusefulthing.org/p/curva-de-adopcion-empresarial",
    title: "La curva de adopción empresarial no es gradual",
    description:
      "Ensayo comparando la adopción de IA en empresas con ciclos anteriores de tecnología de propósito general.",
    category: "Social Commentary",
    confidence: 0.77,
    pestel: ["economic", "social"],
    tldr: "La adopción empresarial de IA sigue la curva del correo electrónico: mucho tiempo de aparente inmovilidad y después un cambio abrupto y generalizado.",
    impact:
      "Sugiere que las métricas de adopción actuales subestiman el cambio que viene, porque miden el tramo plano de la curva.",
    whyMatters:
      "Planificar para un cambio gradual cuando el cambio es abrupto es la forma más común de llegar tarde.",
    age: 46,
  },
  {
    handle: "levelsio",
    author: "Pieter Levels",
    text: "Documentales sobre la carrera de los chips: tres estrenos este año y ninguno explica bien la parte de litografía.",
    url: "https://www.theverge.com/2026/chip-documentaries-review",
    title: "Los documentales de la carrera de los chips",
    description:
      "Reseña de tres documentales recientes sobre la industria de semiconductores y sus omisiones técnicas.",
    category: "Movies",
    confidence: 0.68,
    pestel: ["social", "economic"],
    tldr: "Tres documentales recientes sobre la industria de semiconductores cuentan bien la geopolítica y mal la parte técnica, sobre todo la litografía.",
    impact:
      "La divulgación de la cadena de suministro de chips forma la opinión pública sobre decisiones industriales de miles de millones.",
    whyMatters:
      "Si la conversación pública sobre semiconductores se construye sobre relatos incompletos, las decisiones políticas también.",
    age: 49,
  },
  {
    handle: "GergelyOrosz",
    author: "Gergely Orosz",
    text: "Post mortem de una caída de seis horas causada por un cambio de configuración automatizado. Vale por un curso entero de fiabilidad.",
    url: "https://github.com/danluu/post-mortems",
    title: "Colección de post mortems públicos",
    description:
      "Repositorio con post mortems de incidentes de infraestructura publicados por sus propias empresas.",
    category: "Developer Tools & Projects",
    confidence: 0.86,
    pestel: ["technological"],
    tldr: "Una colección de post mortems públicos de incidentes de infraestructura, incluido uno de seis horas causado por un cambio de configuración automatizado.",
    impact:
      "Material de formación en fiabilidad que ninguna empresa produce por su cuenta porque implica publicar sus propios fallos.",
    whyMatters:
      "La automatización sin marcha atrás es el patrón de fallo que se repite, y va a repetirse más con agentes en el bucle de despliegue.",
    age: 52,
  },
  {
    handle: "dotcsv",
    author: "Carlos Santana",
    text: "Las stablecoins ya mueven más volumen de liquidación transfronteriza que algunas redes bancarias regionales. Dato para tenerlo presente.",
    url: "https://www.ft.com/content/stablecoin-settlement-volume-2026",
    title: "El volumen de liquidación en stablecoins supera a redes bancarias regionales",
    description:
      "Datos de volumen de liquidación transfronteriza en stablecoins comparados con redes bancarias tradicionales.",
    category: "Crypto/Web3",
    confidence: 0.75,
    pestel: ["economic", "legal"],
    tldr: "El volumen de liquidación transfronteriza en stablecoins supera ya al de algunas redes bancarias regionales, según datos de mercado.",
    impact:
      "Empuja la regulación de pagos hacia un terreno donde el emisor no es un banco, con implicaciones de estabilidad financiera.",
    whyMatters:
      "Es infraestructura financiera creciendo fuera del perímetro supervisado. Históricamente eso termina en regulación abrupta.",
    age: 55,
  },
  {
    handle: "_akhaliq",
    author: "AK",
    text: "Dataset abierto de 40 millones de artículos científicos con texto completo y licencia clara. Esto sí mueve la aguja.",
    url: "https://huggingface.co/datasets/open-science-corpus",
    title: "Corpus abierto de literatura científica",
    description:
      "Publicación de un corpus de 40 millones de artículos científicos con texto completo y licencias verificadas.",
    category: "AI Docs/Updates",
    confidence: 0.87,
    pestel: ["technological", "legal"],
    tldr: "Se publica un corpus abierto de 40 millones de artículos científicos con texto completo y licencias verificadas, apto para entrenamiento.",
    impact:
      "Da a los equipos pequeños acceso a datos de calidad con procedencia limpia, que era la barrera más cara de superar.",
    whyMatters:
      "La procedencia verificable de los datos va a ser requisito regulatorio. Un corpus limpio y grande es una ventaja estructural.",
    foresight:
      "Los corpus con licencia verificada se van a volver el activo escaso, y las editoriales científicas van a intentar cerrar esa puerta.",
    age: 58,
  },
];

/** Enlaces pegados a mano desde la pantalla de Análisis. */
const DEMO_MANUAL_LINKS = [
  {
    url: "https://www.anthropic.com/news/model-context-protocol",
    title: "Model Context Protocol",
    description:
      "Especificación abierta para conectar modelos con herramientas y fuentes de datos de forma uniforme.",
    category: "AI Docs/Updates",
    confidence: 0.9,
    pestel: ["technological"],
    tldr: "La especificación abierta para conectar modelos con herramientas y datos, en su versión de referencia.",
    impact: "Es la base sobre la que se está construyendo el ecosistema de herramientas para agentes.",
    whyMatters: "Leer la especificación es la única forma de anticipar qué se puede y qué no se puede construir encima.",
    age: 5,
  },
  {
    url: "https://arxiv.org/abs/2601.07733",
    title: "A survey of evaluation methods for LLM agents",
    description:
      "Revisión sistemática de métodos de evaluación de agentes, con taxonomía de métricas y sus puntos ciegos.",
    category: "AI News",
    confidence: 0.84,
    pestel: ["technological"],
    tldr: "Revisión sistemática de cómo se evalúan hoy los agentes, con una taxonomía de métricas y sus puntos ciegos.",
    impact: "Ordena un campo donde cada equipo mide con su propia regla y los resultados no se pueden comparar.",
    whyMatters: "Sin evaluación comparable no hay forma de saber si un cambio mejora algo o solo mueve el ruido.",
    age: 25,
  },
  {
    url: "https://www.theverge.com/2026/ai-hardware-roundup",
    title: "El hardware de IA que sí llegó al mercado",
    description:
      "Repaso a los dispositivos de IA anunciados en los últimos dos años y a cuáles siguen a la venta.",
    category: "AI News",
    confidence: 0.71,
    pestel: ["economic", "social"],
    tldr: "Un repaso a los dispositivos de IA anunciados en dos años y a cuántos siguen realmente a la venta.",
    impact: "Sirve de correctivo frente al ciclo de anuncios: la mayoría de esas categorías de producto no cuajó.",
    whyMatters: "Distinguir el anuncio del producto es la mitad del trabajo de leer señales de hardware.",
    age: 44,
  },
];

// ---------------------------------------------------------------------------
// Mock de Ollama (bautizo de temas)
// ---------------------------------------------------------------------------

/**
 * Nombres que queremos ver en el grafo y en Horizontes de la demo. El mock elige
 * cuál devolver leyendo el prompt: `nameCluster` manda los títulos y TL;DR de los
 * miembros, así que contar palabras clave basta para saber qué comunidad es. Sin
 * esto habría que confiar en el orden de las llamadas, que no está garantizado.
 */
const CLUSTER_NAMES: { name: string; summary: string; keywords: string[] }[] = [
  {
    name: "Agentes y tool use",
    summary:
      "Señales sobre agentes que planean y llaman herramientas: el diseño del entorno de ejecución pesa hoy más que el tamaño del modelo.",
    keywords: ["agente", "agent", "tool use", "herramienta", "mcp", "harness", "supervis"],
  },
  {
    name: "Open-source y modelos locales",
    summary:
      "Señales sobre pesos abiertos, cuantización e inferencia local: la brecha con los modelos cerrados se cierra y la infraestructura propia vuelve a ser viable.",
    keywords: ["abierto", "open", "local", "cuantiz", "lora", "pesos", "inferencia"],
  },
  {
    name: "Regulación y gobernanza de IA",
    summary:
      "Señales sobre el marco legal de la IA: transparencia de datos de entrenamiento, evaluaciones de riesgo y trazabilidad exigible.",
    keywords: ["regul", "gobernanza", "legal", "sentencia", "riesgo", "transparencia", "auditor"],
  },
];

function pickClusterName(prompt: string): { name: string; summary: string } {
  const haystack = prompt.toLowerCase();
  let best = CLUSTER_NAMES[0];
  let bestScore = -1;
  for (const candidate of CLUSTER_NAMES) {
    const score = candidate.keywords.reduce(
      (acc, kw) => acc + haystack.split(kw).length - 1,
      0,
    );
    if (score > bestScore) {
      best = candidate;
      bestScore = score;
    }
  }
  return { name: best.name, summary: best.summary };
}

async function startOllamaMock(): Promise<Server> {
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      const { name, summary } = pickClusterName(body);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ message: { content: JSON.stringify({ name, summary }) } }));
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  process.env.OLLAMA_HOST = `http://127.0.0.1:${port}`;
  process.env.OLLAMA_API_KEY = "seed-demo-fake-key"; // ollamaConfig() lanza si falta
  return server;
}

// ---------------------------------------------------------------------------
// Usuario
// ---------------------------------------------------------------------------

/** Borra el usuario de demo si existe. El cascade del schema se lleva su tenant. */
async function dropDemoUser(): Promise<void> {
  const deleted = await withPlatformBypass((tx) =>
    tx.user.deleteMany({ where: { email: DEMO_EMAIL } }),
  );
  if (deleted.count > 0) log(`[demo] usuario anterior borrado (${deleted.count})`);
}

async function createDemoUser(): Promise<string> {
  // La API de better-auth escribe el hash con su propio formato; hacerlo a mano
  // sería adivinar. Devuelve el usuario recién creado.
  const result = await auth.api.signUpEmail({
    body: { email: DEMO_EMAIL, password: DEMO_PASSWORD, name: DEMO_NAME },
  });
  const userId = result.user?.id;
  if (!userId) throw new Error("signUpEmail no devolvió un usuario");
  // El hook `after` ya llamó a seedTenant, pero es idempotente y no queremos que
  // la demo dependa de que el hook siga existiendo.
  await seedTenant(userId);
  log(`[demo] usuario creado: ${DEMO_EMAIL} (${userId})`);
  return userId;
}

// ---------------------------------------------------------------------------
// Siembra del tenant
// ---------------------------------------------------------------------------

async function seedConnections(tx: TenantTx, userId: string): Promise<void> {
  // Token de X INVENTADO, cifrado con el esquema real para que las columnas
  // tengan la forma correcta. No sirve para llamar a la API de X, y así debe ser.
  await tx.xAuthToken.create({
    data: {
      userId,
      xUserId: "1487234981234567890",
      xUsername: "fridaruh",
      accessToken: encryptToken(`demo-access-token-${randomUUID()}`),
      refreshToken: encryptToken(`demo-refresh-token-${randomUUID()}`),
      expiresAt: new Date(now.getTime() + 90 * DAY_MS),
      createdAt: daysAgo(61),
      updatedAt: daysAgo(1, 6, 5),
    },
  });

  await tx.ingestionCursor.create({
    data: {
      userId,
      lastTweetId: snowflakeFor(daysAgo(1, 9, 12), 7),
      lastRunAt: daysAgo(0, 6, 2),
      lastStatus: "ok",
      maxLikeRank: DEMO_ITEMS.length,
      minLikeRank: 1,
      backfillReachedWindow: true,
    },
  });

  // Key de Anthropic FICTICIA. `last4` es lo único que la UI enseña y por eso
  // dice "demo": si alguien mira la captura, queda claro que no es una key real.
  await tx.userSecret.create({
    data: {
      userId,
      provider: "anthropic",
      encrypted: encryptToken("sk-ant-api03-DEMO-NO-ES-UNA-KEY-REAL-demo"),
      last4: "demo",
      model: "claude-sonnet-5",
      verifiedAt: daysAgo(0, 6, 3),
      createdAt: daysAgo(58),
    },
  });
}

async function seedQuota(tx: TenantTx, userId: string): Promise<void> {
  const reset = new Date(now);
  reset.setUTCHours(0, 0, 0, 0);
  reset.setUTCDate(reset.getUTCDate() + 1);
  await tx.userQuota.update({
    where: { userId },
    data: {
      xPagesUsedToday: 1,
      analyzeUsedToday: 37,
      windowResetAt: reset,
      pipelineEnabled: true,
      lastManualSyncAt: daysAgo(0, 6, 2),
      lastGraphRefreshAt: daysAgo(0, 6, 20),
    },
  });
}

type SeededItem = { id: string; group?: Group };

async function seedItems(tx: TenantTx, ownerId: string): Promise<SeededItem[]> {
  const seeded: SeededItem[] = [];
  const total = DEMO_ITEMS.length;

  for (let i = 0; i < total; i += 1) {
    const spec = DEMO_ITEMS[i];
    const likedAt = daysAgo(spec.age, 9 + (i % 8), (i * 13) % 60);
    // El tweet es un poco anterior al like: es lo que pasa en la realidad y lo
    // que hace consistente la estimación de `likedAt` de src/lib/liked-at.ts.
    const tweetCreatedAt = new Date(likedAt.getTime() - (2 + (i % 5)) * 3_600_000);
    const published = spec.group !== undefined;

    const item = await tx.likedItem.create({
      data: {
        ownerId,
        source: "x_like",
        tweetId: snowflakeFor(tweetCreatedAt, i + 1),
        authorHandle: spec.handle,
        authorName: spec.author,
        tweetText: spec.text,
        tweetUrl: `https://x.com/${spec.handle}/status/${snowflakeFor(tweetCreatedAt, i + 1)}`,
        tweetCreatedAt,
        detectedAt: new Date(likedAt.getTime() + 3_600_000),
        likedAt,
        likedAtSource: "tweet_date",
        likeRank: total - i,
        contentUrl: spec.url,
        contentTitle: spec.title,
        contentDescription: spec.description,
        contentPublishedAt: new Date(tweetCreatedAt.getTime() - 86_400_000),
        fetchedAt: new Date(likedAt.getTime() + 7_200_000),
        fetchStatus: "success",
        category: spec.category,
        categorySource: "auto",
        categoryConfidence: spec.confidence,
        categoryReasoning: `Coincide con la descripción de «${spec.category}».`,
        categorizedAt: new Date(likedAt.getTime() + 10_800_000),
        pestel: spec.pestel,
        pestelSource: "auto",
        tldr: spec.tldr,
        tldrGeneratedAt: new Date(likedAt.getTime() + 14_400_000),
        impact: spec.impact,
        impactGeneratedAt: new Date(likedAt.getTime() + 14_400_000),
        whyMatters: spec.whyMatters,
        whyMattersGeneratedAt: new Date(likedAt.getTime() + 14_400_000),
        foresight: spec.foresight ?? null,
        foresightGeneratedAt: spec.foresight ? new Date(likedAt.getTime() + 18_000_000) : null,
        publishStatus: published ? "published" : "pending",
        publishedAt: published ? new Date(likedAt.getTime() + 21_600_000) : null,
      },
      select: { id: true },
    });

    seeded.push({ id: item.id, group: spec.group });
  }

  // Enlaces pegados a mano: mismo modelo, distinto `source` (ver manual-link.ts).
  for (let i = 0; i < DEMO_MANUAL_LINKS.length; i += 1) {
    const spec = DEMO_MANUAL_LINKS[i];
    const likedAt = daysAgo(spec.age, 17, 30 + i);
    const domain = new URL(spec.url).hostname.replace(/^www\./, "");
    await tx.likedItem.create({
      data: {
        ownerId,
        source: MANUAL_SOURCE,
        tweetId: `manual:${randomUUID()}`,
        authorHandle: domain,
        tweetText: spec.url,
        tweetUrl: spec.url,
        likedAt,
        likedAtSource: MANUAL_LIKED_AT_SOURCE,
        contentUrl: spec.url,
        contentTitle: spec.title,
        contentDescription: spec.description,
        fetchedAt: new Date(likedAt.getTime() + 60_000),
        fetchStatus: "success",
        category: spec.category,
        categorySource: "manual",
        categoryConfidence: spec.confidence,
        categorizedAt: new Date(likedAt.getTime() + 120_000),
        pestel: spec.pestel,
        tldr: spec.tldr,
        tldrGeneratedAt: new Date(likedAt.getTime() + 180_000),
        impact: spec.impact,
        impactGeneratedAt: new Date(likedAt.getTime() + 180_000),
        whyMatters: spec.whyMatters,
        whyMattersGeneratedAt: new Date(likedAt.getTime() + 180_000),
        publishStatus: "pending",
      },
    });
  }

  return seeded;
}

/** Dos columnas extra, como las que agrega alguien que usa la tabla de verdad. */
async function seedCustomFields(
  tx: TenantTx,
  ownerId: string,
  items: SeededItem[],
): Promise<void> {
  const fields = [
    { fieldKey: "Acción", position: 0 },
    { fieldKey: "Para el reporte", position: 1 },
  ];
  for (const field of fields) {
    await tx.customFieldDefinition.create({ data: { ownerId, ...field } });
  }

  const values = [
    "Escribir hilo",
    "Citar en el informe",
    "Compartir con el equipo",
    "Revisar en un mes",
    "Sí",
    "Pendiente",
  ];
  for (let i = 0; i < Math.min(items.length, 12); i += 1) {
    const field = fields[i % 2].fieldKey;
    await tx.likedItemCustomField.create({
      data: {
        ownerId,
        likedItemId: items[i].id,
        fieldKey: field,
        fieldValue: values[i % values.length],
      },
    });
  }
}

async function seedUsageAndJobs(tx: TenantTx, ownerId: string): Promise<void> {
  const kinds: { kind: string; units: number; tokensIn?: number; tokensOut?: number }[] = [
    { kind: "x_page", units: 1 },
    { kind: "fetch", units: 1 },
    { kind: "ollama_call", units: 1, tokensIn: 1_820, tokensOut: 260 },
    { kind: "anthropic_call", units: 1, tokensIn: 2_140, tokensOut: 310 },
    { kind: "openai_embed", units: 1, tokensIn: 640 },
  ];
  await tx.usageEvent.createMany({
    data: Array.from({ length: 45 }, (_, i) => {
      const spec = kinds[i % kinds.length];
      return {
        userId: ownerId,
        kind: spec.kind,
        units: spec.units,
        tokensIn: spec.tokensIn ?? null,
        tokensOut: spec.tokensOut ?? null,
        createdAt: daysAgo(Math.floor(i / 5), 6, (i % 5) * 7),
      };
    }),
  });

  const runs = [
    { job: "ingest", status: "ok", processed: 12, remaining: 0, minutesAgo: 190 },
    { job: "fetch", status: "ok", processed: 12, remaining: 0, minutesAgo: 182 },
    { job: "categorize", status: "ok", processed: 12, remaining: 0, minutesAgo: 176 },
    { job: "analyze", status: "ok", processed: 12, remaining: 3, minutesAgo: 168 },
    { job: "embed", status: "ok", processed: 6, remaining: 0, minutesAgo: 160 },
  ];
  for (const run of runs) {
    const startedAt = new Date(now.getTime() - run.minutesAgo * 60_000);
    await tx.jobRun.create({
      data: {
        ownerId,
        job: run.job,
        status: run.status,
        startedAt,
        finishedAt: new Date(startedAt.getTime() + 42_000),
        processed: run.processed,
        remaining: run.remaining,
        createdAt: startedAt,
      },
    });
  }
}

// ---------------------------------------------------------------------------
// Embeddings sintéticos + grafo
// ---------------------------------------------------------------------------

/**
 * Vector de 1536 dims con soporte disjunto por grupo: el grupo g llena su tercio
 * del espacio. Coseno ≈ 1 dentro del grupo (muy por encima del umbral 0.55) y
 * exactamente 0 entre grupos, así que el detector de comunidades encuentra tres
 * temas limpios. Misma técnica que scripts/qa-graph-tenant.ts.
 */
function synthVector(group: Group, k: number): number[] {
  const v = new Array<number>(EMBED_DIMS).fill(0);
  const span = EMBED_DIMS / GROUPS;
  const start = group * span;
  for (let i = start; i < start + span; i += 1) v[i] = 1;
  // Perturbación por miembro: sin ella todos los vectores del grupo son idénticos
  // y el grafo queda con scores exactamente 1, que se ve artificial en la captura.
  // Perturbación amplia y determinista (≈ 60 dims por miembro): baja el coseno
  // intra-grupo a ~0.75–0.9, con lo que las aristas tienen pesos distintos y el
  // force-graph separa los nodos en vez de apilarlos en un punto.
  let seed = (group + 1) * 1009 + k * 7919;
  const next = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  for (let j = 0; j < 60; j += 1) {
    const idx = start + Math.floor(next() * span);
    v[idx] += 0.6 + next() * 1.2;
  }
  return v;
}

async function seedEmbeddings(ownerId: string, items: SeededItem[]): Promise<number> {
  const published = items.filter((i) => i.group !== undefined);
  const perGroup = new Map<Group, number>();

  await withOwner(ownerId, async (tx) => {
    for (const item of published) {
      const group = item.group as Group;
      const k = perGroup.get(group) ?? 0;
      perGroup.set(group, k + 1);
      const literal = `[${synthVector(group, k).join(",")}]`;
      await tx.$executeRaw`
        UPDATE liked_items
        SET embedding = ${literal}::vector,
            embedding_hash = ${`demo-${group}-${k}`},
            embedded_at = now()
        WHERE id = ${item.id} AND owner_id = ${ownerId}`;
    }
  }, { timeoutMs: 60_000 });

  return published.length;
}

function ctxFor(ownerId: string): JobContext {
  return {
    ownerId,
    budgetMs: 240_000,
    startedAt: Date.now(),
    runId: `seed-demo-${randomUUID()}`,
    trigger: "manual",
  };
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const mock = await startOllamaMock();
  // Import diferido: graph.ts congela sus umbrales al cargarse (ver arriba).
  const { runGraph } = await import("../src/lib/jobs/graph");

  try {
    await dropDemoUser();
    const ownerId = await createDemoUser();

    const items = await withOwner(
      ownerId,
      async (tx) => {
        await seedConnections(tx, ownerId);
        await seedQuota(tx, ownerId);
        const seeded = await seedItems(tx, ownerId);
        await seedCustomFields(tx, ownerId, seeded);
        await seedUsageAndJobs(tx, ownerId);
        return seeded;
      },
      { timeoutMs: 120_000, maxWaitMs: 20_000 },
    );
    log(`[demo] ${items.length} señales + ${DEMO_MANUAL_LINKS.length} enlaces manuales`);

    const embedded = await seedEmbeddings(ownerId, items);
    log(`[demo] ${embedded} embeddings sintéticos (${GROUPS} grupos)`);

    // El job solo procesa tenants marcados como sucios.
    await withPlatformBypass((tx) =>
      tx.userQuota.update({ where: { userId: ownerId }, data: { graphDirtyAt: new Date() } }),
    );

    const result = await runGraph(ctxFor(ownerId));
    if (!result.ok) throw new Error(`runGraph falló: ${result.error}`);
    log(`[demo] grafo: ${result.processed} nodos, ${result.details?.clusters} temas`);

    // Verificación explícita: sin temas ni snapshot, las capturas de Grafo y
    // Horizontes saldrían vacías y no habría forma de notarlo hasta verlas.
    const check = await withOwner(ownerId, async (tx) => {
      const [clusters, snapshots, links, publishedCount, names] = await Promise.all([
        tx.semanticCluster.count({ where: { ownerId } }),
        tx.graphSnapshot.count({ where: { ownerId } }),
        tx.semanticLink.count({ where: { ownerId } }),
        tx.likedItem.count({ where: { ownerId, publishStatus: "published" } }),
        tx.semanticCluster.findMany({ where: { ownerId }, select: { name: true, size: true } }),
      ]);
      return { clusters, snapshots, links, publishedCount, names };
    });

    log(
      `[demo] verificación: ${check.publishedCount} publicadas · ${check.links} aristas · ` +
        `${check.clusters} temas · ${check.snapshots} snapshot(s)`,
    );
    for (const c of check.names) log(`         · ${c.name} (${c.size})`);

    const problems: string[] = [];
    if (check.publishedCount !== 18) problems.push(`esperaba 18 publicadas, hay ${check.publishedCount}`);
    if (check.clusters < 3) problems.push(`esperaba ≥3 temas, hay ${check.clusters}`);
    if (check.snapshots < 1) problems.push("no hay snapshot del grafo");
    if (problems.length > 0) {
      throw new Error(`La demo quedó incompleta:\n  - ${problems.join("\n  - ")}`);
    }

    log(`\nOK — demo lista.  usuario: ${DEMO_EMAIL}  ·  contraseña: ${DEMO_PASSWORD}`);
    log("Siguiente paso: npm run shots:onboarding");
  } finally {
    await new Promise<void>((resolve) => mock.close(() => resolve()));
    await prisma.$disconnect();
  }
}

main().catch(async (error) => {
  console.error(error);
  await prisma.$disconnect();
  process.exit(1);
});
