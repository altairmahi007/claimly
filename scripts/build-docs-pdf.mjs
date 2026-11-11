// Builds docs/Claimly-Guide.pdf from README.md + docs/ARCHITECTURE.md (Mermaid diagrams included).
// No npm dependencies: the page loads marked + mermaid from jsDelivr and headless Chrome prints it.
//   node scripts/build-docs-pdf.mjs            (needs Google Chrome; set CHROME=/path/to/chrome otherwise)
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(path.join(root, p), 'utf8');
const docs = [
  { id: 'guide', md: read('README.md').replace(/\]\(docs\/ARCHITECTURE\.md\)/g, '](#architecture)').replace(/ · \*\*PDF guide:\*\*.*$/m, '') },
  { id: 'architecture', md: read('docs/ARCHITECTURE.md').replace(/\]\(\.\.\/README\.md\)/g, '](#guide)') },
];
const today = new Date().toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Asia/Kolkata' });

const html = `<!doctype html><html><head><meta charset="utf-8"><title>Claimly guide</title>
<style>
  @page { size: A4; margin: 16mm 14mm 18mm; }
  :root { --ink:#1d2433; --muted:#5b6474; --line:#dfe3ea; --accent:#2f5bd3; --code:#f4f6fa; }
  body { font: 10.5pt/1.5 -apple-system, "Segoe UI", Helvetica, Arial, sans-serif; color: var(--ink); background:#fff; margin:0; }
  .cover { height: 250mm; display:flex; flex-direction:column; justify-content:center; padding: 0 10mm; page-break-after: always; }
  .cover .brand { font-size: 40pt; font-weight: 800; letter-spacing:-1px; color: var(--accent); }
  .cover .sub { font-size: 16pt; margin-top: 6mm; }
  .cover .meta { color: var(--muted); margin-top: 14mm; font-size: 10.5pt; line-height:1.8; }
  .cover ol { margin-top: 10mm; font-size: 11pt; }
  section.doc { page-break-before: always; }
  h1 { font-size: 20pt; color: var(--accent); border-bottom: 2px solid var(--accent); padding-bottom: 2mm; margin: 0 0 4mm; }
  h2 { font-size: 14pt; margin: 7mm 0 2mm; border-bottom: 1px solid var(--line); padding-bottom: 1mm; break-after: avoid; }
  h3 { font-size: 11.5pt; margin: 5mm 0 1.5mm; break-after: avoid; }
  p, li { orphans: 3; widows: 3; }
  a { color: var(--accent); text-decoration: none; }
  table { border-collapse: collapse; width: 100%; font-size: 8.8pt; margin: 2mm 0 4mm; break-inside: auto; }
  tr { break-inside: avoid; }
  th, td { border: 1px solid var(--line); padding: 1.2mm 1.8mm; vertical-align: top; text-align: left; }
  th { background: #eef2fb; }
  code { background: var(--code); padding: 0 1mm; border-radius: 2px; font: 8.8pt/1.4 ui-monospace, Menlo, monospace; }
  pre { background: var(--code); padding: 2.5mm 3mm; border-radius: 4px; white-space: pre-wrap; word-break: break-word; break-inside: avoid; border-left: 3px solid var(--accent); }
  pre code { padding: 0; background: none; }
  blockquote { margin: 3mm 0; padding: 1mm 4mm; border-left: 3px solid #f0b429; background: #fff8e6; color: #5a4a14; }
  .mermaid { text-align: center; margin: 3mm 0 5mm; break-inside: avoid; }
  .mermaid svg { max-width: 100% !important; height: auto; max-height: 200mm; }
  hr { border: 0; border-top: 1px solid var(--line); margin: 5mm 0; }
</style></head><body>
<div class="cover">
  <div class="brand">Claimly</div>
  <div class="sub">Expense claims that your Claude files for you</div>
  <div class="meta">User guide · Architecture and implementation notes<br>
    Live app: https://claimly-kce5.onrender.com<br>Source: https://github.com/altairmahi007/claimly<br>Generated ${today}</div>
  <ol><li>User guide: roles, scenarios, MCP tools, example workflows</li><li>Architecture and implementation notes: diagrams, guardrails, data model, history</li></ol>
</div>
${docs.map((d) => `<section class="doc" id="${d.id}"></section>`).join('\n')}
<script id="src" type="application/json">${JSON.stringify(docs).replace(/</g, '\\u003c')}</script>
<script src="https://cdn.jsdelivr.net/npm/marked@12.0.2/marked.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/mermaid@10.9.1/dist/mermaid.min.js"></script>
<script>
(async () => {
  const slug = (t) => t.toLowerCase().trim().replace(/[^\\p{L}\\p{N}\\s-]/gu, '').replace(/\\s/g, '-');
  for (const d of JSON.parse(document.getElementById('src').textContent)) {
    const el = document.getElementById(d.id);
    el.innerHTML = marked.parse(d.md);
    el.querySelectorAll('h1,h2,h3').forEach((h) => { if (!document.getElementById(slug(h.textContent))) h.id = slug(h.textContent); });
    el.querySelectorAll('pre > code.language-mermaid').forEach((c) => {
      const div = document.createElement('div'); div.className = 'mermaid'; div.textContent = c.textContent; c.parentElement.replaceWith(div);
    });
  }
  mermaid.initialize({ startOnLoad: false, theme: 'neutral', securityLevel: 'loose', flowchart: { htmlLabels: true } });
  await mermaid.run({ querySelector: '.mermaid' });
  document.title = 'READY';
})().catch((e) => { document.body.insertAdjacentHTML('afterbegin', '<pre>BUILD ERROR ' + e.message + '</pre>'); document.title = 'ERROR'; });
</script></body></html>`;

const out = path.join(root, 'docs', 'Claimly-Guide.pdf');
const tmp = path.join(root, 'docs', '.guide.html');
writeFileSync(tmp, html);
const chrome = process.env.CHROME || ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/chromium'].find(existsSync);
if (!chrome) throw new Error('Chrome not found; set CHROME=/path/to/chrome');
execFileSync(chrome, ['--headless=new', '--disable-gpu', '--no-pdf-header-footer', '--virtual-time-budget=30000', '--run-all-compositor-stages-before-draw',
  `--print-to-pdf=${out}`, `file://${tmp}`], { stdio: 'inherit' });
console.log(`Wrote ${path.relative(root, out)}`);
