import { prisma } from "@/lib/prisma";
import {
  extractContentUrl,
  extractMediaUrls,
  fetchLikedTweetsPage,
  getValidAccessToken,
} from "@/lib/x-client";
import { tweetIdToDate } from "@/lib/snowflake";
import { estimateLikedAt } from "@/lib/liked-at";
import type { Prisma } from "@/generated/prisma/client";

const MAX_PAGES_PER_RUN = 10; // ~1000 likes max por corrida, para no agotar rate limit

// Frida pidio explicitamente cobertura de los ultimos 6 meses. El backfill se
// corta al cruzar esa antiguedad en vez de recorrer el historial completo: cada
// pagina extra cuesta creditos de X y no aporta nada a lo que se pidio.
// (El historial mas viejo que ya esta guardado no se toca ni se borra.)
const BACKFILL_WINDOW_MONTHS = 6;

export type IngestionStatus = "ok" | "error_credits_depleted" | "error";

function backfillCutoff(): Date {
  const cutoff = new Date();
  cutoff.setMonth(cutoff.getMonth() - BACKFILL_WINDOW_MONTHS);
  return cutoff;
}

function classifyError(error: unknown): { status: IngestionStatus; message: string } {
  const raw = error instanceof Error ? error.message : String(error);
  if (raw.includes("credits-depleted") || raw.includes("credits depleted") || raw.includes("(402)")) {
    return {
      status: "error_credits_depleted",
      message:
        "Tu cuenta de X se quedo sin creditos (pay-per-use). Recarga saldo en el Developer Portal (Billing/Usage) para que la ingesta pueda seguir.",
    };
  }
  return { status: "error", message: raw };
}

type CollectedTweet = {
  row: Omit<Prisma.LikedItemCreateManyInput, "ownerId" | "likedAt" | "likedAtSource" | "likeRank">;
  tweetCreatedAt: Date | null;
};

