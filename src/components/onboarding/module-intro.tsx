"use client";

import { useEffect, useRef } from "react";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import {
  LayoutGrid,
  Lightbulb,
  CircleHelp,
  Plug,
  Share2,
  Table2,
  Tags,
  Telescope,
  X,
  type LucideIcon,
} from "lucide-react";
import { MODULE_INTROS, type IconKey } from "@/lib/onboarding/config";
import { useOnboarding } from "./onboarding-context";

/**
 * El icono de cada módulo, para el panel de respaldo. Vive aquí y no en
 * config.ts para que config siga siendo datos puros importables desde el server
 * y desde los tests sin arrastrar React.
 */
const ICONS: Record<IconKey, LucideIcon> = {
  sistema: Plug,
  catalogo: LayoutGrid,
  categorias: Tags,
  analisis: Table2,
  grafo: Share2,
  horizontes: Telescope,
  guia: CircleHelp,
  nav: LayoutGrid,
};

/**
 * Lo que va donde iría la captura mientras las capturas no existen
 * (TODO(capturas) en config.ts): un módulo negro con el icono y la etiqueta en
 * mono. No es un placeholder gris de maqueta; es una pieza del sistema, así que
 * cuando llegue la captura real el modal no cambia de forma.
 */
export function PlaceholderPanel({ label, icon }: { label: string; icon: IconKey }) {
  const Icon = ICONS[icon];
  return (
    <div className="flex min-h-[180px] flex-col items-center justify-center gap-3 bg-brand-black px-6 py-10">
      <Icon className="h-7 w-7 text-brand-orange" strokeWidth={1.75} aria-hidden="true" />
      <p className="label-mono text-brand-white">{label}</p>
    </div>
  );
}

/**
 * Capa B de la fórmula: la primera vez que pisas la raíz exacta de un módulo,
 * un modal explica para qué sirve y a dónde ir.
 *
 * Tres candados, en este orden:
 *   1. nunca antes de terminar el tour (si no, se apilan dos modales);
 *   2. solo en la raíz exacta (`pathname === route`), para no tapar subpáginas;
 *   3. solo sin query params — el catálogo y el análisis usan la query para
 *      filtrar, y quien está filtrando ya no necesita la introducción.
 */
export function ModuleIntro() {
  const { ready, state, markIntroSeen } = useOnboarding();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  // Un solo ref para el CTA, sea <button> o <a>: solo se usa para enfocarlo.
  const ctaRef = useRef<HTMLElement | null>(null);

  const blocked = !ready || !state.tourDone || searchParams.toString() !== "";
  const found = blocked ? undefined : MODULE_INTROS.find((m) => pathname === m.route);
  const intro = found && !state.seenIntros.includes(found.key) ? found : undefined;
  const introKey = intro?.key;

  // Foco inicial en el CTA y cierre con Esc: el modal es lo único con lo que se
  // puede interactuar mientras está arriba, así que tiene que ser navegable.
  useEffect(() => {
    if (!introKey) return;
    ctaRef.current?.focus();
  }, [introKey]);

  useEffect(() => {
    if (!introKey) return;
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") markIntroSeen(introKey!);
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [introKey, markIntroSeen]);

  if (!intro) return null;

  const shortLabel = intro.title.replace(/^Paso \d+ · /, "");
  const ctaEsMismaPagina = intro.cta.href === intro.route;

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-brand-black/30 backdrop-blur-[6px]" aria-hidden="true" />

      <div
        role="dialog"
        aria-modal="true"
        aria-label={intro.title}
        className="relative max-h-[92vh] w-full max-w-[540px] overflow-y-auto border border-ink bg-surface-1 p-6"
      >
        <div className="mb-4 flex items-center justify-between gap-3">
          <h2 className="font-display text-[15px] font-semibold tracking-[-0.15px] text-ink">
            {intro.title}
          </h2>
          <button
            type="button"
            onClick={() => markIntroSeen(intro.key)}
            aria-label="Cerrar"
            className="p-1 text-ink-tertiary transition-colors duration-150 hover:text-brand-orange"
          >
            <X className="h-4 w-4" strokeWidth={1.75} />
          </button>
        </div>

        <div className="border border-hairline">
          {intro.screenshot ? (
            /* eslint-disable-next-line @next/next/no-img-element */
            <img
              src={intro.screenshot}
              alt={`Captura de ${shortLabel}`}
              className="block max-h-[260px] w-full object-cover object-top"
            />
          ) : (
            <PlaceholderPanel label={shortLabel} icon={intro.icon} />
          )}
        </div>

        <p className="mt-4 text-[13px] leading-relaxed text-ink-muted">{intro.description}</p>

        {intro.antes && (
          <div className="mt-3 flex gap-2.5 border border-hairline bg-surface-2 px-3.5 py-3">
            <Lightbulb
              className="mt-0.5 h-4 w-4 shrink-0 text-brand-orange"
              strokeWidth={1.75}
              aria-hidden="true"
            />
            <p className="text-[12px] leading-relaxed text-ink-muted">
              <span className="font-semibold text-ink">Antes de empezar: </span>
              {intro.antes}
            </p>
          </div>
        )}

        <div className="mt-5 flex gap-2.5">
          <button
            type="button"
            onClick={() => markIntroSeen(intro.key)}
            className="label-mono flex-1 border border-hairline bg-surface-1 py-2.5 text-ink-subtle transition-colors duration-150 hover:border-ink hover:text-ink"
          >
            Entendido
          </button>
          {ctaEsMismaPagina ? (
            // El CTA apunta a donde ya estamos: cerrar es toda la navegación
            // que hace falta, y un <a> al pathname actual no haría nada.
            <button
              type="button"
              ref={(node) => {
                ctaRef.current = node;
              }}
              onClick={() => markIntroSeen(intro.key)}
              className="label-mono flex-1 border border-ink bg-brand-black py-2.5 text-brand-white transition-colors duration-150 hover:border-brand-orange hover:bg-brand-orange"
            >
              {intro.cta.label}
            </button>
          ) : (
            <Link
              href={intro.cta.href}
              ref={(node) => {
                ctaRef.current = node;
              }}
              onClick={() => markIntroSeen(intro.key)}
              className="label-mono flex-1 border border-ink bg-brand-black py-2.5 text-center text-brand-white transition-colors duration-150 hover:border-brand-orange hover:bg-brand-orange"
            >
              {intro.cta.label}
            </Link>
          )}
        </div>
      </div>
    </div>
  );
}
