/**
 * `GET /api/public/v1/meta` — resumen del banco de quien hace la llamada y
 * constantes del modelo.
 *
 * Es la primera llamada que debería hacer un agente que no conoce el corpus: le
 * dice cuánto hay, hasta cuándo llega, cuándo se recalculó el grafo por última vez
 * y con qué constantes se calculan vitalidad, muerte y aristas. Sin esto, un agente
 * razona sobre un mapa cuyo tamaño y actualidad desconoce.
 *
 * --- `signals` vs `publishedSignals` ------------------------------------------
 * El origen solo reportaba un conteo (`publishedSignals`, con `PUBLISHED_ONLY`)
 * porque esa era la única mitad del acervo visible por la API. Aquí no hay
 * `PUBLISHED_ONLY` (PLAN_MCP §0.2): la persona ve su banco entero, así que
 * `counts.signals` es el total real del tenant y `counts.publishedSignals` es el
 * subconjunto que ya pasó la curación y entra al grafo/semantic-links. Un agente
 * que solo mire `signals` sabe cuánto material hay en total; uno que compare los
 * dos sabe cuánto de eso ya está "listo" — información que antes era binaria
 * (visible o no) y ahora es explícita.
 *
 * `dateRange` (`earliestLikedAt`/`latestLikedAt`) se calcula sobre el banco
 * COMPLETO, no solo lo publicado: responde "¿desde cuándo estoy guardando esto?",
 * una pregunta sobre el hábito de curación, no sobre el grafo.
 * ---------------------------------------------------------------------------------
 */
import type { NextRequest } from "next/server";
import { handleOptions, ok, withPublicApi } from "@/lib/public-api-response";
import { withOwner } from "@/lib/tenant-db";
import { toMeta } from "@/lib/public-dto";

export const runtime = "nodejs";

async function handler(
  request: NextRequest,
  _ctx: unknown,
  { ownerId }: { ownerId: string; keyId: string },
) {
  const result = await withOwner(ownerId, async (tx) => {
    const [
      signals,
      publishedSignals,
      themesAlive,
      themesDead,
      macroThemes,
      links,
      categories,
      snapshots,
      lastSnapshot,
      earliest,
      latest,
    ] = await Promise.all([
      tx.likedItem.count({ where: { ownerId } }),
      tx.likedItem.count({ where: { ownerId, publishStatus: "published" } }),
      tx.semanticCluster.count({ where: { ownerId, status: "alive" } }),
      tx.semanticCluster.count({ where: { ownerId, status: "dead" } }),
      tx.macroCluster.count({ where: { ownerId } }),
      tx.semanticLink.count({ where: { ownerId } }),
      tx.category.count({ where: { ownerId } }),
      tx.graphSnapshot.count({ where: { ownerId } }),
      tx.graphSnapshot.findFirst({
        where: { ownerId },
        orderBy: { takenAt: "desc" },
        select: { takenAt: true },
      }),
      tx.likedItem.findFirst({
        where: { ownerId },
        orderBy: { likedAt: "asc" },
        select: { likedAt: true },
      }),
      tx.likedItem.findFirst({
        where: { ownerId },
        orderBy: { likedAt: "desc" },
        select: { likedAt: true },
      }),
    ]);

    return {
      signals,
      publishedSignals,
      themesAlive,
      themesDead,
      macroThemes,
      links,
      categories,
      snapshots,
      lastSnapshot,
      earliest,
      latest,
    };
  });

  return ok(
    toMeta({
      counts: {
        signals: result.signals,
        publishedSignals: result.publishedSignals,
        themesAlive: result.themesAlive,
        themesDead: result.themesDead,
        macroThemes: result.macroThemes,
        links: result.links,
        categories: result.categories,
        snapshots: result.snapshots,
      },
      lastGraphRunAt: result.lastSnapshot?.takenAt ?? null,
      dateRange: {
        earliestLikedAt: result.earliest?.likedAt ?? null,
        latestLikedAt: result.latest?.likedAt ?? null,
      },
    }),
    { cache: "short", request },
  );
}

export const GET = withPublicApi(handler);

export function OPTIONS(request: Request) {
  return handleOptions(request);
}
