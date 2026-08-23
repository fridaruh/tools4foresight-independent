"use client";

import dynamic from "next/dynamic";
import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";

// force-graph pinta en canvas y toca window al importarse: solo en cliente.
const ForceGraph2D = dynamic(() => import("react-force-graph-2d"), { ssr: false });

export type GraphNode = {
  id: string;
  label: string;
  category: string | null;
  /** La idea principal de la señal (mismo TL;DR de la ficha). */
  tldr: string | null;
  /** Tema detectado por el job de clusters; null = señal sin tema (grupo chico o suelta). */
  clusterId: string | null;
  /** 0..1, decae con vida media de 30 dias salvo que lleguen vecinas nuevas
   *  (src/lib/jobs/graph.ts). null = el grafo aun no corrio desde que existe. */
  vitality: number | null;
  /** Fecha de publicación del contenido (no de cuándo se detectó). null = no se
   *  pudo extraer — esas señales se ven desde el primer paso de la línea de tiempo. */
  publishedAt: string | null;
};

export type GraphCluster = {
  id: string;
  name: string;
  summary: string;
  size: number;
  /** alive | dead — un tema muerto sigue en la leyenda, en gris y con una cruz. */
  status: string;
};

export type GraphPayload = {
  nodes: GraphNode[];
  links: { source: string; target: string; score: number }[];
  /** Ordenados por tamaño: el orden asigna la paleta de colores. */
  clusters: GraphCluster[];
  /** Publicadas que el job de embeddings todavia no proceso. */
  unembedded: number;
};

// Mismas familias de color que CATEGORY_MARKS en CategoryBadge.tsx, pero en hex:
// el canvas no entiende clases de Tailwind. Si alli cambia el mapa, cambia aqui.
const FAMILY_COLORS: Record<string, string> = {
  señal: "#ff4d00", // Signal Orange
  tecnología: "#8fb7d9", // Tech Blue
  humano: "#ff5c8a", // Human Pink
  negocio: "#0a0a0a", // System Black
  otros: "#bfbfbf", // Steel Grey
};

const CATEGORY_FAMILY: Record<string, string> = {
  "AI News": "señal",
  "AI Docs/Updates": "señal",
  "Developer Tools & Projects": "tecnología",
  "Crypto/Web3": "tecnología",
  "Personal & Pop-Culture": "humano",
  Movies: "humano",
  "Social Commentary": "humano",
  "Startup & Business": "negocio",
  "Community Events & Conferences": "negocio",
};

function familyOf(category: string | null): string {
  return (category && CATEGORY_FAMILY[category]) || "otros";
}

// Paleta de temas: arranca en los colores de marca y sigue con tonos que aguantan
// sobre blanco y se distinguen entre si. Se asigna por tamaño de tema (el mas
// grande recibe el primer color); si hay mas temas que colores, la paleta cicla.
const CLUSTER_PALETTE = [
  "#ff4d00", // Signal Orange
  "#2456d9",
  "#0f8b8d",
  "#ff5c8a", // Human Pink
  "#7c5cff",
  "#2f9e6e",
  "#d9a400",
  "#a0522d",
  "#e63946",
  "#5c7a99",
  "#8f2d56",
  "#4a4a45",
];
const NO_CLUSTER_COLOR = "#bfbfbf"; // Steel Grey, como la familia "otros"
const NO_CLUSTER_KEY = "__sin_tema__";

// Por debajo de esta vitalidad la señal es un fosil: se oculta por defecto y el
// toggle "mostrar fosiles" la trae de vuelta apagada. Nada se borra del grafo.
const FOSSIL_THRESHOLD = 0.15;

function vitalityOf(node: { vitality: number | null }): number {
  return node.vitality ?? 1;
}

/** '#rrggbb' + alpha 0..1 → '#rrggbbaa' (el canvas si entiende hex de 8 digitos). */
function withAlpha(hex: string, alpha: number): string {
  return hex + Math.round(alpha * 255).toString(16).padStart(2, "0");
}

