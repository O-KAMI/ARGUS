// One pass of the mirror, run by the worker's schedule (server.ts): read the catalogue's two rankings and
// its curated window, keep what each answered, and store the window's items as this site's own material.
//
// The three reads are conditional and each one is allowed to fail on its own. A ranking that could not be
// read leaves the ranking this site publishes as it was, and a window that could not be read leaves the
// stored items as they were: the mirror goes stale rather than empty, and the pass says which. What the
// pass learned about all three addresses is written in one transaction at the end (state.ts), so the
// ranking the public surfaces read is never one address ahead of the other.
import { heldFor, nextSave, readEndpoints, saveEndpoints, type EndpointRow, type EndpointSave } from "./state.ts";
import { invalidateSnapshot } from "./hot.ts";
import { MIRROR_FULL_READ_MS, mirrorMaxSkewMinutes } from "./config.ts";
import { emptyPass, ensureMirrorSource, reconcileWindow, stampMirrorSource, storeItems, type MirrorPass } from "./mirror.ts";
import { rankingOf, storedHot, storedTopics, type StoredHot, type StoredTopics } from "./snapshot.ts";
import {
  ENDPOINTS, HOT_PATH, HOT_TOPICS_PATH, readSelected, SELECTED_PATH, UPSTREAM_ORIGIN, upstreamJson,
  type UpstreamHot, type UpstreamHotTopics, type WindowStop,
} from "./upstream.ts";

/** What one address's read ended in, as the pass reports it and the owner's alerts read it. */
export interface EndpointRead {
  endpoint: string;
  /** The status this pass got; null when the address was held off or its read threw. */
  status: number | null;
  /** Entries or items the answer held; null when there was no answer to count. */
  count: number | null;
  /** Seconds the address is held off for, by a Retry-After of this pass or of an earlier one. */
  held: number | null;
  error: string | null;
}

export type PassReport = {
  reason: string;
  startedAt: string;
  finishedAt: string;
  /** The mirror's source is paused in the admin, so nothing was read at all. */
  paused: boolean;
  endpoints: EndpointRead[];
  /** Pages of the window read; 0 on a 304 and when the address was held off. */
  pages: number;
  /** The window had not changed since the last pass. */
  unchanged: boolean;
  /** The window read here is not the whole window: see `stopReason` for which page stopped it. */
  truncated: boolean;
  stopReason: WindowStop | null;
  /**
   * How far apart, in minutes, the readings this pass leaves in place were each last read. Null until every
   * address has an answer of its own. Above `mirrorMaxSkewMinutes()` the published ranking is a mix of two
   * moments, which the pass states instead of hiding.
   */
  skewMinutes: number | null;
  items: MirrorPass;
  /** 完整窗口对账后按上游明确撤选撤下的镜像条数；partial 窗口恒为 0。 */
  withdrawn: number;
  /** What went wrong or looked odd, in the order it happened; the run is `partial` when this is not empty. */
  problems: string[];
};

/** The wait a Retry-After asked for, as the moment the address may be read again. */
const holdUntil = (seconds: number | null, now: Date): Date | null =>
  seconds ? new Date(now.getTime() + seconds * 1000) : null;

const secondsFrom = (until: Date | null, now: Date): number | null =>
  until ? Math.max(0, Math.ceil((until.getTime() - now.getTime()) / 1000)) : null;

/**
 * The minutes between the newest and the oldest of the readings a pass leaves in place. Null while fewer
 * than two addresses have an answer of their own: one reading is not a spread.
 */
function skewOf(saves: readonly EndpointSave[]): number | null {
  const times = saves.flatMap((save) => (save.lastOkAt ? [save.lastOkAt.getTime()] : []));
  if (times.length < 2) return null;
  return Math.round((Math.max(...times) - Math.min(...times)) / 60_000);
}

interface RankingRead<S> {
  save: EndpointSave;
  read: EndpointRead;
  /** The reading to publish: this pass's, or the stored one when this pass got no usable answer. */
  value: S | null;
}

/**
 * One ranking address, read and narrowed. A 304 keeps the stored reading and its ETag. An answer that
 * narrows to nothing — a 200 whose body holds no entries — is recorded as a problem and leaves the stored
 * reading in place with its ETag dropped, so the next pass reads the address again instead of holding an
 * empty reading as the current one.
 */
