// Runs the same daily RSS liveness probe on demand.
//   node --env-file=.env scripts/probe-rss.ts
import { closeDb } from "@aihot/backend/db";
import { stopBoss } from "@aihot/backend/jobs/queue";
import { probeRssSources } from "@aihot/backend/sources/rss-health";

const summary = await probeRssSources();
console.log(JSON.stringify(summary, null, 2));
await stopBoss();
await closeDb();
process.exit(summary.failed > 0 || summary.unreachable > 0 ? 1 : 0);
