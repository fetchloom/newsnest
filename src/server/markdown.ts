// Small Markdown renderer that emits inline-styled HTML (email clients ignore <style>).
// Supports: # headings, paragraphs, **bold**, *italic*, ~~strike~~, `code`, ``` fences,
// [links](url), ![images](url), [[Buttons]](url), > quotes, lists, --- rules and raw HTML lines.

export type Styles = Record<"p" | "h1" | "h2" | "h3" | "a" | "button" | "img" | "code" | "pre" | "hr" | "blockquote" | "list" | "li", string>;

export const esc = (s: string): string =>
  String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const FONT = `-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif`;

export const defaultStyles: Styles = {
  p: "margin:0 0 16px;",
  h1: `margin:8px 0 16px;font:700 26px/1.25 ${FONT};color:#09090b;letter-spacing:-0.02em;`,
  h2: `margin:26px 0 12px;font:700 20px/1.3 ${FONT};color:#09090b;`,
  h3: `margin:22px 0 10px;font:600 17px/1.35 ${FONT};color:#09090b;`,
  a: "color:#18181b;text-decoration:underline;",
  button: "display:inline-block;background:#18181b;color:#ffffff;text-decoration:none;font-weight:600;padding:11px 20px;border-radius:8px;margin:4px 0;",
  img: "display:block;max-width:100%;height:auto;border:0;border-radius:8px;margin:8px 0;",
  code: "font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:0.9em;background:#f4f4f5;padding:2px 5px;border-radius:4px;",
  pre: "font:13px/1.55 ui-monospace,SFMono-Regular,Menlo,monospace;background:#f4f4f5;padding:14px 16px;border-radius:8px;overflow:auto;margin:0 0 16px;white-space:pre-wrap;",
  hr: "border:0;border-top:1px solid #e4e4e7;margin:26px 0;",
  blockquote: "margin:0 0 16px;padding:2px 0 2px 16px;border-left:3px solid #18181b;color:#52525b;",
  list: "margin:0 0 16px;padding-left:22px;",
  li: "margin:0 0 6px;",
};

function safeUrl(u: string): string {
  // u is already HTML-escaped
  if (/^(https?:|mailto:|tel:|#|\/)/i.test(u) || /^\{\{[a-z0-9_.|\s]+\}\}$/i.test(u)) return u;
  if (/^[a-z][a-z0-9+.-]*:/i.test(u)) return "#"; // javascript:, data:, etc.
  return "https://" + u;
}

function emphasis(s: string): string {
  return s
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/__([^_]+)__/g, "<strong>$1</strong>")
    .replace(/(^|[^*\w])\*([^*\s](?:[^*]*[^*\s])?)\*(?!\w)/g, "$1<em>$2</em>")
    .replace(/(^|[^_\w])_([^_\s](?:[^_]*[^_\s])?)_(?!\w)/g, "$1<em>$2</em>")
    .replace(/~~([^~]+)~~/g, "<s>$1</s>");
}

function inline(src: string, st: Styles): string {
  const stash: string[] = [];
  const keep = (html: string): string => `\u0001${stash.push(html) - 1}\u0001`;
  let s = src.replace(/`([^`]+)`/g, (_, c: string) => keep(`<code style="${st.code}">${esc(c)}</code>`));
  s = esc(s);
  s = s.replace(/\[\[([^\]]+)\]\]\(([^)\s]+)\)/g, (_, t: string, u: string) => keep(`<a href="${safeUrl(u)}" style="${st.button}">${emphasis(t)}</a>`));
  s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (_, alt: string, u: string) => keep(`<img src="${safeUrl(u)}" alt="${alt}" style="${st.img}">`));
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, t: string, u: string) => keep(`<a href="${safeUrl(u)}" style="${st.a}">${emphasis(t)}</a>`));
  s = s.replace(/&lt;((?:https?:\/\/|mailto:)[^\s&]+)&gt;/g, (_, u: string) => keep(`<a href="${u}" style="${st.a}">${u}</a>`));
  s = emphasis(s);
  return s.replace(/\u0001(\d+)\u0001/g, (_, i: string) => stash[Number(i)]);
}

const RE = {
  blank: /^\s*$/,
  fence: /^\s*```/,
  heading: /^(#{1,3})\s+(.*)$/,
  hr: /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/,
  quote: /^\s*>\s?/,
  ul: /^\s*[-*+]\s+/,
  ol: /^\s*\d+[.)]\s+/,
  html: /^\s*<\/?(?:div|table|tr|td|p|h\d|img|a|center|span|br|hr|section|ul|ol|li|strong|em|figure|!--)[\s>/]/i,
};
const isBlockStart = (l: string): boolean =>
  RE.fence.test(l) || RE.heading.test(l) || RE.hr.test(l) || RE.quote.test(l) || RE.ul.test(l) || RE.ol.test(l) || RE.html.test(l);

