import { Form, Link, useLocation } from "react-router";
import { SITE } from "@aihot/site";
import { INK, InkIcon, InkLockup } from "../ink";
import { IconBell, IconChevronDown } from "../icons";
import { IntentLink } from "../ui/IntentLink";
import { ThemeSwitch } from "./ThemeSwitch";
import { useChangelogDot } from "./Sidebar";
import { sidebar, sidebarIsActive, type NavItem } from "./nav";

const PRIMARY = ["/", "/daily", "/hot", "/topics", "/all"];
const LABELS: Record<string, string> = { "/daily": "每日总结", "/topics": "主题分类", "/all": "资源库" };

function TopLink({ item }: { item: NavItem }) {
  const { pathname } = useLocation();
  const active = sidebarIsActive(item, pathname);
  return (
    <IntentLink
      to={item.to}
      aria-current={active ? "page" : undefined}
      className={`relative flex h-full items-center whitespace-nowrap text-[14px] transition-colors duration-150 after:absolute after:inset-x-0 after:bottom-[17px] after:mx-auto after:h-px after:bg-ink after:transition-opacity ${active ? "font-semibold text-ink after:opacity-100" : "text-ink-3 after:opacity-0 hover:text-ink"}`}
    >
      {LABELS[item.to] ?? item.label}
    </IntentLink>
  );
}

export function TopHeader({ changelogVersion }: { changelogVersion: string | null }) {
  const items = sidebar().flatMap((section) => section.items);
  const primary = PRIMARY.flatMap((to) => items.filter((item) => item.to === to));
  const more = items.filter((item) => !PRIMARY.includes(item.to));
  const dot = useChangelogDot(changelogVersion);
  return (
    <header className="sticky top-0 z-40 hidden border-b border-line-soft bg-bg/95 backdrop-blur-xl lg:block">
      {/* The body's height comes from --bar-h (minus the 1px border), the same token sticky offsets read. */}
      <div className="mx-auto flex h-[calc(var(--bar-h)-1px)] max-w-[1360px] items-center gap-5 px-7 xl:gap-8">
        <Link to="/" aria-label={`${SITE.name} 首页`} className="shrink-0 text-ink">
          <span className="hidden xl:block"><InkLockup height={46} /></span>
          <span className="xl:hidden"><InkLockup height={36} /></span>
        </Link>
        <nav aria-label="主导航" className="flex min-w-0 flex-1 items-center justify-center gap-5 xl:gap-8">
          {primary.map((item) => <TopLink key={item.to} item={item} />)}
          <details className="group relative">
            <summary className="flex h-full cursor-pointer list-none items-center gap-1 text-[14px] text-ink-3 transition-colors hover:text-ink [&::-webkit-details-marker]:hidden">
              更多 <IconChevronDown size={13} className="transition-transform group-open:rotate-180" />
            </summary>
            <div className="absolute left-1/2 top-[70px] w-44 -translate-x-1/2 rounded-card border border-line bg-surface p-1.5 shadow-pop">
              {more.map((item) => {
                const Icon = item.icon;
                return (
                  <IntentLink key={item.to} to={item.to} className="flex h-10 items-center gap-2.5 rounded-control px-3 text-[13px] text-ink-3 hover:bg-bg-sunk hover:text-ink">
                    <Icon size={16} /> {item.label}
                    {item.changelog && dot && <span className="ml-auto size-1.5 rounded-full bg-hot" aria-label="有新的更新" />}
                  </IntentLink>
                );
              })}
            </div>
          </details>
        </nav>
        <div className="flex shrink-0 items-center gap-2.5">
          <Form action="/all" method="get" role="search" className="relative">
            <InkIcon name="search" size={16} className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 opacity-70" />
            <input
              type="search"
              name="q"
              aria-label="搜索内容、作者、主题"
              placeholder="搜索内容、作者、主题…"
              className="h-10 w-[190px] rounded-full border border-line bg-surface/70 pl-10 pr-3 text-[13px] text-ink outline-none transition-[width,border-color] duration-200 placeholder:text-ink-4 focus:w-[220px] focus:border-line-strong xl:w-[230px] xl:focus:w-[250px]"
            />
          </Form>
          <Link to="/daily" aria-label="查看每日更新" title="每日更新" className="relative grid size-10 place-items-center rounded-full text-ink-3 transition-colors hover:bg-bg-sunk hover:text-ink">
            <IconBell size={19} />
            {dot && <span className="absolute right-2 top-2 size-1.5 rounded-full bg-hot" aria-label="有新的更新" />}
          </Link>
          <details className="group relative">
            <summary className="grid size-10 cursor-pointer list-none place-items-center overflow-hidden rounded-full border border-line bg-surface shadow-card [&::-webkit-details-marker]:hidden" aria-label="读者菜单">
              <img src={INK.mark} alt="" width={30} height={28} decoding="async" className="ink-mono size-[29px] object-contain" />
            </summary>
            <div className="absolute right-0 top-12 w-64 rounded-card border border-line bg-surface p-3 shadow-pop">
              <div className="px-1 pb-2 text-[12px] text-ink-4">阅读偏好</div>
              <ThemeSwitch />
              <div className="mt-3 grid grid-cols-2 gap-1 border-t border-line-soft pt-2">
                <IntentLink to="/starred" className="rounded-control px-2 py-2 text-[13px] text-ink-3 hover:bg-bg-sunk hover:text-ink">我的收藏</IntentLink>
                <IntentLink to="/topics" className="rounded-control px-2 py-2 text-[13px] text-ink-3 hover:bg-bg-sunk hover:text-ink">主题分类</IntentLink>
                <IntentLink to="/about" className="rounded-control px-2 py-2 text-[13px] text-ink-3 hover:bg-bg-sunk hover:text-ink">关于 ARGUS</IntentLink>
                <IntentLink to="/feedback" className="rounded-control px-2 py-2 text-[13px] text-ink-3 hover:bg-bg-sunk hover:text-ink">意见反馈</IntentLink>
              </div>
            </div>
          </details>
        </div>
      </div>
    </header>
  );
}
