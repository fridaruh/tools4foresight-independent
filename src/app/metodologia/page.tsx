export const metadata = { title: "Metodología — tools4foresight" };

export default function MetodologiaPage() {
  return (
    <div
      data-section="metodologia"
      className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-6 px-6 py-8 sm:px-10"
    >
      <header>
        <h1 className="section-title text-ink">Metodología</h1>
        <p className="text-sm text-ink-subtle">
          Qué significa cada indicador que ves en Horizontes y en el Grafo, qué supuestos hay
          detrás y qué NO son estos números. No es documentación técnica de cómo está construido
          el sistema — es la explicación de qué estás leyendo cuando lees un tema, un horizonte o
          una etiqueta.
        </p>
      </header>

      <div className="flex flex-col gap-6 text-sm leading-relaxed text-ink">
        <section>
          <h2 className="section-heading mb-1 text-ink">1. Qué es una señal</h2>
          <p>
            Una señal es un enlace que guardaste — por un like en X o porque lo agregaste a mano —
            junto con lo que el sistema pudo leer de su contenido: título, texto y (cuando el sitio
            lo trae) fecha de publicación real. No toda señal es una tendencia; es materia prima.
            El foresight pasa cuando decides <strong>publicarla</strong>: eso es lo que la mete al
            grafo semántico y a los temas de Horizontes. Lo no publicado queda en tu catálogo, pero
            no cuenta para nada de lo que sigue en este documento.
          </p>
        </section>

        <section>
          <h2 className="section-heading mb-1 text-ink">2. TL;DR, impacto y «por qué importa»</h2>
          <p>
            Tres lecturas distintas del mismo material, generadas por un modelo de lenguaje sobre
            el texto y el contenido leído del enlace:
          </p>
          <ul className="mt-2 flex flex-col gap-1.5 pl-4">
            <li>
              <strong>TL;DR</strong>: qué dice la señal, sin evaluarla. Resumen, no opinión.
            </li>
            <li>
              <strong>Impacto</strong>: qué cambia si esto es cierto o se sostiene. Es una lectura,
              no un hecho verificado.
            </li>
            <li>
              <strong>¿Por qué importa?</strong>: parte del impacto y responde a quién le pega y qué
              habría que vigilar.
            </li>
          </ul>
          <p className="mt-2">
            Los tres se escriben una sola vez y quedan fijos hasta que los edites a mano — el
            sistema no los reescribe encima de una edición manual. Solo se analizan las señales más
            recientes de tu catálogo (una ventana fija, hoy de varios cientos), no el histórico
            completo: es una decisión deliberada para no gastar cómputo en material viejo que ya
            revisaste o descartaste.
          </p>
        </section>

        <section>
          <h2 className="section-heading mb-1 text-ink">3. Categorías, PESTEL y etiquetas</h2>
          <p>Tres capas de clasificación, cada una con un propósito distinto:</p>
          <ul className="mt-2 flex flex-col gap-1.5 pl-4">
            <li>
              <strong>Categoría</strong>: una sola por señal, contra un catálogo cerrado que tú
              defines y editas. Es la clasificación temática principal — la que arma la
              distribución de fuentes.
            </li>
            <li>
              <strong>PESTEL</strong>: hasta dos dimensiones (Político, Económico, Social,
              Tecnológico, Ecológico, Legal) por señal, contra un marco fijo. Responde «¿de qué
              tipo de fuerza viene este cambio?», no de qué trata.
            </li>
            <li>
              <strong>Etiquetas</strong>: texto libre, de 3 a 5 por señal, sin catálogo detrás. Son
              la capa más granular — sirven para buscar y agrupar sin las ataduras de un catálogo
              cerrado.
            </li>
          </ul>
          <p className="mt-2">
            Las tres se generan automáticamente y se congelan en cuanto las editas a mano: una
            corrección tuya nunca se pierde en la siguiente corrida del modelo.
          </p>
        </section>

        <section>
          <h2 className="section-heading mb-1 text-ink">4. El grafo semántico: cuándo dos señales se conectan</h2>
          <p>
            Cada señal publicada se traduce a un vector (un embedding) que representa su
            significado. Dos señales se conectan cuando la similitud entre sus vectores supera un
            umbral fijo — hoy, un coseno de <strong>0.55</strong> sobre una escala de 0 a 1 — y cada
            señal se queda solo con sus <strong>8 vecinas más parecidas</strong> como mucho, para
            que el mapa no se vuelva una maraña de conexiones débiles. El grosor de una conexión en
            el grafo es esa similitud; el tamaño de un nodo es cuántas conexiones tiene.
          </p>
          <p className="mt-2">
            <strong>Supuesto importante:</strong> la similitud es semántica (de significado), no de
            coincidencia de palabras. Dos señales pueden estar fuertemente conectadas sin compartir
            ni una palabra, y dos señales con vocabulario parecido pueden no estarlo si tratan cosas
            distintas.
          </p>
        </section>

        <section>
          <h2 className="section-heading mb-1 text-ink">5. Temas: cómo se agrupan las señales</h2>
          <p>
            Sobre esa red de conexiones, un algoritmo de detección de comunidades (propagación de
            etiquetas ponderada) agrupa las señales que están densamente conectadas entre sí. Un
            grupo necesita al menos <strong>3 señales</strong> para convertirse en un tema con
            nombre; grupos más chicos quedan «sin tema» — no porque no importen, sino porque no hay
            suficiente material todavía para bautizarlos con confianza.
          </p>
          <p className="mt-2">
            El nombre y la descripción de cada tema los escribe un modelo de lenguaje a partir de
            los títulos y resúmenes de sus señales — es una síntesis, no una etiqueta que el
            algoritmo «sepa» de antemano. Cada tema es un <strong>linaje</strong>: si en la siguiente
            corrida el grupo sigue siendo esencialmente el mismo (se mide con solapamiento de
            miembros, no con identidad exacta), conserva su nombre e historial en vez de nacer de
            nuevo. Un tema no se borra cuando pierde vitalidad: se marca como muerto, y si llegan
            señales nuevas que lo reconectan, resucita con su historial intacto.
          </p>
        </section>

        <section>
          <h2 className="section-heading mb-1 text-ink">6. Vitalidad</h2>
          <p>
            Cada señal empieza con vitalidad 1 y decae con una <strong>vida media de 30 días</strong>{" "}
            sin señales nuevas cerca de ella — a los 30 días vale la mitad, a los 60 un cuarto, y
            así. Una señal <strong>sin tema</strong> (huérfana) decae al doble de velocidad: si en
            15 días nada la acompañó, es ruido; si algo llega, vuelve a subir. La vitalidad de un
            tema es la suma de la vitalidad de sus señales, así que un tema grande con señales
            recientes se mantiene vivo aunque cada señal individual sea vieja — mientras haya
            continuidad.
          </p>
          <p className="mt-2">
            Un tema con vitalidad por debajo de <strong>1.0</strong> (menos que una sola señal
            recién llegada) se considera muerto. Es reversible: se recalcula en cada corrida, así
            que si llega una señal nueva que lo reconecta, resucita.
          </p>
        </section>

        <section>
          <h2 className="section-heading mb-1 text-ink">7. Densidad, conectividad y novedad</h2>
          <p>Tres indicadores adicionales por tema, todos derivados de los embeddings:</p>
          <ul className="mt-2 flex flex-col gap-1.5 pl-4">
            <li>
              <strong>Densidad</strong>: qué tan parecidas son entre sí las señales del tema (su
              cohesión interna). Alta densidad = tema enfocado; baja = tema disperso, quizás dos
              cosas distintas agrupadas de más.
            </li>
            <li>
              <strong>Conectividad</strong>: qué proporción de las conexiones del tema salen hacia
              otros temas en vez de quedarse adentro. Alta conectividad = tema puente, que conecta
              varias conversaciones.
            </li>
            <li>
              <strong>Novedad</strong>: qué tan lejos está el tema del centro de gravedad de todo tu
              mapa. Un tema cerca del centro es «lo esperado» dentro de tu catálogo; uno lejano es
              atípico — no necesariamente irrelevante, pero sí distinto de tu patrón habitual.
            </li>
          </ul>
        </section>

        <section>
          <h2 className="section-heading mb-1 text-ink">8. Horizontes: H1, H2, H3</h2>
          <p>
            El horizonte es una <strong>hipótesis sugerida</strong>, no una probabilidad ni una
            predicción con margen de error — es una heurística sobre tamaño, vitalidad y novedad
            del tema, pensada para leerse, no para citarse como dato duro. Tú la confirmas o la
            corriges; una vez que la fijas a mano, el sistema deja de tocarla aunque los números
            sigan cambiando.
          </p>
          <ul className="mt-2 flex flex-col gap-1.5 pl-4">
            <li>
              <strong>H1 · Ya está pasando</strong>: tema grande (8+ señales), con vitalidad alta
              (3+) y cerca del centro del mapa (novedad baja o media). Es tendencia consolidada
              dentro de tu propio radar, no algo nuevo.
            </li>
            <li>
              <strong>H3 · Señal débil</strong>: tema chico (menos de 5 señales), con poca vitalidad
              (menos de 1.5) o muy alejado del resto (novedad en el 25% más atípico). Es una
              hipótesis a vigilar, no una conclusión.
            </li>
            <li>
              <strong>H2 · En transición</strong>: todo lo que no califica claramente como H1 ni
              H3. La categoría intermedia, y en la práctica la más grande.
            </li>
          </ul>
          <p className="mt-2">
            <strong>Supuesto importante:</strong> los umbrales de tamaño y vitalidad son fijos en el
            sistema, pero los de novedad son relativos a <em>tu propio</em> catálogo — se calculan
            sobre la mediana y el percentil 75 de tus temas vivos, no contra un estándar externo.
            Dos cuentas con contenido distinto pueden clasificar temas parecidos en horizontes
            distintos, porque «lo atípico» se mide contra lo típico de cada quien.
          </p>
        </section>

        <section>
          <h2 className="section-heading mb-1 text-ink">9. Macro-temas</h2>
          <p>
            Cuando un horizonte acumula más de 5 temas finos, se agrupan en macro-temas (como mucho
            5 por horizonte, 15 en total) para que la vista de conjunto siga siendo legible. Un
            macro-tema no tiene vitalidad ni historial propio — es una síntesis fresca en cada
            corrida del grafo, hecha con un modelo de lenguaje a partir de los nombres y resúmenes
            de los temas finos que agrupa. Nunca mezcla temas de horizontes distintos: si algo está
            en H1 y algo en H3, son macro-temas separados aunque el contenido se parezca.
          </p>
        </section>

        <section>
          <h2 className="section-heading mb-1 text-ink">10. Límites y supuestos a tener presentes</h2>
          <ul className="flex flex-col gap-1.5 pl-4">
            <li>
              Todo lo anterior depende de qué tan bien se pudo leer el contenido del enlace. Un
              sitio que bloquea el acceso automático, o un PDF sin metadata, produce una señal con
              poco material real — y eso se nota en su clasificación y en sus conexiones.
            </li>
            <li>
              La fecha de publicación que ves es la del contenido cuando el sitio la expone; cuando
              no, no se inventa — la señal simplemente queda sin fecha en vez de asumir la del día
              en que la guardaste.
            </li>
            <li>
              El horizonte, los indicadores y los temas se recalculan enteros en cada corrida del
              grafo: no es un proceso incremental que «recuerde» el estado anterior salvo por el
              linaje de temas y lo que hayas fijado a mano.
            </li>
            <li>
              Nada de esto reemplaza el juicio. Son lecturas del patrón de lo que guardaste, no un
              oráculo — el propósito es darte un mapa razonado de dónde mirar, no una respuesta
              cerrada.
            </li>
          </ul>
        </section>
      </div>
    </div>
  );
}
