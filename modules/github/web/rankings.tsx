// GitHub 开源趋势: the four boards, one tab each (方案 9 节). Filters are all a reader may change — the
// weekly boards keep GitHub's own order and the star boards keep stars descending, so the page never offers
// a sort control that could break either. Styling is the site's own tokens (app.css), nothing hard-coded.
import { Link, useLoaderData, useNavigate, useNavigation, useSearchParams } from "react-router";
import { beijingTime } from "@aihot/contracts/time";
import { cachedPage, loadOr404, pageHeaders } from "@aihot/web/lib/api.server";
import { pageMeta } from "@aihot/web/lib/seo";
import { PillTabs } from "@aihot/web/components/ui/Tabs";
import { EmptyState } from "@aihot/web/components/ui/Page";
import { IconExternal, IconGithub, IconSearch } from "@aihot/web/components/icons";
import type { Screen } from "@aihot/web/components/shell/screens";
import { AI_CATEGORIES, AI_CATEGORY_LABELS, BOARD_COPY, BOARDS, PAGE_SIZES, type AiCategory, type RankingRepository, type RankingResponse } from "../contract";

// The back bar and the breadcrumb say the name the reader tapped, not a third one of our own (AGENTS.md).
export const handle: Screen = { tab: "me", name: "GitHub 开源榜单" };
export { pageHeaders as headers };

const QUERY_KEYS = ["board", "page", "pageSize", "language", "category", "keyword"] as const;

export async function loader({ request }: { request: Request }) {
  const url = new URL(request.url);
  const params = new URLSearchParams();
  for (const key of QUERY_KEYS) {
    const value = url.searchParams.get(key)?.trim();
    if (value) params.set(key, key === "keyword" ? value.slice(0, 100) : value.slice(0, 60));
  }
  if (!params.get("board")) params.set("board", "all_weekly");
  const data = await loadOr404<RankingResponse>(`/api/github/rankings?${params}`, { signal: request.signal });
  return cachedPage(60, { data });
}

interface LoaderData { data: RankingResponse; expiresAt: number }

export function meta({ data }: { data?: LoaderData }) {
  const board = data?.data.board ?? "all_weekly";
  const copy = BOARD_COPY[board];
  return pageMeta({
    title: `${copy.label} · GitHub 开源趋势`,
    description: `${copy.basis} 发现值得关注的开源项目。`,
    path: board === "all_weekly" ? "/github" : `/github?board=${board}`,
    noindex: board !== "all_weekly",
  });
}

const stars = (count: number) => count.toLocaleString("en-US");

function RepoRow({ item, weekly, ai }: { item: RankingRepository; weekly: boolean; ai: boolean }) {
  return (
    <li className="flex gap-3 border-b border-line-soft px-4 py-3 last:border-b-0 lg:px-5">
      <div className="w-12 shrink-0 text-right">
        <div className="num text-[15px] font-semibold leading-[1.4] text-ink-2">{item.rank}</div>
        {/* The AI weekly board shows its own number beside GitHub's position (方案 9.4). */}
        {weekly && ai && item.sourceRank !== null && item.sourceRank !== item.rank && (
          <div className="num mt-0.5 text-[11px] text-ink-4">全站 #{item.sourceRank}</div>
        )}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
          <a
            href={item.htmlUrl}
            target="_blank"
            rel="noreferrer noopener"
            className="min-w-0 truncate text-[15px] font-medium text-ink hover:text-accent hover:underline"
          >
            <span className="text-ink-4">{item.ownerLogin} / </span>
            {item.name}
          </a>
          <IconExternal size={12} className="shrink-0 self-center text-ink-4" />
          {item.isArchived && <span className="rounded-mark bg-bg-muted px-1.5 py-0.5 text-[11px] text-ink-3">已归档</span>}
        </div>
        {item.description && <p className="mt-1 line-clamp-2 text-[13px] leading-[1.6] text-ink-3">{item.description}</p>}
        <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-ink-4">
          <span className="num">★ {stars(item.stargazersCount)}</span>
          {item.forksCount !== null && <span className="num">Fork {stars(item.forksCount)}</span>}
          {item.language && <span>{item.language}</span>}
          {item.updatedAt && <span>更新于 {beijingTime(item.updatedAt)}</span>}
          {ai && item.aiPrimaryCategory && (
            <span className="rounded-mark bg-accent-soft px-1.5 py-0.5 text-[11px] text-accent-ink">{AI_CATEGORY_LABELS[item.aiPrimaryCategory]}</span>
          )}
        </div>
        {item.topics.length > 0 && (
          <div className="mt-1.5 flex flex-wrap gap-1">
            {item.topics.slice(0, 6).map((topic) => (
              <span key={topic} className="rounded-full bg-well px-2 py-0.5 text-[11px] text-ink-3">{topic}</span>
            ))}
          </div>
        )}
      </div>
    </li>
  );
}