/**
 * El grafo de enlaces semanticos entre señales publicadas. Nodo = señal, arista =
 * similitud coseno por encima del umbral del job, tamaño = numero de conexiones.
 * Dos modos de color: por tema (comunidades detectadas y bautizadas por el job de
 * clusters) o por familia de categoria. La leyenda filtra; pasar el cursor sobre un
 * nodo atenua todo lo que no esta conectado a el; clic abre un panel lateral con la
 * idea principal, sus señales mas parecidas y la explicacion de su tema.
 *
 * Decision de Frida (2026-08-19): la similitud numerica no se muestra en ningun
 * lado — la fuerza de una conexion se lee en el grosor de la arista y el orden de
 * "las mas parecidas", no en un porcentaje.
 */
export function SemanticGraph({ payload }: { payload: GraphPayload }) {
  const router = useRouter();
  const hasClusters = payload.clusters.length > 0;
  const [colorMode, setColorMode] = useState<"tema" | "categoria">(hasClusters ? "tema" : "categoria");
  const [hiddenFamilies, setHiddenFamilies] = useState<Set<string>>(new Set());
  const [hiddenClusters, setHiddenClusters] = useState<Set<string>>(new Set());
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showFossils, setShowFossils] = useState(false);
  const [themePanelOpen, setThemePanelOpen] = useState(true);
  const fossilCount = payload.nodes.filter((n) => vitalityOf(n) < FOSSIL_THRESHOLD).length;

  // Línea de tiempo por fecha de publicación (no por cuándo se detectó la señal):
  // el paso 0 muestra solo lo que no tiene fecha, y cada paso siguiente suma un
  // bloque de 3 años más — nunca quita lo que ya se veía. "Ver todas" ignora el
  // filtro por completo.
  const publishedYears = useMemo(
    () =>
      payload.nodes
        .map((n) => (n.publishedAt ? new Date(n.publishedAt).getFullYear() : null))
        .filter((y): y is number => y !== null),
    [payload],
  );
  const timelineCutoffs = useMemo(() => {
    if (publishedYears.length === 0) return [0];
    const minYear = Math.min(...publishedYears);
    const maxYear = Math.max(...publishedYears);
    const cutoffs = [minYear - 1];
    for (let y = minYear; y <= maxYear; y += 3) cutoffs.push(y + 2);
    return cutoffs;
  }, [publishedYears]);
  const [timelineIndex, setTimelineIndex] = useState(0);
  const [showAllDates, setShowAllDates] = useState(false);
  const undatedCount = payload.nodes.length - publishedYears.length;

  const nodeById = useMemo(() => new Map(payload.nodes.map((n) => [n.id, n])), [payload]);

  const clusterColor = useMemo(() => {
    const map = new Map<string, string>();
    payload.clusters.forEach((cluster, i) => {
      map.set(cluster.id, CLUSTER_PALETTE[i % CLUSTER_PALETTE.length]);
    });
    return map;
  }, [payload]);

  const clusterById = useMemo(
    () => new Map(payload.clusters.map((c) => [c.id, c])),
    [payload],
  );

  function colorOf(node: GraphNode): string {
    if (colorMode === "tema") {
      const cluster = node.clusterId ? clusterById.get(node.clusterId) : null;
      if (cluster?.status === "dead") return NO_CLUSTER_COLOR;
      return (node.clusterId && clusterColor.get(node.clusterId)) || NO_CLUSTER_COLOR;
    }
    return FAMILY_COLORS[familyOf(node.category)];
  }

  // Grado y vecinas por nodo, sobre el grafo completo (no el filtrado): el tamaño
  // de una señal y sus "mas parecidas" no deben cambiar al esconder una familia.
  const { degree, neighbors, topSimilar } = useMemo(() => {
    const deg = new Map<string, number>();
    const nbrs = new Map<string, Set<string>>();
    const scored = new Map<string, { id: string; score: number }[]>();
    for (const link of payload.links) {
      deg.set(link.source, (deg.get(link.source) ?? 0) + 1);
      deg.set(link.target, (deg.get(link.target) ?? 0) + 1);
      if (!nbrs.has(link.source)) nbrs.set(link.source, new Set());
      if (!nbrs.has(link.target)) nbrs.set(link.target, new Set());
      nbrs.get(link.source)!.add(link.target);
      nbrs.get(link.target)!.add(link.source);
      if (!scored.has(link.source)) scored.set(link.source, []);
      if (!scored.has(link.target)) scored.set(link.target, []);
      scored.get(link.source)!.push({ id: link.target, score: link.score });
      scored.get(link.target)!.push({ id: link.source, score: link.score });
    }
    const top = new Map<string, string[]>();
    for (const [id, list] of scored) {
      top.set(
        id,
        list
          .sort((a, b) => b.score - a.score)
          .slice(0, 3)
          .map((n) => n.id),
      );
    }
    return { degree: deg, neighbors: nbrs, topSimilar: top };
  }, [payload]);

  function isVisible(node: GraphNode): boolean {
    if (!showFossils && vitalityOf(node) < FOSSIL_THRESHOLD) return false;
    if (!showAllDates && node.publishedAt) {
      const year = new Date(node.publishedAt).getFullYear();
      if (year > timelineCutoffs[timelineIndex]) return false;
    }
    if (colorMode === "tema") return !hiddenClusters.has(node.clusterId ?? NO_CLUSTER_KEY);
    return !hiddenFamilies.has(familyOf(node.category));
  }

  const graphData = useMemo(() => {
    const visible = payload.nodes.filter(isVisible);
    const visibleIds = new Set(visible.map((node) => node.id));
    return {
      // Copias: force-graph muta los objetos (x, y, vx, vy) y React quiere props
      // inmutables; ademas los links referencian ids que la lib resuelve a nodos.
      nodes: visible.map((node) => ({ ...node })),
      links: payload.links
        .filter((link) => visibleIds.has(link.source) && visibleIds.has(link.target))
        .map((link) => ({ ...link })),
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [payload, hiddenFamilies, hiddenClusters, colorMode, showFossils, timelineIndex, showAllDates, timelineCutoffs]);

  // Si el nodo seleccionado desaparece del lienzo (filtro), el panel se cierra.
  // El setState en el efecto es necesario para sincronizar el panel cerrado con el filtro aplicado.
  // @see https://react.dev/learn/you-might-not-need-an-effect
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    if (!selectedId) return;

    const node = nodeById.get(selectedId);
    if (!node) {
      setSelectedId(null);
      return;
    }

    // Verificar si el nodo sigue visible con los filtros actuales
    if (!isVisible(node)) {
      setSelectedId(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId, nodeById, colorMode, hiddenClusters, hiddenFamilies, showFossils, timelineIndex, showAllDates]);
  /* eslint-enable react-hooks/set-state-in-effect */

  function toggleFamily(family: string) {
    setHiddenFamilies((prev) => {
      const next = new Set(prev);
      if (next.has(family)) next.delete(family);
      else next.add(family);
      return next;
    });
  }

  function toggleCluster(key: string) {
    setHiddenClusters((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  if (payload.nodes.length === 0) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-2 border border-hairline bg-surface-1 p-10 text-center">
        <p className="section-title text-ink">El grafo está vacío</p>
        <p className="max-w-md text-sm text-ink-subtle">
          {payload.unembedded > 0
            ? `Hay ${payload.unembedded} señales publicadas sin embeber. Corre el job de embeddings (con tu Ollama local arriba): POST /api/jobs/embed/run.`
            : "No hay señales publicadas todavía: el grafo se construye solo sobre lo publicado."}
        </p>
      </div>
    );
  }

  const hovered = hoveredId ? (nodeById.get(hoveredId) ?? null) : null;
  const selected = selectedId ? (nodeById.get(selectedId) ?? null) : null;
  const selectedCluster = selected?.clusterId ? (clusterById.get(selected.clusterId) ?? null) : null;

  const chipClass = (hidden: boolean) =>
    `label-mono flex items-center gap-1.5 border border-hairline px-2 py-1 text-[10px] uppercase tracking-[0.06em] transition-colors duration-150 ${
      hidden ? "text-ink-tertiary opacity-50" : "text-ink-muted"
    }`;

  return (
    <>
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="section-title text-ink">Grafo de señales</h1>
          <p className="mt-1 text-xs text-ink-subtle">
            {payload.nodes.length} señales publicadas · {payload.links.length} enlaces semánticos
            {hasClusters && <> · {payload.clusters.length} temas</>}
            {payload.unembedded > 0 && (
              <span className="text-brand-orange">
                {" "}
                · {payload.unembedded} publicadas sin embeber aún
              </span>
            )}
          </p>
        </div>
        <div className="flex flex-col items-end gap-2">
          <div className="flex items-center gap-2">
            {fossilCount > 0 && (
              <button
                type="button"
                onClick={() => setShowFossils((v) => !v)}
                aria-pressed={showFossils}
                title="Señales que perdieron vitalidad (vida media de 30 días sin señales nuevas cerca). No se borran: se apagan."
                className={`label-mono border border-hairline px-2.5 py-1 text-[10px] uppercase tracking-[0.06em] transition-colors duration-150 ${
                  showFossils ? "bg-ink text-canvas" : "text-ink-muted hover:text-ink"
                }`}
              >
                {showFossils ? "ocultar" : "mostrar"} fósiles · {fossilCount}
              </button>
            )}
          {hasClusters && (
            <div className="flex items-center gap-0 border border-hairline">
              {(
                [
                  ["tema", "Por tema"],
                  ["categoria", "Por categoría"],
                ] as const
              ).map(([mode, label]) => (
                <button
                  key={mode}
                  type="button"
                  onClick={() => setColorMode(mode)}
                  aria-pressed={colorMode === mode}
                  className={`label-mono px-2.5 py-1 text-[10px] uppercase tracking-[0.06em] transition-colors duration-150 ${
                    colorMode === mode ? "bg-ink text-canvas" : "text-ink-muted hover:text-ink"
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
          )}
          </div>
          {colorMode === "categoria" && (
            <div className="flex max-w-2xl flex-wrap items-center justify-end gap-2">
              {Object.entries(FAMILY_COLORS).map(([family, color]) => {
                const hidden = hiddenFamilies.has(family);
                return (
                  <button
                    key={family}
                    type="button"
                    onClick={() => toggleFamily(family)}
                    aria-pressed={!hidden}
                    className={chipClass(hidden)}
                  >
                    <span aria-hidden className="h-1.5 w-1.5 shrink-0" style={{ backgroundColor: color }} />
                    {family}
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </header>

      {timelineCutoffs.length > 1 && (
        <div className="flex flex-wrap items-center gap-3 border border-hairline bg-surface-1 px-3 py-2">
          <p className="label-mono text-[10px] uppercase tracking-[0.06em] text-ink-tertiary">
            Fecha de publicación
          </p>
          <input
            type="range"
            min={0}
            max={timelineCutoffs.length - 1}
            step={1}
            value={timelineIndex}
            disabled={showAllDates}
            onChange={(event) => setTimelineIndex(Number(event.target.value))}
            aria-label="Avanzar la línea de tiempo por bloques de 3 años"
            className="w-48 accent-ink disabled:opacity-40"
          />
          <span className="label-mono min-w-24 text-[10px] text-ink-subtle">
            {showAllDates
              ? "todas las fechas"
              : timelineIndex === 0
                ? `sin fecha (${undatedCount})`
                : `hasta ${timelineCutoffs[timelineIndex]}`}
          </span>
          <button
            type="button"
            onClick={() => setShowAllDates((v) => !v)}
            aria-pressed={showAllDates}
            className={`label-mono border border-hairline px-2.5 py-1 text-[10px] uppercase tracking-[0.06em] transition-colors duration-150 ${
              showAllDates ? "bg-ink text-canvas" : "text-ink-muted hover:text-ink"
            }`}
          >
            Ver todas
          </button>
          <span className="label-mono ml-auto text-[10px] text-ink-tertiary">
            {graphData.nodes.length} de {payload.nodes.length} visibles
          </span>
        </div>
      )}

      <div className="relative flex-1 overflow-hidden border border-hairline bg-surface-1">
        <GraphCanvas
          graphData={graphData}
          degree={degree}
          neighbors={neighbors}
          colorOf={(node) => colorOf(node)}
          activeId={hoveredId ?? selectedId}
          selectedId={selectedId}
          onHover={(node) => setHoveredId(node?.id ?? null)}
          onSelect={(node) => setSelectedId(node.id)}
          onBackgroundClick={() => setSelectedId(null)}
        />

        {/* Ficha rapida al pasar el cursor (el detalle completo se abre con clic). */}
        {hovered && hovered.id !== selectedId && (
          <div className="pointer-events-none absolute bottom-3 left-3 max-w-sm border border-hairline bg-canvas/95 p-3">
            <p className="label-mono mb-1 flex items-center gap-1.5 text-[10px] text-ink-tertiary">
              <span
                aria-hidden
                className="h-1.5 w-1.5 shrink-0"
                style={{ backgroundColor: colorOf(hovered) }}
              />
              {colorMode === "tema"
                ? ((hovered.clusterId && clusterById.get(hovered.clusterId)?.name) ?? "Sin tema")
                : (hovered.category ?? "Sin categorizar")}
            </p>
            <p className="text-sm leading-snug text-ink">{hovered.label}</p>
            {hovered.tldr && (
              <p className="mt-1.5 line-clamp-3 text-xs leading-snug text-ink-subtle">{hovered.tldr}</p>
            )}
            <p className="mt-1.5 text-[10px] text-ink-tertiary">Clic para ver el detalle</p>
          </div>
        )}

        {/* Panel de temas: solo en modo "por tema", alfabético y colapsable. */}
        {colorMode === "tema" && payload.clusters.length > 0 && (
          <div className="absolute left-3 top-3 z-10 flex max-h-[calc(100%-1.5rem)] w-56 flex-col border border-hairline bg-canvas/95">
            <button
              type="button"
              onClick={() => setThemePanelOpen((v) => !v)}
              aria-expanded={themePanelOpen}
              className="label-mono flex items-center justify-between gap-2 px-2.5 py-1.5 text-[10px] uppercase tracking-[0.06em] text-ink-muted hover:text-ink"
            >
              Temas · {payload.clusters.length}
              <span aria-hidden>{themePanelOpen ? "–" : "+"}</span>
            </button>
            {themePanelOpen && (
              <div className="flex flex-col gap-0.5 overflow-y-auto border-t border-hairline p-1.5">
                {[...payload.clusters]
                  .sort((a, b) => a.name.localeCompare(b.name))
                  .map((cluster) => {
                    const hidden = hiddenClusters.has(cluster.id);
                    return (
                      <button
                        key={cluster.id}
                        type="button"
                        onClick={() => toggleCluster(cluster.id)}
                        aria-pressed={!hidden}
                        title={
                          cluster.status === "dead"
                            ? `Tema muerto (sin señales nuevas). ${cluster.summary || ""}`.trim()
                            : cluster.summary || cluster.name
                        }
                        className={`label-mono flex items-center gap-1.5 px-1.5 py-1 text-left text-[10px] transition-colors duration-150 ${
                          hidden || cluster.status === "dead" ? "text-ink-tertiary opacity-50" : "text-ink-muted hover:text-ink"
                        }`}
                      >
                        <span
                          aria-hidden
                          className="h-1.5 w-1.5 shrink-0"
                          style={{ backgroundColor: cluster.status === "dead" ? NO_CLUSTER_COLOR : clusterColor.get(cluster.id) }}
                        />
                        <span className="truncate">
                          {cluster.status === "dead" && <span aria-hidden>† </span>}
                          {cluster.name}
                        </span>
                      </button>
                    );
                  })}
                <button
                  type="button"
                  onClick={() => toggleCluster(NO_CLUSTER_KEY)}
                  aria-pressed={!hiddenClusters.has(NO_CLUSTER_KEY)}
                  className={`label-mono flex items-center gap-1.5 px-1.5 py-1 text-left text-[10px] transition-colors duration-150 ${
                    hiddenClusters.has(NO_CLUSTER_KEY) ? "text-ink-tertiary opacity-50" : "text-ink-muted hover:text-ink"
                  }`}
                >
                  <span aria-hidden className="h-1.5 w-1.5 shrink-0" style={{ backgroundColor: NO_CLUSTER_COLOR }} />
                  sin tema
                </button>
              </div>
            )}
          </div>
        )}

        {/* Panel de detalle: idea principal, señales mas parecidas y el tema. */}
        {selected && (
          <aside className="absolute inset-y-0 right-0 flex w-80 max-w-[85%] flex-col overflow-y-auto border-l border-hairline bg-canvas/95 backdrop-blur-sm">
            <div className="flex items-start justify-between gap-2 border-b border-hairline p-3">
              <p className="label-mono flex items-center gap-1.5 pt-0.5 text-[10px] text-ink-tertiary">
                <span
                  aria-hidden
                  className="h-1.5 w-1.5 shrink-0"
                  style={{ backgroundColor: colorOf(selected) }}
                />
                {selected.category ?? "Sin categorizar"}
              </p>
              <button
                type="button"
                onClick={() => setSelectedId(null)}
                aria-label="Cerrar detalle"
                className="label-mono px-1 text-xs text-ink-tertiary transition-colors hover:text-ink"
              >
                ✕
              </button>
            </div>

            <div className="flex flex-col gap-4 p-3">
              <div>
                <p className="text-sm font-medium leading-snug text-ink">{selected.label}</p>
                {selected.tldr && (
                  <p className="mt-2 text-xs leading-relaxed text-ink-subtle">{selected.tldr}</p>
                )}
                <button
                  type="button"
                  onClick={() => router.push(`/senales/${selected.id}`)}
                  className="label-mono mt-2 border border-hairline px-2 py-1 text-[10px] uppercase tracking-[0.06em] text-ink-muted transition-colors hover:border-ink hover:text-ink"
                >
                  Abrir ficha completa →
                </button>
              </div>

              {(topSimilar.get(selected.id)?.length ?? 0) > 0 && (
                <div>
                  <p className="label-mono mb-1.5 text-[10px] uppercase tracking-[0.06em] text-ink-tertiary">
                    Señales más parecidas
                  </p>
                  <ul className="flex flex-col gap-1">
                    {topSimilar.get(selected.id)!.map((otherId) => {
                      const other = nodeById.get(otherId);
                      if (!other) return null;
                      return (
                        <li key={otherId}>
                          <button
                            type="button"
                            onClick={() => setSelectedId(otherId)}
                            className="w-full border border-hairline px-2 py-1.5 text-left text-xs leading-snug text-ink-muted transition-colors hover:border-ink hover:text-ink"
                          >
                            {other.label}
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                </div>
              )}

              <div>
                <p className="label-mono mb-1.5 text-[10px] uppercase tracking-[0.06em] text-ink-tertiary">
                  Tema
                </p>
                {selectedCluster ? (
                  <>
                    <p className="flex items-center gap-1.5 text-sm font-medium text-ink">
                      <span
                        aria-hidden
                        className="h-2 w-2 shrink-0"
                        style={{ backgroundColor: clusterColor.get(selectedCluster.id) }}
                      />
                      {selectedCluster.name}
                    </p>
                    {selectedCluster.summary && (
                      <p className="mt-1.5 text-xs leading-relaxed text-ink-subtle">
                        {selectedCluster.summary}
                      </p>
                    )}
                    <p className="label-mono mb-1.5 mt-3 text-[10px] uppercase tracking-[0.06em] text-ink-tertiary">
                      {selectedCluster.size} señales en este tema
                    </p>
                    <ul className="flex max-h-56 flex-col gap-0.5 overflow-y-auto">
                      {payload.nodes
                        .filter((n) => n.clusterId === selectedCluster.id)
                        .map((member) => (
                          <li key={member.id}>
                            <button
                              type="button"
                              onClick={() => setSelectedId(member.id)}
                              className={`w-full px-1.5 py-1 text-left text-xs leading-snug transition-colors hover:text-ink ${
                                member.id === selected.id ? "text-ink" : "text-ink-subtle"
                              }`}
                            >
                              {member.id === selected.id ? "▸ " : ""}
                              {member.label}
                            </button>
                          </li>
                        ))}
                    </ul>
                  </>
                ) : (
                  <p className="text-xs leading-relaxed text-ink-subtle">
                    Esta señal no cayó en ningún tema: está poco conectada con el resto del grafo.
                  </p>
                )}
              </div>
            </div>
          </aside>
        )}
      </div>
    </>
  );
}

type CanvasNode = GraphNode & { x?: number; y?: number };
type CanvasLink = {
  source: string | CanvasNode;
  target: string | CanvasNode;
  score: number;
};

function linkEndId(end: string | CanvasNode): string {
  return typeof end === "object" ? end.id : end;
}

function GraphCanvas({
  graphData,
  degree,
  neighbors,
  colorOf,
  activeId,
  selectedId,
  onHover,
  onSelect,
  onBackgroundClick,
}: {
  graphData: { nodes: CanvasNode[]; links: { source: string; target: string; score: number }[] };
  degree: Map<string, number>;
  neighbors: Map<string, Set<string>>;
  colorOf: (node: GraphNode) => string;
  /** Nodo cuyo vecindario se resalta (hover, o la seleccion si no hay hover). */
  activeId: string | null;
  selectedId: string | null;
  onHover: (node: GraphNode | null) => void;
  onSelect: (node: GraphNode) => void;
  onBackgroundClick: () => void;
}) {
  // La lib pide numeros, no CSS: sin esto el canvas mide window.innerWidth y se
  // sale del contenedor con borde. El observer sigue el resize del viewport.
  const wrapperRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);

  useEffect(() => {
    const wrapper = wrapperRef.current;
    if (!wrapper) return;
    const observer = new ResizeObserver(() => setWidth(wrapper.clientWidth));
    observer.observe(wrapper);
    return () => observer.disconnect();
  }, []);

  function isInNeighborhood(id: string): boolean {
    if (!activeId) return true;
    return id === activeId || (neighbors.get(activeId)?.has(id) ?? false);
  }

  return (
    <div ref={wrapperRef}>
      {width > 0 && (
        <ForceGraph2D
          graphData={graphData}
          backgroundColor="#ffffff"
          width={width}
          // Altura fija razonable: 640 llena una laptop sin scroll raro.
          height={640}
          nodeId="id"
          // Tamaño = conexiones, escalado por vitalidad: lo que se esta apagando
          // se achica ademas de desvanecerse.
          nodeVal={(node) => {
            const n = node as CanvasNode;
            return (2 + (degree.get(n.id) ?? 0)) * (0.35 + 0.65 * vitalityOf(n));
          }}
          // Con un nodo activo, todo lo que no es su vecindario se atenua: la
          // familia semantica de una señal se ve de un vistazo. La vitalidad
          // tambien va a la opacidad: una señal sin continuidad se va apagando.
          nodeColor={(node) => {
            const n = node as CanvasNode;
            const color = colorOf(n);
            const alpha = 0.25 + 0.75 * Math.min(1, vitalityOf(n));
            return isInNeighborhood(n.id) ? withAlpha(color, alpha) : withAlpha(color, 0.15);
          }}
          nodeLabel={() => ""}
          nodeCanvasObjectMode={() => "after"}
          nodeCanvasObject={(node, ctx, globalScale) => {
            const n = node as CanvasNode;
            if (n.x === undefined || n.y === undefined) return;
            const radius = 4 * Math.sqrt(2 + (degree.get(n.id) ?? 0));

            // Anillo naranja sobre la señal seleccionada, para no perderla.
            if (n.id === selectedId) {
              ctx.beginPath();
              ctx.arc(n.x, n.y, radius + 2 / globalScale, 0, 2 * Math.PI);
              ctx.strokeStyle = "#ff4d00";
              ctx.lineWidth = 2 / globalScale;
              ctx.stroke();
            }

            // Titulos directo en el lienzo al acercarse: primero los hubs, y con
            // mas zoom, todos. Asi el grafo se lee sin depender del hover.
            const isHub = (degree.get(n.id) ?? 0) >= 5;
            if (globalScale < 2.4 && !(isHub && globalScale >= 1.4)) return;
            if (!isInNeighborhood(n.id)) return;
            const label = n.label.length > 32 ? `${n.label.slice(0, 32)}…` : n.label;
            ctx.font = `${11 / globalScale}px Inter, sans-serif`;
            ctx.textAlign = "center";
            ctx.textBaseline = "top";
            ctx.fillStyle = "#3a3a38";
            ctx.fillText(label, n.x, n.y + radius + 3 / globalScale);
          }}
          linkColor={(link) => {
            const l = link as CanvasLink;
            if (!activeId) return "#dcdcd7";
            const touchesActive = linkEndId(l.source) === activeId || linkEndId(l.target) === activeId;
            return touchesActive ? "#b5b5b0" : "#dcdcd722";
          }}
          linkWidth={(link) => Math.max(0.5, ((link as { score: number }).score - 0.5) * 6)}
          onNodeHover={(node) => onHover((node as CanvasNode | null) ?? null)}
          onNodeClick={(node) => onSelect(node as CanvasNode)}
          onBackgroundClick={onBackgroundClick}
          cooldownTicks={200}
        />
      )}
    </div>
  );
}