async function readRanking<T, S>(
  endpoint: string,
  previous: EndpointRow | null,
  now: Date,
  origin: string,
  narrow: (answer: T | null) => S | null,
  countOf: (stored: S) => number,
  problems: string[],
): Promise<RankingRead<S>> {
  const kept = (previous?.answer ?? null) as S | null;
  const held = heldFor(previous, now);
  if (held) {
    return {
      save: nextSave(previous, endpoint, {}),
      read: { endpoint, status: null, count: previous?.lastCount ?? null, held, error: null },
      value: kept,
    };
  }
  try {
    const answer = await upstreamJson<T>(endpoint, previous?.etag, origin);
    if (answer.status === 304) {
      return {
        save: nextSave(previous, endpoint, { lastStatus: 304, lastOkAt: now, lastAttemptAt: now, lastError: null, policy: answer.policy ?? undefined }),
        read: { endpoint, status: 304, count: previous?.lastCount ?? null, held: null, error: null },
        value: kept,
      };
    }
    if (answer.status !== 200) {
      const until = holdUntil(answer.retryAfter, now);
      const error = `HTTP ${answer.status}，等待 ${answer.retryAfter ?? 0} 秒`;
      problems.push(`${endpoint} ${error}，本次跳过`);
      return {
        save: nextSave(previous, endpoint, { lastStatus: answer.status, lastAttemptAt: now, holdUntil: until, lastError: error, policy: answer.policy ?? undefined }),
        read: { endpoint, status: answer.status, count: previous?.lastCount ?? null, held: secondsFrom(until, now), error },
        value: kept,
      };
    }
    const stored = narrow(answer.data);
    if (!stored) {
      problems.push(`${endpoint} 答了 200 但没有可用的条目，保留上一次的读数`);
      // 畸形 200 不刷新有效性：last_ok_at 仍是上一次真正读到内容的时间，旧快照不冒充“刚成功”。
      return {
        save: nextSave(previous, endpoint, { etag: null, lastStatus: 200, lastCount: 0, lastAttemptAt: now, lastError: "answer held no entries", policy: answer.policy ?? undefined }),
        read: { endpoint, status: 200, count: 0, held: null, error: "answer held no entries" },
        value: kept,
      };
    }
    const count = countOf(stored);
    return {
      save: nextSave(previous, endpoint, {
        etag: answer.etag, holdUntil: null, lastStatus: 200, lastCount: count, lastOkAt: now, lastAttemptAt: now, contentAt: now, lastError: null,
        policy: answer.policy, answer: stored,
      }),
      read: { endpoint, status: 200, count, held: null, error: null },
      value: stored,
    };
  } catch (error) {
    const message = String(error).slice(0, 400);
    problems.push(`${endpoint} 读取失败：${message}`);
    return {
      save: nextSave(previous, endpoint, { lastStatus: null, lastAttemptAt: now, lastError: message }),
      read: { endpoint, status: null, count: previous?.lastCount ?? null, held: null, error: message },
      value: kept,
    };
  }
}

/**
 * One pass. `reason` is what the run is recorded as ("schedule", or the admin's manual fetch). Nothing
 * here throws on an unreadable upstream: the pass reports it, and the stored mirror stays as it was.
 * `origin` is only ever another address of the same catalogue (a test's stub); egress stays guarded.
 */
