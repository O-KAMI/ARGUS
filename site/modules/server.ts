// The backend of the site's modules, installed by the api and the worker when they start (site/modules/index.ts).
import type { ServerModule } from "@aihot/backend/modules";
import aihot from "@aihot/aihot/server";
import github from "@aihot/github/server";

export const SERVER_MODULES: readonly ServerModule[] = [aihot, github];
