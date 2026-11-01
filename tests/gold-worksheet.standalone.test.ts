// The labelling worksheet's pure half: the sheet's columns, its CSV round trip, and how strictly a filled
// sheet is read back. A typo that silently became a decision would poison the calibration, so the refusals
// matter as much as the accepts.
import assert from "node:assert/strict";
import { test } from "node:test";
import { COLUMNS, DECISIONS, flatten, interleave, parseCsv, readFilled, splitOf, stratumName, stratumOf, stratumQuota, STRATA, TEXT_LIMIT, toCsv, type WorksheetRow } from "../scripts/gold-worksheet-core.ts";

const row = (over: Partial<WorksheetRow> = {}): WorksheetRow => ({
  index: 1, code: "s7", split: "development", id: "art-1", source: "某人",
  publishedAt: "2026-10-12 09:30", text: "一条帖子", url: "https://x.com/i/status/1", ...over,
});

test("the sheet carries what the operator reads and nothing the model decided", () => {
  // The columns are the guard: a score, a level or a "currently selected" column would let the machine's
  // answer leak into a human judgement that is supposed to be independent of it.
  assert.deepEqual([...COLUMNS], ["序号", "代号", "集合", "id", "信源", "发布时间", "原文", "原文链接", "决定", "理由"]);
  assert.deepEqual([...DECISIONS], ["select", "reject"]);
  const csv = toCsv([row(), row({ index: 2, id: "art-2", code: "s1" })]);
  assert.ok(csv.startsWith("\uFEFF"), "a BOM, or Excel reads the Chinese as the legacy encoding");
  assert.ok(!/score|selected|精选|评分|分数/i.test(csv), "no column or value names the machine's verdict");
  assert.equal(csv.split("\r\n").filter(Boolean).length, 3, "a header and two rows");
});

test("the strata codes are opaque and map back to the score pair they were drawn from", () => {
  for (const s of STRATA) {
    assert.equal(stratumName(s.code), s.name);
    assert.equal(stratumOf(s.s1, s.s2)?.code, s.code, `${s.name} round-trips`);
    assert.ok(stratumQuota(s.code) > 0);
  }
  assert.equal(stratumName("s99"), null, "a code this script did not issue");
  assert.equal(stratumOf(75, 60), null, "a score that is not one of the three levels");
  assert.equal(stratumOf(90, null)?.name, "hit", "rule A leaves no second score when the first was decisive");
  // The rare pairs are taken whole; only the two large agreeing piles are sampled.
  assert.deepEqual(STRATA.filter((s) => s.take >= 99).map((s) => s.name), ["hit-edge", "hit-veto", "edge-raise", "edge-veto", "miss-near"]);
  // Rule A asks a second time only when the first level was `edge`, so exactly these five pairs can still
  // be produced; the others are the stock's history and stay in the design as threshold evidence.
  assert.deepEqual(STRATA.filter((s) => s.future).map((s) => s.name), ["hit", "edge-raise", "edge-keep", "edge-veto", "miss"]);
});

test("the sheet is dealt round-robin, so a half-finished sheet still spans every stratum", () => {
  // A hand-filled sheet is stopped halfway far more often than finished. Read in order, the rows that do
  // carry a decision must not all come from one pile, or the labels describe one score range only.
  assert.deepEqual(interleave([["a1", "a2", "a3"], ["b1"], ["c1", "c2"]]), ["a1", "b1", "c1", "a2", "c2", "a3"]);
  assert.deepEqual(interleave([]), []);
  assert.deepEqual(interleave([[], []]), [], "strata with nothing drawn contribute nothing");
  const firstPass = interleave(STRATA.map((s) => [s.code, `${s.code}-2`]));
  assert.deepEqual(new Set(firstPass.slice(0, STRATA.length)), new Set(STRATA.map((s) => s.code)), "one row of every stratum before any second row");
});

