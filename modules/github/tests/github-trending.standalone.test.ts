// The trending parser and the AI classifier, with no database and no network (方案 11.1, 11.2). The HTML
// sample is generated here rather than committed as a file: a fixture nobody regenerates goes stale.
import assert from "node:assert/strict";
import { test } from "node:test";
import { parseTrending, TrendingParseError } from "../backend/trending.ts";
import { classifyRepository } from "../backend/classify.ts";

const card = (owner: string, repo: string, description: string, language: string | null, stars: number, forks: number, weeklyStars: number) => `
  <article class="Box-row">
    <h2 class="h3 lh-condensed">
      <a href="/${owner}/${repo}" data-view-component="true" class="Link">
        <span class="text-normal">${owner} /</span>
        ${repo}
      </a>
    </h2>
    <p class="col-9 color-fg-muted my-1 pr-4">${description}</p>
    <div class="f6 color-fg-muted mt-2">
      ${language === null ? "" : `<span class="d-inline-block ml-0 mr-3" itemprop="programmingLanguage">${language}</span>`}
      <a class="Link--muted d-inline-block mr-3" href="/${owner}/${repo}/stargazers">${stars.toLocaleString("en-US")}</a>
      <a class="Link--muted d-inline-block mr-3" href="/${owner}/${repo}/forks">${forks.toLocaleString("en-US")}</a>
      <span class="d-inline-block float-sm-right">${weeklyStars.toLocaleString("en-US")} stars this week</span>
    </div>
  </article>`;

const page = (...cards: string[]) => `<!doctype html><html><body><main><div class="application-main">${cards.join("")}</div></main></body></html>`;

// Deliberately out of star order: the weekly boards must keep the page's order, not sort by stars.
const SAMPLE = page(
  card("small-org", "tiny-tool", "A small helper.", "Go", 900, 40, 300),
  card("ai-lab", "agent-kit", "Build autonomous AI agents.", "Python", 12_000, 900, 1_500),
  card("ml-org", "vector-store", "Vector database for RAG.", "Rust", 5_400, 210, 700),
  card("no-lang", "plain-thing", "Something without a language label.", null, 3_100, 88, 210),
  card("big-org", "huge-repo", "An enormous project.", "TypeScript", 98_000, 7_000, 2_000),
  card("ai-lab", "agent-kit", "Build autonomous AI agents.", "Python", 12_000, 900, 1_500),
);

test("the trending page parses into cards with the fields a board needs", () => {
  const parsed = parseTrending(SAMPLE, "https://github.com/trending?since=weekly", new Date("2026-01-05T00:00:00Z"));
  assert.equal(parsed.items.length, 5, "the repeated card is kept once");
  assert.deepEqual(parsed.warnings.join(" "), "duplicate repository card ai-lab/agent-kit kept once");
  const second = parsed.items[1]!;
  assert.equal(second.fullName, "ai-lab/agent-kit");
  assert.equal(second.ownerLogin, "ai-lab");
  assert.equal(second.name, "agent-kit");
  assert.equal(second.htmlUrl, "https://github.com/ai-lab/agent-kit");
  assert.equal(second.description, "Build autonomous AI agents.");
  assert.equal(second.language, "Python");
  assert.equal(second.stargazersCount, 12_000);
  assert.equal(second.forksCount, 900);
  assert.equal(parsed.items[3]!.language, null, "a card without a language label keeps none");
  assert.equal(parsed.fetchedAt.toISOString(), "2026-01-05T00:00:00.000Z");
});

test("source_rank is the page's own order and never follows the star count", () => {
  const parsed = parseTrending(SAMPLE, "https://github.com/trending?since=weekly", new Date());
  assert.deepEqual(parsed.items.map((item) => item.sourceRank), [1, 2, 3, 4, 5]);
  assert.deepEqual(parsed.items.map((item) => item.fullName), [
    "small-org/tiny-tool", "ai-lab/agent-kit", "ml-org/vector-store", "no-lang/plain-thing", "big-org/huge-repo",
  ]);
  const stars = parsed.items.map((item) => item.stargazersCount);
  assert.notDeepEqual(stars, [...stars].sort((a, b) => b - a), "the fixture is not star-ordered, so the assertion above is about order, not luck");
});

test("the weekly stars a card prints are not read: this module collects no growth figure", () => {
  const parsed = parseTrending(SAMPLE, "https://github.com/trending?since=weekly", new Date());
  // big-org/huge-repo prints 98,000 cumulative and 2,000 this week; only the cumulative one is kept.
  assert.equal(parsed.items[4]!.stargazersCount, 98_000);
  assert.ok(!("starsThisWeek" in parsed.items[4]!), "no weekly-growth field exists on the parsed item");
});

