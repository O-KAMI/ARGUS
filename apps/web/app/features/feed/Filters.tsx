// Feed filters: content type, technical direction and source (a row of three menus on desktop, a sheet
// behind the bar's filter button on phones), the phone bar of 精选 and 全部, and search.
import { useEffect, useRef, useState } from "react";
import { Form, Link, useNavigate, useNavigation, useSearchParams } from "react-router";
import {
  CATEGORY_LABELS, CHANNEL_LABELS, FIELD_FILTERS, GENRE_FILTERS, PLATFORM_KEYS, PLATFORM_LABELS,
} from "@aihot/contracts/taxonomy";
import type { TimelineFilters } from "@aihot/contracts/site";
import { SITE } from "@aihot/site";
import { IconChevronDown, IconClose, IconFilter, IconSearch } from "../../components/icons";
import { PillTabs } from "../../components/ui/Tabs";
import { Sheet, ChoiceTick } from "../../components/ui/Sheet";
import { Wordmark } from "@aihot/site/brand/Logo.tsx";
import { BarButton, PhoneBar } from "../../components/shell/PhoneBar";
import { openSearch } from "../search/SearchOverlay";

/** Same page with some query parameters changed (paging state dropped). */
function hrefWith(base: string, params: URLSearchParams, patch: Record<string, string | null>) {
  const sp = new URLSearchParams(params);
  for (const [k, v] of Object.entries(patch)) {
    if (v === null || v === "") sp.delete(k);
    else sp.set(k, v);
  }
  sp.delete("page");
  sp.delete("cursor");
  const s = sp.toString();
  return s ? `${base}?${s}` : base;
}

function isFiltered(f: TimelineFilters): boolean {
  return f.channel !== "all" || !!f.category || !!f.tag || !!f.genre || !!f.field
    || (!!f.platform && f.platform !== "all");
}

/** The source menu is one choice: a platform, or the special 一手 quality filter. */
function sourceValue(f: TimelineFilters): string {
  return f.channel === "firstParty" ? "firstParty" : (f.platform ?? "all");
}

