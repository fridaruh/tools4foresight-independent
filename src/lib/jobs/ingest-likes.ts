import {
  extractContentUrl,
  extractMediaUrls,
  fetchLikedTweetsPage,
  getValidAccessToken,
  XCreditsDepleted,
  XRateLimited,
} from "@/lib/x-client";
import { tweetIdToDate } from "@/lib/snowflake";
import { estimateLikedAt } from "@/lib/liked-at";
import { withOwner, type TenantTx } from "@/lib/tenant-db";
import { reserveQuota, recordUsage } from "@/lib/quota";
import { clearXCreditsDepleted, markXCreditsDepleted } from "@/lib/platform-flags";
import type { Prisma } from "@/generated/prisma/client";

// La transacción de este job hace varias llamadas de red a X (una por página) y
// una posible segunda transacción anidada para refrescar el token: el timeout
// default de withOwner (30s) se queda corto. La ruta que lo invoca declara
// maxDuration = 120; el margen aquí se queda un poco por debajo.
const TX_TIMEOUT_MS = 100_000;

export type IngestionStatus = "ok" | "error_credits_depleted" | "error" | "rate_limited";

function backfillCutoff(months: number): Date {
  const cutoff = new Date();
  cutoff.setMonth(cutoff.getMonth() - months);
  return cutoff;
}

type CollectedTweet = {
  row: Omit<Prisma.LikedItemCreateManyInput, "ownerId" | "likedAt" | "likedAtSource" | "likeRank">;
  tweetCreatedAt: Date | null;
};

type RunOutcome =
  | { status: "disabled" }
  | {
      status: IngestionStatus;
      error?: string;
      tweetsSeen: number;
      liked_items_created: number;
      pagesFetched: number;
      stoppedOnKnownTweet: boolean;
      reachedEndOfHistory: boolean;
      reachedWindow: boolean;
      backfillComplete: boolean;
      stoppedOnBudget: boolean;
    };

