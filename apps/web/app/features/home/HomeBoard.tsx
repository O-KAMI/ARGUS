import { Link } from "react-router";
import type { FeedItemSummary, HotEntryView, HotResponse, MediaView, TimelineCard, TimelineResponse, TopicSummary, TopicsResponse } from "@aihot/contracts/site";
import { CATEGORY_LABELS } from "@aihot/contracts/taxonomy";
import { beijingDate, beijingEnglishDate } from "@aihot/contracts/time";
import { IntentLink } from "../../components/ui/IntentLink";
import { EmptyState } from "../../components/ui/Page";
import { SourceAvatar } from "../../components/ui/SourceAvatar";
import { IconBookmark, IconChart, IconChevronRight, IconFlame } from "../../components/icons";
import { INK, InkIcon, type InkIconName } from "../../components/ink";
import { Faces } from "../hot/Faces";
import { Sparkline } from "../hot/Sparkline";
import { OriginalLink, SourceLine, StarButton } from "../feed/parts";
import { relativeTime } from "../../lib/format";
import { dailyQuote } from "./daily-quote";
import { useUnreadOnly } from "../../lib/local-state";

function SectionTitle({ icon, title, href, linkLabel }: { icon: React.ReactNode; title: string; href: string; linkLabel: string }) {
  return (
    <div className="mb-3 flex items-center gap-2">
      <span className="text-ink-3">{icon}</span>
      <h2 className="font-serif text-[18px] font-semibold tracking-[0.04em] text-ink">{title}</h2>
      <Link to={href} className="ml-auto inline-flex items-center gap-1 text-[12px] text-ink-4 transition-colors hover:text-ink">
        {linkLabel} <span aria-hidden="true">→</span>
      </Link>
    </div>
  );
}

function dateParts() {
  const now = new Date();
  const day = beijingDate(now.getTime());
  const [year, month, date] = day.split("-");
  return { day, year, month, date, english: beijingEnglishDate(now) };
}

function DateCard() {
  const d = dateParts();
  const quote = dailyQuote(d.day);
  return (
    <section className="card relative overflow-hidden px-5 pb-4 pt-5" aria-labelledby="today-date">
      <time id="today-date" dateTime={d.day} className="block">
        <span className="font-serif text-[40px] font-normal leading-none tracking-[0.04em] text-ink"><span className="num">{d.month}</span><span className="mx-2 text-ink-4">/</span><span className="num">{d.date}</span></span>
        <span className="mt-3 block font-serif text-[13px] tracking-[0.14em] text-ink-3">{d.english}</span>
      </time>
      <div aria-hidden="true" className="relative mt-4 hidden h-[112px] overflow-hidden rounded-control lg:block">
        <img src={INK.dateCard} alt="" width={760} height={950} decoding="async" className="ink-photo size-full object-cover object-[center_62%]" />
        <img src={INK.sealGuan} alt="" width={22} height={23} decoding="async" className="ink-mono absolute right-1.5 top-1/2 w-[22px] -translate-y-1/2 object-contain" />
      </div>
      <div className="relative mt-3 border-t border-line-soft pt-4 lg:mt-2 lg:border-t-0 lg:pt-0">
        <span aria-hidden="true" className="absolute -top-1 left-0 font-serif text-[30px] leading-none text-line-strong">“</span>
        <h2 className="sr-only">今日名言</h2>
        <p className="line-clamp-4 min-h-[56px] pl-5 font-serif text-[14px] leading-[1.9] tracking-[0.04em] text-ink-2">{quote.text}</p>
        <p className="mt-2 text-right text-[11px] tracking-[0.08em] text-ink-4">—— {quote.source}</p>
      </div>
    </section>
  );
}

const TOPIC_ICONS: InkIconName[] = ["ai", "agent", "llm", "ui", "tools", "learn"];
const PREFERRED_TOPICS = ["AI 技术", "Agent", "LLM", "UI 设计", "开源工具", "学习资源"];