function FilterSelect({ label, value, options, onChange }: {
  label: string;
  value: string;
  options: Array<{ value: string; label: string }>;
  onChange: (value: string) => void;
}) {
  return (
    <span className="relative inline-flex items-center">
      <select
        aria-label={label}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="h-9 cursor-pointer appearance-none rounded-full bg-well pl-3.5 pr-8 text-[13px] font-medium text-ink-3 ring-1 ring-inset ring-line-soft outline-none transition-colors hover:text-ink focus:ring-accent"
      >
        {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
      <IconChevronDown size={13} className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-ink-4" />
    </span>
  );
}

/** Desktop: content type, technical direction and source, each one choice. */
export function FilterMenus({ base, filters, className = "" }: { base: string; filters: TimelineFilters; className?: string }) {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const go = (patch: Record<string, string | null>) => navigate(hrefWith(base, params, patch), { preventScrollReset: true });
  return (
    <div className={`flex flex-wrap items-center gap-2 ${className}`}>
      <FilterSelect
        label="内容类型"
        value={filters.genre ?? "all"}
        options={[{ value: "all", label: "内容类型 · 全部" }, ...GENRE_FILTERS.map((f) => ({ value: f.tag, label: f.label }))]}
        onChange={(v) => go({ genre: v === "all" ? null : v })}
      />
      <FilterSelect
        label="技术方向"
        value={filters.field ?? "all"}
        options={[{ value: "all", label: "技术方向 · 全部" }, ...FIELD_FILTERS.map((f) => ({ value: f.tag, label: f.label }))]}
        onChange={(v) => go({ field: v === "all" ? null : v })}
      />
      <FilterSelect
        label="来源"
        value={sourceValue(filters)}
        options={[
          { value: "all", label: "来源 · 全部" },
          ...PLATFORM_KEYS.filter((k) => k !== "all").map((k) => ({ value: k, label: PLATFORM_LABELS[k] })),
          { value: "firstParty", label: "一手（官方）" },
        ]}
        onChange={(v) => {
          if (v === "firstParty") go({ channel: "firstParty", platform: null });
          else go({ channel: null, platform: v === "all" ? null : v });
        }}
      />
      {isFiltered(filters) && (
        <button
          type="button"
          onClick={() => go({ category: null, channel: null, tag: null, genre: null, field: null, platform: null })}
          className="h-9 rounded-full px-2.5 text-[12.5px] text-ink-4 transition-colors hover:text-accent"
        >
          重置
        </button>
      )}
    </div>
  );
}

/**
 * The phone bar of 精选 and 全部: the brand, the 精选 | 全部 switch (a filter in use carries over), and
 * buttons for the filter sheet and search.
 */
export function FeedBar({ base, filters }: { base: "/" | "/all"; filters: TimelineFilters }) {
  const [params] = useSearchParams();
  const [sheet, setSheet] = useState(false);
  const scope = (to: string) => hrefWith(to, params, { q: null, tab: null, search: null });
  const filtered = isFiltered(filters);
  return (
    <>
      <PhoneBar
        leading={
          <Link to="/" aria-label={`${SITE.name} 首页`} className="flex h-11 items-center pl-2.5 pr-2 text-ink">
            <Wordmark size={17} />
          </Link>
        }
        center={
          <PillTabs
            size="sm"
            layoutId="feed-scope"
            label="看精选或全部"
            active={base === "/" ? "featured" : "all"}
            items={[
              { key: "featured", label: "精选", to: scope("/"), resetScroll: true, prefetchOnPress: true },
              { key: "all", label: "全部", to: scope("/all"), resetScroll: true, prefetchOnPress: true },
            ]}
          />
        }
        actions={
          <>
            <BarButton label={filtered ? "筛选（已选）" : "筛选"} on={filtered} onClick={() => setSheet(true)}>
              <IconFilter size={21} />
              {filtered && <span aria-hidden="true" className="absolute right-[9px] top-[9px] size-[7px] rounded-full bg-accent ring-2 ring-bg" />}
            </BarButton>
            <SearchButton />
          </>
        }
      />
      <FilterSheet open={sheet} onClose={() => setSheet(false)} base={base} filters={filters} />
    </>
  );
}

/** One group of choices in the phone sheet. */
function SheetGroup({ title, options, active, onPick }: {
  title: string;
  options: Array<{ value: string; label: string }>;
  active: string;
  onPick: (value: string) => void;
}) {
  return (
    <section className="mx-4 border-t border-line-soft py-3 first:border-t-0">
      <h3 className="mb-2 text-[12.5px] font-semibold text-ink-4">{title}</h3>
      <div className="flex flex-wrap gap-2">
        {options.map((o) => {
          const on = o.value === active;
          return (
            <Link
              key={o.value}
              to="#"
              onClick={(event) => {
                event.preventDefault();
                onPick(o.value);
              }}
              aria-current={on ? "true" : undefined}
              className={`inline-flex min-h-9 items-center gap-1 rounded-full px-3 text-[13px] ring-1 ring-inset transition-colors active:opacity-60 ${
                on ? "bg-accent-soft font-semibold text-accent ring-accent/20" : "bg-well text-ink-2 ring-line-soft"
              }`}
            >
              {o.label}
              {on && <ChoiceTick />}
            </Link>
          );
        })}
      </div>
    </section>
  );
}

/** Phones: the three filters as one scrollable sheet; choosing one applies it and closes. */
function FilterSheet({ open, onClose, base, filters }: { open: boolean; onClose: () => void; base: string; filters: TimelineFilters }) {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const pick = (patch: Record<string, string | null>) => {
    onClose();
    navigate(hrefWith(base, params, patch), { preventScrollReset: true });
  };
  return (
    <Sheet open={open} onClose={onClose} title="筛选">
      <SheetGroup
        title="内容类型"
        active={filters.genre ?? "all"}
        options={[{ value: "all", label: "不限" }, ...GENRE_FILTERS.map((f) => ({ value: f.tag, label: f.label }))]}
        onPick={(v) => pick({ genre: v === "all" ? null : v })}
      />
      <SheetGroup
        title="技术方向"
        active={filters.field ?? "all"}
        options={[{ value: "all", label: "不限" }, ...FIELD_FILTERS.map((f) => ({ value: f.tag, label: f.label }))]}
        onPick={(v) => pick({ field: v === "all" ? null : v })}
      />
      <SheetGroup
        title="来源"
        active={sourceValue(filters)}
        options={[
          { value: "all", label: "不限" },
          ...PLATFORM_KEYS.filter((k) => k !== "all").map((k) => ({ value: k, label: PLATFORM_LABELS[k] })),
          { value: "firstParty", label: "一手（官方）" },
        ]}
        onPick={(v) => {
          if (v === "firstParty") pick({ channel: "firstParty", platform: null });
          else pick({ channel: null, platform: v === "all" ? null : v });
        }}
      />
      {isFiltered(filters) && (
        <div className="mx-4 pb-2 pt-1">
          <button
            type="button"
            onClick={() => pick({ category: null, channel: null, tag: null, genre: null, field: null, platform: null })}
            className="h-11 w-full rounded-full bg-bg-sunk text-[13px] font-medium text-ink-3 transition-colors active:opacity-60"
          >
            清除全部筛选
          </button>
        </div>
      )}
    </Sheet>
  );
}

/** Phones: the filters and tag in use as chips under the bar; each one clears itself when tapped. */
export function ActiveFilters({ base, filters }: { base: string; filters: TimelineFilters }) {
  const [params] = useSearchParams();
  const chip = "inline-flex min-h-11 max-w-full items-center gap-1 rounded-full bg-accent-soft pl-3 pr-2 text-[13px] font-medium text-accent transition-opacity active:opacity-60";
  const genre = GENRE_FILTERS.find((f) => f.tag === filters.genre)?.label;
  const field = FIELD_FILTERS.find((f) => f.tag === filters.field)?.label;
  const platform = filters.platform && filters.platform !== "all" ? PLATFORM_LABELS[filters.platform] : null;
  const category = filters.category ? CATEGORY_LABELS[filters.category] : null;
  const channel = filters.channel === "firstParty" ? CHANNEL_LABELS.firstParty : null;
  const chips = [
    { key: "genre", label: genre, patch: { genre: null } as Record<string, string | null> },
    { key: "field", label: field, patch: { field: null } as Record<string, string | null> },
    { key: "source", label: platform ?? channel, patch: (channel ? { channel: null } : { platform: null }) as Record<string, string | null> },
    { key: "category", label: category, patch: { category: null } as Record<string, string | null> },
    { key: "tag", label: filters.tag ? `#${filters.tag}` : null, patch: { tag: null } as Record<string, string | null> },
  ].filter((c) => !!c.label);
  if (chips.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-2 pb-3 pt-1 lg:hidden">
      {chips.map((c) => (
        <Link key={c.key} to={hrefWith(base, params, c.patch)} aria-label={`取消筛选：${c.label}`} className={chip}>
          <span className="truncate">{c.label}</span>
          <IconClose size={14} strokeWidth={2} className="shrink-0" />
        </Link>
      ))}
    </div>
  );
}

/** Phones: the magnifier in a bar; the search opens over the page with the keyboard up. */
function SearchButton() {
  return (
    <BarButton label="搜索" onClick={(event) => openSearch("", event.currentTarget)}>
      <IconSearch size={21} />
    </BarButton>
  );
}

function useSlashFocus(ref: React.RefObject<HTMLInputElement | null>) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "/" && !(e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || (e.target as HTMLElement)?.isContentEditable)) {
        e.preventDefault();
        ref.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [ref]);
}

