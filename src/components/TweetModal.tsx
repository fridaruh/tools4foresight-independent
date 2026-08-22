"use client";

import { useEffect, useRef, useState } from "react";
import { authorLabel, isManualItem, type BoardItem } from "@/lib/board-item";
import { formatLongDate, likedAtTooltip } from "@/lib/format";
import { CategoryBadge } from "@/components/CategoryBadge";

/**
 * Texto que nunca se recorta (decision de Frida): el plegado solo esconde el excedente
 * visualmente y "Ver más" lo despliega. El texto completo siempre esta en el DOM.
 *
 * Si sobra o no se mide sobre el elemento ya renderizado en vez de estimarlo por
 * numero de caracteres: los dos textos que pasan por aqui tienen escalas muy distintas
 * (los tweets no llegan a 340 caracteres, las descripciones de articulos llegan a 2300)
 * y cualquier umbral fijo se equivoca en uno de los dos — o no aparece nunca, o aparece
 * un "Ver más" que no tiene nada que desplegar.
 */
function ExpandableText({ text, className }: { text: string; className: string }) {
  const [expanded, setExpanded] = useState(false);
  const [overflows, setOverflows] = useState(false);
  const textRef = useRef<HTMLParagraphElement>(null);

  useEffect(() => {
    const element = textRef.current;
    if (!element) return;
    // Se mide en estado plegado; una vez desplegado ya no hay nada que medir.
    if (!expanded) setOverflows(element.scrollHeight > element.clientHeight + 1);
  }, [text, expanded]);

  return (
    <div className="flex flex-col items-start gap-1">
      <p ref={textRef} className={`${className} ${expanded ? "" : "line-clamp-6"}`}>
        {text}
      </p>
      {(overflows || expanded) && (
        <button
          type="button"
          onClick={() => setExpanded((prev) => !prev)}
          className="text-xs font-medium text-ink-subtle underline-offset-2 hover:text-ink hover:underline"
        >
          {expanded ? "Ver menos" : "Ver más"}
        </button>
      )}
    </div>
  );
}

