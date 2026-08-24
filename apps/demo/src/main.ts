import { CwiRenderer } from 'cwi-web';
import { validate, assignColors, speakerStats, type CwiManifest, type Issue, type Character } from 'cwi-core';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const stage = $('stage');
const video = $<HTMLVideoElement>('vid');
const capture = $('capture');

/**
 * Two sources: a synthetic scene that exercises every mechanic in the spec, and
 * a real HeyGen render put through the full pipeline (SRT + audio -> alignment
 * -> acoustics -> manifest). The second one is the point — it is machine
 * generated end to end, from a provider that never heard of this spec.
 */
const SOURCES = {
  sample: { manifest: '/sample.cwi.json', video: '/scene.mp4', label: 'synthetic scene, original dialogue' },
  heygen: { manifest: '/heygen.cwi.json', video: '/heygen.mp4', label: 'HeyGen render, captions derived by the pipeline' },
  control: { manifest: '/control-room.cwi.json', video: '/control-room.mp4', label: 'four HeyGen renders merged; attribution across four speakers' },
} as const;
type SourceKey = keyof typeof SOURCES;

let pristineCast: Character[] = [];
let manifest: CwiManifest = { cwi: '1.0', characters: [], cues: [] };
let duration = 1;

const renderer = new CwiRenderer(capture, {});

// --- Timebase ----------------------------------------------------------
// The demo owns the clock and pushes the video to follow it. That keeps the
// caption clock authoritative even if the media element stalls, and mirrors how
// an editor integration works: the NLE playhead leads, captions follow.
let t = 0, playing = false, last = performance.now();
let bound = false;

async function loadSource(key: SourceKey): Promise<void> {
  const src = SOURCES[key];
  playing = false;
  $('play').textContent = 'Play';
  $('play').dataset.on = 'false';
  video.pause();
  bound = false;

  const m = await fetch(src.manifest).then((r) => r.json()) as CwiManifest;
  pristineCast = m.characters.map((c) => ({ ...c, color: undefined }));
  manifest = m;
  duration = Math.max(...m.cues.map((c) => c.end)) + 1;
  $<HTMLInputElement>('scrub').max = String(duration);
  t = 0;
  $<HTMLInputElement>('scrub').value = '0';

  video.src = src.video;
  renderer.observe(video);
  video.addEventListener('loadedmetadata', () => { bound = true; renderer.seek(t); }, { once: true });
  // Some demo media is deliberately not committed (see .gitignore). Captions
  // still render on their own, so say what happened rather than showing black.
  video.addEventListener('error', () => {
    console.info(`[cwi] ${src.video} is unavailable — captions render without picture. ` +
      'See README "Regenerating the demo media".');
  }, { once: true });

  reassign();
  renderer.seek(0);
}

