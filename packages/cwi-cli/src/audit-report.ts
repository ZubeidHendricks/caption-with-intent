/**
 * Renderings of an audit report.
 *
 * The HTML is self-contained — no fonts, no scripts, no network — because a
 * compliance artifact gets archived, emailed and opened years later on machines
 * that will not fetch anything. It must still be readable then.
 */
import type { AuditReport } from './audit.js';
import type { Verdict } from './criteria.js';

const VERDICT_LABEL: Record<Verdict, string> = {
  pass: 'Pass', fail: 'Fail', warn: 'Warning', review: 'Needs review',
};

export function toMarkdown(r: AuditReport): string {
  const L: string[] = [];
  L.push(`# Caption accessibility audit — ${r.title}`, '');
  L.push(`> ${r.disclaimer}`, '');
  L.push('| | |', '|---|---|');
  L.push(`| Manifest | \`${r.manifest.path}\` |`);
  L.push(`| SHA-256 | \`${r.manifest.sha256}\` |`);
  L.push(`| Generated | ${r.generated} |`);
  L.push(`| Tool | cwi ${r.toolVersion} |`);
  L.push(`| Spec | ${r.specVersion} |`);
  L.push(`| Content | ${r.counts.characters} characters, ${r.counts.cues} cues, ${r.counts.tokens} tokens, ${r.counts.captionedSeconds}s captioned |`);
  L.push('');
  L.push(`**${r.summary.fail} failing · ${r.summary.warn} warning · ${r.summary.review} needs review · ${r.summary.pass} passing**`, '');

  for (const group of groupByFramework(r)) {
    L.push(`## ${group.framework}`, '');
    for (const f of group.findings) {
      L.push(`### ${VERDICT_LABEL[f.verdict]} — ${f.criterion.id} ${f.criterion.title} (${f.criterion.level})`, '');
      L.push(`> ${f.criterion.requirement}`, '');
      L.push(f.detail, '');
      if (f.remediation) L.push(`**Remediation.** ${f.remediation}`, '');
      L.push(`*Assessed:* ${f.criterion.assessment} — ${f.criterion.method}`, '');
    }
  }

  L.push('## Cast', '', '| Character | Colour | Words | Seconds |', '|---|---|---|---|');
  for (const c of r.cast) L.push(`| ${c.name} | \`${c.color ?? '—'}\` | ${c.words} | ${c.seconds} |`);
  L.push('');
  return L.join('\n');
}

