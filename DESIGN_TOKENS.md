# Design tokens — AI The New Sexy

La fuente de verdad de la marca es [`DESIGN.md`](./DESIGN.md). Este archivo solo
documenta **cómo se implementa** en esta app: qué token de `src/app/globals.css`
corresponde a qué regla de la marca, y las decisiones que hubo que tomar donde el
documento no llegaba al detalle de una interfaz.

Antes de este sistema la app usaba una paleta charcoal genérica y una fuente de display
distinta por pantalla. Las dos cosas se retiraron: la primera por la paleta de marca, la
segunda porque una identidad que se define como *sistemática y modular* no puede cambiar
de voz tipográfica cada vez que cambias de pestaña.

## Color

Los seis colores de marca viven como `--brand-*` y no se usan directamente en los
componentes; encima de ellos van los tokens semánticos, que sí.

| Marca (DESIGN.md §3) | Token | Valor | Dónde se usa en la app |
|---|---|---|---|
| Signal Orange | `--brand-orange` | `#ff4d00` | número de sección, foco, hover del botón principal, `status:`, categorías de IA |
| System Black | `--brand-black` / `--color-ink` | `#0a0a0a` | texto, bordes de módulo, botón principal, estado activo |
| Base White | `--brand-white` / `--color-canvas` | `#f7f7f5` | fondo de página. Nunca `#fff` puro de fondo |
| Steel Grey | `--brand-grey` / `--color-hairline-strong` | `#bfbfbf` | divisores, metadata secundaria, categoría "Otros" |
| Tech Blue | `--brand-blue` | `#8fb7d9` | categorías de herramientas y sistemas |
| Human Pink | `--brand-pink` | `#ff5c8a` | categorías de dimensión humana |

**La escalera de superficies va al revés que en un tema gris.** `canvas` es el blanco
cálido de la marca y `surface-1` es blanco puro, así que una card *sube* hacia el blanco
en vez de bajar hacia el gris:

```
canvas #f7f7f5 → surface-1 #ffffff → surface-2 #eeeeeb → surface-3 #e4e4e0 → surface-4 #d9d9d4
hairline #dcdcd7 · hairline-strong #bfbfbf · hairline-tertiary #0a0a0a (= negro, para el borde fuerte)
ink #0a0a0a · ink-muted #3a3a38 · ink-subtle #63635f · ink-tertiary #8a8a85
```

### Naranja con moderación

DESIGN.md §3 pide usar Signal Orange "con moderación", y una tabla de enriquecimiento
tiene 50 botones Guardar visibles a la vez. Por eso **el botón principal es negro, no
naranja**: el naranja entra en el hover, en el foco y en los indicadores de estado, que
es donde señala algo en vez de decorar.

Acciones que sí llevan el estilo principal (negro sólido, naranja al hover): sincronizar,
"Generar análisis" y "Agregar enlace". El resto es secundario: fondo blanco, borde
hairline, borde negro al hover.

## Tipografía

| Nivel (DESIGN.md §6) | Familia | Clase | Notas |
|---|---|---|---|
| 1 — Hero | Inter Tight Bold | `.section-title` | 36px, uppercase, tracking −1.2px |
| 2 — Section title | IBM Plex Mono Medium | `.section-title::before` | el `01 / CATÁLOGO` naranja arriba del `<h1>` |
| 3 — Supporting headline | Inter Tight Medium | `.section-heading` | 15px |
| 4 — Body | Inter Regular | (default de `body`) | prosa, celdas de tabla |
| 5 — Metadata | IBM Plex Mono | `.label-mono` | 11px, uppercase, tracking 0.1em |

**Suisse Intl no está.** La marca pide Suisse Intl para display; es de licencia comercial
y no está en Google Fonts. Se usa **Inter Tight** como sustituta: misma familia
neo-grotesca, anchos más cerrados que Inter, aguanta el Bold en tamaños grandes. Si se
compra la licencia, se cambia en `src/app/layout.tsx` y en `--font-display`.

`.label-mono` es la clase que más trabaja del sistema: encabezados de tabla, badges de
categoría, navegación, botones de acción, contadores y estados. Es lo que le da a la
interfaz el tono de documentación técnica en vez de SaaS.

