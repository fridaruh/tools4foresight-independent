import { withOwner, type TenantTx } from "@/lib/tenant-db";
import { fetchContentMetadata } from "@/lib/content-fetch";
import { categorizeBatch } from "@/lib/categorize";
import { pestelClassifyBatch } from "@/lib/pestel-classify";
import { generateImpact, generateTldr, generateWhyMatters, type AnalysisInput } from "@/lib/analyze";
import { getAnalysisSystemPrompts } from "@/lib/analysis-prompts";
import { toBoardItem } from "@/lib/board-item";

/**
 * Corre la cadena completa sobre UN item de UN tenant: fetch de contenido →
 * categorización → PESTEL → TL;DR → impacto → "por qué importa".
 *
 * Es la versión síncrona de lo que los jobs hacen por lotes, y existe para el
 * enlace agregado a mano: quien acaba de pegar una URL espera ver la fila llena,
 * no esperar al cron. Cada etapa es independiente — si la categorización falla
 * (Ollama caído, sin API key), el item se queda con `category = null` y los jobs
 * normales lo levantan después, igual que a cualquier otro.
 *
 * Respeta las mismas reglas que los jobs: no pisa nada marcado como 'manual' y
 * no regenera lo que ya tiene valor.
 *
 * Sobre las transacciones: NO se envuelve todo en un solo `withOwner`. Entre
 * etapa y etapa hay llamadas de red de hasta 90 s cada una; una transacción
 * abierta ese tiempo contra el pooler de Neon se come una conexión del pool por
 * item (PLAN §7.4). Cada escritura abre la suya, corta, y el `ownerId` viaja en
 * el `where` de todas.
 */
