// The industry-mirror module's addresses: none. It adds no page and no route of its own — what it brings
// in is served by the engine's own surfaces (the hot ranking through ServerModule.hot, the mirrored
// reports through the ordinary pool and item pages). Its backend plugs in through server.ts
// (site/modules/server.ts); it has no web.tsx, so site/modules/web.ts does not list it.
import { defineModule } from "@aihot/contracts/modules";

export default defineModule({ name: "aihot" });