## Identidad por sección

Cada pantalla lleva `data-section="..."` en su contenedor. Ahí se definen
`--section-index` y `--section-label`, y `.section-title::before` los imprime. Agregar
una pantalla es agregar el bloque en `globals.css` y la entrada en la lista de secciones
de `TopNav`; ninguna página repite ese markup.

Hay dos navegaciones según el rol (`TopNav` recibe el rol y elige la lista), así que la
numeración se reinicia entre ambas:

**Admin** (`ADMIN_SECTIONS`):

| Sección | Ruta | Índice | `data-section` |
|---|---|---|---|
| Catálogo | `/` | 01 | `likes` |
| Análisis | `/enrich` | 02 | `enrich` |
| Taxonomía | `/categorias` | 03 | `categorias` |
| Sistema | `/conexion` | 04 | `conexion` |
| Usuarios | `/usuarios` | 05 | `usuarios` |

**Member** (`MEMBER_SECTIONS`):

| Sección | Ruta | Índice | `data-section` |
|---|---|---|---|
| Categorías | `/categorias` | 01 | `explora` |
| Señales | `/senales` | 02 | `senales` |

En la esquina derecha de la nav van el botón de sincronizar (solo admin) y el círculo de
cuenta (`UserMenu`: inicial del nombre, borde negro que pasa a naranja en hover/abierto,
desplegable con "Mi perfil" y "Cerrar sesión"). Sin sesión de usuario se muestra el botón
de salir del gate legacy.

## Geometría

**Radio cero en toda la escala.** `--radius-xs` … `--radius-4xl` valen `0px` en el
`@theme`, así que cualquier `rounded-*` que ya exista o que se escriba después queda
recto sin tener que editarlo (DESIGN.md §10 y §24). Las pastillas de filtros y el toggle
de vista se volvieron rectangulares a mano, porque `rounded-full` no sale de esa escala.

**Sin sombras.** La jerarquía la dan el borde de 1px y la escalera de superficies. Los
elementos que flotan (modal, desplegable de PESTEL, panel de categorías) llevan borde
negro de 1px en vez de `shadow-xl`.

## Iconografía y estados

- Iconos lineales, `strokeWidth` 1.5–1.8, sin relleno. Nada de emojis en la UI
  (DESIGN.md §11): el banner de estado usa `status: error` en mono, no ⚠️.
- Estado del sistema: barra Signal Orange a la izquierda + label `status:` en mono.
- Foco: outline naranja de 2px con 1px de offset, global en `globals.css`.
- `.focus-frame` reproduce las esquinas abiertas de §13 para los estados vacíos.

## Badge de categoría

Diez categorías con diez pasteles distintos chocaba de frente con §4 ("una pieza debería
usar uno o dos colores de acento como máximo"), pero el color hacía un trabajo real:
distinguir de un vistazo en una parrilla de 60 tarjetas.

La salida fue usar la jerarquía de color que la propia marca define en §4 en lugar de una
paleta inventada. El badge es un label mono con borde hairline y un cuadrito de 6px que
agrupa por familia — naranja = señal/IA, azul = tecnología y sistemas, rosa = dimensión
humana, negro = negocio y estructura, gris = secundario. El nombre completo sigue ahí
para desambiguar dentro de la familia. Ver `src/components/CategoryBadge.tsx`.

## Logo y favicon

- `public/logo-aitns.png` — lockup completo recortado a su contenido, con el fondo blanco
  vuelto transparente para que se apoye sobre el Base White. Va en la barra superior.
- `src/app/icon.png`, `src/app/apple-icon.png`, `src/app/favicon.ico` — el símbolo **AI**
  solo, blanco sobre System Black. El lockup completo es ilegible a 16–32px; §7 lista el
  "brand mark independiente" y el "compact lockup" como variaciones válidas, y a ese
  tamaño el símbolo es lo único que se reconoce.

Si el logo cambia, hay que regenerar los cuatro archivos: el símbolo se recorta del
lockup y se recolorea a blanco sobre `#0a0a0a`.
