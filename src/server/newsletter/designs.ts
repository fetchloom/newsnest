import { esc } from "../markdown.ts";

// Email designs. A design decides the look of the page around the content (masthead, colours, type, footer) and the
// colours and fonts the blocks inside it use. "plain" is the original quiet layout; the other three are the free designs.

export const DESIGN_IDS = ["plain", "editorial", "modern", "bold"] as const;
export type DesignId = (typeof DESIGN_IDS)[number];

export const DESIGN_INFO: { id: DesignId; name: string; description: string }[] = [
  { id: "plain", name: "Plain", description: "Simple and quiet, like a note from a person." },
  { id: "editorial", name: "Editorial", description: "A magazine masthead, serif type and warm paper. For essays and long reads." },
  { id: "modern", name: "Modern", description: "A clean card with a colour header and rounded buttons. For updates and digests." },
  { id: "bold", name: "Bold", description: "A full-width colour banner and a big headline. For announcements and launches." },
];

export const isDesignId = (v: unknown): v is DesignId => typeof v === "string" && (DESIGN_IDS as readonly string[]).includes(v);

export const fontStack = (f: "sans" | "serif" | "mono"): string =>
  f === "serif" ? "Georgia,'Times New Roman',Times,serif"
    : f === "mono" ? "ui-monospace,SFMono-Regular,Menlo,Consolas,monospace"
      : "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";

