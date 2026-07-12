// src/genex.config.ts — domains derive from the SERVING HOST, so one build runs on dev AND prod
// (promoting a game is a copy, never a rebuild). The dev marker is a config var, not a literal.
// VITE_GENEX_* overrides still win (local dev / explicit stacks).
const DEV_SUFFIX = (import.meta.env.VITE_GENEX_KEY_SUFFIX as string | undefined) ?? "-dev";
const IS_DEV = location.hostname.endsWith(`${DEV_SUFFIX}.genex.technology`);
export const GENEX = {
  slug: import.meta.env.VITE_GENEX_SLUG as string,
  apiUrl:
    (import.meta.env.VITE_GENEX_API_URL as string | undefined) ??
    (IS_DEV ? "https://api-dev.genex.games" : "https://api.genex.games"),
  colyseusUrl:
    (import.meta.env.VITE_GENEX_COLYSEUS_URL as string | undefined) ??
    (IS_DEV ? "wss://relay-dev.genex.games" : "wss://relay.genex.games"),
  dashboardOrigins: (
    (import.meta.env.VITE_GENEX_DASHBOARD_ORIGINS as string | undefined) ??
    (IS_DEV ? "https://dev.genex.games" : "https://genex.games")
  ).split(","),
} as const;
