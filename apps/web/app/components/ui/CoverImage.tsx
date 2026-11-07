// A cover whose source is known can still fail to load (a dead upstream picture, a blocked proxy).
// The slot then carries the given fallback — the title's own card, a heat panel or a brand mark —
// instead of a large broken image; the card's stretched link keeps its click entry either way.
import { useState, type ImgHTMLAttributes, type ReactNode } from "react";

export function CoverImage({ fallback, ...props }: ImgHTMLAttributes<HTMLImageElement> & { fallback: ReactNode }) {
  const [failed, setFailed] = useState(false);
  return failed ? <>{fallback}</> : <img {...props} onError={() => setFailed(true)} />;
}