export function render(md: string, st: Styles = defaultStyles): string {
  const lines = String(md ?? "").replace(/\r\n?/g, "\n").split("\n");
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    let m: RegExpExecArray | null;
    if (RE.blank.test(line)) { i++; continue; }
    if (RE.fence.test(line)) {
      const buf: string[] = [];
      i++;
      while (i < lines.length && !RE.fence.test(lines[i])) buf.push(lines[i++]);
      i++;
      out.push(`<pre style="${st.pre}"><code>${esc(buf.join("\n"))}</code></pre>`);
      continue;
    }
    if ((m = RE.heading.exec(line))) {
      const n = m[1].length as 1 | 2 | 3;
      out.push(`<h${n} style="${st[`h${n}`]}">${inline(m[2], st)}</h${n}>`);
      i++; continue;
    }
    if (RE.hr.test(line)) { out.push(`<hr style="${st.hr}">`); i++; continue; }
    if (RE.quote.test(line)) {
      const buf: string[] = [];
      while (i < lines.length && RE.quote.test(lines[i])) buf.push(lines[i++].replace(RE.quote, ""));
      out.push(`<blockquote style="${st.blockquote}">${render(buf.join("\n"), st)}</blockquote>`);
      continue;
    }
    if (RE.ul.test(line) || RE.ol.test(line)) {
      const ordered = RE.ol.test(line);
      const re = ordered ? RE.ol : RE.ul;
      const items: string[] = [];
      while (i < lines.length && (re.test(lines[i]) || (/^\s{2,}\S/.test(lines[i]) && items.length))) {
        if (re.test(lines[i])) items.push(lines[i].replace(re, ""));
        else items[items.length - 1] += " " + lines[i].trim();
        i++;
      }
      const tag = ordered ? "ol" : "ul";
      out.push(`<${tag} style="${st.list}">${items.map((t) => `<li style="${st.li}">${inline(t, st)}</li>`).join("")}</${tag}>`);
      continue;
    }
    if (RE.html.test(line)) {
      const buf: string[] = [];
      while (i < lines.length && !RE.blank.test(lines[i])) buf.push(lines[i++]);
      out.push(buf.join("\n"));
      continue;
    }
    const buf: string[] = [];
    while (i < lines.length && !RE.blank.test(lines[i]) && (buf.length === 0 || !isBlockStart(lines[i]))) buf.push(lines[i++]);
    out.push(`<p style="${st.p}">${buf.map((l) => inline(l, st)).join("<br>\n")}</p>`);
  }
  return out.join("\n");
}

/** Plain-text alternative for the multipart email. */
export function toText(md: string): string {
  return String(md ?? "")
    .replace(/\r\n?/g, "\n")
    .replace(/^\s*```.*$/gm, "")
    .replace(/^#{1,3}\s+(.*)$/gm, (_, t: string) => t.toUpperCase())
    .replace(/\[\[([^\]]+)\]\]\(([^)\s]+)\)/g, "$1: $2")
    .replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, "")
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, "$1 ($2)")
    .replace(/\*\*([^*]+)\*\*|__([^_]+)__/g, "$1$2")
    .replace(/~~([^~]+)~~/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/^\s*>\s?/gm, "  ")
    .replace(/^\s*[-*+]\s+/gm, "• ")
    .replace(/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/gm, "————")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|h\d|li|tr)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function htmlToText(html: string): string {
  return toText(
    String(html ?? "")
      .replace(/<(style|script|head)[\s\S]*?<\/\1>/gi, "")
      .replace(/<a\s[^>]*href="([^"]+)"[^>]*>(.*?)<\/a>/gis, "$2 ($1)"),
  );
}

/** Wraps rendered Markdown in a minimal, readable email shell. */
export function markdownDocument(subject: string, md: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(subject)}</title></head>
<body style="margin:0;padding:0;background:#ffffff;">
<div style="max-width:600px;margin:0 auto;padding:32px 20px;font:16px/1.65 ${FONT};color:#27272a;">
${render(md)}
</div></body></html>`;
}
