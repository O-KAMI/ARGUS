import { redirect, useLoaderData } from "react-router";
import type { Route } from "./+types/home";
import type { HotResponse, TimelineResponse, TopicsResponse } from "@aihot/contracts/site";
import { cachedPage, loadOr404 } from "../lib/api.server";
import { pageReuse } from "../lib/page-reuse";
import { filterLabels, filterParams, hasFeedFilters, itemListLd, listPath, pageMeta, readFilters, siteLd } from "../lib/seo";
import { inNav } from "../components/shell/nav";
import { useUnreadOnly } from "../lib/local-state";
import type { Screen } from "../components/shell/screens";
import { Timeline } from "../features/feed/Timeline";
import { HotTopics } from "../features/feed/HotTopics";
import { ActiveFilters, FeedBar, FilterMenus, SearchField } from "../features/feed/Filters";
import { InkHero } from "../features/home/InkHero";
import { INK } from "../components/ink";
import { HomeBoard } from "../features/home/HomeBoard";

export const handle: Screen = { tab: "featured", name: "精选" };
// The opening painting is the page's first paint; ask for it with the document.
export const links: Route.LinksFunction = () => [{ rel: "preload", as: "image", href: INK.heroWide, fetchPriority: "high" }];
export { pageHeaders as headers } from "../lib/api.server";
export const { clientLoader, shouldRevalidate } = pageReuse<typeof loader>();

export async function loader({ request }: Route.LoaderArgs) {
  const url = new URL(request.url);
  const q = url.searchParams.get("q");
  // Search lives on /all; keep the parameters so old links still land on results.
  if (q && q.trim()) throw redirect(`/all${url.search}`);
  const filters = readFilters(url.searchParams);
  const upstream = new Headers();
  const editorial = !hasFeedFilters(filters);
  const [data, hot, topics] = await Promise.all([
    // The board already carries the day's lead; a shorter first page keeps the document light.
    loadOr404<TimelineResponse>(listPath("/api/site/timeline", { ...filterParams(filters), ...(editorial ? { limit: 12 } : {}) }), { responseHeaders: upstream, signal: request.signal }),
    editorial ? loadOr404<HotResponse>("/api/site/hot", { signal: request.signal }) : Promise.resolve(null),
    editorial ? loadOr404<TopicsResponse>("/api/site/topics", { signal: request.signal }) : Promise.resolve(null),
  ]);
  return cachedPage(60, { data, hot, topics, filters }, upstream);
}

export function meta({ loaderData }: Route.MetaArgs) {
  const path = listPath("/", loaderData ? filterParams(loaderData.filters) : {});
  const titles = loaderData?.data.cards.map((c) => c.item.title) ?? [];
  return pageMeta({ path, noindex: hasFeedFilters(loaderData?.filters), jsonLd: path === "/" ? [...siteLd(), itemListLd("/", "精选", titles)] : undefined });
}

export default function Home() {
  const { data, hot, topics, filters } = useLoaderData<typeof loader>();
  const labels = filterLabels(filters);
  const title = labels.length ? labels.join(" · ") : "精选";
  const showHero = !hasFeedFilters(filters);
  // While 只看未读 is on the selected grid steps aside, and the timeline keeps its first three cards.
  const unreadOnly = useUnreadOnly();
  const featuredKeys = showHero && !unreadOnly ? new Set(data.cards.slice(0, 3).map((card) => card.key)) : undefined;
  return (
    <div className="pb-6">
      <FeedBar base="/" filters={filters} />
      <ActiveFilters base="/" filters={filters} />
      {showHero && hot && topics ? (
        <>
          <InkHero />
          <HomeBoard data={data} hot={hot} topics={topics} />
        </>
      ) : (
        <div className="hidden lg:block">
          <h1 className="mt-6 text-[24px] font-semibold leading-[1.3] text-ink">{title}</h1>
          <div className="mb-5 mt-4 flex flex-wrap items-center justify-between gap-3">
            <FilterMenus base="/" filters={filters} className="min-w-0" />
            <SearchField keep={filterParams(filters)} />
          </div>
        </div>
      )}
      {!showHero && data.hot && inNav("/hot") && <HotTopics entries={data.hot} />}
      <section aria-label="精选时间线" className={showHero ? "mt-8" : ""}>
        {showHero && <h2 className="mb-2 hidden font-serif text-[21px] font-semibold text-ink lg:block">最新时间线</h2>}
        <Timeline initial={data} filters={data.filters} featuredKeys={featuredKeys} />
      </section>
    </div>
  );
}
