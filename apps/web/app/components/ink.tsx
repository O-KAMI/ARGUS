import lockupPrimary from "../assets/ink/lockup-primary.webp";
import mark from "../assets/ink/mark.webp";
import heroWide from "../assets/ink/hero-wide.webp";
import dateCard from "../assets/ink/date-card.webp";
import sealGuan from "../assets/ink/seal-guan.png";
import favicon from "../assets/ink/favicon-64.png";
import appleIcon from "../assets/ink/apple-icon-180.png";
import iconDaily from "../assets/ink/i-daily.png";
import iconHot from "../assets/ink/i-hot.png";
import iconAi from "../assets/ink/i-ai.png";
import iconAgent from "../assets/ink/i-agent.png";
import iconLlm from "../assets/ink/i-llm.png";
import iconUi from "../assets/ink/i-ui.png";
import iconTools from "../assets/ink/i-tools.png";
import iconLearn from "../assets/ink/i-learn.png";
import iconSearch from "../assets/ink/i-search.png";

/** The brand's ink drawings, cut from the delivery pack's sheets; night reads them as negatives (app.css). */
export const INK = {
  lockupPrimary,
  mark,
  heroWide,
  dateCard,
  sealGuan,
  favicon,
  appleIcon,
};

export const INK_ICONS = {
  daily: iconDaily,
  hot: iconHot,
  ai: iconAi,
  agent: iconAgent,
  llm: iconLlm,
  ui: iconUi,
  tools: iconTools,
  learn: iconLearn,
  search: iconSearch,
} as const;

export type InkIconName = keyof typeof INK_ICONS;

export function InkIcon({ name, size = 18, className = "" }: { name: InkIconName; size?: number; className?: string }) {
  return (
    <img
      src={INK_ICONS[name]}
      alt=""
      aria-hidden="true"
      width={size}
      height={size}
      decoding="async"
      style={{ width: size, height: size }}
      className={`ink-mono shrink-0 select-none object-contain ${className}`}
    />
  );
}

/** The header's mark + wordmark as one drawing; the link around it carries the name. */
export function InkLockup({ height, className = "" }: { height: number; className?: string }) {
  return (
    <img
      src={lockupPrimary}
      alt=""
      width={Math.round(height * 2.623)}
      height={height}
      decoding="async"
      style={{ height }}
      className={`ink-mono w-auto select-none ${className}`}
    />
  );
}