async function runIngestion(ownerId: string) {
  // TODO(fase3): mover estas lecturas dentro de withOwner() y quitar los filtros
  // manuales; por ahora RLS ya acota lo que se ve, pero cada query lo repite.
  const cursor = await prisma.ingestionCursor.findUnique({ where: { userId: ownerId } });
  const { xUserId, accessToken } = await getValidAccessToken(ownerId);

  // Si venimos de un backfill cortado a la mitad, retomamos desde ese pagination_token
  // y mantenemos el tweet_id "pendiente" que se fijara como cursor solo al terminar el ciclo.
  // Si no, arrancamos un ciclo nuevo desde la pagina 1.
  const isResumingBackfill = Boolean(cursor?.resumePaginationToken);
  let paginationToken = cursor?.resumePaginationToken ?? undefined;
  let pendingNewestTweetId = cursor?.pendingNewestTweetId ?? undefined;
  const stopAtTweetId = cursor?.lastTweetId ?? undefined;
  const cutoff = backfillCutoff();

  const collected: CollectedTweet[] = [];
  let pagesFetched = 0;
  let stoppedOnKnownTweet = false;
  let reachedEndOfHistory = false;
  let reachedWindow = false;

  outer: while (pagesFetched < MAX_PAGES_PER_RUN) {
    const page = await fetchLikedTweetsPage({ xUserId, accessToken, paginationToken });
    pagesFetched++;

    for (const tweet of page.tweets) {
      if (stopAtTweetId && tweet.id === stopAtTweetId) {
        stoppedOnKnownTweet = true;
        break outer;
      }

      // created_at viene en la respuesta, pero el snowflake del ID es igual de
      // exacto y ademas funciona para las filas historicas que ya estan en la DB
      // sin created_at. Usamos el ID como fuente unica para no tener dos criterios.
      const tweetCreatedAt = tweetIdToDate(tweet.id) ?? (tweet.created_at ? new Date(tweet.created_at) : null);

      // El orden de likes es descendente, asi que en cuanto un tweet cae fuera de
      // la ventana de 6 meses todo lo que sigue tambien lo hace. Se corta el ciclo.
      if (tweetCreatedAt && tweetCreatedAt < cutoff) {
        reachedWindow = true;
        break outer;
      }

      if (!pendingNewestTweetId) {
        pendingNewestTweetId = tweet.id;
      }

      const author = page.users.get(tweet.author_id);
      const contentUrl = extractContentUrl(tweet);
      const mediaUrls = extractMediaUrls(tweet, page.media);

      collected.push({
        tweetCreatedAt,
        row: {
          tweetId: tweet.id,
          authorHandle: author?.username ?? tweet.author_id,
          authorName: author?.name,
          tweetText: tweet.text,
          tweetUrl: `https://x.com/${author?.username ?? "i"}/status/${tweet.id}`,
          tweetCreatedAt,
          detectedAt: new Date(),
          mediaUrls,
          contentUrl,
          fetchStatus: contentUrl ? "pending" : "not_applicable",
        },
      });
    }

    if (!page.nextToken) {
      reachedEndOfHistory = true;
      break;
    }
    paginationToken = page.nextToken;
  }

  // Ventana de deteccion para estimar la fecha del like:
  //  - corrida incremental (likes nuevos, arriba del cursor): entre la corrida
  //    anterior y ahora. Con el cron diario eso acota el like a ~24h.
  //  - backfill (likes mas viejos que todo lo guardado): sin piso; el techo es el
  //    like mas antiguo que ya tenemos, porque estos son anteriores a ese.
  let windowStart: Date | null = null;
  let windowEnd = new Date();

  if (isResumingBackfill) {
    const oldest = await prisma.likedItem.findFirst({
      where: { ownerId },
      orderBy: { likedAt: "asc" },
      select: { likedAt: true },
    });
    if (oldest) windowEnd = oldest.likedAt;
  } else {
    windowStart = cursor?.lastRunAt ?? null;
  }

  const estimates = estimateLikedAt(collected, windowStart, windowEnd);

  // Rank global: mas alto = like mas reciente. Los incrementales se numeran por
  // encima del maximo conocido; el backfill, por debajo del minimo.
  const startRank = isResumingBackfill
    ? (cursor?.minLikeRank ?? 0) - 1
    : (cursor?.maxLikeRank ?? 0) + collected.length;

  const batch: Prisma.LikedItemCreateManyInput[] = collected.map((item, i) => ({
    ...item.row,
    ownerId,
    likedAt: estimates[i].likedAt,
    likedAtSource: estimates[i].likedAtSource,
    likeRank: startRank - i,
  }));

  let created = 0;
  if (batch.length > 0) {
    const result = await prisma.likedItem.createMany({ data: batch, skipDuplicates: true });
    created = result.count;
  }

  const rankLo = batch.length > 0 ? startRank - (batch.length - 1) : null;
  const rankHi = batch.length > 0 ? startRank : null;

  const cycleComplete = stoppedOnKnownTweet || reachedEndOfHistory || reachedWindow;

  const cursorState = {
    lastRunAt: new Date(),
    lastStatus: "ok",
    lastError: null,
    lastTweetId: cycleComplete ? (pendingNewestTweetId ?? stopAtTweetId) : stopAtTweetId,
    pendingNewestTweetId: cycleComplete ? null : pendingNewestTweetId,
    resumePaginationToken: cycleComplete ? null : paginationToken,
    backfillReachedWindow: reachedWindow || (cursor?.backfillReachedWindow ?? false),
    maxLikeRank: rankHi === null ? cursor?.maxLikeRank : Math.max(rankHi, cursor?.maxLikeRank ?? rankHi),
    minLikeRank: rankLo === null ? cursor?.minLikeRank : Math.min(rankLo, cursor?.minLikeRank ?? rankLo),
  };

  await prisma.ingestionCursor.upsert({
    where: { userId: ownerId },
    update: cursorState,
    create: {
      ...cursorState,
      userId: ownerId,
      lastTweetId: cursorState.lastTweetId ?? undefined,
      pendingNewestTweetId: cursorState.pendingNewestTweetId ?? undefined,
      resumePaginationToken: cursorState.resumePaginationToken ?? undefined,
    },
  });

  return {
    tweetsSeen: batch.length,
    liked_items_created: created,
    pagesFetched,
    stoppedOnKnownTweet,
    reachedEndOfHistory,
    reachedWindow,
    backfillComplete: cycleComplete,
  };
}

async function recordFailure(ownerId: string, error: unknown) {
  const { status, message } = classifyError(error);
  await prisma.ingestionCursor.upsert({
    where: { userId: ownerId },
    update: { lastRunAt: new Date(), lastStatus: status, lastError: message },
    create: { userId: ownerId, lastRunAt: new Date(), lastStatus: status, lastError: message },
  });
  return { status, message };
}

/**
 * Ingesta los likes de X de UN tenant. `ownerId` es obligatorio: no existe una
 * ingesta "global".
 * TODO(fase2.4): el tope de paginas sale de UserQuota, no de la constante de arriba.
 */
export async function ingestLikes(ownerId: string) {
  try {
    const summary = await runIngestion(ownerId);
    return { ok: true as const, ...summary };
  } catch (error) {
    const { status, message } = await recordFailure(ownerId, error);
    return { ok: false as const, errorType: status, error: message };
  }
}
