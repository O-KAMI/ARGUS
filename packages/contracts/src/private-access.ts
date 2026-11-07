// Whether readers need a signed-in session. The web process gates pages and the api gates reads; both
// must reach the same verdict from the same environment value, so the parse lives here once.
/** Private by default. Only an explicit false opens the site: a typo must fail startup, not publish it. */
export function privateAccessFromEnv(value: string | undefined): boolean {
  if (value === undefined || value === "" || value === "true") return true;
  if (value === "false") return false;
  throw new Error("PRIVATE_ACCESS must be true or false");
}