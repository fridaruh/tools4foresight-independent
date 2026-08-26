/**
 * Agregación de horizontes, compartida por `/horizons` y `/horizons/{key}`.
 *
 * Vive aquí y no en cada route porque los dos endpoints tienen que contar
 * EXACTAMENTE igual: si divergen, un agente que cruce el panorama con el detalle ve
 * números que no cuadran y desconfía de los dos.
 *
 * Solo cuenta temas VIVOS: un fósil ya no ocupa un horizonte (dejó de ser una
 * apuesta sobre el futuro), aunque siga siendo consultable por su id.
 *
 * --- Diferencia con el origen: quién abre la transacción -----------------------------
 * En el repo de origen estas funciones usaban el `prisma` global, porque allá había
 * un solo acervo. Aquí cada query tiene dueño, así que ambas reciben
 * `(tx: TenantTx, ownerId: string)` y **no abren su propia transacción**: el route
 * handler es quien llama a `withOwner(ownerId, (tx) => …)` y compone lo que necesite
 * dentro de la misma.
 *
 * Se eligió esa forma —y no "recibir el ownerId y abrir withOwner por dentro"— por
 * consistencia con el estilo ya establecido del repo: `loadCategories` (categories.ts)
 * y todo `category-service.ts` reciben `(tx, ownerId)` con el mismo contrato explícito
 * ("el caller es responsable de abrir la transacción"). Además evita que `/horizons`
 * abra tres o cuatro transacciones sueltas para armar una sola respuesta, que con el
 * pooler de Neon es justo lo que no conviene.
 *
 * El `ownerId` va además en el `where` de cada query (CLAUDE.md §1) aunque RLS ya lo
 * garantice dentro de `withOwner`: es la barrera de aplicación, la misma que pone
 * `tenantClient`, escrita a mano porque aquí el cliente es un `tx` pelado.
 * ------------------------------------------------------------------------------------
 */
import type { TenantTx } from "@/lib/tenant-db";
import { HORIZONS, type HorizonKey } from "@/lib/horizons";
import { MACRO_THEME_SELECT, toMacroTheme, type MacroThemeDTO } from "@/lib/public-dto";

export type HorizonCounts = { themeCount: number; signalCount: number; vitalitySum: number };

export async function horizonCounts(
  tx: TenantTx,
  ownerId: string,
): Promise<Record<HorizonKey, HorizonCounts>> {
  const [grouped, signalCounts] = await Promise.all([
    tx.semanticCluster.groupBy({
      by: ["horizon"],
      where: { ownerId, status: "alive", horizon: { in: [...HORIZONS] } },
      _count: { _all: true },
      _sum: { vitality: true },
    }),
    // El conteo de señales sale de `liked_items`, no del campo `size` del tema:
    // `size` es la foto de la última corrida del grafo y puede haber quedado
    // desfasado si algo cambió después. Las filas de ahora son la verdad de ahora.
    //
    // Sin filtro de `publishStatus`, a diferencia del origen: aquí la persona ve su
    // banco entero (PLAN_MCP §0.2). En la práctica el filtro tampoco haría nada —
    // `clusterId` solo lo escribe el job de grafo, que únicamente mira señales
    // publicadas — pero dejarlo escrito insinuaría un scope que ya no existe.
    tx.likedItem.groupBy({
      by: ["clusterId"],
      where: { ownerId, cluster: { status: "alive", horizon: { in: [...HORIZONS] } } },
      _count: { _all: true },
    }),
  ]);

  const clusterHorizon = new Map<string, HorizonKey>();
  if (signalCounts.length > 0) {
    const clusters = await tx.semanticCluster.findMany({
      where: {
        ownerId,
        id: { in: signalCounts.map((r) => r.clusterId).filter((id): id is string => id !== null) },
      },
      select: { id: true, horizon: true },
    });
    for (const c of clusters) {
      if (c.horizon === "H1" || c.horizon === "H2" || c.horizon === "H3") clusterHorizon.set(c.id, c.horizon);
    }
  }

  const result = Object.fromEntries(
    HORIZONS.map((key) => [key, { themeCount: 0, signalCount: 0, vitalitySum: 0 }]),
  ) as Record<HorizonKey, HorizonCounts>;

  for (const row of grouped) {
    const key = row.horizon as HorizonKey | null;
    if (!key || !(key in result)) continue;
    result[key].themeCount = row._count._all;
    result[key].vitalitySum = row._sum.vitality ?? 0;
  }

  for (const row of signalCounts) {
    if (!row.clusterId) continue;
    const key = clusterHorizon.get(row.clusterId);
    if (key) result[key].signalCount += row._count._all;
  }

  return result;
}

/**
 * `withThemes = false` (el listado `/horizons`) devuelve los macro-temas con
 * `themes: []`: anidar los temas completos en los tres horizontes devolvería el
 * corpus entero en una sola respuesta. Se pueblan en `/horizons/{key}` y en
 * `/macro-themes`.
 */
export async function macroThemesByHorizon(
  tx: TenantTx,
  ownerId: string,
  withThemes: boolean,
): Promise<Record<HorizonKey, MacroThemeDTO[]>> {
  const macros = await tx.macroCluster.findMany({
    where: { ownerId },
    select: MACRO_THEME_SELECT,
    orderBy: [{ horizon: "asc" }, { name: "asc" }],
  });

  const result = Object.fromEntries(HORIZONS.map((key) => [key, [] as MacroThemeDTO[]])) as Record<
    HorizonKey,
    MacroThemeDTO[]
  >;

  for (const macro of macros) {
    const dto = toMacroTheme(macro);
    if (dto.horizon in result) {
      result[dto.horizon].push(withThemes ? dto : { ...dto, themes: [] });
    }
  }

  return result;
}