test("a page with no repository cards fails instead of producing an empty board", () => {
  assert.throws(
    () => parseTrending("<!doctype html><html><body><h1>Sign in to GitHub</h1></body></html>", "https://github.com/trending", new Date()),
    TrendingParseError,
  );
  assert.throws(() => parseTrending("", "https://github.com/trending", new Date()), TrendingParseError);
});

test("a card the parser cannot read at all is reported, not silently dropped", () => {
  const parsed = parseTrending(page(
    ...Array.from({ length: 5 }, (_, i) => card("org", `repo-${i}`, "A project.", "Python", 100 + i, 10, 5)),
    '<article class="Box-row"><h2><a href="/sponsors/acme">Sponsor</a></h2></article>',
  ), "https://github.com/trending", new Date());
  assert.equal(parsed.items.length, 5);
  assert.ok(parsed.warnings.some((warning) => warning.includes("card")), parsed.warnings.join("; "));
});

const classify = (input: Parameters<typeof classifyRepository>[0]) => classifyRepository(input);
const base = { fullName: "acme/thing", description: null as string | null, topics: [] as string[], matchedTopics: [] as string[], manualOverride: null };

test("a strong AI topic classifies the repository and names its category", () => {
  const llm = classify({ ...base, topics: ["llm"] });
  assert.equal(llm.isAi, true);
  assert.equal(llm.primaryCategory, "llm");
  assert.equal(llm.method, "topic");

  const agent = classify({ ...base, topics: ["ai-agent"] });
  assert.equal(agent.primaryCategory, "agent");
  assert.equal(classify({ ...base, topics: ["mcp-server"] }).primaryCategory, "mcp");
  assert.equal(classify({ ...base, topics: ["rag"] }).primaryCategory, "rag");
  assert.equal(classify({ ...base, topics: ["vllm"] }).primaryCategory, "infra");
});

test("a description that says what the project is classifies it without any topic", () => {
  const result = classify({ ...base, description: "A model serving runtime with fast LLM inference." });
  assert.equal(result.isAi, true);
  assert.equal(result.method, "description");
  assert.ok(result.categories.includes("infra") || result.categories.includes("llm"), result.categories.join(","));
});

test("a broad topic with nothing behind it is not enough", () => {
  const result = classify({ ...base, topics: ["ai"], description: "A booking system for a dental clinic." });
  assert.equal(result.isAi, false);
  assert.equal(result.primaryCategory, null);
  assert.ok(result.reasons.some((reason) => reason.includes("宽泛")), result.reasons.join("; "));
});

test("several topics give one repository several categories and one primary", () => {
  const result = classify({ ...base, topics: ["llm", "ai-agent", "rag"], matchedTopics: ["llm", "rag"] });
  assert.equal(result.isAi, true);
  assert.deepEqual(result.categories, ["agent", "llm", "rag"]);
  assert.equal(result.primaryCategory, "agent", "the taxonomy's own order picks the primary");
  assert.deepEqual(result.matchedTopics, ["ai-agent", "llm", "rag"], "the repository's topics and the queries that found it are kept together");
});

test("a resource list stays on the AI boards under its own category", () => {
  const result = classify({ ...base, fullName: "acme/awesome-llm", topics: ["llm"], description: "A curated list of LLM resources." });
  assert.equal(result.isAi, true);
  assert.deepEqual(result.categories, ["resources"]);
  assert.equal(result.primaryCategory, "resources");
});

test("an administrator's word is never overruled by the rules", () => {
  const excluded = classify({ ...base, topics: ["llm", "ai-agent"], description: "An LLM agent framework.", manualOverride: "exclude" });
  assert.equal(excluded.isAi, false);
  assert.equal(excluded.method, "manual");
  assert.equal(excluded.confidence, 1);

  const included = classify({ ...base, description: "A booking system.", manualOverride: "include" });
  assert.equal(included.isAi, true);
  assert.equal(included.method, "manual");
});

test("confidence is a number between 0 and 1 and grows with the evidence", () => {
  const weak = classify({ ...base, description: "An assistant for notes." });
  const strong = classify({ ...base, topics: ["llm", "ai-agent"], description: "An LLM agent framework with RAG." });
  for (const result of [weak, strong]) {
    assert.ok(result.confidence >= 0 && result.confidence <= 1, String(result.confidence));
    assert.equal(result.confidence, Math.round(result.confidence * 1000) / 1000, "kept to three decimal places");
  }
  assert.ok(strong.confidence > weak.confidence, `${strong.confidence} > ${weak.confidence}`);
});