function TopicRail({ topics }: { topics: TopicSummary[] }) {
  const chosen: TopicSummary[] = [];
  for (const name of PREFERRED_TOPICS) {
    const match = topics.find((t) => t.name.toLowerCase() === name.toLowerCase() && !chosen.includes(t));
    if (match) chosen.push(match);
  }
  for (const topic of [...topics.filter((t) => t.group === "field"), ...topics.filter((t) => t.group === "genre"), ...topics]) {
    if (chosen.length >= 6) break;
    if (!chosen.includes(topic)) chosen.push(topic);
  }
  return (
    <nav className="card mt-4 p-4" aria-label="主题导航">
      <Link to="/topics" className="mb-2 flex items-center gap-2 px-1 text-ink">
        <InkIcon name="daily" size={17} /><span className="font-serif text-[17px] font-semibold">主题导航</span><IconChevronRight size={14} className="ml-auto text-ink-4" />
      </Link>
      <div className="space-y-0.5">
        {chosen.slice(0, 6).map((topic, index) => {
          const Icon = TOPIC_ICONS[index];
          return (
            <IntentLink key={topic.slug} to={`/topics/${topic.slug}`} className="group flex h-10 items-center gap-2.5 rounded-control border border-transparent px-2 text-[13px] text-ink-2 transition-colors hover:border-line-soft hover:bg-bg-sunk">
              <InkIcon name={TOPIC_ICONS[index]} size={17} className="opacity-80" /><span className="min-w-0 truncate">{topic.name}</span><IconChevronRight size={13} className="ml-auto text-ink-4 transition-transform group-hover:translate-x-0.5" />
            </IntentLink>
          );
        })}
      </div>
      <Link to="/topics" className="mt-2 block px-2 text-[12px] text-ink-4 hover:text-ink">全部主题 →</Link>
    </nav>
  );
}

function LeadHeat({ entry }: { entry: HotEntryView }) {
  const seen = entry.spark.filter((value): value is number => value !== null);
  return (
    <div className="flex aspect-[16/5] w-full flex-col rounded-control border border-line-soft bg-bg-sunk/60 px-4 py-3 sm:aspect-[32/9]">
      <div className="flex items-center justify-between text-[11px] text-ink-4">
        <span>近 24 小时跨源热度</span>
        <span>当前 <strong className="num font-semibold text-hot">{Math.round(entry.heat)}</strong></span>
      </div>
      {seen.length >= 3 ? <Sparkline values={entry.spark} className="mt-2 min-h-0 w-full flex-1" /> : <div className="grid flex-1 place-items-center font-serif text-[13px] tracking-[0.1em] text-ink-4">热度趋势正在积累</div>}
      <div className="flex justify-between text-[10px] text-ink-4"><span>24 小时前</span><span>现在</span></div>
    </div>
  );
}

