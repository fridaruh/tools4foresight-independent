// La categoria se lee como un label tecnico, no como una pastilla de color.
//
// Antes eran nueve pasteles distintos, uno por categoria. DESIGN.md §4 lo prohibe de
// frente: "evitar grandes composiciones multicolor; una pieza deberia usar uno o dos
// colores de acento como maximo". Pero el color tambien hacia un trabajo real —
// distinguir categorias de un vistazo en una parrilla de 60 tarjetas.
//
// La salida es usar la jerarquia de color que la propia marca define (§4) en vez de
// una paleta inventada: el cuadrito que precede al texto agrupa por familia, y el
// nombre completo sigue ahi para desambiguar dentro de la familia.
//
//   Signal Orange -> señal: el tema central de la marca (IA)
//   Tech Blue     -> tecnologia y sistemas
//   Human Pink    -> dimension humana
//   System Black  -> negocio y estructura
//   Steel Grey    -> secundario / sin clasificar
const CATEGORY_MARKS: Record<string, string> = {
  "AI News": "bg-brand-orange",
  "AI Docs/Updates": "bg-brand-orange",
  "Developer Tools & Projects": "bg-brand-blue",
  "Crypto/Web3": "bg-brand-blue",
  "Personal & Pop-Culture": "bg-brand-pink",
  Movies: "bg-brand-pink",
  "Social Commentary": "bg-brand-pink",
  "Startup & Business": "bg-brand-black",
  "Community Events & Conferences": "bg-brand-black",
  Otros: "bg-brand-grey",
};

export function CategoryBadge({ category }: { category: string | null }) {
  const label = category ?? "Sin categorizar";
  const mark = category ? CATEGORY_MARKS[category] ?? CATEGORY_MARKS.Otros : "bg-brand-grey";

  return (
    // `nowrap` + tracking corto: en mono mayusculas, "Developer Tools & Projects" se
    // parte en tres lineas y descuadra la fila de la tarjeta.
    <span
      title={label}
      className="label-mono inline-flex min-w-0 max-w-full items-center gap-1.5 border border-hairline px-1.5 py-0.5 text-[10px] tracking-[0.06em] text-ink-muted"
    >
      <span aria-hidden className={`h-1.5 w-1.5 shrink-0 ${mark}`} />
      <span className="truncate whitespace-nowrap">{label}</span>
    </span>
  );
}
