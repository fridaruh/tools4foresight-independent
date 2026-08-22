// Catalogo de categorias y ejemplos few-shot.
//
// Vive aparte del pipeline a proposito (ver PLAN seccion 3.3): las categorias van
// a cambiar con el uso, y ajustarlas no deberia requerir tocar la logica del job.
// Editar este archivo es suficiente.
//
// Ampliado 2026-07-27: con las 4 categorias originales el 55% de los likes caia en
// "Otros". Las 6 nuevas salieron de analizar una muestra de 150 de esos items, y
// los ejemplos de abajo son likes reales de Frida, no inventados — un few-shot con
// su vocabulario clasifica mejor que uno generico.
//
// Frontera Movies / Personal & Pop-Culture (decidida por Frida el 2026-07-27): el cine
// y las series queer (lesbico, gay, sapphic) van a Movies aunque el tweet sea una
// anecdota personal; el resto del comentario personal sobre cine se queda en
// Personal & Pop-Culture. La regla vive en las dos descripciones a proposito, porque el
// modelo lee cada categoria por separado y solo respeta el desempate si lo ve en ambas.

export type CategoryDefinition = {
  name: string;
  /** Que entra aqui. Va literal al prompt, escribirlo para el modelo. */
  description: string;
  /** 2-3 ejemplos por categoria (PLAN 3.3). Texto corto tipo tweet. */
  examples: string[];
};

export const CATEGORIES: CategoryDefinition[] = [
  {
    name: "AI News",
    description:
      "Noticias y lanzamientos de IA: modelos nuevos, rondas de inversion de empresas de IA, movimientos del sector, resultados de benchmarks. Es la noticia en si; si el tweet explica como usar algo, va en AI Docs/Updates.",
    examples: [
      "Anthropic lanza Claude Opus 5, disponible hoy en la API",
      "Today we're releasing Personal Computer. Personal Computer integrates with the apps you already use",
    ],
  },
  {
    name: "AI Docs/Updates",
    description:
      "Documentacion tecnica, changelogs, releases, tutoriales y guias de implementacion de herramientas de IA. Lo que te ensena a usar algo de IA. Si el proyecto no tiene que ver con IA, va en Developer Tools & Projects.",
    examples: [
      "Nuevo en la doc: guia de prompt caching con ejemplos por lenguaje",
      "n8n's official Claude Code connector can now create and edit workflows!",
    ],
  },
  {
    name: "Developer Tools & Projects",
    description:
      "Herramientas de codigo, librerias, CLIs, repos open source y proyectos que alguien construyo, cuando el tema central NO es la IA. Incluye el clasico 'hice esto y aqui esta el link'.",
    examples: [
      "made a tiny terminal app to download videos from youtube, instagram, etc — npm i -g yoinks",
      "I built an MCP server for WhatsApp. It's fully open-source, self-hosted and doesn't rely on third-party services",
    ],
  },
  {
    name: "Startup & Business",
    description:
      "Negocio y producto: lanzamientos de empresa, metricas y revenue, levantamiento de capital, contrataciones, marca, y reflexiones de emprendedor. Si la empresa es de IA y la nota es la noticia del modelo, va en AI News.",
    examples: [
      "we launched publicly 8 days ago, hit $1M ARR today, and only took down one cloud provider along the way",
      "70% of local businesses still don't have proper websites. what if we...",
    ],
  },
  {
    name: "Personal & Pop-Culture",
    description:
      "REGLA DURA: si el item habla de una pelicula o serie lesbica, gay, sapphic o queer, NO va aqui — va en Movies, sin excepcion y sin importar el tono (pregunta suelta, recomendacion casual, hilo de fans, anecdota personal). Fuera de eso: memes, chistes, videos virales, anecdotas personales, musica, celebridades y comentario ligero del dia a dia. La cobertura de cine y series (estrenos, trailers, criticas) va en Movies; el comentario personal sobre una pelicula o serie que no es queer si se queda aqui. Libros y novelas no son cine: se quedan aqui aunque sean sapphic.",
    examples: [
      "If you can wear a lobster costume with authority, you're safe from becoming a stiff",
      "llegas por un cafe y te encuentras con @FridaRuh — vida presencial > vida remota",
      "segun un insider de Netflix, Cruel Summer de Taylor Swift aparece en la temporada 3",
    ],
  },
  {
    name: "Community Events & Conferences",
    description:
      "Meetups, hackathones, charlas, conferencias y networking: convocatorias, participaciones y recuentos. Lo que tiene fecha y lugar.",
    examples: [
      "Sabado 13 de mayo en Hermosillo, Sonora. Participare en @TEDxPitic y compartire espacio con grandes especialistas",
      "Ya casi es el #GoogleIO, y es un buen momento para hacer networking!",
    ],
  },
  {
    name: "Social Commentary",
    description:
      "Politica, sociedad, genero e identidad, salud mental, religion y temas de fondo. Opinion sobre el mundo, no sobre tecnologia ni sobre la vida personal de quien tuitea.",
    examples: [
      "Si la disyuntiva esta entre respetar el lenguaje y respetar la identidad de una persona, SIEMPRE VOY A ELEGIR RESPETAR LA IDENTIDAD",
      "El Papa Francisco movio muchas cosas para tratar que la Iglesia se alejara de ese conservadurismo",
    ],
  },
  {
    name: "Crypto/Web3",
    description:
      "Criptomonedas, NFTs, DeFi, blockchains y tooling de web3.",
    examples: [
      "Meta is now paying creators in $USDC in Colombia and Philippines (on @Solana)",
      "web3 builders: your feed is noise; offline interactions are the signal",
    ],
  },
  {
    name: "Movies",
    description:
      "REGLA DURA: cualquier item sobre cine o series lesbico, gay, sapphic o queer va aqui SIEMPRE, sin importar el tono — una pregunta suelta, una recomendacion casual, un hilo de fans o una anecdota personal cuentan igual que una critica. Esta regla le gana a Personal & Pop-Culture. Fuera de eso: cine y series en general — estrenos, trailers, criticas, premios, reparto. Libros y novelas no cuentan como cine.",
    examples: [
      "El trailer de Dune Parte 3 ya esta arriba",
      "Hayley Kiyoko's 'GIRLS LIKE GIRLS' debuts with 85% on Rotten Tomatoes",
      "a beautiful french lesbian movie i watched recently, highly recommend it",
      "drop your favorite wlw show, i need something to binge this weekend",
    ],
  },
  {
    name: "Otros",
    description:
      "Lo que no calza en ninguna categoria existente y tampoco justifica una nueva. Usarla es el ultimo recurso, no el default: si un item calza aunque sea parcialmente en otra categoria, esa gana.",
    examples: ["Buenos dias a todos menos a los que no pusieron modo oscuro"],
  },
];

/** Nombre de la categoria de fallback; nunca debe faltar del catalogo. */
export const FALLBACK_CATEGORY = "Otros";

export const CATEGORY_NAMES = CATEGORIES.map((c) => c.name);

export function isKnownCategory(name: string): boolean {
  return CATEGORY_NAMES.includes(name);
}