function LeadHot({ entry }: { entry?: HotEntryView }) {
  return (
    <section aria-labelledby="home-hot-title">
      <div className="mb-3 flex items-center gap-2">
        <InkIcon name="hot" size={19} className="opacity-90" /><h2 id="home-hot-title" className="font-serif text-[18px] font-semibold tracking-[0.04em] text-ink">今日热点</h2>
        <Link to="/hot" className="ml-auto text-[12px] text-ink-4 hover:text-ink">查看更多 →</Link>
      </div>
      {entry ? (
        <article className="card card-hover group relative overflow-hidden p-4 sm:p-5">
          {entry.cover ? (
            <img src={entry.cover.url} srcSet={entry.cover.srcSet} sizes="(min-width: 1280px) 650px, (min-width: 961px) 48vw, calc(100vw - 64px)" width={entry.cover.width ?? undefined} height={entry.cover.height ?? undefined} alt="" loading="eager" fetchPriority="high" decoding="async" className="aspect-[16/5] w-full rounded-control bg-bg-sunk object-cover sm:aspect-[32/9]" />
          ) : <LeadHeat entry={entry} />}
          <h3 className="mt-4 line-clamp-2 font-serif text-[21px] font-semibold leading-[1.45] text-ink sm:text-[23px]">
            <IntentLink viewTransition to={`/story/${entry.story.publicId}`} className="after:absolute after:inset-0 after:content-[''] group-hover:text-accent">{entry.story.title}</IntentLink>
          </h3>
          <div className="relative z-10 mt-2 flex flex-wrap gap-1.5">
            <span className="rounded-mark bg-bg-sunk px-2 py-1 text-[11px] text-ink-3">跨源热点</span>
            {entry.sourceNames.slice(0, 2).map((name) => <span key={name} className="rounded-mark bg-bg-sunk px-2 py-1 text-[11px] text-ink-3">{name}</span>)}
          </div>
          {entry.summary && <p className="mt-3 line-clamp-2 text-[14px] leading-[1.75] text-ink-3">{entry.summary}</p>}
          <div className="relative z-10 mt-4 flex items-center gap-3 border-t border-line-soft pt-3">
            <Faces participants={entry.participants} total={entry.participantCount} size={24} interactive={false} />
            <span className="min-w-0 truncate text-[12px] text-ink-4">{entry.sourceCount} 个来源 · {entry.participantCount} 位参与者</span>
            <span className="ml-auto inline-flex shrink-0 items-center gap-1 text-[12px] text-hot"><IconFlame size={14} /><span className="num">{Math.round(entry.heat)}</span></span>
            <Link to={`/story/${entry.story.publicId}`} aria-label="查看事件与收藏报道" title="查看事件与收藏报道" className="grid size-8 place-items-center rounded-control text-ink-4 hover:bg-bg-sunk hover:text-accent"><IconBookmark size={17} /></Link>
          </div>
        </article>
      ) : <div className="card"><EmptyState title="今日暂无跨源热点">达到讨论门槛的事件会显示在这里。</EmptyState></div>}
    </section>
  );
}

function HotRanking({ entries }: { entries: HotEntryView[] }) {
  return (
    <section className="card flex h-full flex-col p-4" aria-labelledby="home-ranking-title">
      <SectionTitle icon={<IconChart size={18} />} title="热门榜单" href="/hot" linkLabel="完整榜单" />
      {entries.length ? (
        <ol className="divide-y divide-line-soft">
          {entries.slice(0, 5).map((entry) => {
            const face = entry.participants[0];
            return (
              <li key={entry.story.publicId}>
                <IntentLink to={`/story/${entry.story.publicId}`} className="group flex min-h-[66px] items-center gap-2.5 py-2">
                  <span className={`grid size-6 shrink-0 place-items-center rounded-mark text-[12px] font-semibold ${entry.rank === 1 ? "bg-rank-1 text-white" : entry.rank <= 3 ? "bg-bg-sunk text-rank-2" : "bg-bg-sunk text-ink-4"}`}>{entry.rank}</span>
                  <SourceAvatar name={face?.name ?? entry.story.title} iconUrl={face?.iconUrl} iconSrcSet={face?.iconSrcSet} size={26} />
                  <span className="min-w-0 flex-1 line-clamp-2 text-[13px] font-medium leading-[1.45] text-ink-2 group-hover:text-ink">{entry.story.title}</span>
                  <span className="inline-flex shrink-0 items-center gap-1 text-[12px] text-ink-4"><IconFlame size={13} className="text-hot" /><span className="num">{Math.round(entry.heat)}</span></span>
                </IntentLink>
              </li>
            );
          })}
        </ol>
      ) : <EmptyState title="榜单正在酝酿">有新的跨源讨论后会自动更新。</EmptyState>}
    </section>
  );
}

function cardCover(item: FeedItemSummary): MediaView | null {
  return (item.cover ?? item.x?.media[0]) ?? null;
}