function frame(now: number) {
  const dt = Math.min((now - last) / 1000, 0.1); last = now;
  if (playing) {
    t += dt;
    if (t >= duration) t = 0;
    $<HTMLInputElement>('scrub').value = String(t);
    // Nudge the video back in step only on genuine drift, so we are not
    // issuing a seek every frame.
    if (bound && Math.abs(video.currentTime - t) > 0.25) video.currentTime = t;
  }
  renderer.seek(t);
  $('time').textContent = `${t.toFixed(2)} / ${duration.toFixed(2)}`;
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

$('play').onclick = async () => {
  playing = !playing;
  $('play').textContent = playing ? 'Pause' : 'Play';
  $('play').dataset.on = String(playing);
  if (bound) { if (playing) await video.play().catch(() => {}); else video.pause(); }
};

$<HTMLInputElement>('scrub').oninput = (e) => {
  t = +(e.target as HTMLInputElement).value;
  if (bound) video.currentTime = t;
  renderer.seek(t);
};

document.querySelectorAll<HTMLButtonElement>('button[data-src]').forEach((b) => {
  b.onclick = async () => {
    document.querySelectorAll<HTMLButtonElement>('button[data-src]').forEach((x) => (x.dataset.on = 'false'));
    b.dataset.on = 'true';
    await loadSource(b.dataset.src as SourceKey);
  };
});

// Expose for debugging and for host integrations poking at the instance.
(window as unknown as Record<string, unknown>).cwi = { renderer, get manifest() { return manifest; } };

// --- Colour-vision simulation -----------------------------------------
// Filter the whole stage, so the caption colours degrade exactly as they would
// for a viewer with that deficiency.
const FILTERS: Record<string, string> = { none: '', prot: 'url(#f-prot)', deut: 'url(#f-deut)', trit: 'url(#f-trit)' };
$('cvd').querySelectorAll<HTMLButtonElement>('button').forEach((b) => {
  b.onclick = () => {
    $('cvd').querySelectorAll<HTMLButtonElement>('button').forEach((x) => (x.dataset.on = 'false'));
    b.dataset.on = 'true';
    stage.style.filter = FILTERS[b.dataset.cvd!];
    document.querySelectorAll<HTMLElement>('.sw').forEach((s) => (s.style.filter = FILTERS[b.dataset.cvd!]));
  };
});

// --- Editorial toggles -------------------------------------------------
let mono = false, cvdSafe = true;
$('mono').onclick = () => {
  mono = !mono;
  $('mono').dataset.on = String(mono);
  renderer.setOptions({ monochrome: mono });
};
$('cvdsafe').onclick = () => {
  cvdSafe = !cvdSafe;
  $('cvdsafe').dataset.on = String(cvdSafe);
  reassign();
};

function reassign() {
  if (!pristineCast.length) return;
  const { characters, warnings } = assignColors(pristineCast, { cvdSafe });
  manifest = { ...manifest, characters };
  renderer.load(manifest);
  renderAside(warnings);
}

// --- Spec parameter sliders -------------------------------------------
const bind = (id: string, out: string, fmt: (v: number) => string, apply: (v: number) => void) => {
  const el = $<HTMLInputElement>(id);
  const o = $(out);
  const run = () => { const v = +el.value; o.textContent = fmt(v); apply(v); };
  el.oninput = run; run();
};
bind('base', 'baseO', (v) => v.toFixed(1), (v) => renderer.setOptions({ baselineSizePct: v }));
bind('pop', 'popO', (v) => v.toFixed(2), (v) => renderer.setOptions({ popScale: v }));
bind('box', 'boxO', (v) => v.toFixed(2), (v) => renderer.setOptions({ boxOpacity: v }));
bind('ra', 'raO', (v) => v.toFixed(2), (v) => renderer.setOptions({ readAheadOpacity: v }));

// --- Cast + validation panel ------------------------------------------
function renderAside(extra: string[] = []) {
  const stats = speakerStats(manifest.cues);
  $('cast').innerHTML = manifest.characters.map((c) => {
    const s = stats.get(c.id);
    return `<div>
      <span class="sw" style="background:${c.color}"></span>
      <span>${c.name ?? c.id}</span>
      <span class="tier">${c.tier}${s ? ` · ${s.words}w` : ''}</span>
    </div>`;
  }).join('');

  const issues: Issue[] = validate(manifest);
  const all = [
    ...extra.map((m): Issue => ({ severity: 'warning', code: 'assign', message: m })),
    ...issues,
  ];
  $('issues').innerHTML = all.length
    ? all.map((i) => `<div class="issue ${i.severity}"><code>${i.code}${i.ref ? ` · ${i.ref}` : ''}</code>${i.message}</div>`).join('')
    : '<div class="clean">No issues.</div>';

  const errs = all.filter((i) => i.severity === 'error').length;
  const warns = all.filter((i) => i.severity === 'warning').length;
  const tokens = manifest.cues.reduce((n, c) => n + c.lines.reduce((k, l) => k + l.tokens.length, 0), 0);
  $('stat').textContent = `${manifest.cues.length} cues · ${tokens} tokens · ${errs} errors, ${warns} warnings`;

  // Re-apply the active CVD filter to the freshly drawn swatches.
  const on = $('cvd').querySelector<HTMLButtonElement>('button[data-on="true"]');
  if (on) document.querySelectorAll<HTMLElement>('.sw').forEach((s) => (s.style.filter = FILTERS[on.dataset.cvd!]));
}

await loadSource('sample');