export async function mirrorOnce(reason: string, now = new Date(), origin: string = UPSTREAM_ORIGIN): Promise<PassReport> {
  const out: PassReport = {
    reason, startedAt: now.toISOString(), finishedAt: now.toISOString(), paused: false,
    endpoints: [], pages: 0, unchanged: false, truncated: false, stopReason: null, skewMinutes: null,
    items: emptyPass(), withdrawn: 0, problems: [],
  };
  if (!(await ensureMirrorSource()).enabled) {
    out.paused = true;
    out.problems.push("镜像信源已在后台暂停，本次未读取");
    out.finishedAt = new Date().toISOString();
    return out;
  }
  const rows = await readEndpoints(ENDPOINTS);
  const saves: EndpointSave[] = [];

  const hot = await readRanking<UpstreamHot, StoredHot>(HOT_PATH, rows.get(HOT_PATH) ?? null, now, origin, storedHot, (s) => s.entries.length, out.problems);
  const topics = await readRanking<UpstreamHotTopics, StoredTopics>(HOT_TOPICS_PATH, rows.get(HOT_TOPICS_PATH) ?? null, now, origin, storedTopics, (s) => s.count, out.problems);
  saves.push(hot.save, topics.save);
  out.endpoints.push(hot.read, topics.read);

  // The rankings are read before the window, so the items this pass stores carry the covers and the places
  // the rankings of the same pass name for them.
  const ranking = rankingOf(topics.value, hot.value);
  const previousWindow = rows.get(SELECTED_PATH) ?? null;
  const held = heldFor(previousWindow, now);
  if (held) {
    saves.push(nextSave(previousWindow, SELECTED_PATH, {}));
    out.endpoints.push({ endpoint: SELECTED_PATH, status: null, count: previousWindow?.lastCount ?? null, held, error: null });
  } else {
    // 第一页的 ETag 只承诺第一页：距上次完整读取超过对账间隔就无条件全量重读，后页的更正不会被 304 无限期挡住。
    const reconcileDue = !previousWindow?.fullReadAt || now.getTime() - previousWindow.fullReadAt.getTime() >= MIRROR_FULL_READ_MS;
    const window = await readSelected(reconcileDue ? null : previousWindow?.etag ?? null, origin).catch((error: unknown) => {
      out.problems.push(`${SELECTED_PATH} 读取失败：${String(error)}`);
      return null;
    });
    if (!window) {
      saves.push(nextSave(previousWindow, SELECTED_PATH, { lastStatus: null, lastAttemptAt: now, lastError: "read failed" }));
      out.endpoints.push({ endpoint: SELECTED_PATH, status: null, count: previousWindow?.lastCount ?? null, held: null, error: "read failed" });
    } else if (window.wait) {
      const until = holdUntil(window.wait, now);
      const error = `要求等待 ${window.wait} 秒`;
      out.problems.push(`${SELECTED_PATH} ${error}，本次跳过`);
      out.stopReason = window.stopReason;
      out.truncated = window.truncated;
      saves.push(nextSave(previousWindow, SELECTED_PATH, { lastStatus: 429, lastAttemptAt: now, holdUntil: until, lastError: error }));
      out.endpoints.push({ endpoint: SELECTED_PATH, status: 429, count: null, held: secondsFrom(until, now), error });
    } else if (window.unchanged) {
      out.unchanged = true;
      out.stopReason = window.stopReason;
      // 304 确认窗口未变（有效验证），但不是新内容的生成：content_at 不动。
      saves.push(nextSave(previousWindow, SELECTED_PATH, { etag: window.etag, holdUntil: null, lastStatus: 304, lastOkAt: now, lastAttemptAt: now, lastError: null }));
      out.endpoints.push({ endpoint: SELECTED_PATH, status: 304, count: previousWindow?.lastCount ?? null, held: null, error: null });
    } else {
      out.pages = window.pages;
      out.stopReason = window.stopReason;
      out.truncated = window.truncated;
      out.items = await storeItems(window.items, ranking, now);
      if (out.items.skipped) out.problems.push(`${out.items.skipped} 条未入库（缺标题、缺中文摘要、缺原文链接，或同一地址已属于本站别的信源）`);
      // A window upstream still had more of is stored as far as it reached and said out loud, with its ETag
      // dropped so the next pass reads from the start: a short read must not be kept as the whole window.
      const stopped = window.truncated
        ? `truncated: ${window.stopReason === "max-pages" ? `读到第 ${window.pages} 页上游仍说有更多` : "分页中途断了"}，本次入库 ${window.items.length} 条，下次从头再读`
        : null;
      if (stopped) out.problems.push(`${SELECTED_PATH} ${stopped}`);
      // 有可重试的未应用项就不确认这个版本：丢掉 ETag，下一轮无条件重读，上游始终 304 也能补齐。
      if (out.items.failed) out.problems.push(`${SELECTED_PATH} ${out.items.failed} 条入库失败（可重试），本次不确认窗口版本，下次重读补齐`);
      // 只有完整窗口才对账成员：缺席于完整精选且仍在窗口年龄内的是上游明确撤选；partial 绝不按缺席撤稿。
      if (!window.truncated && window.items.length) {
        out.withdrawn = (await reconcileWindow(window.items, now)).withdrawn;
      }
      // A page that did not answer leaves the ETag alone (readSelected), so the next pass reads from the start.
      saves.push(nextSave(previousWindow, SELECTED_PATH, {
        etag: out.items.failed ? null : window.etag, holdUntil: null, lastStatus: 200, lastCount: window.items.length,
        lastOkAt: now, lastAttemptAt: now, contentAt: out.items.stored ? now : undefined,
        fullReadAt: window.truncated ? undefined : now, lastError: stopped ?? (out.items.failed ? "items failed" : null),
      }));
      out.endpoints.push({ endpoint: SELECTED_PATH, status: 200, count: window.items.length, held: null, error: stopped ?? (out.items.failed ? "items failed" : null) });
    }
  }

  // The three readings are each allowed to keep an older answer, so the ranking published from them can be
  // two moments joined together. The spread is measured and stated; above the module's own limit the pass is
  // `partial`, which is what the owner's alerts read.
  out.skewMinutes = skewOf(saves);
  if (out.skewMinutes !== null && out.skewMinutes > mirrorMaxSkewMinutes()) {
    out.problems.push(`三个地址的读数相差 ${out.skewMinutes} 分钟，本次发布的榜单是混合快照`);
  }

  await saveEndpoints(saves);
  await stampMirrorSource(out.endpoints, out.problems.length);
  // A pass that ran in this process (the administrator's manual fetch) leaves the surfaces reading what it
  // just wrote instead of the reading they cached before it.
  invalidateSnapshot();
  out.finishedAt = new Date().toISOString();
  return out;
}