/** Desktop search field (GET /all?q=…): at the end of the filter row as the same grey track, at the height of md tabs, with a "/" hint. */
export function SearchField({ defaultValue = "", keep = {} }: { defaultValue?: string; keep?: Record<string, string | null> }) {
  const [value, setValue] = useState(defaultValue);
  const navigation = useNavigation();
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => setValue(defaultValue), [defaultValue]);
  useSlashFocus(inputRef);
  const searching = navigation.state === "loading" && navigation.location?.pathname === "/all" && !!new URLSearchParams(navigation.location.search).get("q");
  const hidden = Object.entries(keep).map(([k, v]) => (v ? <input key={k} type="hidden" name={k} value={v} /> : null));

  return (
    <Form method="get" action="/all" role="search" className="group relative w-full shrink-0 lg:w-60">
      {hidden}
      <label htmlFor="site-search" className="sr-only">
        搜索标题、摘要与正文
      </label>
      <IconSearch size={16} className={`pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 transition-colors ${searching ? "text-accent" : "text-ink-4 group-focus-within:text-ink-3"}`} />
      <input
        ref={inputRef}
        id="site-search"
        name="q"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder="搜索标题、摘要…"
        maxLength={200}
        autoComplete="off"
        className="h-[42px] w-full rounded-full bg-well pl-10 pr-10 text-[14px] text-ink outline-none ring-1 ring-inset ring-line-soft transition-[background-color,box-shadow] placeholder:text-ink-4 hover:ring-line-strong focus:bg-surface focus:shadow-[0_0_0_3px_var(--accent-soft)] focus:ring-accent"
      />
      {value ? (
        <button
          type="button"
          aria-label="清空"
          onClick={() => {
            setValue("");
            inputRef.current?.focus();
          }}
          className="absolute right-3 top-1/2 grid size-6 -translate-y-1/2 place-items-center rounded-full text-ink-4 transition-colors hover:bg-bg-sunk hover:text-ink"
        >
          <IconClose size={13} />
        </button>
      ) : (
        <kbd className="mono pointer-events-none absolute right-4 top-1/2 hidden -translate-y-1/2 rounded-mark border border-line-strong bg-surface px-1.5 text-[10.5px] leading-4 text-ink-4 lg:block">/</kbd>
      )}
    </Form>
  );
}