export default function GithubRankingsPage() {
  const { data } = useLoaderData() as LoaderData;
  const [params] = useSearchParams();
  const navigation = useNavigation();
  const navigate = useNavigate();
  const copy = BOARD_COPY[data.board];
  const ai = data.board === "ai_weekly" || data.board === "ai_stars";
  const busy = navigation.state === "loading";

  const withParams = (changes: Record<string, string | null>, resetPage = true) => {
    const sp = new URLSearchParams(params);
    for (const [key, value] of Object.entries(changes)) {
      if (value === null) sp.delete(key);
      else sp.set(key, value);
    }
    if (resetPage) sp.delete("page");
    const search = sp.toString();
    return search ? `/github?${search}` : "/github";
  };
  const pageHref = (page: number) => withParams({ page: page > 1 ? String(page) : null }, false);
  const keyword = params.get("keyword") ?? "";

  return (
    <div className="pb-6">
      <div className="mb-4 mt-1 lg:mt-0">
        <h1 className="flex items-center gap-2 text-[22px] font-semibold leading-[1.3] text-ink lg:text-[24px]">
          <IconGithub size={20} className="text-ink-3" />
          GitHub 开源趋势
        </h1>
        <p className="mt-1 text-[13px] text-ink-3">发现值得关注的开源项目。</p>
      </div>

      <PillTabs
        layoutId="github-boards"
        label="榜单"
        active={data.board}
        items={BOARDS.map((board) => ({ key: board, label: BOARD_COPY[board].tab, to: withParams({ board }) }))}
      />

      <p className="mt-3 text-[12.5px] leading-[1.6] text-ink-4">{copy.basis}全站总榜与 AI 总榜均已排除 Fork 仓库。</p>

      {data.stale && (
        <p className="mt-2 rounded-control bg-amber-soft px-3 py-2 text-[12.5px] leading-[1.6] text-amber-ink">
          数据更新失败，当前为上次成功结果{data.fetchedAt ? `（${beijingTime(data.fetchedAt)}）` : ""}。
        </p>
      )}

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <label className="flex items-center gap-1.5 text-[12.5px] text-ink-3">
          语言
          <select
            value={data.filters.language ?? ""}
            onChange={(event) => { navigate(withParams({ language: event.target.value || null })); }}
            className="h-8 max-w-[10rem] rounded-control border border-line bg-surface px-2 text-[12.5px] text-ink"
          >
            <option value="">全部</option>
            {data.languages.map((language) => <option key={language} value={language}>{language}</option>)}
          </select>
        </label>

        {ai && (
          <label className="flex items-center gap-1.5 text-[12.5px] text-ink-3">
            AI 分类
            <select
              value={data.filters.category ?? ""}
              onChange={(event) => { navigate(withParams({ category: event.target.value || null })); }}
              className="h-8 max-w-[11rem] rounded-control border border-line bg-surface px-2 text-[12.5px] text-ink"
            >
              <option value="">全部</option>
              {AI_CATEGORIES.map((category: AiCategory) => (
                <option key={category} value={category}>{AI_CATEGORY_LABELS[category]}</option>
              ))}
            </select>
          </label>
        )}

        <form action="/github" method="get" className="flex min-w-0 items-center gap-1.5">
          {QUERY_KEYS.filter((key) => key !== "keyword" && key !== "page").map((key) => {
            const value = params.get(key);
            return value ? <input key={key} type="hidden" name={key} value={value} /> : null;
          })}
          <div className="flex h-8 min-w-0 items-center gap-1.5 rounded-control border border-line bg-surface px-2">
            <IconSearch size={13} className="shrink-0 text-ink-4" />
            <input
              type="search"
              name="keyword"
              defaultValue={keyword}
              placeholder="搜索仓库名或简介"
              className="min-w-0 flex-1 bg-transparent text-[12.5px] text-ink outline-none placeholder:text-ink-4"
            />
          </div>
        </form>

        <PillTabs
          layoutId="github-page-size"
          size="xs"
          label="每页条数"
          active={String(data.pageSize)}
          items={PAGE_SIZES.map((size) => ({ key: String(size), label: `${size} 条`, to: withParams({ pageSize: String(size) }) }))}
        />
      </div>

      <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-[12px] text-ink-4">
        <span>
          共 <span className="num">{data.total}</span> 个项目
          {data.fetchedAt && <> · 数据更新于 <span className="num">{beijingTime(data.fetchedAt)}</span></>}
        </span>
        {(data.filters.language || data.filters.category || data.filters.keyword) && (
          <Link to={withParams({ language: null, category: null, keyword: null })} className="text-accent hover:underline">清除筛选</Link>
        )}
      </div>

      <div className={`mt-2 transition-opacity duration-200 ${busy ? "opacity-50" : ""}`}>
        {data.items.length === 0 ? (
          <div className="lg:card">
            <EmptyState title={data.total === 0 && !data.fetchedAt ? "还没有榜单数据" : "没有符合条件的项目"}>
              {data.total === 0 && !data.fetchedAt
                ? "采集任务还没有成功跑过一次，或这个榜单的上一次采集失败了。后台可以手动刷新。"
                : "换个语言、分类或关键词再试，或者清除筛选。"}
            </EmptyState>
          </div>
        ) : (
          <ul className="overflow-hidden rounded-card bg-surface ring-1 ring-line-soft">
            {data.items.map((item) => <RepoRow key={item.repositoryId} item={item} weekly={copy.weekly} ai={ai} />)}
          </ul>
        )}
      </div>

      {data.pageCount > 1 && (
        <nav className="mt-4 flex items-center justify-center gap-3 text-[13px]" aria-label="分页">
          {data.page > 1
            ? <Link to={pageHref(data.page - 1)} className="rounded-control px-3 py-1.5 text-accent ring-1 ring-line-soft hover:bg-accent-softer">上一页</Link>
            : <span className="rounded-control px-3 py-1.5 text-ink-4 ring-1 ring-line-soft">上一页</span>}
          <span className="num text-ink-3">{data.page} / {data.pageCount}</span>
          {data.page < data.pageCount
            ? <Link to={pageHref(data.page + 1)} className="rounded-control px-3 py-1.5 text-accent ring-1 ring-line-soft hover:bg-accent-softer">下一页</Link>
            : <span className="rounded-control px-3 py-1.5 text-ink-4 ring-1 ring-line-soft">下一页</span>}
        </nav>
      )}

      <p className="mt-6 text-[12px] leading-[1.7] text-ink-4">
        周榜来自 GitHub Trending Weekly 公开页面，GitHub 没有公布完整的排名算法，本站只保留它的原始顺序；
        总榜来自 GitHub 搜索接口，每个查询最多返回 1,000 个仓库，不代表全部公开仓库。
        AI 分类基于公开 Topics 与仓库信息用规则识别，可在后台人工修正。
      </p>
    </div>
  );
}
