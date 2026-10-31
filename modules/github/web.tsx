// What the GitHub rankings module adds to the pages: one entry in the desktop sidebar's 资源 section, and a
// row on the 我的 page so phones reach it too (site/modules/web.ts lists this file).
import { defineWebModule } from "@aihot/web/modules";
import { IconGithub } from "@aihot/web/components/icons";

export default defineWebModule({
  name: "github",
  sidebar: {
    section: "资源",
    items: [{ to: "/github", label: "GitHub 开源榜单", icon: IconGithub }],
  },
  tools: [{ to: "/github", label: "GitHub 开源榜单", icon: <IconGithub size={20} /> }],
});
