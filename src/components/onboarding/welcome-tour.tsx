"use client";

import { useEffect, useRef, useState } from "react";
import { TOUR_STEPS } from "@/lib/onboarding/config";
import { useOnboarding } from "./onboarding-context";
import { PlaceholderPanel } from "./module-intro";

/**
 * Capa A de la fórmula: cuatro pasos, una sola vez en la vida de la cuenta.
 *
 * No hay botón "Atrás" a propósito. Un tour de cuatro pantallas que se puede
 * saltar entero no necesita navegación hacia atrás; lo que necesita es no
 * estorbar, y por eso "Saltar por ahora" está a la izquierda, lejos del pulgar
 * que va al CTA.
 */
export function WelcomeTour() {
  const { ready, state, completeTour } = useOnboarding();
  const [step, setStep] = useState(0);
  const ctaRef = useRef<HTMLButtonElement | null>(null);

  const visible = ready && !state.tourDone;

  // Foco en el CTA al abrir y al cambiar de paso: el tour se recorre con Enter.
  useEffect(() => {
    if (!visible) return;
    ctaRef.current?.focus();
  }, [visible, step]);

  // Esc = saltar. Es la salida que espera cualquiera que ya conozca la app.
  useEffect(() => {
    if (!visible) return;
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") completeTour();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [visible, completeTour]);

  if (!visible) return null;

  const current = TOUR_STEPS[step];
  const isLast = step === TOUR_STEPS.length - 1;

  function next() {
    if (isLast) completeTour();
    else setStep((s) => s + 1);
  }

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-brand-black/30 backdrop-blur-[6px]" aria-hidden="true" />

      <div
        role="dialog"
        aria-modal="true"
        aria-label={current.title}
        className="relative max-h-[92vh] w-full max-w-[540px] overflow-y-auto border border-ink bg-surface-1 p-6"
      >
        <h2 className="mb-4 font-display text-[15px] font-semibold tracking-[-0.15px] text-ink">
          {current.title}
        </h2>

        <div className="border border-hairline">
          {current.flow ? (
            <ol className="space-y-2.5 bg-brand-black px-6 py-6">
              {current.flow.map((paso, i) => (
                <li key={paso} className="flex items-center gap-3">
                  <span className="label-mono flex h-6 w-6 shrink-0 items-center justify-center bg-brand-orange text-brand-white">
                    {i + 1}
                  </span>
                  <span className="flex-1 text-[12.5px] leading-snug text-brand-white">{paso}</span>
                </li>
              ))}
            </ol>
          ) : current.image ? (
            /* eslint-disable-next-line @next/next/no-img-element */
            <img
              src={current.image}
              alt=""
              className="block max-h-[280px] w-full object-cover object-top"
            />
          ) : current.bubble ? (
            <div className="flex flex-col items-center gap-6 bg-brand-black px-6 py-8">
              <p className="border border-hairline bg-brand-white px-5 py-2.5 text-center font-display text-[15px] font-semibold tracking-[-0.15px] text-ink">
                {splitHighlight(current.bubble, current.bubbleHighlight)}
              </p>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src="/icon.png"
                alt="Individual"
                width={120}
                height={120}
                className="h-[120px] w-[120px] object-contain"
              />
            </div>
          ) : (
            <PlaceholderPanel label={current.imageLabel ?? current.title} icon={current.icon ?? "nav"} />
          )}
        </div>

        <p className="mt-4 text-[13px] leading-relaxed text-ink-muted">{current.description}</p>

        <div className="mt-5 flex items-center justify-between gap-3">
          <button
            type="button"
            onClick={completeTour}
            className="label-mono text-ink-tertiary transition-colors duration-150 hover:text-ink"
          >
            Saltar por ahora
          </button>

          <div className="flex items-center gap-1.5" aria-hidden="true">
            {TOUR_STEPS.map((s, i) => (
              <span
                key={s.title}
                className={`h-[6px] transition-all duration-200 ${
                  i === step ? "w-4 bg-brand-orange" : "w-[6px] bg-hairline-strong"
                }`}
              />
            ))}
          </div>

          <button
            type="button"
            ref={ctaRef}
            onClick={next}
            className="label-mono border border-ink bg-brand-black px-4 py-2.5 text-brand-white transition-colors duration-150 hover:border-brand-orange hover:bg-brand-orange"
          >
            {current.cta}
          </button>
        </div>
      </div>
    </div>
  );
}

/** Pinta `highlight` en Signal Orange dentro de `text`. */
function splitHighlight(text: string, highlight?: string) {
  if (!highlight || !text.includes(highlight)) return text;
  const [before, ...rest] = text.split(highlight);
  return (
    <>
      {before}
      <span className="text-brand-orange">{highlight}</span>
      {rest.join(highlight)}
    </>
  );
}