/** White or near-black text, whichever reads better on the brand colour. */
export function contrastText(hex: string): string {
  const n = parseInt(hex.slice(1), 16);
  const lum = (0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
  return lum > 0.62 ? "#111111" : "#ffffff";
}

/** The colours and type the content blocks use inside a design. */
export interface Tokens {
  id: DesignId;
  page: string; card: string; text: string; muted: string; line: string; soft: string;
  font: string; headFont: string;
  /** Corner radius for buttons. */
  button: string;
}

const SANS = fontStack("sans");
const SERIF = fontStack("serif");

export function tokens(id: DesignId, pub: { font: "sans" | "serif" | "mono" }): Tokens {
  switch (id) {
    case "editorial":
      return { id, page: "#efe8d8", card: "#fffdf7", text: "#1f1b16", muted: "#7a6f62", line: "#d9cfbd", soft: "#f3ecdd", font: SERIF, headFont: SERIF, button: "0" };
    case "modern":
      return { id, page: "#eef0f5", card: "#ffffff", text: "#111827", muted: "#6b7280", line: "#e5e7eb", soft: "#f3f4f6", font: SANS, headFont: SANS, button: "999px" };
    case "bold":
      return { id, page: "#0b1020", card: "#ffffff", text: "#0f172a", muted: "#64748b", line: "#e2e8f0", soft: "#f1f5f9", font: SANS, headFont: "'Helvetica Neue',Helvetica,Arial,sans-serif", button: "6px" };
    default: {
      const f = fontStack(pub.font);
      return { id: "plain", page: "#f4f4f5", card: "#ffffff", text: "#27272a", muted: "#71717a", line: "#e4e4e7", soft: "#f4f4f5", font: f, headFont: f, button: "8px" };
    }
  }
}

export interface Frame {
  t: Tokens;
  brand: string;
  name: string;
  description: string;
  logoUrl: string | null;
  /** Already merged, plain text. Escaped here. */
  subject: string;
  preheader: string;
  title: string | null;
  /** Rendered block HTML. */
  body: string;
  footerText: string;
  address: string;
  unsubscribeUrl: string;
  viewUrl: string | null;
  date: string;
  pixel: string;
}

const preheader = (f: Frame): string =>
  `<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">${esc(f.preheader)}${"&#847;&zwnj;&nbsp;".repeat(40)}</div>`;

function open(f: Frame): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light only"><title>${esc(f.subject)}</title></head>
<body style="margin:0;padding:0;background:${f.t.page};-webkit-text-size-adjust:100%;">
${preheader(f)}
`;
}

const close = (f: Frame): string => `${f.pixel}</body></html>`;

const shell = (f: Frame, inner: string, pad = "24px 12px", extra = ""): string =>
  `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${f.t.page};"><tr><td align="center" style="padding:${pad};">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:620px;background:${f.t.card};${extra}">
${inner}
</table></td></tr></table>`;

/** The footer lines every design shares. Keeps the exact unsubscribe markup other code depends on. */
function footerLines(f: Frame, link: string): string {
  const footer = f.footerText ? `<div style="margin:0 0 10px;">${esc(f.footerText)}</div>` : "";
  const address = f.address ? `<div style="margin:0 0 10px;">${esc(f.address)}</div>` : "";
  const view = f.viewUrl ? `<a href="${esc(f.viewUrl)}" style="color:${link};">View in browser</a> · ` : "";
  return `${footer}${address}<div>${view}<a href="${esc(f.unsubscribeUrl)}" style="color:${link};">Unsubscribe</a></div>`;
}

const logoImg = (f: Frame, height: number): string => `<img src="${esc(f.logoUrl!)}" alt="${esc(f.name)}" style="display:block;max-height:${height}px;width:auto;border:0;">`;

// ---- plain ----------------------------------------------------------------------
function plain(f: Frame): string {
  const { t } = f;
  const logo = f.logoUrl ? logoImg(f, 40) : `<span style="font:700 16px ${t.font};color:${t.text};letter-spacing:-0.01em;">${esc(f.name)}</span>`;
  const title = f.title ? `<h1 style="margin:0 0 20px;font:700 30px/1.2 ${t.font};color:${t.text};letter-spacing:-0.02em;">${esc(f.title)}</h1>` : "";
  return open(f) + shell(f, `<tr><td style="padding:24px 32px 0;border-top:4px solid ${f.brand};border-radius:12px 12px 0 0;">${logo}</td></tr>
<tr><td style="padding:24px 32px 8px;font:16px/1.65 ${t.font};color:${t.text};">${title}${f.body}</td></tr>
<tr><td style="padding:16px 32px 28px;font:12.5px/1.6 ${t.font};color:${t.muted};border-top:1px solid ${t.line};">${footerLines(f, t.muted)}</td></tr>`, "24px 12px", `border-radius:12px;border:1px solid ${t.line};`) + close(f);
}

// ---- editorial: a magazine masthead on warm paper --------------------------------
function editorial(f: Frame): string {
  const { t } = f;
  const name = f.logoUrl
    ? `<div style="display:inline-block;">${logoImg(f, 56)}</div>`
    : `<div style="font:700 38px/1.1 ${t.headFont};color:${t.text};letter-spacing:-0.01em;">${esc(f.name)}</div>`;
  const tagline = f.description ? `<div style="font:italic 15px/1.5 ${t.font};color:${t.muted};margin-top:8px;">${esc(f.description)}</div>` : "";
  const title = f.title ? `<h1 style="margin:28px 0 6px;font:700 32px/1.2 ${t.headFont};color:${t.text};text-align:center;letter-spacing:-0.01em;">${esc(f.title)}</h1><div style="width:48px;height:2px;background:${f.brand};margin:16px auto 28px;font-size:0;line-height:0;">&nbsp;</div>` : "";
  return open(f) + shell(f, `<tr><td align="center" style="padding:40px 44px 0;text-align:center;">
<div style="font:11px/1 ${t.font};letter-spacing:.18em;text-transform:uppercase;color:${t.muted};margin:0 0 16px;">${esc(f.date)}</div>${name}${tagline}
<div style="border-top:3px double ${t.line};margin-top:26px;font-size:0;line-height:0;">&nbsp;</div></td></tr>
<tr><td style="padding:0 44px 12px;font:17px/1.7 ${t.font};color:${t.text};">${title}${f.body}</td></tr>
<tr><td align="center" style="padding:22px 44px 34px;text-align:center;font:12.5px/1.6 ${t.font};color:${t.muted};border-top:1px solid ${t.line};">${footerLines(f, t.muted)}</td></tr>`, "28px 12px", `border:1px solid ${t.line};`) + close(f);
}

// ---- modern: a card with a colour header ----------------------------------------
function modern(f: Frame): string {
  const { t } = f;
  const ink = contrastText(f.brand);
  const name = f.logoUrl ? logoImg(f, 32) : `<span style="font:700 17px ${t.font};color:${ink};letter-spacing:-0.01em;">${esc(f.name)}</span>`;
  const view = f.viewUrl ? `<a href="${esc(f.viewUrl)}" style="color:${ink};font:12.5px ${t.font};text-decoration:none;opacity:.85;">View in browser</a>` : "";
  const title = f.title
    ? `<div style="font:600 11px/1 ${t.font};letter-spacing:.1em;text-transform:uppercase;color:${f.brand};margin:0 0 12px;">${esc(f.date)}</div><h1 style="margin:0 0 22px;font:800 31px/1.15 ${t.headFont};color:${t.text};letter-spacing:-0.025em;">${esc(f.title)}</h1>` : "";
  return open(f) + shell(f, `<tr><td style="background:${f.brand};padding:22px 32px;border-radius:16px 16px 0 0;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td>${name}</td><td align="right">${view}</td></tr></table></td></tr>
<tr><td style="padding:36px 32px 12px;font:16px/1.65 ${t.font};color:${t.text};">${title}${f.body}</td></tr>
<tr><td style="background:${t.soft};padding:22px 32px 28px;border-radius:0 0 16px 16px;font:12.5px/1.6 ${t.font};color:${t.muted};">${footerLines(f, t.muted)}</td></tr>`, "28px 12px", "border-radius:16px;") + close(f);
}

// ---- bold: a full-width banner with a big headline ------------------------------
function bold(f: Frame): string {
  const { t } = f;
  const ink = contrastText(f.brand);
  const name = f.logoUrl ? logoImg(f, 36) : `<div style="font:700 12px/1 ${t.font};letter-spacing:.16em;text-transform:uppercase;color:${ink};opacity:.8;">${esc(f.name)}</div>`;
  const headline = f.title
    ? `<h1 style="margin:16px 0 0;font:800 40px/1.06 ${t.headFont};color:${ink};letter-spacing:-0.035em;">${esc(f.title)}</h1>`
    : `<div style="height:8px;font-size:0;line-height:0;">&nbsp;</div>`;
  return open(f) + shell(f, `<tr><td style="background:${f.brand};padding:44px 36px 42px;">${name}${headline}</td></tr>
<tr><td style="padding:36px 36px 12px;font:16px/1.7 ${t.font};color:${t.text};">${f.body}</td></tr>
<tr><td style="background:#0b1020;padding:26px 36px 32px;font:12.5px/1.6 ${t.font};color:#9aa3b8;">${footerLines(f, "#cbd3e6")}</td></tr>`, "28px 12px", "border-radius:10px;overflow:hidden;") + close(f);
}

export function composeEmail(id: DesignId, f: Frame): string {
  switch (id) {
    case "editorial": return editorial(f);
    case "modern": return modern(f);
    case "bold": return bold(f);
    default: return plain(f);
  }
}
