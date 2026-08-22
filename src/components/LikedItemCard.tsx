import { authorLabel, isManualItem, type BoardItem } from "@/lib/board-item";
import { formatDate, likedAtTooltip, truncate } from "@/lib/format";
import { CategoryBadge } from "@/components/CategoryBadge";

/** Cuanto texto del tweet se muestra en la tarjeta antes de mandar al popup. */
const TWEET_PREVIEW_CHARS = 100;

export function LikedItemCard({
  item,
  onOpen,
  favoriteButton,
}: {
  item: BoardItem;
  onOpen: () => void;
  /** Corazón de favoritos, esquina superior derecha. Nadie lo pasa hoy — punto
      de extensión sin caller activo. Va como hermano absoluto del boton de la
      tarjeta (un boton no puede anidar otro boton). */
  favoriteButton?: React.ReactNode;
}) {
  const image = item.contentImageUrl ?? item.mediaUrls[0] ?? null;
  // Tweet de puro texto: no hay link que previsualizar, asi que el contenido de la
  // tarjeta es el tweet mismo, cortado (el texto completo vive en el popup).
  const isTextOnly = !item.contentTitle;
  const title = item.contentTitle ?? truncate(item.tweetText, TWEET_PREVIEW_CHARS);

  return (
    <div className="relative flex">
      {favoriteButton && <div className="absolute right-2 top-2 z-10">{favoriteButton}</div>}
    <button
      type="button"
      onClick={onOpen}
      className="group flex w-full flex-col overflow-hidden border border-hairline bg-surface-1 text-left transition-colors duration-150 hover:border-ink"
    >
      {image ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={image}
          alt=""
          className="h-40 w-full object-cover transition-transform duration-300 group-hover:scale-[1.03]"
          loading="lazy"
        />
      ) : (
        <div className="flex h-40 w-full items-center justify-center bg-surface-2 text-ink-tertiary">
          <span className="label-mono">sin imagen</span>
        </div>
      )}

      <div className="flex flex-1 flex-col gap-2 p-4">
        <div className="flex items-center justify-between gap-2">
          <CategoryBadge category={item.category} />
          <span
            className="shrink-0 text-xs text-ink-tertiary"
            title={likedAtTooltip(item.likedAt, item.likedAtSource)}
          >
            {isManualItem(item) ? "+ " : "♥ ~"}
            {formatDate(item.likedAt)}
          </span>
        </div>

        <h3
          className={`leading-snug text-ink line-clamp-3 ${
            isTextOnly ? "text-sm font-normal" : "text-[15px] font-medium line-clamp-2"
          }`}
        >
          {title}
        </h3>

        {item.contentDescription && (
          <p className="text-sm leading-relaxed text-ink-subtle line-clamp-2">
            {truncate(item.contentDescription, 160)}
          </p>
        )}

        <div className="mt-auto flex items-center gap-1.5 pt-2 text-xs text-ink-tertiary">
          <span>{authorLabel(item)}</span>
          {isTextOnly && item.tweetText.length > TWEET_PREVIEW_CHARS && (
            <span className="text-ink-subtle">· leer completo</span>
          )}
          {item.fetchStatus === "failed" && (
            <span className="text-danger" title="No se pudo extraer el contenido de este link">
              · fetch fallido
            </span>
          )}
        </div>
      </div>
    </button>
    </div>
  );
}