test("a case stays in the same calibration half on every sheet", () => {
  assert.equal(splitOf("art-1"), splitOf("art-1"));
  const halves = new Set(Array.from({ length: 200 }, (_, i) => splitOf(`art-${i}`)));
  assert.deepEqual([...halves].sort(), ["development", "holdout"], "both halves get used");
});

test("a post survives the CSV round trip with its commas, quotes and line breaks", () => {
  const awkward = `他说 "这个" 好用，然后换行\n第二行，还有\t制表符`;
  const csv = toCsv([row({ text: awkward })]);
  const cells = parseCsv(csv)[1]!;
  assert.equal(cells[6], flatten(awkward).slice(0, TEXT_LIMIT));
  assert.equal(cells[8], "", "决定 starts empty");
  assert.equal(cells[9], "", "理由 starts empty");
  assert.equal(parseCsv(csv)[0]!.join(","), [...COLUMNS].join(","));
});

test("a long post is cut where a reader stops, not where the scorer does", () => {
  const long = "字".repeat(TEXT_LIMIT + 500);
  assert.equal(parseCsv(toCsv([row({ text: long })]))[1]![6]!.length, TEXT_LIMIT);
});

const filled = (decisions: Array<[string, string]>) => {
  const rows = decisions.map(([decision, reason], i) => row({ index: i + 1, id: `art-${i + 1}` }));
  const lines = parseCsv(toCsv(rows)).map((cells, n) => {
    if (n === 0) return cells;
    cells[8] = decisions[n - 1]![0];
    cells[9] = decisions[n - 1]![1];
    return cells;
  });
  return lines.map((cells) => cells.map((c) => `"${c.replace(/"/g, '""')}"`).join(",")).join("\r\n");
};

test("a filled sheet reads back as labels carrying the stratum and half they were drawn from", () => {
  const sheet = readFilled(filled([["select", "教程写得实在"], ["", ""], ["reject", "带货"]]));
  assert.deepEqual(sheet.errors, []);
  assert.equal(sheet.skipped, 1, "a blank cell is a row not decided yet, not a reject");
  assert.deepEqual(sheet.labels.map((l) => [l.id, l.decision, l.stratum, l.split, l.reason]), [
    ["art-1", "select", "edge-veto", "development", "教程写得实在"],
    ["art-3", "reject", "edge-veto", "development", "带货"],
  ]);
});

test("a sheet that cannot be applied whole is refused whole", () => {
  for (const [decision, reason, expected] of [["选", "理由", /不是 select \/ reject/], ["select", "", /没有填理由/]] as const) {
    const sheet = readFilled(filled([[decision, reason]]));
    assert.equal(sheet.labels.length, 0, `${decision}/${reason} writes nothing`);
    assert.match(sheet.errors[0] ?? "", expected);
  }
  // A decision is read case-insensitively, so an operator typing SELECT is not refused.
  const upper = readFilled(filled([["SELECT", "大写也算"]]));
  assert.deepEqual(upper.errors, []);
  assert.equal(upper.labels[0]!.decision, "select");

  const foreign = filled([["select", "理由"]]).replace('"s7"', '"s99"');
  assert.match(readFilled(foreign).errors[0] ?? "", /代号 s99 不是本脚本发出的/);

  const twice = filled([["select", "理由"], ["select", "理由"]]).replace('"art-2"', '"art-1"');
  assert.match(readFilled(twice).errors[0] ?? "", /出现过两次/);

  const tampered = filled([["select", "理由"]]).replace('"决定"', '"评分"');
  assert.match(readFilled(tampered).errors[0] ?? "", /the header is not the sheet this script wrote/);

  assert.deepEqual(readFilled("").errors, ["the file is empty"]);
});

test("a sheet Excel wrote back with LF and a stray blank line still reads", () => {
  const csv = filled([["select", "理由"]]).replace(/\r\n/g, "\n") + "\n\n";
  const sheet = readFilled(csv);
  assert.deepEqual(sheet.errors, []);
  assert.equal(sheet.labels.length, 1);
});
