import { NextRequest, NextResponse } from "next/server";
import { requireUserApi } from "@/lib/require-user";
import { withOwner, type TenantTx } from "@/lib/tenant-db";

const KINDS = ["temas", "senales", "historial"] as const;
type Kind = (typeof KINDS)[number];

// CSV para llevar el mapa a un taller, una hoja de calculo o un 2x2 afuera de la
// app. Tres vistas: temas (una fila por linaje con sus indicadores), señales (una
// fila por señal con su tema, horizonte y vitalidad) e historial (una fila por
// tema y snapshot: la serie temporal).
export async function GET(request: NextRequest) {
  const user = await requireUserApi();
  if (user instanceof NextResponse) return user;

  const kind = request.nextUrl.searchParams.get("kind") as Kind | null;
  if (!kind || !KINDS.includes(kind)) {
    return NextResponse.json({ error: `kind debe ser uno de ${KINDS.join(", ")}` }, { status: 400 });
  }

  const rows = await withOwner(user.userId, async (tx) => {
    return kind === "temas" ? temas(tx) : kind === "senales" ? senales(tx) : historial(tx);
  });

  const stamp = new Date().toISOString().slice(0, 10);
  return new NextResponse(toCsv(rows), {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="tools4foresight-${kind}-${stamp}.csv"`,
      "Cache-Control": "no-store",
    },
  });
}

async function temas(tx: TenantTx) {
  const clusters = await tx.semanticCluster.findMany({
    orderBy: [{ status: "asc" }, { vitality: "desc" }],
  });
  return clusters.map((c) => ({
    id: c.id,
    tema: c.name,
    resumen: c.summary,
    estado: c.status === "alive" ? "vivo" : "muerto",
    horizonte: c.horizon ?? "",
    horizonte_sugerido: c.horizonSuggested ?? "",
    horizonte_origen: c.horizonSource,
    senales: c.size,
    vitalidad: round(c.vitality),
    velocidad_30d: c.velocity30d,
    velocidad_30d_previos: c.velocityPrev30d,
    densidad: round(c.density),
    conectividad: round(c.connectivity),
    temas_puente: c.bridgeClusters,
    novedad: round(c.novelty),
    primera_vez: iso(c.firstSeenAt),
    ultima_senal: iso(c.lastSignalAt),
    murio: iso(c.diedAt),
    resurrecciones: c.revivedCount,
  }));
}

async function senales(tx: TenantTx) {
  const items = await tx.likedItem.findMany({
    where: { publishStatus: "published", embeddedAt: { not: null } },
    orderBy: [{ clusterId: "asc" }, { vitality: "desc" }],
    select: {
      id: true,
      contentTitle: true,
      tweetText: true,
      tweetUrl: true,
      contentUrl: true,
      category: true,
      pestel: true,
      likedAt: true,
      vitality: true,
      cluster: { select: { name: true, status: true, horizon: true } },
    },
  });
  return items.map((i) => ({
    id: i.id,
    titulo: i.contentTitle ?? i.tweetText.slice(0, 120),
    url: i.contentUrl ?? i.tweetUrl,
    categoria: i.category ?? "",
    pestel: i.pestel.join("|"),
    fecha_like: iso(i.likedAt),
    vitalidad: round(i.vitality),
    tema: i.cluster?.name ?? "",
    tema_estado: i.cluster ? (i.cluster.status === "alive" ? "vivo" : "muerto") : "sin tema",
    horizonte: i.cluster?.horizon ?? "",
  }));
}

async function historial(tx: TenantTx) {
  const rows = await tx.graphSnapshotCluster.findMany({
    orderBy: [{ snapshot: { takenAt: "asc" } }, { vitality: "desc" }],
    select: {
      clusterId: true,
      name: true,
      size: true,
      status: true,
      vitality: true,
      velocity30d: true,
      density: true,
      connectivity: true,
      novelty: true,
      horizon: true,
      horizonSuggested: true,
      snapshot: { select: { takenAt: true, trigger: true } },
    },
  });
  return rows.map((r) => ({
    fecha: iso(r.snapshot.takenAt),
    disparador: r.snapshot.trigger,
    tema_id: r.clusterId,
    tema: r.name,
    estado: r.status === "alive" ? "vivo" : "muerto",
    senales: r.size,
    vitalidad: round(r.vitality),
    velocidad_30d: r.velocity30d,
    densidad: round(r.density),
    conectividad: round(r.connectivity),
    novedad: round(r.novelty),
    horizonte: r.horizon ?? "",
    horizonte_sugerido: r.horizonSuggested ?? "",
  }));
}

function round(n: number | null | undefined): string {
  return n === null || n === undefined ? "" : n.toFixed(3);
}

function iso(d: Date | null | undefined): string {
  return d ? d.toISOString() : "";
}

/** RFC 4180 con BOM para que Excel abra los acentos bien. */
function toCsv(rows: Record<string, string | number>[]): string {
  if (rows.length === 0) return "﻿";
  const headers = Object.keys(rows[0]);
  const escape = (v: string | number) => {
    const s = String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [headers.join(","), ...rows.map((r) => headers.map((h) => escape(r[h])).join(","))];
  return "﻿" + lines.join("\r\n") + "\r\n";
}
