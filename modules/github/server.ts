// The GitHub open-source rankings module's backend sockets (packages/backend/src/modules.ts): its routes,
// its daily refresh, its queue and its share of the retention run.
import { defineServerModule } from "@aihot/backend/modules";
import { collectionEnabled, githubConfig } from "./backend/config.ts";
import { githubRefreshQueue, refreshGithubRankings } from "./backend/collect.ts";
import { registerGithubRoutes } from "./backend/routes.ts";
import { pruneCollectionRuns, pruneUnseenRepositories } from "./backend/store.ts";

export default defineServerModule({
  name: "github",
  http: registerGithubRoutes,
  schedules: [
    // One refresh a day at 08:00 Beijing time, like every other schedule in the worker. It fetches public
    // pages and a public API, so it follows the engine's collection valve rather than a switch of its own.
    {
      name: "github.refresh",
      cron: githubConfig.refreshCron,
      missed: "once",
      when: collectionEnabled,
      run: () => refreshGithubRankings("schedule"),
    },
  ],
  queues: [githubRefreshQueue],
  retention: async (now) => {
    const day = 86_400_000;
    return {
      github_collection_runs: await pruneCollectionRuns(new Date(now.getTime() - 30 * day)),
      github_repositories_unseen: await pruneUnseenRepositories(new Date(now.getTime() - 365 * day)),
    };
  },
});