export async function processSingleItem(ownerId: string, id: string) {
  const item = await withOwner(ownerId, (tx) =>
    tx.likedItem.findFirst({
      where: { id, ownerId },
      select: {
        id: true,
        tweetId: true,
        authorHandle: true,
        tweetText: true,
        contentUrl: true,
        contentTitle: true,
        contentDescription: true,
        fetchStatus: true,
        category: true,
        categorySource: true,
        pestel: true,
        pestelSource: true,
        tldr: true,
        tldrSource: true,
        impact: true,
        impactSource: true,
        whyMatters: true,
        whyMattersSource: true,
      },
    }),
  );

  // No encontrado y "de otro tenant" son la misma respuesta a propósito: un 404
  // distinto de un 403 le diría al curioso que el item existe.
  if (!item) return { ok: false as const, error: "No encontrado" };

  // El catálogo de categorías y los system prompts son DEL TENANT y se leen una
  // sola vez, igual que en los jobs por lotes: son la misma consulta para las
  // cuatro llamadas al modelo que vienen abajo.
  const { categories, prompts } = await withOwner(ownerId, async (tx) => ({
    categories: await tx.category.findMany({
      where: { ownerId },
      orderBy: { position: "asc" },
    }),
    prompts: await getAnalysisSystemPrompts(tx, ownerId),
  }));

  /** Azúcar: cada escritura es su propia transacción de tenant, corta. */
  const write = <T>(fn: (tx: TenantTx) => Promise<T>) => withOwner(ownerId, fn);

  const errors: string[] = [];
  let contentTitle = item.contentTitle;
  let contentDescription = item.contentDescription;

  // 1. Contenido del enlace. Sin esto la categorizacion trabaja sobre una URL pelada.
  if (item.contentUrl && item.fetchStatus === "pending") {
    try {
      const content = await fetchContentMetadata(item.contentUrl);
      contentTitle = content.title;
      contentDescription = content.description;
      await write((tx) =>
        tx.likedItem.updateMany({
          where: { id, ownerId },
          data: {
            contentTitle: content.title,
            contentDescription: content.description,
            contentImageUrl: content.imageUrl,
            contentPublishedAt: content.publishedAt,
            fetchedAt: new Date(),
            fetchStatus: "success",
          },
        }),
      );
    } catch (error) {
      await write((tx) =>
        tx.likedItem.updateMany({
          where: { id, ownerId },
          data: { fetchedAt: new Date(), fetchStatus: "failed" },
        }),
      );
      // No se corta: el titulo del enlace ayuda, pero la URL sola tambien dice algo
      // (el dominio, el slug) y el modelo puede clasificar con eso.
      errors.push(`No se pudo leer el contenido del enlace: ${message(error)}`);
    }
  }

  // 2. Categoria. Un "lote" de uno solo: reusa el mismo prompt y el mismo parseo que
  //    el job por lotes, sin duplicar el manejo de respuestas raras del modelo.
  if (item.category === null && item.categorySource !== "manual") {
    try {
      const [result] = await categorizeBatch(
        [
          {
            tweetId: item.tweetId,
            authorHandle: item.authorHandle,
            tweetText: item.tweetText,
            contentTitle,
            contentDescription,
          },
        ],
        categories,
      );
      if (result) {
        await write((tx) =>
          tx.likedItem.updateMany({
            where: { id, ownerId, category: null, categorySource: { not: "manual" } },
            data: {
              category: result.category,
              categorySource: "auto",
              categoryConfidence: result.confidence,
              categoryReasoning: result.reasoning,
              categorizedAt: new Date(),
            },
          }),
        );
      }
    } catch (error) {
      errors.push(`No se pudo categorizar: ${message(error)}`);
    }
  }

  // 2b. PESTEL. A diferencia del job de fondo (que solo toca likes de las ultimas 2
  //     semanas), este boton es un pedido explicito sobre este item puntual, asi que
  //     no aplica esa ventana — solo respeta lo editado a mano, igual que categoria.
  if (item.pestel.length === 0 && item.pestelSource !== "manual") {
    try {
      const [result] = await pestelClassifyBatch([
        { tweetId: item.tweetId, tweetText: item.tweetText, contentTitle, contentDescription },
      ]);
      if (result) {
        await write((tx) =>
          tx.likedItem.updateMany({
            where: { id, ownerId, pestel: { equals: [] }, pestelSource: { not: "manual" } },
            data: { pestel: result.pestel, pestelSource: "auto" },
          }),
        );
      }
    } catch (error) {
      errors.push(`No se pudo clasificar PESTEL: ${message(error)}`);
    }
  }

  // 3. TL;DR, impacto y "por que importa", en ese orden: el tercero usa el segundo
  //    como contexto (ver lib/analyze.ts).
  const source: AnalysisInput = {
    tweetText: item.tweetText,
    contentTitle,
    contentDescription,
  };

  try {
    let tldr = item.tldr;

    if (tldr === null && item.tldrSource !== "manual") {
      tldr = await generateTldr(source, prompts.tldr);
      await write((tx) =>
        tx.likedItem.updateMany({
          where: { id, ownerId, tldr: null, tldrSource: { not: "manual" } },
          data: { tldr, tldrSource: "auto", tldrGeneratedAt: new Date() },
        }),
      );
    }

    let impact = item.impact;

    if (impact === null && item.impactSource !== "manual") {
      impact = await generateImpact(source, prompts.impact);
      await write((tx) =>
        tx.likedItem.updateMany({
          where: { id, ownerId, impact: null, impactSource: { not: "manual" } },
          data: { impact, impactSource: "auto", impactGeneratedAt: new Date() },
        }),
      );
    }

    let whyMatters = item.whyMatters;

    if (impact !== null && whyMatters === null && item.whyMattersSource !== "manual") {
      whyMatters = await generateWhyMatters(source, impact, prompts.whyMatters);
      await write((tx) =>
        tx.likedItem.updateMany({
          where: { id, ownerId, whyMatters: null, whyMattersSource: { not: "manual" } },
          data: { whyMatters, whyMattersSource: "auto", whyMattersGeneratedAt: new Date() },
        }),
      );
    }
  } catch (error) {
    errors.push(`No se pudo generar el análisis: ${message(error)}`);
  }

  const updated = await withOwner(ownerId, (tx) =>
    tx.likedItem.findFirstOrThrow({ where: { id, ownerId } }),
  );

  return {
    // La corrida "sirvio" mientras el item exista. Los errores de cada etapa se
    // devuelven igual, para poder mostrarlos en la fila sin tumbarla.
    ok: true as const,
    // Misma forma que consume la tabla; impacto y "por que importa" van aparte porque
    // no son parte de BoardItem (la pantalla 1 no los muestra).
    item: toBoardItem(updated),
    tldr: updated.tldr,
    impact: updated.impact,
    whyMatters: updated.whyMatters,
    pestel: updated.pestel,
    ...(errors.length > 0 ? { errors } : {}),
  };
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
