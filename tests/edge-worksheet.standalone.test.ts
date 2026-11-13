// The boundary-case worksheet's pure half: its columns, the CSV round trip, and how strictly a filled
// sheet is read back. Unlike the blind gold sheet this one names the kind and shows the reason, so the
// guard here is the opposite — the category must survive into the label as the gold stratum, and a typo
// that silently became a decision would still poison the calibration.
import assert from "node:assert/strict";
import { test } from "node:test";
import { LEARNING_KINDS } from "@aihot/industry/selection";
import { dealByKind, EDGE_COLUMNS, EDGE_DECISIONS, edgeStratum, KIND_QUOTA, readEdgeFilled, toEdgeCsv, type EdgeRow } from "../scripts/edge-worksheet-core.ts";
import { flatten, parseCsv, splitOf } from "../scripts/gold-worksheet-core.ts";

const row = (over: Partial<EdgeRow> = {}): EdgeRow => ({
  index: 1, kind: "skill_playbook", id: "art-1", source: "某人",
  publishedAt: "2026-10-12 09:30", title: "一个教程", summary: "讲怎么做", reason: "可复用但偏入门",
  url: "https://x.com/i/status/1", ...over,
});

test("the sheet names the kind and shows the reason — it is not blind", () => {
  assert.deepEqual([...EDGE_COLUMNS], ["序号", "类别", "id", "信源", "发布时间", "标题", "摘要", "推荐理由", "原文链接", "决定", "理由"]);
  assert.deepEqual([...EDGE_DECISIONS], ["select", "reject"]);
  assert.equal(KIND_QUOTA, 6);
  const csv = toEdgeCsv([row()]);
  assert.ok(csv.startsWith("\uFEFF"), "a BOM, or Excel reads the Chinese as the legacy encoding");
  assert.ok(csv.includes("skill_playbook"), "the kind is on the sheet");
  assert.ok(csv.includes("可复用但偏入门"), "the model's reason is on the sheet");
  assert.equal(csv.split("\r\n").filter(Boolean).length, 2, "a header and one row");
});

test("the kind travels as the gold stratum, so a label becomes a per-kind rule", () => {
  for (const kind of LEARNING_KINDS) assert.equal(edgeStratum(kind), `edge:${kind}`);
});

test("the sheet is dealt round-robin, so a half-finished sheet still spans every kind", () => {
  assert.deepEqual(dealByKind([["a1", "a2", "a3"], ["b1"], ["c1", "c2"]]), ["a1", "b1", "c1", "a2", "c2", "a3"]);
  assert.deepEqual(dealByKind([]), []);
  assert.deepEqual(dealByKind([[], []]), [], "kinds with nothing drawn contribute nothing");
  const firstPass = dealByKind(LEARNING_KINDS.map((k) => [k, `${k}-2`]));
  assert.deepEqual(new Set(firstPass.slice(0, LEARNING_KINDS.length)), new Set(LEARNING_KINDS), "one row of every kind before any second row");
});

test("a post survives the CSV round trip with its commas, quotes and line breaks", () => {
  const awkward = `他说 "这个" 好用，然后换行\n第二行，还有\t制表符`;
  const csv = toEdgeCsv([row({ summary: awkward })]);
  const cells = parseCsv(csv)[1]!;
  assert.equal(cells[6], flatten(awkward).slice(0, 400));
  assert.equal(cells[9], "", "决定 starts empty");
  assert.equal(cells[10], "", "理由 starts empty");
  assert.equal(parseCsv(csv)[0]!.join(","), [...EDGE_COLUMNS].join(","));
});

test("each text field is cut where a reader stops, one line so the sheet stays readable", () => {
  const long = "字".repeat(900);
  const cells = parseCsv(toEdgeCsv([row({ title: long, summary: long, reason: long })]))[1]!;
  assert.equal(cells[5]!.length, 120, "title");
  assert.equal(cells[6]!.length, 400, "summary");
  assert.equal(cells[7]!.length, 400, "reason");
});

const filled = (decisions: Array<[string, string]>, kind = "skill_playbook") => {
  const rows = decisions.map((_, i) => row({ index: i + 1, id: `art-${i + 1}`, kind }));
  const lines = parseCsv(toEdgeCsv(rows)).map((cells, n) => {
    if (n === 0) return cells;
    cells[9] = decisions[n - 1]![0];
    cells[10] = decisions[n - 1]![1];
    return cells;
  });
  return lines.map((cells) => cells.map((c) => `"${c.replace(/"/g, '""')}"`).join(",")).join("\r\n");
};

test("a filled sheet reads back as labels carrying the kind, stratum and half", () => {
  const sheet = readEdgeFilled(filled([["select", "教程写得实在"], ["", ""], ["reject", "带货"]]));
  assert.deepEqual(sheet.errors, []);
  assert.equal(sheet.skipped, 1, "a blank cell is a row not decided yet, not a reject");
  assert.deepEqual(sheet.labels.map((l) => [l.id, l.decision, l.kind, l.stratum, l.split, l.reason]), [
    ["art-1", "select", "skill_playbook", "edge:skill_playbook", splitOf("art-1"), "教程写得实在"],
    ["art-3", "reject", "skill_playbook", "edge:skill_playbook", splitOf("art-3"), "带货"],
  ]);
});

test("a sheet that cannot be applied whole is refused whole", () => {
  for (const [decision, reason, expected] of [["选", "理由", /不是 select \/ reject/], ["select", "", /没有填理由/]] as const) {
    const sheet = readEdgeFilled(filled([[decision, reason]]));
    assert.equal(sheet.labels.length, 0, `${decision}/${reason} writes nothing`);
    assert.match(sheet.errors[0] ?? "", expected);
  }
  // A decision is read case-insensitively, so an operator typing SELECT is not refused.
  const upper = readEdgeFilled(filled([["SELECT", "大写也算"]]));
  assert.deepEqual(upper.errors, []);
  assert.equal(upper.labels[0]!.decision, "select");

  const foreign = filled([["select", "理由"]], "not_a_kind");
  assert.match(readEdgeFilled(foreign).errors[0] ?? "", /类别 not_a_kind 不是学习轨的内容类型/);

  const twice = filled([["select", "理由"], ["select", "理由"]]).replace('"art-2"', '"art-1"');
  assert.match(readEdgeFilled(twice).errors[0] ?? "", /出现过两次/);

  const tampered = filled([["select", "理由"]]).replace('"决定"', '"评分"');
  assert.match(readEdgeFilled(tampered).errors[0] ?? "", /the header is not the sheet this script wrote/);

  assert.deepEqual(readEdgeFilled("").errors, ["the file is empty"]);
});

test("a sheet Excel wrote back with LF and a stray blank line still reads", () => {
  const csv = filled([["select", "理由"]]).replace(/\r\n/g, "\n") + "\n\n";
  const sheet = readEdgeFilled(csv);
  assert.deepEqual(sheet.errors, []);
  assert.equal(sheet.labels.length, 1);
});