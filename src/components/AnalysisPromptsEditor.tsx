"use client";

import { useState } from "react";

type PromptState = {
  /** Override guardado, o null si rige el default. */
  value: string | null;
  default: string;
};

type PromptProps = {
  promptKey: "tldr" | "impact" | "why_matters" | "foresight";
  title: string;
  description: string;
  initial: PromptState;
};

function PromptEditor({ promptKey, title, description, initial }: PromptProps) {
  const [savedValue, setSavedValue] = useState(initial.value);
  const [text, setText] = useState(initial.value ?? initial.default);
  const [saving, setSaving] = useState(false);
  const [flash, setFlash] = useState("");

  const custom = savedValue !== null;
  const dirty = text !== (savedValue ?? initial.default);

  async function put(value: string) {
    setSaving(true);
    setFlash("");
    try {
      const res = await fetch("/api/prompts", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: promptKey, value }),
      });
      if (!res.ok) throw new Error();
      const data = (await res.json()) as { value: string | null };
      setSavedValue(data.value);
      setText(data.value ?? initial.default);
      setFlash("Guardado");
    } catch {
      setFlash("No se pudo guardar");
    } finally {
      setSaving(false);
      setTimeout(() => setFlash(""), 3000);
    }
  }

  // Guardar un texto identico al original borra el override en vez de duplicarlo:
  // asi una mejora futura del prompt default le llega sola a quien no personalizo.
  const save = () => put(text === initial.default ? "" : text);
  const restore = () => put("");

  return (
    <div className="flex flex-col gap-2 rounded-xl border border-hairline bg-surface-1 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="label-mono text-ink-tertiary">{title}</p>
        <span className={`label-mono text-[10px] ${custom ? "text-brand-orange" : "text-ink-tertiary"}`}>
          {custom ? "personalizado" : "original"}
        </span>
      </div>
      <p className="text-xs text-ink-subtle">{description}</p>
      <textarea
        value={text}
        onChange={(event) => setText(event.target.value)}
        rows={12}
        spellCheck={false}
        className="w-full resize-y border border-hairline bg-canvas px-3 py-2 font-mono text-xs leading-relaxed text-ink outline-none focus:border-hairline-strong"
      />
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={save}
          disabled={saving || !dirty}
          className="label-mono border border-ink bg-ink px-3 py-1.5 text-brand-white transition-colors duration-150 hover:border-brand-orange hover:bg-brand-orange disabled:opacity-40"
        >
          {saving ? "Guardando…" : "Guardar"}
        </button>
        {(custom || dirty) && (
          <button
            type="button"
            onClick={restore}
            disabled={saving}
            className="text-xs text-ink-subtle underline-offset-2 hover:text-ink hover:underline disabled:opacity-40"
          >
            Restaurar el original
          </button>
        )}
        {flash && <span className="label-mono text-ink-subtle">{flash}</span>}
      </div>
    </div>
  );
}

export function AnalysisPromptsEditor({
  tldr,
  impact,
  whyMatters,
  foresight,
}: {
  tldr: PromptState;
  impact: PromptState;
  whyMatters: PromptState;
  foresight: PromptState;
}) {
  return (
    <div className="flex flex-col gap-4">
      <PromptEditor
        promptKey="tldr"
        title="System prompt · TL;DR"
        description="Las instrucciones para el resumen de ~100 palabras sobre lo que trata el tweet o artículo. Es la primera columna de la tabla de análisis."
        initial={tldr}
      />
      <PromptEditor
        promptKey="impact"
        title="System prompt · Impacto"
        description="Lo que el modelo recibe como instrucciones al escribir el análisis de impacto. La pregunta en sí (IA, política, geopolítica, autopercepción) va aparte y no cambia desde aquí."
        initial={impact}
      />
      <PromptEditor
        promptKey="why_matters"
        title="System prompt · ¿Por qué importa?"
        description="Las instrucciones para el «por qué importa», que se escribe partiendo del análisis de impacto ya generado."
        initial={whyMatters}
      />
      <PromptEditor
        promptKey="foresight"
        title="System prompt · Foresight"
        description="Las instrucciones del foresight, que se escribe con Claude a partir del TL;DR y del «por qué importa» ya generados. Solo se ve en la tabla de enriquecimiento, no en Señales."
        initial={foresight}
      />
    </div>
  );
}
