import type { ReactNode } from "react";
import type { HotEntryView } from "@aihot/contracts/site";
import { IntentLink } from "../../components/ui/IntentLink";

/**
 * Where a hot-ranking entry opens. An entry this site computed from its own evidence has an event page and
 * no `link`; an entry it mirrors from another catalogue has no event page here, so `link` says where a
 * reader actually goes — this site's own report of the item, or the publisher's article in a new tab, or
 * nowhere at all when it has neither (contracts/site.ts `HotEntryLink`).
 */
function targetOf(e: HotEntryView): { to: string; external: boolean } | null {
  return e.link === undefined ? { to: `/story/${e.story.publicId}`, external: false } : e.link;
}

/** The address an entry opens, or null when it opens nothing (a mirrored entry with no page anywhere). */
export function entryHref(e: HotEntryView): string | null {
  return targetOf(e)?.to ?? null;
}

/** Is this entry one of this site's own events, with an event page and everything that hangs off it. */
export const isOwnStory = (e: HotEntryView): boolean => e.link === undefined;

/** The entry's link, or a plain span when it has none. `className` is the caller's own, stretch included. */
export function EntryLink({ e, className, children }: { e: HotEntryView; className?: string; children: ReactNode }) {
  const target = targetOf(e);
  if (!target) return <span className={className}>{children}</span>;
  if (target.external) {
    return (
      <a href={target.to} target="_blank" rel="noopener noreferrer" title="在新标签页打开原文" className={className}>
        {children}
      </a>
    );
  }
  return (
    <IntentLink viewTransition to={target.to} className={className}>
      {children}
    </IntentLink>
  );
}