async function runIngestion(ownerId: string, tx: TenantTx): Promise<RunOutcome> {
  const quota = await tx.userQuota.findUnique({ where: { userId: ownerId } });
  if (!quota || !quota.pipelineEnabled) {
    return { status: "disabled" };
  }

  const cursor = await tx.ingestionCursor.findUnique({ where: { userId: ownerId } });
  const { xUserId, accessToken } = await getValidAccessToken(ownerId);

  // Backfill "pendiente" = todavía no llegamos ni una vez a la ventana de
  // BACKFILL_WINDOW_MONTHS (cursor.backfillReachedWindow sigue en false).
  // Mientras eso sea cierto, la corrida gasta el cupo de backfill (más
  // páginas); en cuanto se cruza la ventana una vez, backfillReachedWindow
  // queda en true para siempre y las corridas siguientes son incrementales
  // con el cupo diario, más chico.
  const backfillPending = !(cursor?.backfillReachedWindow ?? false);
  const maxPages = backfillPending ? quota.xBackfillPages : quota.xPagesPerDay;

  // Si venimos de un backfill cortado a la mitad, retomamos desde ese pagination_token
  // y mantenemos el tweet_id "pendiente" que se fijara como cursor solo al terminar el ciclo.
  // Si no, arrancamos un ciclo nuevo desde la pagina 1.
  const isResumingBackfill = Boolean(cursor?.resumePaginationToken);
  let paginationToken = cursor?.resumePaginationToken ?? undefined;
  let pendingNewestTweetId = cursor?.pendingNewestTweetId ?? undefined;
  const stopAtTweetId = cursor?.lastTweetId ?? undefined;
  const cutoff = backfillCutoff(quota.xBackfillMonths);

  const collected: CollectedTweet[] = [];
  let pagesFetched = 0;
  let stoppedOnKnownTweet = false;
  let reachedEndOfHistory = false;
  let reachedWindow = false;
  let stoppedOnBudget = false;

  let runStatus: IngestionStatus = "ok";
  let runError: string | undefined;
  let retryAfter: Date | undefined;

  outer: while (pagesFetched < maxPages) {
    // Se reserva ANTES de gastar la llamada a X: si no hay cupo, se corta acá
    // sin pedirle nada a X, no después de haber pagado el costo.
    const reserved = await reserveQuota(tx, ownerId, "x_pages", 1);
    if (!reserved) {
      stoppedOnBudget = true;
      break;
    }

    let page;
    try {
      page = await fetchLikedTweetsPage({ xUserId, accessToken, paginationToken });
    } catch (error) {
      if (error instanceof XRateLimited) {
        runStatus = "rate_limited";
        runError = error.message;
        retryAfter = error.resetAt;
        break;
      }
      if (error instanceof XCreditsDepleted) {
        runStatus = "error_credits_depleted";
        runError = error.message;
        // Global: la X App compartida se quedó sin saldo, no es un problema
        // de este tenant en particular.
        await markXCreditsDepleted();
        break;
      }
      // Error de verdad (red, 5xx, etc.): se deja propagar. Al venir de dentro
      // de la transacción de withOwner(), todo lo escrito en esta corrida
      // (incluida la reserva de cupo de esta página) se revierte, y el catch
      // de ingestLikes() registra el fallo en una transacción nueva.
      throw error;
    }

    pagesFetched++;
    await recordUsage(tx, ownerId, "x_page", 1);

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
      // la ventana configurada todo lo que sigue tambien lo hace. Se corta el ciclo.
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
    const oldest = await tx.likedItem.findFirst({
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
    const result = await tx.likedItem.createMany({ data: batch, skipDuplicates: true });
    created = result.count;
  }

  const rankLo = batch.length > 0 ? startRank - (batch.length - 1) : null;
  const rankHi = batch.length > 0 ? startRank : null;

  const cycleComplete = stoppedOnKnownTweet || reachedEndOfHistory || reachedWindow;

  const cursorState = {
    lastRunAt: new Date(),
    lastStatus: runStatus,
    lastError: runError ?? null,
    retryAfter: retryAfter ?? null,
    lastTweetId: cycleComplete ? (pendingNewestTweetId ?? stopAtTweetId) : stopAtTweetId,
    pendingNewestTweetId: cycleComplete ? null : pendingNewestTweetId,
    resumePaginationToken: cycleComplete ? null : paginationToken,
    backfillReachedWindow: reachedWindow || (cursor?.backfillReachedWindow ?? false),
    maxLikeRank: rankHi === null ? cursor?.maxLikeRank : Math.max(rankHi, cursor?.maxLikeRank ?? rankHi),
    minLikeRank: rankLo === null ? cursor?.minLikeRank : Math.min(rankLo, cursor?.minLikeRank ?? rankLo),
  };

  await tx.ingestionCursor.upsert({
    where: { userId: ownerId },
    update: cursorState,
    create: {
      ...cursorState,
      userId: ownerId,
      lastTweetId: cursorState.lastTweetId ?? undefined,
      pendingNewestTweetId: cursorState.pendingNewestTweetId ?? undefined,
      resumePaginationToken: cursorState.resumePaginationToken ?? undefined,
      retryAfter: cursorState.retryAfter ?? undefined,
    },
  });

  // Una corrida OK es la señal de que la X App volvió a tener saldo (si el
  // flag global seguía prendido de un 402 anterior, se apaga acá).
  if (runStatus === "ok") {
    await clearXCreditsDepleted();
  }

  return {
    status: runStatus,
    ...(runError ? { error: runError } : {}),
    tweetsSeen: batch.length,
    liked_items_created: created,
    pagesFetched,
    stoppedOnKnownTweet,
    reachedEndOfHistory,
    reachedWindow,
    backfillComplete: cycleComplete,
    stoppedOnBudget,
  };
}

async function recordFailure(ownerId: string, error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  await withOwner(ownerId, (tx) =>
    tx.ingestionCursor.upsert({
      where: { userId: ownerId },
      update: { lastRunAt: new Date(), lastStatus: "error", lastError: message },
      create: { userId: ownerId, lastRunAt: new Date(), lastStatus: "error", lastError: message },
    }),
  );
  return { status: "error" as const, message };
}

/**
 * Ingesta los likes de X de UN tenant. `ownerId` es obligatorio: no existe una
 * ingesta "global". Toda la corrida —lectura de cuota, lectura/escritura del
 * cursor, reserva de cupo, creación de items— pasa por una única transacción
 * de `withOwner(ownerId, ...)`.
 */
export async function ingestLikes(ownerId: string) {
  try {
    const outcome = await withOwner(ownerId, (tx) => runIngestion(ownerId, tx), {
      timeoutMs: TX_TIMEOUT_MS,
    });

    if (outcome.status === "disabled") {
      return outcome;
    }

    // "ok", "rate_limited" y "error_credits_depleted" son resultados manejados
    // sin excepción: el job no crasheó, solo se topó con un límite esperado.
    return { ok: true as const, ...outcome };
  } catch (error) {
    const { status, message } = await recordFailure(ownerId, error);
    return { ok: false as const, errorType: status, error: message };
  }
}
