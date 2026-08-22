"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { Check, ChevronDown, CircleHelp, PartyPopper, X } from "lucide-react";
import { GUIDE_SECTIONS, MODULE_INTROS, type ModuleKey } from "@/lib/onboarding/config";
import { useOnboarding, useOnboardingOptional } from "./onboarding-context";

/**
 * Capa C de la fórmula: la checklist fija abajo a la derecha.
 *
 * Es el único elemento del onboarding que no es un modal, y el que hace el
 * trabajo real: dice qué sigue, cuánto falta y lleva a la pantalla exacta. El
 * acordeón sigue al primer pendiente por su cuenta, así que abrirla y cerrarla
 * no es parte del flujo — abrirla y ver el chip "Siguiente" sí.
 *
 * Solo en desktop (`hidden md:flex`): en un teléfono taparía media pantalla y
 * las tareas que propone se hacen mejor en grande.
 */
export function GuideWidget() {
  const {
    ready,
    state,
    progress,
    isTaskDone,
    isTaskVerified,
    toggleTask,
    markIntroSeen,
    resetIntro,
    closeGuide,
  } = useOnboarding();

  const firstPending = useMemo(
    () => GUIDE_SECTIONS.find((sec) => sec.tasks.some((t) => !isTaskDone(t.id)))?.key ?? null,
    [isTaskDone],
  );

  // '' = el usuario colapsó a mano; null = seguir al progreso.
  const [manualExpand, setManualExpand] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState(false);

  // Cuando el progreso avanza a otra sección, la guía vuelve a seguirlo sola.
  const [prevFirstPending, setPrevFirstPending] = useState(firstPending);
  if (prevFirstPending !== firstPending) {
    setPrevFirstPending(firstPending);
    setManualExpand(null);
  }

  if (!ready || !state.guideOpen) return null;

  const expandedKey = manualExpand === "" ? null : (manualExpand ?? firstPending);
  const completa = progress.total > 0 && progress.done === progress.total;

  return (
    <aside
      aria-label="Guía de configuración"
      // Ancla de scripts/onboarding-screenshots.ts: la captura tour-guia.png
      // recorta exactamente este nodo. No quitarlo al refactorizar el layout.
      data-onboarding="guide"
      className="fixed right-4 bottom-4 z-50 hidden w-[300px] flex-col border border-ink bg-surface-1 md:flex"
    >
      <div className="flex items-center gap-2 px-4 pt-3.5 pb-1">
        <p className="flex-1 font-display text-[13px] font-semibold tracking-[-0.13px] text-ink">
          Guía de configuración
        </p>
        <span className="label-mono text-ink-tertiary">
          <span className="text-ink">{progress.done}</span>/{progress.total}
        </span>
        <button
          type="button"
          onClick={() => setCollapsed((v) => !v)}
          aria-label={collapsed ? "Expandir guía" : "Minimizar guía"}
          className="p-0.5 text-ink-tertiary transition-colors duration-150 hover:text-brand-orange"
        >
          <ChevronDown
            className={`h-3.5 w-3.5 transition-transform duration-200 ${collapsed ? "rotate-180" : ""}`}
            strokeWidth={1.75}
          />
        </button>
        <button
          type="button"
          onClick={closeGuide}
          aria-label="Cerrar guía"
          className="p-0.5 text-ink-tertiary transition-colors duration-150 hover:text-brand-orange"
        >
          <X className="h-3.5 w-3.5" strokeWidth={1.75} />
        </button>
      </div>

      {!completa && (
        <p className="px-4 pb-2 text-[10.5px] text-ink-tertiary">
          El orden sigue el ciclo de vida de una señal
        </p>
      )}

      <div className="mx-4 h-[3px] bg-surface-3">
        <div
          className="h-full bg-brand-orange transition-all duration-300"
          style={{ width: `${progress.total ? (progress.done / progress.total) * 100 : 0}%` }}
        />
      </div>

      {!collapsed && completa && (
        <div className="flex flex-col items-center px-5 py-6 text-center">
          <span className="mb-3 flex h-10 w-10 items-center justify-center border border-ink bg-brand-orange">
            <PartyPopper className="h-5 w-5 text-brand-white" strokeWidth={1.75} />
          </span>
          <p className="mb-1 font-display text-[13px] font-semibold text-ink">¡Guía completada!</p>
          <p className="mb-4 text-[12px] leading-relaxed text-ink-subtle">
            Ya configuraste lo esencial de Tools 4 Foresight. Puedes volver a abrir esta guía cuando
            quieras desde el icono de ayuda.
          </p>
          <button
            type="button"
            onClick={closeGuide}
            className="label-mono w-full border border-ink bg-brand-black py-2 text-brand-white transition-colors duration-150 hover:border-brand-orange hover:bg-brand-orange"
          >
            Cerrar guía
          </button>
        </div>
      )}

      {!collapsed && !completa && (
        <div className="mt-2 max-h-[46vh] overflow-y-auto pb-2">
          {GUIDE_SECTIONS.map((sec) => {
            const allDone = sec.tasks.every((t) => isTaskDone(t.id));
            const isExpanded = expandedKey === sec.key;
            const esSiguiente = sec.key === firstPending;
            // El número sale del índice real en MODULE_INTROS para que coincida
            // con el "Paso N" del modal de cada módulo. Bienvenida no lleva.
            const moduleIndex = MODULE_INTROS.findIndex((m) => m.key === sec.key);
            const numero = moduleIndex >= 0 ? moduleIndex + 1 : null;

            return (
              <div key={sec.key} className="border-t border-hairline">
                <button
                  type="button"
                  onClick={() => setManualExpand(isExpanded ? "" : sec.key)}
                  aria-expanded={isExpanded}
                  className={`flex w-full items-center gap-2 px-4 py-2.5 text-left font-display text-[13px] font-medium tracking-[-0.13px] transition-colors duration-150 hover:bg-surface-2 ${
                    allDone ? "text-ink-tertiary line-through" : "text-ink"
                  }`}
                >
                  <span>
                    {numero !== null ? `${numero}. ` : ""}
                    {sec.title}
                  </span>
                  {esSiguiente && (
                    <span
                      className="label-mono bg-brand-orange px-1.5 py-0.5 text-brand-white no-underline"
                      style={{ fontSize: "9.5px" }}
                    >
                      Siguiente
                    </span>
                  )}
                  <span className="flex-1" />
                  <ChevronDown
                    className={`h-3.5 w-3.5 shrink-0 text-ink-tertiary transition-transform duration-200 ${
                      isExpanded ? "rotate-180" : ""
                    }`}
                    strokeWidth={1.75}
                  />
                </button>

                {isExpanded && (
                  <div className="space-y-1 px-4 pb-2.5">
                    {sec.tasks.map((task) => {
                      const done = isTaskDone(task.id);
                      const verified = isTaskVerified(task.id);
                      return (
                        <div key={task.id} className="flex items-center gap-2.5 py-1">
                          {verified ? (
                            // Verificada contra la base: no hay nada que marcar,
                            // solo que reportar. Un checkbox aquí sería mentira.
                            <span
                              className={`flex h-4 w-4 shrink-0 items-center justify-center border ${
                                done ? "border-ink bg-brand-black" : "border-hairline-strong"
                              }`}
                              title={
                                done ? "Verificado en tus datos" : "Se marca solo cuando lo hagas"
                              }
                              aria-hidden="true"
                            >
                              {done && <Check className="h-2.5 w-2.5 text-brand-white" strokeWidth={3} />}
                            </span>
                          ) : (
                            <button
                              type="button"
                              onClick={() => {
                                if (task.kind === "action") toggleTask(task.id);
                                if (task.kind === "intro" && task.module) {
                                  if (done) resetIntro(task.module as ModuleKey);
                                  else markIntroSeen(task.module as ModuleKey);
                                }
                              }}
                              aria-label={
                                done ? `${task.label} — completado` : `Marcar ${task.label}`
                              }
                              className={`flex h-4 w-4 shrink-0 items-center justify-center border transition-colors duration-150 ${
                                done
                                  ? "border-ink bg-brand-black"
                                  : "border-hairline-strong hover:border-brand-orange"
                              }`}
                            >
                              {done && <Check className="h-2.5 w-2.5 text-brand-white" strokeWidth={3} />}
                            </button>
                          )}

                          <span
                            className={`flex-1 text-[12px] leading-snug ${
                              done ? "text-ink-tertiary line-through" : "text-ink-muted"
                            }`}
                          >
                            {task.label}
                            {verified && (
                              <span className="sr-only">
                                {done ? " (verificado en tus datos)" : " (se verifica solo)"}
                              </span>
                            )}
                          </span>

                          {task.href && (
                            <Link
                              href={task.href}
                              onClick={() => {
                                // Reabre la introducción del módulo aunque ya se
                                // haya visto: "Ver" significa enséñamelo otra vez.
                                if (task.kind === "intro" && task.module) {
                                  resetIntro(task.module as ModuleKey);
                                }
                              }}
                              className="label-mono text-ink-tertiary transition-colors duration-150 hover:text-brand-orange"
                            >
                              Ver
                            </Link>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </aside>
  );
}

/**
 * El icono de ayuda de la barra superior: la única forma de recuperar la guía
 * después de cerrarla. Usa el hook opcional porque `TopNav` también se pinta en
 * la landing y en /login, donde no hay provider montado.
 */
export function GuideHelpButton() {
  const onboarding = useOnboardingOptional();
  if (!onboarding) return null;

  return (
    <button
      type="button"
      onClick={onboarding.openGuide}
      aria-label="Abrir guía de configuración"
      title="Guía de configuración"
      className="hidden h-8 w-8 items-center justify-center border border-hairline bg-surface-1 text-ink-subtle transition-colors duration-150 hover:border-brand-orange hover:text-brand-orange sm:h-9 sm:w-9 md:flex"
    >
      <CircleHelp className="h-4 w-4" strokeWidth={1.75} />
    </button>
  );
}
