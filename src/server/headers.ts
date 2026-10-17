import type { ServerResponse } from "node:http";

/** Pages a visitor sees. Nothing on them runs script, so nothing is allowed to. */
const PUBLIC_CSP = "default-src 'none'; img-src * data:; style-src 'unsafe-inline'; form-action *; base-uri 'none'"; // forms only post to this site's own endpoints, which may live on another host than the page (custom site domain)
/** What the dashboard really uses: its own scripts and styles, inline style attributes, sandboxed previews, SSE and fetch to itself. */
const DASHBOARD_CSP = "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; font-src 'self'; connect-src 'self'; frame-src 'self'; form-action 'self'; base-uri 'none'";

const PUBLIC_PAGES = /^\/(p|subscribe|confirm|login|magic|poll|s|u)(\/|$)/;

export interface HeaderInfo {
  pathname: string;
  /** The request came in on the publication's own domain, where the website lives at /. */
  siteDomain: boolean;
  https: boolean;
  /** The subscribe form meant to sit inside other sites: /subscribe?embed=1, and the page its POST answers with. */
  embed: boolean;
}

/**
 * Headers every response carries. Set up front, so a handler that writes its own headers still overrides them.
 * Framing: the website (/p) may be shown inside the dashboard preview, and the embedded subscribe form can sit on any site;
 * everything else refuses to be framed.
 */
export function securityHeaders(res: ServerResponse, o: HeaderInfo): void {
  res.setHeader("x-content-type-options", "nosniff");
  res.setHeader("referrer-policy", "strict-origin-when-cross-origin");
  if (o.https) res.setHeader("strict-transport-security", "max-age=31536000");

  const dashboard = o.pathname === "/app" || o.pathname.startsWith("/app/");
  const embeddable = o.pathname === "/subscribe" && o.embed;
  const sameOrigin = !dashboard && (o.siteDomain || o.pathname === "/p" || o.pathname.startsWith("/p/"));
  const ancestors = embeddable ? "" : sameOrigin ? "frame-ancestors 'self'" : "frame-ancestors 'none'";
  if (!embeddable) res.setHeader("x-frame-options", sameOrigin ? "SAMEORIGIN" : "DENY");

  let csp = "";
  if (dashboard) csp = DASHBOARD_CSP;
  else if (o.siteDomain || PUBLIC_PAGES.test(o.pathname)) csp = PUBLIC_CSP;
  const policy = [csp, ancestors].filter(Boolean).join("; ");
  if (policy) res.setHeader("content-security-policy", policy);
}
