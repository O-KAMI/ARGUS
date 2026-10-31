// Wordmark 的 size 是字标高度；RingMark 只用于加载与空状态。
import { useId } from "react";
import { SITE } from "../site.ts";

export function BrandMark({ size = 24, className = "" }: { size?: number; className?: string }) {
  const id = useId().replace(/:/g, "");
  const clip = `argus-eye-${id}`;
  const pupil = `argus-pupil-${id}`;
  const ink = `argus-ink-${id}`;
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" className={className} aria-hidden="true" focusable="false">
      <defs>
        <clipPath id={clip}><circle cx="32" cy="33" r="25" /></clipPath>
        <radialGradient id={pupil} cx="35%" cy="28%" r="72%">
          <stop offset="0" stopColor="#777972" />
          <stop offset=".28" stopColor="#242521" />
          <stop offset="1" stopColor="#080908" />
        </radialGradient>
        <linearGradient id={ink} x1="8" y1="8" x2="54" y2="56" gradientUnits="userSpaceOnUse">
          <stop stopColor="#11120f" />
          <stop offset=".58" stopColor="currentColor" />
          <stop offset="1" stopColor="currentColor" stopOpacity=".38" />
        </linearGradient>
      </defs>
      <circle cx="32" cy="33" r="24.8" fill="var(--paper-light, #FBF9F4)" />
      <g clipPath={`url(#${clip})`}>
        <path d="M3 39 14 31 21 35 31 25 40 35 48 29 62 40V64H3Z" fill="currentColor" opacity=".12" />
        <path d="M1 46 12 38 20 43 30 31 39 43 47 37 63 47V64H1Z" fill="currentColor" opacity=".26" />
        <path d="M0 53 13 44 22 50 33 39 43 50 51 45 64 52V64H0Z" fill="currentColor" opacity=".5" />
        <path d="M0 60 16 51 26 57 38 48 49 57 64 52V64H0Z" fill="currentColor" opacity=".82" />
        <path d="M8 42c12-3 24-2 37 0s14 2 20 0" fill="none" stroke="var(--paper-light, #FBF9F4)" strokeWidth="2.2" opacity=".7" />
      </g>
      <path d="M54.5 18.5C50 9.5 40 4.5 29.5 6 16 7.8 6.5 18 6 31.5 5.5 45.5 15.5 57 29 58.5c10.5 1.2 21-4.2 25.5-13.5" fill="none" stroke={`url(#${ink})`} strokeWidth="5.8" strokeLinecap="round" />
      <path d="M53 15.5C46 5 30 2.5 18 9M8 23C4 37 11 51 24 56M41 55c7-2 12-6 15-12" fill="none" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" opacity=".48" />
      <circle cx="34" cy="21" r="8.7" fill={`url(#${pupil})`} />
      <circle cx="31.2" cy="17.6" r="2.5" fill="#fff" opacity=".92" />
      <circle cx="54.5" cy="22" r="2.1" fill="currentColor" opacity=".85" />
    </svg>
  );
}

export function Wordmark({ size = 24, className = "", title = SITE.name, layout = "horizontal" }: { size?: number; className?: string; title?: string; layout?: "horizontal" | "vertical" }) {
  const showSubtitle = size >= 20;
  return (
    <span className={`inline-flex ${layout === "vertical" ? "flex-col gap-[0.55em]" : "items-center gap-[0.48em]"} leading-none ${className}`} aria-label={title} role="img">
      <BrandMark size={Math.round(size * 1.12)} className="shrink-0" />
      <span className={`flex flex-col justify-center ${layout === "vertical" ? "items-center" : ""}`}>
        <span aria-hidden="true" className="font-medium tracking-[0.12em] text-ink" style={{ fontFamily: "Georgia, 'Times New Roman', serif", fontSize: Math.round(size * 0.82) }}>
          {SITE.name}
        </span>
        {showSubtitle && (
          <span aria-hidden="true" className="mt-[0.42em] font-medium tracking-[0.24em] text-ink-4" style={{ fontSize: Math.max(7, Math.round(size * 0.22)) }}>
            AI INTELLIGENCE HUB
          </span>
        )}
      </span>
    </span>
  );
}

export function RingMark({ className = "", spinning = false }: { className?: string; spinning?: boolean }) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden="true">
      <g style={spinning ? { transformOrigin: "12px 12px", animation: "spin-slow 1.1s linear infinite" } : undefined}>
        <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeDasharray="42 15" />
      </g>
      <circle cx="12" cy="12" r="2.4" fill="var(--seal-red, #B65E52)" />
    </svg>
  );
}