// Popup para leer completo el texto de un tweet: en la tarjeta se corta a 100
// caracteres, y al hacer click se abre aqui sin salir de la pantalla.
//
// tldr/impact/whyMatters como props le sirven a la tabla de enriquecimiento, que
// tiene un estado mas fresco que el item (ediciones sin recargar); sin prop se usa
// lo que trae el BoardItem, que es el caso del catalogo. onPrev/onNext prenden la
// navegacion anterior/siguiente (flechas laterales y ←/→ del teclado).
export function TweetModal({
  item,
  tldr,
  impact,
  whyMatters,
  favoriteButton,
  onClose,
  onPrev,
  onNext,
  hasPrev = false,
  hasNext = false,
}: {
  item: BoardItem;
  tldr?: string | null;
  impact?: string | null;
  whyMatters?: string | null;
  /** Corazón de favoritos (esquina superior derecha). Nadie lo pasa hoy — punto
      de extensión sin caller activo. */
  favoriteButton?: React.ReactNode;
  onClose: () => void;
  onPrev?: () => void;
  onNext?: () => void;
  hasPrev?: boolean;
  hasNext?: boolean;
}) {
  const closeRef = useRef<HTMLButtonElement>(null);

  const tldrText = tldr !== undefined ? tldr : item.tldr;
  const impactText = impact !== undefined ? impact : item.impact;
  const whyMattersText = whyMatters !== undefined ? whyMatters : item.whyMatters;

  useEffect(() => {
    closeRef.current?.focus();

    function handleKey(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
      if (event.key === "ArrowLeft" && onPrev) onPrev();
      if (event.key === "ArrowRight" && onNext) onNext();
    }
    document.addEventListener("keydown", handleKey);

    // Evita que el fondo siga haciendo scroll detras del modal.
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    return () => {
      document.removeEventListener("keydown", handleKey);
      document.body.style.overflow = previousOverflow;
    };
  }, [onClose, onPrev, onNext]);

  const image = item.contentImageUrl ?? item.mediaUrls[0] ?? null;
  const manual = isManualItem(item);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={manual ? `Enlace de ${item.authorHandle}` : `Tweet de @${item.authorHandle}`}
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink/25 p-4 backdrop-blur-sm"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      {onPrev && hasPrev && (
        <button
          type="button"
          onClick={onPrev}
          aria-label="Anterior (←)"
          title="Anterior (←)"
          className="absolute left-2 top-1/2 z-10 -translate-y-1/2 border border-ink bg-canvas p-2.5 text-ink transition-colors duration-150 hover:border-brand-orange hover:bg-brand-orange hover:text-brand-white max-sm:hidden sm:left-4"
        >
          <svg viewBox="0 0 16 16" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth={1.8}>
            <path d="M10 3 5 8l5 5" />
          </svg>
        </button>
      )}
      {onNext && hasNext && (
        <button
          type="button"
          onClick={onNext}
          aria-label="Siguiente (→)"
          title="Siguiente (→)"
          className="absolute right-2 top-1/2 z-10 -translate-y-1/2 border border-ink bg-canvas p-2.5 text-ink transition-colors duration-150 hover:border-brand-orange hover:bg-brand-orange hover:text-brand-white max-sm:hidden sm:right-4"
        >
          <svg viewBox="0 0 16 16" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth={1.8}>
            <path d="m6 3 5 5-5 5" />
          </svg>
        </button>
      )}
      <div className="max-h-[85vh] w-full max-w-xl overflow-y-auto border border-ink bg-canvas">
        <div className="flex items-start justify-between gap-4 border-b border-hairline px-5 py-4">
          <div className="min-w-0">
            <p className="truncate text-sm font-medium text-ink">
              {item.authorName ?? authorLabel(item)}
            </p>
            <p className="truncate text-xs text-ink-tertiary">
              {manual ? `${item.authorHandle} · agregado a mano` : `@${item.authorHandle}`}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            {favoriteButton}
            <button
              ref={closeRef}
              type="button"
              onClick={onClose}
              aria-label="Cerrar"
              className="shrink-0 rounded-md p-1.5 text-ink-subtle transition-colors duration-150 hover:bg-surface-2 hover:text-ink"
            >
              <svg viewBox="0 0 16 16" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth={1.5}>
                <path d="m4 4 8 8M12 4l-8 8" />
              </svg>
            </button>
          </div>
        </div>

        <div className="flex flex-col gap-4 px-5 py-4">
          {/* Orden pedido por Frida (2026-08-17): titulo → tweet → TL;DR → preview →
              por que importa → impacto. Las fechas bajan al pie, junto a la categoria. */}
          {item.contentTitle && (
            <a
              href={item.contentUrl ?? item.tweetUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-lg font-medium leading-snug text-ink underline-offset-2 hover:underline"
            >
              {item.contentTitle}
            </a>
          )}

          {/* En un enlace manual `tweetText` ES la URL (no hay tweet), asi que se
              muestra como enlace y no como cuerpo de texto. */}
          {manual ? (
            <a
              href={item.tweetUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="break-all text-sm text-ink-subtle underline-offset-2 hover:text-ink hover:underline"
            >
              {item.tweetUrl}
            </a>
          ) : (
            <ExpandableText
              text={item.tweetText}
              className="whitespace-pre-wrap text-[15px] leading-relaxed text-ink"
            />
          )}

          {tldrText && (
            <div className="border-t border-hairline pt-4">
              <p className="label-mono mb-1 text-ink-tertiary">TL;DR</p>
              <p className="whitespace-pre-wrap text-sm leading-relaxed text-ink">{tldrText}</p>
            </div>
          )}

          {image && (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={image} alt="" className="w-full rounded-lg border border-hairline object-cover" />
          )}

          {item.contentDescription && (
            <div className="flex flex-col gap-2 rounded-lg border border-hairline p-3">
              <ExpandableText
                text={item.contentDescription}
                className="whitespace-pre-wrap text-sm leading-relaxed text-ink-subtle"
              />
              {item.contentUrl && (
                <a
                  href={item.contentUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-xs font-medium text-ink-subtle underline-offset-2 hover:text-ink hover:underline"
                >
                  Leer el original ↗
                </a>
              )}
            </div>
          )}

          {(whyMattersText || impactText) && (
            <div className="flex flex-col gap-3 border-t border-hairline pt-4">
              {whyMattersText && (
                <div>
                  <p className="label-mono mb-1 text-ink-tertiary">¿Por qué importa?</p>
                  <p className="whitespace-pre-wrap text-sm leading-relaxed text-ink">{whyMattersText}</p>
                </div>
              )}
              {impactText && (
                <div>
                  <p className="label-mono mb-1 text-ink-tertiary">Impacto</p>
                  <p className="whitespace-pre-wrap text-sm leading-relaxed text-ink">{impactText}</p>
                </div>
              )}
            </div>
          )}

          <dl className="grid grid-cols-2 gap-x-4 gap-y-2 rounded-lg bg-surface-1 px-3 py-2.5 text-xs">
            <div>
              <dt className="text-ink-tertiary">{manual ? "Lo agregaste" : "Le diste like"}</dt>
              <dd className="text-ink" title={likedAtTooltip(item.likedAt, item.likedAtSource)}>
                {manual ? "" : "~"}
                {formatLongDate(item.likedAt)}
                {!manual && <span className="ml-1 text-ink-tertiary">(aprox.)</span>}
              </dd>
            </div>
            <div>
              <dt className="text-ink-tertiary">Se publicó</dt>
              <dd className="text-ink">
                {formatLongDate(item.contentPublishedAt ?? item.tweetCreatedAt)}
              </dd>
            </div>
          </dl>

          <div className="flex items-center justify-between gap-3 border-t border-hairline pt-4">
            <CategoryBadge category={item.category} />
            <a
              href={item.tweetUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-xs font-medium text-ink-subtle underline-offset-2 hover:text-ink hover:underline"
            >
              {manual ? "Abrir enlace ↗" : "Ver en X ↗"}
            </a>
          </div>

          {item.categoryReasoning && (
            <p className="text-[11px] leading-relaxed text-ink-tertiary">
              Categorizado automáticamente: {item.categoryReasoning}
            </p>
          )}
        </div>

        {/* En movil las flechas laterales flotarian encima del texto (no hay margen
            fuera de la tarjeta), asi que la navegacion baja a una barra pegada al
            fondo del popup. En sm+ se ocultan y vuelven las flechas laterales. */}
        {(onPrev || onNext) && (
          <div className="sticky bottom-0 grid grid-cols-2 border-t border-ink bg-canvas sm:hidden">
            <button
              type="button"
              onClick={onPrev}
              disabled={!hasPrev}
              className="label-mono border-r border-hairline px-4 py-3.5 text-left text-ink transition-colors duration-150 active:bg-surface-2 disabled:text-ink-tertiary"
            >
              ← Anterior
            </button>
            <button
              type="button"
              onClick={onNext}
              disabled={!hasNext}
              className="label-mono px-4 py-3.5 text-right text-ink transition-colors duration-150 active:bg-surface-2 disabled:text-ink-tertiary"
            >
              Siguiente →
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