function SelectedCard({ card }: { card: TimelineCard }) {
  const item = card.item;
  const cover = cardCover(item);
  return (
    <article className="group relative min-w-0 overflow-hidden rounded-card border border-line-soft bg-surface shadow-card transition-shadow duration-150 hover:shadow-card-hover">
      <div className="grid min-h-[164px] grid-cols-[39%_minmax(0,1fr)]">
        {cover ? (
          <img src={cover.poster ?? cover.url} srcSet={cover.srcSet} sizes="(min-width: 1280px) 130px, 30vw" width={cover.width ?? undefined} height={cover.height ?? undefined} alt={cover.alt ?? ""} loading="lazy" decoding="async" className="h-full min-h-[164px] w-full bg-bg-sunk object-cover" />
        ) : (
          <div className="grid min-h-[164px] place-items-center bg-bg-sunk p-3 text-center font-serif text-[12px] tracking-[0.1em] text-ink-4">ARGUS<br />精选</div>
        )}
        <div className="flex min-w-0 flex-col p-3">
          <div className="flex gap-1 overflow-hidden text-[12px] text-ink-4">
            {item.category && <span className="shrink-0 rounded-mark bg-bg-sunk px-1.5 py-0.5">{CATEGORY_LABELS[item.category]}</span>}
            {item.tags[0] && <span className="truncate rounded-mark bg-bg-sunk px-1.5 py-0.5">{item.tags[0]}</span>}
          </div>
          <h3 className="mt-2 line-clamp-2 font-serif text-[16px] font-semibold leading-[1.45] text-ink">
            <IntentLink viewTransition to={`/items/${item.id}`} className="after:absolute after:inset-0 after:content-[''] group-hover:text-accent">{item.title}</IntentLink>
          </h3>
          {item.summary && <p className="mt-1.5 line-clamp-2 text-[12px] leading-[1.65] text-ink-3">{item.summary}</p>}
          <div className="relative z-10 mt-auto flex items-end gap-1 pt-2 text-[12px] text-ink-4">
            <SourceLine item={item} className="max-w-[45%]" />
            {item.publishedAt && <span className="shrink-0">· {relativeTime(item.publishedAt)}</span>}
            <OriginalLink item={item} className="ml-auto size-7" />
            <StarButton item={item} className="size-7" />
          </div>
        </div>
      </div>
    </article>
  );
}

export function HomeBoard({ data, hot, topics }: { data: TimelineResponse; hot: HotResponse; topics: TopicsResponse }) {
  const unreadOnly = useUnreadOnly();
  const featured = data.cards.slice(0, 3);
  return (
    <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-[230px_minmax(0,1fr)_290px] xl:grid-cols-[240px_minmax(0,1fr)_310px]">
      <div className="min-w-0 lg:row-span-2">
        <DateCard />
        <div className="hidden lg:block"><TopicRail topics={topics.topics} /></div>
      </div>
      <div className="min-w-0"><LeadHot entry={hot.entries[0]} /></div>
      <div className="hidden min-w-0 lg:block"><HotRanking entries={hot.entries} /></div>
      {!unreadOnly && (
        <section className="min-w-0 lg:col-span-2 lg:col-start-2" aria-labelledby="home-selected-title">
          <div className="mb-3 flex items-center gap-2">
            <InkIcon name="daily" size={18} className="opacity-80" /><h2 id="home-selected-title" className="font-serif text-[18px] font-semibold tracking-[0.04em] text-ink">精选内容</h2>
            <Link to="/all" className="ml-auto text-[12px] text-ink-4 hover:text-ink">查看更多 →</Link>
          </div>
          {featured.length ? <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">{featured.map((card) => <SelectedCard key={card.key} card={card} />)}</div> : <div className="card"><EmptyState title="还没有精选内容">通过编辑筛选的报道会显示在这里。</EmptyState></div>}
        </section>
      )}
    </div>
  );
}
