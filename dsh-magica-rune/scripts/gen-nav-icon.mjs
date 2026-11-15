import fs from "node:fs";
const RAW = "D:/project-code/llm/madoka/dsh-magica-rune/docs/raw/a.md";
const OUT = "D:/project-code/llm/madoka/dsh-magica-rune/src/client/nav-icon.ts";
const src = fs.readFileSync(RAW, "utf8");
const lines = src.split(/\r?\n/);
const svgLine = lines.find(l => l.trimStart().startsWith("<svg xmlns='http://www.w3.org/2000/svg' width='18'"));
if (!svgLine) throw new Error("svg line not found");
const svg = svgLine.trim();
if (!svg.endsWith("</svg>")) throw new Error("svg line truncated? len=" + svg.length);
const uri = svg.replace(/</g, "%3C").replace(/>/g, "%3E").replace(/"/g, "'");
console.error("svg bytes=" + svg.length + " uri bytes=" + uri.length);
const ts = `/**
 * Settings nav icon: replace the shell's fallback gear with the wrench+screwdriver
 * glyph taken verbatim from docs/raw/a.md 10.1 (same viewBox, same path data).
 *
 * settings.section has no \`icon\` field in 0.2, so the shell falls back to a gear.
 * We mark the target button with an attribute and paint a ::before masked box;
 * neither touches React-managed DOM, and background:currentColor makes the glyph
 * follow the nav label colour in light/dark/hover/active automatically.
 * @module dsh-magica-rune/client/nav-icon
 */

const MARKER = 'data-dsh-magica-rune-nav'
const STYLE_ID = 'dsh-magica-rune-nav-icon'

/** raw a.md 10.1 SVG, percent-encoded for CSS url() (single quotes, no base64). */
const SLIDERS_SVG =
  ${JSON.stringify(uri)}

const NAV_CSS =
  \`[\${MARKER}] > svg:first-child{display:none}\` +
  \`[\${MARKER}]::before{content:'';flex:none;width:16px;height:16px;\` +
  \`background:currentColor;\` +
  \`-webkit-mask:url("\${SLIDERS_SVG}") center / contain no-repeat;\` +
  \`mask:url("\${SLIDERS_SVG}") center / contain no-repeat}\`

export function setupNavIcon(label: () => string): () => void {
  if (document.getElementById(STYLE_ID) === null) {
    const el = document.createElement('style')
    el.id = STYLE_ID
    el.textContent = NAV_CSS
    document.head.appendChild(el)
  }

  let disposed = false
  const sync = (): void => {
    if (disposed) return
    const want = label().trim()
    for (const button of document.querySelectorAll<HTMLButtonElement>('[role="dialog"] nav button')) {
      if ((button.textContent ?? '').trim() === want) button.setAttribute(MARKER, '')
      else button.removeAttribute(MARKER)
    }
  }

  sync()
  const observer = new MutationObserver(sync)
  observer.observe(document.body, { childList: true, subtree: true, characterData: true })

  return () => {
    disposed = true
    observer.disconnect()
    for (const button of document.querySelectorAll(\`[\${MARKER}]\`)) button.removeAttribute(MARKER)
    document.getElementById(STYLE_ID)?.remove()
  }
}
`;
fs.writeFileSync(OUT, ts, { encoding: "utf8" });
console.error("written " + OUT + " " + Buffer.byteLength(ts) + " bytes");