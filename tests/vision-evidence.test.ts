// 审计 2026-11-04 三.5 的影子开关：关时一张图也不读，预筛与从前逐字相同；开时学习轨的短图文在预筛
// 拒绝之前先让视觉模型读图里的步骤，按修订缓存（同一修订不付第二次），图读不到记「证据不足、可回看」，
// 帖子仍按文字判定——不静默放过，也不静默拦下。长文与非学习轨永远不触发读图。
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { after, before, test } from "node:test";
import sharp from "sharp";
import { closeDb, sql } from "@aihot/backend/db";
import { config } from "@aihot/backend/config";
import { upsertMaterial } from "@aihot/backend/content/materials";
import { runSelectionPrefilter } from "@aihot/backend/editorial/analyze";
import { loadAnalyzeInput } from "@aihot/backend/editorial/input";
import { visionEvidence } from "@aihot/backend/editorial/vision";
import { Reply, stub, tag } from "./setup.ts";

const SOURCE = `vision-${tag()}`;
let visionDown = false;
const users: string[] = [];
const provider = await stub((_hit, req) => {
  const body = JSON.parse(req.body);
  const content = body.messages.at(-1).content;
  users.push(JSON.stringify(content));
  const isVision = Array.isArray(content) && content.some((part: { type?: string }) => part.type === "image_url");
  if (isVision) {
    if (visionDown) return new Reply(500, { error: "vision down" });
    return { choices: [{ message: { content: JSON.stringify({ evidence: "图里三步：装插件、填令牌、重启终端" }) } }] };
  }
  return { choices: [{ message: { content: JSON.stringify({ label: "PASS", reason: "属于这个行业" }) } }] };
});
for (const name of ["DASHSCOPE", "DEEPSEEK", "XIAOMI_MIMO"]) {
  process.env[`${name}_BASE_URL`] = `${provider.url}/v1`;
  process.env[`${name}_API_KEY`] = "test-key";
}
// The step's own choice: a preset that declares vision, on the stubbed provider.
process.env.VISION_EVIDENCE_MODEL = "qwen3-vl-flash";
const png = await sharp({ create: { width: 24, height: 24, channels: 3, background: { r: 200, g: 200, b: 200 } } }).png().toBuffer();
const images = createServer((_req, res) => { res.writeHead(200, { "content-type": "image/png" }); res.end(png); });
await new Promise<void>((resolve) => images.listen(0, "127.0.0.1", resolve));
const imageUrl = `http://127.0.0.1:${(images.address() as { port: number }).port}/shot.png`;

before(async () => {
  config.allowPrivateNetworkFetch = true;
  await sql`INSERT INTO sources (id, name, kind, tier, participation_mode, tags, next_fetch_at)
            VALUES (${SOURCE}, 'Vision source', 'rss', 'T1', 'editorial', ${["track:learning"]}, '2100-01-01')`;
});
after(async () => {
  config.visionEvidenceShadow = false;
  await provider.close();
  await new Promise<void>((resolve) => images.close(() => resolve()));
  await closeDb();
});

const post = async (name: string, text: string, withImage: boolean) => {
  const { articleId } = await upsertMaterial({
    sourceId: SOURCE, url: `https://example.org/vision/${name}-${tag()}`, title: text, bodyText: text, bodyStatus: "ok", via: "fetch",
    media: withImage ? [{ kind: "image", url: imageUrl }] : [],
  });
  return articleId;
};
const evidenceOf = async (id: string) => (await sql<{ vision_evidence: { state: string; text: string | null; revision: number } | null }[]>`SELECT vision_evidence FROM articles WHERE id = ${id}`)[0]!.vision_evidence;

test("the shadow switch off reads no image and leaves the prefilter exactly as before", async () => {
  config.visionEvidenceShadow = false;
  const id = await post("off", "配置如下", true);
  const calls = provider.hits();
  const prefilter = await runSelectionPrefilter((await loadAnalyzeInput(id))!);
  assert.equal(prefilter.label, "PASS");
  assert.equal(provider.hits(), calls + 1, "only the prefilter call");
  assert.equal(await evidenceOf(id), null, "nothing is recorded while dormant");
  assert.ok(!users.at(-1)!.includes("image_url"), "the prefilter input carries no picture");
});

test("the switch on reads the picture once per revision and the prefilter sees the evidence as model-read", async () => {
  config.visionEvidenceShadow = true;
  const id = await post("on", "配置如下", true);
  const calls = provider.hits();
  const prefilter = await runSelectionPrefilter((await loadAnalyzeInput(id))!);
  assert.equal(prefilter.label, "PASS");
  assert.equal(provider.hits(), calls + 2, "the evidence call plus the prefilter");
  const evidence = await evidenceOf(id);
  assert.equal(evidence?.state, "ok");
  assert.ok(evidence?.text?.includes("装插件"), "the steps the text never wrote");
  const prefilterInput = users.at(-1)!;
  assert.ok(prefilterInput.includes("视觉证据（视觉模型读图所得，非原文文字）"), "the evidence is labelled as model-read, not source text");
  // The same revision never pays twice: the cached reading is reused.
  const again = provider.hits();
  const cached = await visionEvidence((await loadAnalyzeInput(id))!);
  assert.equal(provider.hits(), again, "the cached evidence of this revision costs nothing");
  assert.equal(cached?.text, evidence?.text);
});

test("an unreadable picture is recorded as insufficient evidence, and the post is still judged on its text", async () => {
  visionDown = true;
  try {
    const id = await post("down", "配置如下，图却读不到", true);
    const calls = provider.hits();
    const prefilter = await runSelectionPrefilter((await loadAnalyzeInput(id))!);
    assert.equal(prefilter.label, "PASS", "the text alone still decides");
    assert.equal(provider.hits(), calls + 2, "one failed evidence call, one prefilter");
    assert.equal((await evidenceOf(id))?.state, "unavailable", "证据不足、可回看");
  } finally {
    visionDown = false;
  }
});

test("long text and other tracks never trigger a picture read", async () => {
  const long = "这是一篇足够长的实践记录。".repeat(30);
  const longId = await post("long", long, true);
  let calls = provider.hits();
  await runSelectionPrefilter((await loadAnalyzeInput(longId))!);
  assert.equal(provider.hits(), calls + 1, "a long post speaks for itself");
  assert.equal(await evidenceOf(longId), null);
  await sql`UPDATE sources SET tags = ${[]} WHERE id = ${SOURCE}`;
  const newsId = await post("news-track", "配置如下", true);
  calls = provider.hits();
  await runSelectionPrefilter((await loadAnalyzeInput(newsId))!);
  assert.equal(provider.hits(), calls + 1, "the news track keeps its text-only standard");
  assert.equal(await evidenceOf(newsId), null);
  await sql`UPDATE sources SET tags = ${["track:learning"]} WHERE id = ${SOURCE}`;
});