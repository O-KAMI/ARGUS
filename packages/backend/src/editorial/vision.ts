// Visual evidence for learning-track posts whose text is short while the substance sits in a picture
// (audit 2026-11-04 三.5): the prefilter used to reject on the text alone, so a screenshot tutorial that
// says only "配置如下" lost its core evidence before anyone read the image. Gathered before the prefilter
// decides, receipted like every paid call, cached per revision, and dormant while VISION_EVIDENCE_SHADOW
// is off. A picture no vision model could read leaves the post judged on its text and marked
// 证据不足、可回看 — never silently blocked, never silently passed.
import { z } from "zod";
import { trackOf } from "@aihot/industry/selection";
import { config } from "../config.ts";
import { sql } from "../db.ts";
import { chatJson } from "../providers/llm.ts";
import { firstImagePart, type AnalyzeInputArticle } from "./input.ts";
import { modelRoute, modelSupportsVision } from "./models.ts";

/** A post shorter than this can hide its substance in the picture; longer text speaks for itself. */
export const VISION_SHORT_CHARS = 140;

const PROMPT_VERSION = "vision-evidence-1";
const SYSTEM = "读图并只写图里看得见的事实：步骤、配置、数字、界面文字。不推测图外信息，不评论。";
const EvidenceSchema = z.object({ evidence: z.string().min(1) });

export interface VisionEvidence {
  revision: number;
  /** ok: a vision model read the picture; unavailable: 证据不足、可回看. */
  state: "ok" | "unavailable";
  text: string | null;
  model: string | null;
  at: string;
}

/** The text a post is judged on before any picture is read. */
const textOf = (a: AnalyzeInputArticle) => (a.bodyText ?? a.xPost?.text ?? a.excerpt ?? "").trim();

const hasImage = (a: AnalyzeInputArticle) =>
  [...(a.xPost?.media ?? []), ...(a.xPost?.quoted?.media ?? []), ...a.media].some((m: { kind?: string; url?: string }) => m.kind === "image" && !!m.url);

/** Only the learning track's short picture posts: the track whose value can sit in a screenshot. */
export function wantsVisionEvidence(a: AnalyzeInputArticle): boolean {
  if (trackOf(a.source.tags) !== "learning") return false;
  const text = textOf(a);
  return text.length > 0 && text.length < VISION_SHORT_CHARS && hasImage(a);
}

/**
 * The cached evidence of this revision, or a fresh reading. `null` while the shadow switch is off or the
 * post is not eligible: the prefilter then decides on the text exactly as before, with no model call here.
 */
export async function visionEvidence(a: AnalyzeInputArticle, onReceipt?: (receiptId: number) => void): Promise<VisionEvidence | null> {
  if (!config.visionEvidenceShadow || !wantsVisionEvidence(a)) return null;
  const [row] = await sql<{ vision_evidence: VisionEvidence | null }[]>`SELECT vision_evidence FROM articles WHERE id = ${a.id}`;
  if (row?.vision_evidence && row.vision_evidence.revision === a.revision) return row.vision_evidence;
  const at = new Date().toISOString();
  const { model, fallbackModel } = await modelRoute("visionEvidence");
  let evidence: VisionEvidence;
  const image = modelSupportsVision(model) ? await firstImagePart(a) : null;
  if (!image) {
    evidence = { revision: a.revision, state: "unavailable", text: null, model: modelSupportsVision(model) ? model : null, at };
  } else {
    try {
      const res = await chatJson({
        model, fallbackModel, purpose: "vision_evidence", subject: `article:${a.id}@${a.revision}`, promptVersion: PROMPT_VERSION,
        system: SYSTEM, user: [{ type: "text", text: `帖子文字：\n${textOf(a)}` }, image], schema: EvidenceSchema, temperature: 0, maxTokens: 400,
      });
      onReceipt?.(res.receiptId);
      evidence = { revision: a.revision, state: "ok", text: res.data.evidence.slice(0, 2000), model: res.model, at };
    } catch {
      evidence = { revision: a.revision, state: "unavailable", text: null, model, at };
    }
  }
  // Cached per revision: a re-run of the same revision never pays twice, and an unavailable reading stays
  // reviewable instead of being retried into a budget loop. A new revision reads the picture again.
  await sql`UPDATE articles SET vision_evidence = ${sql.json(evidence as never)} WHERE id = ${a.id} AND revision = ${a.revision}`;
  return evidence;
}
