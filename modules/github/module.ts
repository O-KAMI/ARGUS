// The GitHub open-source rankings module's addresses. Its backend plugs in through server.ts, its pages'
// parts through web.tsx (site/modules/ lists all three). Every path it answers already sits under /api/,
// which the engine claims for the api process (contracts/http-policy.ts ENGINE_API_PATHS), so it names no
// apiPaths of its own.
import { defineModule } from "@aihot/contracts/modules";

export default defineModule({
  name: "github",
  pages: [{ path: "github", file: "web/rankings.tsx" }],
});
