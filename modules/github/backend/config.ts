// The module's own configuration. GITHUB_TOKEN is read through the engine's credential groups like every
// other collector key (packages/backend/src/config.ts), so it never appears in a bundle, a log or a test
// snapshot; the rest are plain environment variables with the plan's defaults (方案 10 节).
import { credential } from "@aihot/backend/config";

const env = process.env;

function str(name: string, fallback: string): string {
  const value = env[name];
  return value !== undefined && value !== "" ? value : fallback;
}

function int(name: string, fallback: number): number {
  const value = env[name];
  if (value === undefined || value === "") return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`Environment variable ${name} must be a positive integer`);
  return parsed;
}

export const githubConfig = {
  /** Read-only, public data only. Without one GitHub answers 60 REST requests an hour per address, and collection degrades instead of failing. */
  token: credential("collectors", "GITHUB_TOKEN"),
  apiBaseUrl: str("GITHUB_API_BASE_URL", "https://api.github.com").replace(/\/+$/, ""),
  trendingWeeklyUrl: str("GITHUB_TRENDING_WEEKLY_URL", "https://github.com/trending?since=weekly"),
  /** The star board's depth; the Search API hands out at most 100 a page and 1,000 a query. */
  allStarsLimit: Math.min(int("GITHUB_ALL_STARS_LIMIT", 100), 1000),
  /** How deep each AI topic query goes. */
  aiTopicPageSize: Math.min(int("GITHUB_AI_TOPIC_PAGE_SIZE", 100), 100),
  refreshCron: str("GITHUB_REFRESH_CRON", "0 8 * * *"),
  timeoutMs: int("GITHUB_HTTP_TIMEOUT_MS", 15_000),
  /** Attempts at one request, the first included; a rate-limited answer is never retried. */
  maxRetries: int("GITHUB_MAX_RETRIES", 3),
  taxonomyVersion: str("GITHUB_AI_TAXONOMY_VERSION", "v1"),
};

export type GithubConfig = typeof githubConfig;

/** Whether the module may talk to GitHub at all: the engine's collection valve, not a switch of its own. */
export const collectionEnabled = () => env.COLLECT_ENABLED === "true";