export function toHtml(r: AuditReport): string {
  const esc = (s: string) => s.replace(/[&<>"]/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));

  const badge = (v: Verdict) => `<span class="b b-${v}">${VERDICT_LABEL[v]}</span>`;

  const groups = groupByFramework(r).map((g) => `
    <section>
      <h2>${esc(g.framework)}</h2>
      ${g.findings.map((f) => `
        <article class="f f-${f.verdict}">
          <header>
            ${badge(f.verdict)}
            <h3>${esc(f.criterion.id)} · ${esc(f.criterion.title)}</h3>
            <span class="lvl">${esc(f.criterion.level)}</span>
          </header>
          <blockquote>${esc(f.criterion.requirement)}</blockquote>
          <p>${esc(f.detail)}</p>
          ${f.remediation ? `<p class="rem"><strong>Remediation.</strong> ${esc(f.remediation)}</p>` : ''}
          <p class="meth"><em>Assessed: ${esc(f.criterion.assessment)}</em> — ${esc(f.criterion.method)}</p>
        </article>`).join('')}
    </section>`).join('');

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Caption accessibility audit — ${esc(r.title)}</title>
<style>
  :root{--ink:#1a1c1e;--dim:#5c6166;--line:#dfe3e6;--bg:#fff;
        --pass:#1a7f4b;--fail:#b3261e;--warn:#8a5a00;--review:#3b5bdb}
  @media (prefers-color-scheme:dark){:root{--ink:#e6e8ea;--dim:#9aa0a6;--line:#2b2f33;--bg:#131517;
        --pass:#5ecf8f;--fail:#ff8a80;--warn:#ffc46b;--review:#8ba4ff}}
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--ink);
       font:16px/1.6 ui-serif,Georgia,'Times New Roman',serif;padding:48px 24px}
  main{max-width:820px;margin:0 auto}
  h1{font-size:28px;line-height:1.25;margin:0 0 6px}
  h2{font-size:13px;text-transform:uppercase;letter-spacing:.10em;color:var(--dim);
     margin:44px 0 14px;font-family:ui-sans-serif,system-ui,sans-serif;font-weight:600}
  h3{font-size:17px;margin:0;font-weight:600}
  .disc{border-left:3px solid var(--warn);background:color-mix(in srgb,var(--warn) 8%,transparent);
        padding:12px 16px;margin:20px 0;font-size:14px;font-family:ui-sans-serif,system-ui,sans-serif}
  table{border-collapse:collapse;width:100%;font-size:14px;
        font-family:ui-sans-serif,system-ui,sans-serif;margin:20px 0}
  th,td{text-align:left;padding:7px 10px;border-bottom:1px solid var(--line);vertical-align:top}
  th{color:var(--dim);font-weight:600;width:150px}
  code{font:13px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;word-break:break-all}
  .tally{display:flex;gap:10px;flex-wrap:wrap;margin:22px 0;
         font-family:ui-sans-serif,system-ui,sans-serif;font-size:14px}
  .tally div{padding:8px 14px;border:1px solid var(--line);border-radius:4px}
  .tally strong{font-size:20px;display:block;line-height:1.2}
  .f{border:1px solid var(--line);border-left-width:4px;border-radius:4px;
     padding:16px 18px;margin:0 0 14px}
  .f-pass{border-left-color:var(--pass)} .f-fail{border-left-color:var(--fail)}
  .f-warn{border-left-color:var(--warn)} .f-review{border-left-color:var(--review)}
  .f header{display:flex;align-items:baseline;gap:10px;flex-wrap:wrap;margin-bottom:10px}
  .lvl{margin-left:auto;color:var(--dim);font-size:13px;
       font-family:ui-sans-serif,system-ui,sans-serif}
  .b{font:600 11px/1 ui-sans-serif,system-ui,sans-serif;text-transform:uppercase;
     letter-spacing:.07em;padding:5px 9px;border-radius:3px;color:#fff;white-space:nowrap}
  .b-pass{background:var(--pass)} .b-fail{background:var(--fail)}
  .b-warn{background:var(--warn)} .b-review{background:var(--review)}
  blockquote{margin:0 0 12px;padding-left:14px;border-left:2px solid var(--line);
             color:var(--dim);font-style:italic}
  .rem{background:color-mix(in srgb,var(--ink) 5%,transparent);padding:10px 14px;border-radius:4px}
  .meth{font-size:13px;color:var(--dim);font-family:ui-sans-serif,system-ui,sans-serif}
  .sw{display:inline-block;width:26px;height:13px;border-radius:2px;vertical-align:middle;
      border:1px solid var(--line)}
  footer{margin-top:52px;padding-top:18px;border-top:1px solid var(--line);
         color:var(--dim);font-size:13px;font-family:ui-sans-serif,system-ui,sans-serif}
  @media print{body{padding:0}.f{break-inside:avoid}}
</style></head><body><main>
<h1>Caption accessibility audit</h1>
<p style="margin:0;color:var(--dim)">${esc(r.title)}</p>
<div class="disc">${esc(r.disclaimer)}</div>
<table>
  <tr><th>Manifest</th><td><code>${esc(r.manifest.path)}</code></td></tr>
  <tr><th>SHA-256</th><td><code>${esc(r.manifest.sha256)}</code></td></tr>
  <tr><th>Generated</th><td>${esc(r.generated)}</td></tr>
  <tr><th>Tool</th><td>cwi ${esc(r.toolVersion)}</td></tr>
  <tr><th>Spec</th><td>${esc(r.specVersion)}</td></tr>
  <tr><th>Content</th><td>${r.counts.characters} characters · ${r.counts.cues} cues · ${r.counts.tokens} tokens · ${r.counts.captionedSeconds}s captioned</td></tr>
</table>
<div class="tally">
  <div><strong>${r.summary.fail}</strong>failing</div>
  <div><strong>${r.summary.warn}</strong>warning</div>
  <div><strong>${r.summary.review}</strong>needs review</div>
  <div><strong>${r.summary.pass}</strong>passing</div>
</div>
${groups}
<section><h2>Cast</h2><table>
  <tr><th>Character</th><th>Colour</th><th>Words</th><th>Seconds</th></tr>
  ${r.cast.map((c) => `<tr><td>${esc(c.name)}</td>
    <td><span class="sw" style="background:${esc(c.color ?? 'transparent')}"></span>
        <code>${esc(c.color ?? '—')}</code></td>
    <td>${c.words}</td><td>${c.seconds}</td></tr>`).join('')}
</table></section>
<footer>Generated by cwi ${esc(r.toolVersion)}. The SHA-256 above identifies the exact manifest
audited; re-running against a different manifest produces a different hash.</footer>
</main></body></html>`;
}

function groupByFramework(r: AuditReport) {
  const order = ['WCAG 2.2', 'EN 301 549', 'FCC 47 CFR 79.1', 'CWI V1.0'];
  return order
    .map((framework) => ({
      framework,
      findings: r.findings.filter((f) => f.criterion.framework === framework)
        .sort((a, b) => rank(a.verdict) - rank(b.verdict)),
    }))
    .filter((g) => g.findings.length);
}

const rank = (v: Verdict) => ({ fail: 0, warn: 1, review: 2, pass: 3 }[v]);
