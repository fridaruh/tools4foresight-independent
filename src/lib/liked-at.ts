// Estimacion de la fecha del like.
//
// La X API no expone cuando ocurrio el like: solo devuelve los likes ordenados
// del mas reciente al mas antiguo (ver PLAN seccion 1.4). Lo que si sabemos con
// certeza de cada like L en la posicion i de esa lista:
//
//   1. L no pudo pasar antes de que el tweet existiera  -> likedAt >= tweetCreatedAt(i)
//   2. Los likes vienen ordenados                       -> likedAt(i) >= likedAt(j) para todo j > i
//   3. Cayo dentro de la ventana de deteccion           -> windowStart <= likedAt <= windowEnd
//
// Combinando 1 y 2, la cota inferior mas ajustada para la posicion i es el maximo
// de tweetCreatedAt entre i y el final de la lista. Eso es lo que calculamos aqui,
// recorriendo del like mas viejo al mas nuevo y arrastrando el maximo.
//
// El resultado es una estimacion, no un dato exacto, y la UI lo muestra como tal.

export type LikedAtSource = "tweet_date" | "ordered";

export type EstimateInput = {
  /** Fecha de creacion del tweet (snowflake). null si no se pudo derivar. */
  tweetCreatedAt: Date | null;
};

export type EstimateResult = {
  likedAt: Date;
  likedAtSource: LikedAtSource;
};

/**
 * @param items Likes ordenados del mas reciente al mas antiguo, tal como los devuelve X.
 * @param windowStart Piso de la ventana: nada de este lote pudo haberse likeado antes.
 *   En una corrida incremental es el `lastRunAt` anterior; en backfill, null.
 * @param windowEnd Techo de la ventana: nada de este lote pudo haberse likeado despues.
 *   En una corrida incremental es "ahora"; en backfill, el like mas viejo ya guardado.
 */
export function estimateLikedAt(
  items: EstimateInput[],
  windowStart: Date | null,
  windowEnd: Date,
): EstimateResult[] {
  const results: EstimateResult[] = new Array(items.length);
  let runningMax = windowStart ? windowStart.getTime() : Number.NEGATIVE_INFINITY;

  // Del like mas viejo al mas reciente, para que el maximo se propague hacia arriba.
  for (let i = items.length - 1; i >= 0; i--) {
    const created = items[i].tweetCreatedAt?.getTime();
    if (created !== undefined && created > runningMax) runningMax = created;

    // Si no hay ninguna cota (tweet sin fecha derivable y sin windowStart),
    // el unico dato honesto que queda es el techo de la ventana.
    const lowerBound = Number.isFinite(runningMax) ? runningMax : windowEnd.getTime();
    const estimate = Math.min(lowerBound, windowEnd.getTime());

    results[i] = {
      likedAt: new Date(estimate),
      likedAtSource: windowStart ? "ordered" : "tweet_date",
    };
  }

  return results;
}
