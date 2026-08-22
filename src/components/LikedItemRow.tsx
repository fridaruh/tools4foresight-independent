import { authorLabel, isManualItem, type BoardItem } from "@/lib/board-item";
import { formatDate, likedAtTooltip, truncate } from "@/lib/format";
import { CategoryBadge } from "@/components/CategoryBadge";

export function LikedItemRow({ item, onOpen }: { item: BoardItem; onOpen: () => void }) {
  const title = item.contentTitle ?? truncate(item.tweetText, 160);
  const thumb = item.contentImageUrl ?? item.mediaUrls[0] ?? null;

  return (
    <button
      type="button"
      onClick={onOpen}
      className="group flex w-full items-center gap-4 rounded-lg border border-transparent px-3 py-3 text-left transition-colors duration-150 hover:border-hairline hover:bg-surface-1"
    >
      {thumb ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={thumb} alt="" className="h-12 w-12 shrink-0 rounded-md object-cover" loading="lazy" />
      ) : (
        <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-md bg-surface-2 text-ink-tertiary">
          <span className="label-mono text-[9px]">s/i</span>
        </div>
      )}

      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-ink">{title}</p>
        <p className="truncate text-xs text-ink-subtle">{authorLabel(item)}</p>
      </div>

      <CategoryBadge category={item.category} />
      {/* En movil la fecha aplasta el titulo; el dato completo sigue en el popup. */}
      <span
        className="hidden w-28 shrink-0 text-right text-xs text-ink-tertiary sm:block"
        title={likedAtTooltip(item.likedAt, item.likedAtSource)}
      >
        {isManualItem(item) ? "+ " : "♥ ~"}
        {formatDate(item.likedAt)}
      </span>
    </button>
  );
}
