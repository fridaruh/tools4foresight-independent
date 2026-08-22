import { prisma } from "@/lib/prisma";
import { fetchContentMetadata } from "@/lib/content-fetch";
import { categorizeBatch } from "@/lib/categorize";
import { pestelClassifyBatch } from "@/lib/pestel-classify";
import { generateImpact, generateTldr, generateWhyMatters, type AnalysisInput } from "@/lib/analyze";
import { generateForesight } from "@/lib/foresight";
import { toBoardItem } from "@/lib/board-item";

/**
 * Corre la cadena completa sobre UN item: fetch de contenido -> categorizacion ->
 * impacto -> "por que importa".
 *
 * Es la version sincrona de lo que los jobs hacen por lotes, y existe para el enlace
 * agregado a mano: quien acaba de pegar una URL espera ver la fila llena, no esperar
 * al cron. Cada etapa es independiente — si la categorizacion falla (Ollama caido, sin
 * API key), el item se queda con category = null y los jobs normales lo levantan
 * despues, igual que a cualquier otro.
 *
 * Respeta las mismas reglas que los jobs: no pisa nada marcado como 'manual' y no
 * regenera lo que ya tiene valor.
 */
export async function processSingleItem(id: string) {
  const item = await prisma.likedItem.findUnique({
    where: { id },
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
      foresight: true,
      foresightSource: true,
    },
  });

  if (!item) return { ok: false as const, error: "No encontrado" };

  const errors: string[] = [];
  let contentTitle = item.contentTitle;
  let contentDescription = item.contentDescription;

  // 1. Contenido del enlace. Sin esto la categorizacion trabaja sobre una URL pelada.
  if (item.contentUrl && item.fetchStatus === "pending") {
    try {
      const content = await fetchContentMetadata(item.contentUrl);
      contentTitle = content.title;
      contentDescription = content.description;
      await prisma.likedItem.update({
        where: { id },
        data: {
          contentTitle: content.title,
          contentDescription: content.description,
          contentImageUrl: content.imageUrl,
          contentPublishedAt: content.publishedAt,
          fetchedAt: new Date(),
          fetchStatus: "success",
        },
      });
    } catch (error) {
      await prisma.likedItem.update({
        where: { id },
        data: { fetchedAt: new Date(), fetchStatus: "failed" },
      });
      // No se corta: el titulo del enlace ayuda, pero la URL sola tambien dice algo
      // (el dominio, el slug) y el modelo puede clasificar con eso.
      errors.push(`No se pudo leer el contenido del enlace: ${message(error)}`);
    }
  }

  // 2. Categoria. Un "lote" de uno solo: reusa el mismo prompt y el mismo parseo que
  //    el job por lotes, sin duplicar el manejo de respuestas raras del modelo.
  if (item.category === null && item.categorySource !== "manual") {
    try {
      const [result] = await categorizeBatch([
        {
          tweetId: item.tweetId,
          authorHandle: item.authorHandle,
          tweetText: item.tweetText,
          contentTitle,
          contentDescription,
        },
      ]);
      if (result) {
        await prisma.likedItem.updateMany({
          where: { id, category: null, categorySource: { not: "manual" } },
          data: {
            category: result.category,
            categorySource: "auto",
            categoryConfidence: result.confidence,
            categoryReasoning: result.reasoning,
            categorizedAt: new Date(),
          },
        });
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
        await prisma.likedItem.updateMany({
          where: { id, pestel: { equals: [] }, pestelSource: { not: "manual" } },
          data: { pestel: result.pestel, pestelSource: "auto" },
        });
      }
    } catch (error) {
      errors.push(`No se pudo clasificar PESTEL: ${message(error)}`);
    }
  }

  // 3. Impacto y "por que importa", en ese orden: el segundo usa el primero como
  //    contexto (ver lib/analyze.ts).
  const source: AnalysisInput = {
    tweetText: item.tweetText,
    contentTitle,
    contentDescription,
  };

  try {
    let tldr = item.tldr;

    if (tldr === null && item.tldrSource !== "manual") {
      tldr = await generateTldr(source);
      await prisma.likedItem.updateMany({
        where: { id, tldr: null, tldrSource: { not: "manual" } },
        data: { tldr, tldrSource: "auto", tldrGeneratedAt: new Date() },
      });
    }

    let impact = item.impact;

    if (impact === null && item.impactSource !== "manual") {
      impact = await generateImpact(source);
      await prisma.likedItem.updateMany({
        where: { id, impact: null, impactSource: { not: "manual" } },
        data: { impact, impactSource: "auto", impactGeneratedAt: new Date() },
      });
    }

    let whyMatters = item.whyMatters;

    if (impact !== null && whyMatters === null && item.whyMattersSource !== "manual") {
      whyMatters = await generateWhyMatters(source, impact);
      await prisma.likedItem.updateMany({
        where: { id, whyMatters: null, whyMattersSource: { not: "manual" } },
        data: { whyMatters, whyMattersSource: "auto", whyMattersGeneratedAt: new Date() },
      });
    }

    // 4. Foresight, al final: parte del TL;DR y del "por que importa". Corre en
    //    Claude (ver lib/foresight.ts), no en Ollama.
    if (
      tldr !== null &&
      whyMatters !== null &&
      item.foresight === null &&
      item.foresightSource !== "manual"
    ) {
      const foresight = await generateForesight({ tldr, whyMatters });
      await prisma.likedItem.updateMany({
        where: { id, foresight: null, foresightSource: { not: "manual" } },
        data: { foresight, foresightSource: "auto", foresightGeneratedAt: new Date() },
      });
    }
  } catch (error) {
    errors.push(`No se pudo generar el análisis: ${message(error)}`);
  }

  const updated = await prisma.likedItem.findUniqueOrThrow({ where: { id } });

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
    foresight: updated.foresight,
    pestel: updated.pestel,
    ...(errors.length > 0 ? { errors } : {}),
  };
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
