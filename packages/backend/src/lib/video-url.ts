// Video watch/share/embed addresses name players, whose controls and recommendations are not articles.
export function isVideoPageUrl(input: string): boolean {
  let url: URL;
  try { url = new URL(input); } catch { return false; }
  if (!/^https?:$/.test(url.protocol)) return false;
  const host = url.hostname.toLowerCase();
  if (/^(?:www\.|m\.)?youtube\.com$/.test(host)) {
    return (/^\/watch\/?$/.test(url.pathname) && !!url.searchParams.get("v")) || /^\/(?:shorts|embed|v)\/[^/]+\/?$/.test(url.pathname);
  }
  if (host === "youtu.be") return /^\/[^/]+\/?$/.test(url.pathname);
  if (/^(?:www\.|m\.)?bilibili\.com$/.test(host)) return /^\/video\/(?:BV[a-zA-Z0-9]{10}|av\d+)\/?$/i.test(url.pathname);
  if (host === "b23.tv") return /^\/[a-zA-Z0-9]+\/?$/.test(url.pathname);
  if (host === "vimeo.com" || host === "www.vimeo.com") return /^\/\d+(?:\/[a-zA-Z0-9]+)?\/?$/.test(url.pathname);
  return host === "player.vimeo.com" && /^\/video\/\d+\/?$/.test(url.pathname);
}

/** Stable video identity where the address itself carries the provider's complete ID. */
export function videoIdentityKeyForUrl(input: string): string | null {
  let url: URL;
  try { url = new URL(input.trim()); } catch { return null; }
  if (!/^https?:$/.test(url.protocol)) return null;
  const host = url.hostname.toLowerCase();
  let id: string | null = null;
  if (/^(?:www\.|m\.)?youtube\.com$/.test(host)) {
    if (/^\/watch\/?$/.test(url.pathname)) id = url.searchParams.get("v");
    else id = /^\/(?:shorts|embed|v)\/([a-zA-Z0-9_-]{11})\/?$/.exec(url.pathname)?.[1] ?? null;
    if (id && /^[a-zA-Z0-9_-]{11}$/.test(id)) return `youtube:${id}`;
  } else if (host === "youtu.be") {
    id = /^\/([a-zA-Z0-9_-]{11})\/?$/.exec(url.pathname)?.[1] ?? null;
    if (id) return `youtube:${id}`;
  } else if (/^(?:www\.|m\.)?bilibili\.com$/.test(host)) {
    const bvid = /^\/video\/(BV([a-zA-Z0-9]{10}))\/?$/i.exec(url.pathname)?.[1];
    // Parts (?p=2) belong to the same BV video; another BV is always another material.
    if (bvid) return `bilibili:BV${bvid.slice(2)}`;
  }
  return null;
}
