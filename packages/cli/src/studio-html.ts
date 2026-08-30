/**
 * The Studio page.
 *
 * One file, no build step, no bundler, no framework. That is a deliberate
 * constraint rather than minimalism for its own sake: this ships inside a CLI
 * package, and a page that needed compiling would need a toolchain in the
 * tarball and would rot the first time that toolchain moved.
 *
 * The renderer is the real one, imported from @corerus/chorus-web and served by
 * the studio server. What the operator previews is what the export writes,
 * because it is the same code drawing it.
 *
 * **This interface has to meet the standard the product enforces.** A tool that
 * audits other people's captions against WCAG and ships an inaccessible UI is
 * not a serious tool. So: every control has a real label, focus is visible and
 * never removed, status changes are announced through a live region rather than
 * only appearing, colour is never the only carrier of a verdict — the words
 * "ok", "check" and "stopped" carry it too — and the whole flow works from the
 * keyboard.
 */
export function studioHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Chorus Studio</title>
<style>
  :root {
    --bg:#0b0d11; --panel:#141820; --raise:#1b202a; --line:#28303d; --ink:#e9edf3;
    --dim:#98a3b5; --accent:#9E60FB; --ok:#A8F906; --warn:#FCE99C; --bad:#E95935;
    --radius:10px;
  }
  @media (prefers-reduced-motion: no-preference) {
    .fade { animation: fade .18s ease-out; }
    @keyframes fade { from { opacity:0; transform:translateY(3px) } to { opacity:1 } }
  }
  * { box-sizing:border-box; }
  body {
    margin:0; background:var(--bg); color:var(--ink);
    font:15px/1.55 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;
  }
  /* Focus is never removed, only made legible. Removing it is the single most
     common way a web app becomes unusable without a mouse. */
  :focus-visible { outline:2px solid var(--accent); outline-offset:2px; border-radius:4px; }
  header {
    padding:16px 24px; border-bottom:1px solid var(--line);
    display:flex; align-items:baseline; gap:14px; flex-wrap:wrap;
  }
  h1 { font-size:17px; margin:0; font-weight:620; letter-spacing:-.01em; }
  .sub { color:var(--dim); font-size:13px; }
  .grow { flex:1 }
  main { display:grid; grid-template-columns:minmax(340px,400px) 1fr; min-height:calc(100vh - 57px); }
  @media (max-width:900px) { main { grid-template-columns:1fr } aside { border-right:0 } }
  aside { border-right:1px solid var(--line); padding:20px; overflow-y:auto; }
  section.stage { padding:20px 24px; }
  .step { margin-bottom:20px; padding-bottom:18px; border-bottom:1px solid var(--line); }
  .step:last-child { border-bottom:0; margin-bottom:0; }
  h2 {
    font-size:11.5px; text-transform:uppercase; letter-spacing:.09em;
    color:var(--dim); margin:0 0 10px; font-weight:640;
  }
  .drop {
    border:1.5px dashed var(--line); border-radius:var(--radius); padding:20px 16px;
    text-align:center; color:var(--dim); cursor:pointer; width:100%;
    background:transparent; font:inherit; display:block;
  }
  .drop:hover,.drop.over { border-color:var(--accent); color:var(--ink); background:#191426; }
  .drop strong { display:block; color:var(--ink); font-weight:560; margin-bottom:2px; }
  button {
    font:inherit; font-weight:560; padding:9px 15px; border-radius:8px;
    border:1px solid var(--line); background:var(--raise); color:var(--ink); cursor:pointer;
  }
  button:hover:not(:disabled) { border-color:#3a4557; }
  button.primary { background:var(--accent); border-color:var(--accent); color:#160a24; }
  button:disabled { opacity:.45; cursor:not-allowed; }
  .frame {
    position:relative; background:#000; border-radius:var(--radius); overflow:hidden;
    aspect-ratio:16/9; max-height:60vh; margin:0 auto;
  }
  .frame video { width:100%; height:100%; display:block; }
  /* Fullscreen applies to the frame, not the video, so the captions come with
     it. Without these the frame keeps its 16/9 box inside a black screen. */
  .frame:fullscreen { aspect-ratio:auto; max-height:none; width:100vw; height:100vh;
    border-radius:0; display:flex; align-items:center; justify-content:center; }
  .frame:fullscreen video { width:100%; height:100%; object-fit:contain; }
  .note { color:var(--dim); font-size:13px; margin:8px 0 0; }
  .bad{color:var(--bad)} .ok{color:var(--ok)} .warn{color:var(--warn)}
  .bar { height:5px; background:var(--line); border-radius:3px; overflow:hidden; margin-top:10px; }
  .bar i { display:block; height:100%; background:var(--accent); width:0; transition:width .2s; }
  table { width:100%; border-collapse:collapse; font-size:13.5px; }
  td { padding:6px 4px; border-bottom:1px solid var(--line); vertical-align:middle; }
  .swatch { width:14px; height:14px; border-radius:4px; display:inline-block; flex:none; }
  select,input[type=text] {
    font:inherit; background:var(--panel); color:var(--ink);
    border:1px solid var(--line); border-radius:7px; padding:7px 9px; width:100%;
  }
  input[type=text]:hover { border-color:#3a4557; }
  .row { display:flex; gap:8px; align-items:center; }
  .hidden { display:none !important; }
  code { background:var(--raise); padding:1px 5px; border-radius:4px; font-size:12.5px; }
  /* The team's stage log. The verdict is a word as well as a colour, because
     colour alone is exactly the failure this product exists to fix. */
  .stages { list-style:none; margin:12px 0 0; padding:0; }
  .stages li { display:flex; gap:10px; padding:7px 0; border-bottom:1px solid var(--line); }
  .stages li:last-child { border-bottom:0 }
  .verdict {
    font-size:11px; font-weight:700; letter-spacing:.05em; text-transform:uppercase;
    padding:2px 7px; border-radius:5px; flex:none; height:fit-content; min-width:62px;
    text-align:center; border:1px solid;
  }
  .v-ok{color:var(--ok);border-color:#3d5a08;background:#18220a}
  .v-warn{color:var(--warn);border-color:#5c5326;background:#221f0f}
  .v-stop{color:var(--bad);border-color:#6b2a1a;background:#26120d}
  .stages b { font-weight:560; display:block; }
  .stages span { color:var(--dim); font-size:12.5px; }
  .plan {
    background:var(--panel); border:1px solid var(--line); border-radius:var(--radius);
    padding:14px; margin-bottom:18px;
  }
  .plan .row { justify-content:space-between; align-items:baseline; }
  .plan h3 { margin:0; font-size:14px; font-weight:600; }
  .usage { height:6px; background:var(--line); border-radius:3px; overflow:hidden; margin:10px 0 6px; }
  .usage i { display:block; height:100%; background:var(--ok); }
  .usage i.over { background:var(--warn); }
  /* Visible only to screen readers: status that must be announced but would be
     noise on screen. */
  .sr { position:absolute; width:1px; height:1px; overflow:hidden; clip:rect(0 0 0 0); white-space:nowrap; }
</style>
</head>
<body>
<header>
  <h1>Chorus Studio</h1>
  <span class="sub">captions that carry who is speaking, and how</span>
  <span class="grow"></span>
  <span class="sub" id="privacy">everything stays on this machine</span>
</header>

<main>
<aside aria-label="Controls">
  <div class="plan hidden" id="planBox">
    <div class="row">
      <h3 id="planName">Free</h3>
      <button id="upgrade" style="padding:5px 11px;font-size:13px">Upgrade</button>
    </div>
    <div class="usage"><i id="usageBar"></i></div>
    <p class="note" id="usageText" style="margin-top:0"></p>
  </div>

  <div class="step">
    <h2>1 &middot; Video</h2>
    <button class="drop" id="dropVideo" aria-describedby="videoNote">
      <strong>Drop a video</strong>
      or press to choose a file
    </button>
    <p class="note" id="videoNote" role="status"></p>
  </div>

  <div class="step">
    <h2>2 &middot; The words</h2>
    <button class="drop" id="dropSubs" aria-describedby="subsNote">
      <strong>Drop a subtitle file</strong>
      SRT or WebVTT &mdash; optional
    </button>
    <p class="note" id="subsNote" role="status"></p>
    <p class="note" id="asrNote"></p>
  </div>

  <div class="step">
    <h2>3 &middot; Design</h2>
    <label for="profile" class="sr">Caption design profile</label>
    <select id="profile">
      <option value="chorus-1.0">Chorus 1.0 &mdash; colour-vision safe, position + mark</option>
      <option value="cwi-1.0">Caption with Intention 1.0 &mdash; the published design</option>
    </select>
    <p class="note">Chorus separates speakers by more than hue, so no pair depends on
       colour alone. V1.0 is here to author conformant material or to compare.</p>

    <label class="row" style="margin-top:10px;cursor:pointer">
      <input type="checkbox" id="diarize" style="width:auto">
      <span class="note" style="margin:0">Try to tell speakers apart by voice</span>
    </label>
    <p class="note hidden" id="diarizeNote">Approximate. It separates voices that
       differ in pitch and misses two people in a similar range &mdash; including,
       often, a narrator against someone on camera. Check the cast before exporting.
       Labelled subtitles are exact; this is a guess.</p>

    <button class="primary" id="go" disabled style="margin-top:12px;width:100%">Add captions</button>
    <div class="bar hidden" id="bar"><i></i></div>
    <p class="note" id="status" role="status" aria-live="polite"></p>
  </div>

  <div class="step hidden" id="stagesStep">
    <h2>What the team found</h2>
    <ul class="stages" id="stages"></ul>
    <p class="note hidden" id="openNote"></p>
  </div>

  <div class="step hidden" id="castStep">
    <h2>Cast</h2>
    <p class="note" style="margin-top:0">Rename anyone. Nothing knows that Speaker 2
       is the interviewer; you do.</p>
    <table id="cast"><tbody id="castBody"></tbody></table>
    <p class="note hidden" id="castSaved" role="status"></p>
  </div>

  <div class="step hidden" id="exportStep">
    <h2>4 &middot; Export</h2>
    <div class="row">
      <button class="primary" id="export">Burn into the video</button>
      <button id="exportAlpha">Overlay only</button>
    </div>
    <p class="note">An overlay is a transparent ProRes 4444 track for an editor.
       Burning in produces a finished MP4.</p>
    <p class="note" id="exportNote" role="status"></p>
  </div>
</aside>

<section class="stage" aria-label="Preview">
  <div class="frame" id="frame">
    <video id="video" controls playsinline></video>
  </div>
  <p class="note" id="hint">Drop in a video. The words come from a subtitle file or
     from speech recognition; who is speaking, how loudly and at what pitch come
     from the soundtrack.</p>
  <div id="langRow" class="row hidden" style="margin-top:12px">
    <label for="lang" class="note" style="margin:0">Subtitle language</label>
    <select id="lang" style="width:auto"></select>
  </div>
  <p class="sr" id="announce" role="status" aria-live="polite"></p>
</section>
</main>

<script type="importmap">
{"imports":{
  "@corerus/chorus-core": "/vendor/core/index.js",
  "@corerus/chorus-web": "/vendor/web/index.js"
}}
</script>
<script type="module">
import { CwiRenderer } from '@corerus/chorus-web';

const $ = (id) => document.getElementById(id);
const state = { job:null, subtitles:null, manifest:null, renderer:null };
const say = (m) => { $('announce').textContent = m; };

// --- environment ------------------------------------------------------------
const env = await (await fetch('/api/environment')).json();
if (!env.ok) {
  $('asrNote').innerHTML = '<span class="bad">The analysis environment is not ready: '
    + env.detail.join('; ') + '</span>';
} else if (!env.asr) {
  $('asrNote').innerHTML = 'No speech recognition installed, so a subtitle file is '
    + 'required. <code>pip install faster-whisper</code> to transcribe here instead.';
} else if (env.asr === 'whisperx') {
  $('asrNote').innerHTML = '<span class="ok">WhisperX available</span> &mdash; a subtitle '
    + 'file is optional. It transcribes and separates speakers.';
} else {
  $('asrNote').innerHTML = '<span class="ok">faster-whisper available</span> &mdash; a '
    + 'subtitle file is optional. It does not identify <em>who</em> is speaking, so a '
    + 'transcribed track has one speaker until you label them.';
}

// --- plan -------------------------------------------------------------------
// Billing is optional: the local app runs without any of it, and the panel
// simply does not appear.
try {
  const plan = await (await fetch('/api/plan')).json();
  if (plan && plan.plan) {
    $('planBox').classList.remove('hidden');
    $('planName').textContent = plan.plan.label;
    const used = plan.minutesUsed, inc = plan.plan.includedMinutes;
    const pct = inc ? Math.min(100, (used / inc) * 100) : 0;
    $('usageBar').style.width = pct + '%';
    if (pct >= 100) $('usageBar').classList.add('over');
    $('usageText').textContent = used.toFixed(1) + ' of ' + inc + ' minutes used this period';
    $('upgrade').onclick = () => { window.location.href = plan.upgradeUrl || '/api/checkout'; };
  }
} catch { /* no billing configured */ }

// --- uploads ----------------------------------------------------------------
function dropzone(el, accept, onFile) {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = accept;
  input.className = 'hidden';
  el.after(input);
  el.onclick = () => input.click();
  input.onchange = () => input.files[0] && onFile(input.files[0]);
  el.ondragover = (e) => { e.preventDefault(); el.classList.add('over'); };
  el.ondragleave = () => el.classList.remove('over');
  el.ondrop = (e) => {
    e.preventDefault();
    el.classList.remove('over');
    if (e.dataTransfer.files[0]) onFile(e.dataTransfer.files[0]);
  };
}

dropzone($('dropVideo'), 'video/*', async (file) => {
  $('videoNote').textContent = 'uploading ' + (file.size / 1e6).toFixed(0) + ' MB…';
  const r = await fetch('/api/upload?name=' + encodeURIComponent(file.name), { method:'POST', body:file });
  const out = await r.json();
  if (out.error) { $('videoNote').innerHTML = '<span class="bad">' + out.error + '</span>'; return; }
  state.job = out.id;
  $('videoNote').textContent = out.name + ' · ' + (out.size / 1e6).toFixed(0) + ' MB';
  $('video').src = '/media/' + out.id;
  say('Video loaded.');
  refreshGo();
});

dropzone($('dropSubs'), '.srt,.vtt,text/plain', async (file) => {
  if (!state.job) { $('subsNote').innerHTML = '<span class="bad">Add the video first.</span>'; return; }
  const r = await fetch('/api/subtitles?id=' + state.job + '&name=' + encodeURIComponent(file.name),
    { method:'POST', body:file });
  const out = await r.json();
  if (out.error) { $('subsNote').innerHTML = '<span class="bad">' + out.error + '</span>'; return; }
  state.subtitles = out.path;
  $('subsNote').textContent = out.entries + ' entries · “' + out.first + '…”';
  say(out.entries + ' subtitle entries loaded.');
  refreshGo();
});

function refreshGo() { $('go').disabled = !state.job || (!state.subtitles && !env.asr); }

$('diarize').onchange = () => $('diarizeNote').classList.toggle('hidden', !$('diarize').checked);

// --- run the team -----------------------------------------------------------
$('go').onclick = async () => {
  $('go').disabled = true;
  $('bar').classList.remove('hidden');
  $('stages').innerHTML = '';
  $('stagesStep').classList.remove('hidden');
  say('Working.');
  await fetch('/api/analyze', {
    method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ id:state.job, subtitles:state.subtitles, asr:env.asr,
                           profile:$('profile').value, diarize:$('diarize').checked }),
  });
  poll();
};

const WORD = { ok:'ok', warn:'check', stop:'stopped' };

function drawStages(stages) {
  if (!stages) return;
  const ul = $('stages');
  ul.innerHTML = '';
  for (const s of stages) {
    const li = document.createElement('li');
    li.className = 'fade';
    const v = document.createElement('span');
    v.className = 'verdict v-' + s.verdict;
    // The word, not only the colour. This product exists because colour alone
    // is not an accessible way to say something.
    v.textContent = WORD[s.verdict] ?? s.verdict;
    const body = document.createElement('div');
    const b = document.createElement('b');
    b.textContent = s.stage + ' — ' + s.summary;
    const sp = document.createElement('span');
    sp.textContent = s.advice || s.role;
    body.append(b, sp);
    li.append(v, body);
    ul.appendChild(li);
  }
}

async function poll() {
  const r = await (await fetch('/api/job?id=' + state.job)).json();
  $('status').textContent = r.message ?? '';
  $('bar').querySelector('i').style.width = ((r.progress ?? 0) * 100) + '%';
  drawStages(r.stages);

  if (r.stage === 'failed') {
    $('status').innerHTML = '<span class="bad">' + (r.error ?? 'failed') + '</span>';
    $('go').disabled = false;
    $('bar').classList.add('hidden');
    say('Stopped: ' + (r.error ?? 'failed'));
    return;
  }
  if (r.stage === 'ready' && r.manifest) {
    state.manifest = r.manifest;
    mount(r.manifest);
    if (r.open && r.open.length) {
      $('openNote').classList.remove('hidden');
      $('openNote').innerHTML = '<span class="warn">Still open:</span> ' + r.open.join('; ')
        + '. These do not stop the export; somebody has to answer for them first.';
    }
    $('bar').classList.add('hidden');
    $('exportStep').classList.remove('hidden');
    $('go').disabled = false;
    say('Captions ready. ' + r.message);
    return;
  }
  if (r.stage === 'done') {
    $('exportNote').innerHTML = '<a href="/download/' + state.job + '" download>Download '
      + r.output + '</a>';
    $('bar').classList.add('hidden');
    say('Export ready to download.');
    return;
  }
  setTimeout(poll, 700);
}

// --- preview ----------------------------------------------------------------
function mount(manifest) {
  const video = $('video');
  if (!state.renderer) {
    state.renderer = new CwiRenderer($('frame'));
    state.renderer.bind(video);
  }
  state.renderer.load(manifest);
  $('hint').textContent = manifest.cues.length + ' cues · ' + manifest.characters.length
    + ' speakers · press play';

  drawCast(manifest.characters);
  $('castStep').classList.remove('hidden');

  const langs = state.renderer.languages();
  if (langs.length > 1) {
    $('lang').innerHTML = langs.map((l) => '<option>' + l + '</option>').join('');
    $('lang').onchange = () => state.renderer.setLanguage($('lang').value);
    $('langRow').classList.remove('hidden');
  }
}

function drawCast(characters) {
  const body = $('castBody');
  body.innerHTML = '';
  characters.forEach((c, i) => {
    const tr = document.createElement('tr');

    const sw = document.createElement('td');
    sw.style.width = '22px';
    const dot = document.createElement('span');
    dot.className = 'swatch';
    dot.style.background = c.color;
    dot.setAttribute('role', 'img');
    dot.setAttribute('aria-label', 'colour ' + c.color);
    sw.appendChild(dot);

    const name = document.createElement('td');
    const input = document.createElement('input');
    input.type = 'text';
    input.value = c.name ?? c.id;
    input.setAttribute('aria-label', 'Name for speaker ' + (i + 1));
    input.onchange = () => saveCast();
    name.appendChild(input);

    const where = document.createElement('td');
    where.className = 'note';
    where.style.width = '76px';
    where.textContent = [c.position, c.glyph].filter(Boolean).join(' ');

    tr.append(sw, name, where);
    body.appendChild(tr);
  });
}

async function saveCast() {
  const names = [...$('castBody').querySelectorAll('input')].map((i) => i.value.trim());
  const characters = state.manifest.characters.map((c, i) => ({ id:c.id, name:names[i] || c.id }));
  const r = await (await fetch('/api/cast', {
    method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ id:state.job, characters }),
  })).json();
  if (r.characters) {
    state.manifest.characters = r.characters;
    state.renderer.load(state.manifest);
    $('castSaved').classList.remove('hidden');
    $('castSaved').textContent = 'Cast saved.';
    say('Cast saved.');
  }
}

// --- export -----------------------------------------------------------------
async function doExport(alpha) {
  $('exportNote').textContent = 'rendering — the real renderer, frame by frame';
  $('bar').classList.remove('hidden');
  say('Rendering.');
  await fetch('/api/manifest', {
    method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ id:state.job, manifest:state.manifest }),
  });
  await fetch('/api/export', {
    method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ id:state.job, alpha }),
  });
  poll();
}
$('export').onclick = () => doExport(false);
$('exportAlpha').onclick = () => doExport(true);

// --- fullscreen -------------------------------------------------------------
// The browser's own fullscreen button fullscreens the <video> element. Our
// captions are a sibling of it, not a child, so they are left behind in the
// hidden page and the viewer gets a full-screen video with no captions at all
// — the one moment they most want them. Catch it, back out, and fullscreen the
// frame instead, which contains both.
document.addEventListener('fullscreenchange', async () => {
  if (document.fullscreenElement === $('video')) {
    await document.exitFullscreen();
    await $('frame').requestFullscreen();
  }
  setTimeout(() => state.renderer?.seek($('video').currentTime), 60);
});

// Safari fullscreens video through a separate path that cannot be intercepted
// the same way, so tell the truth rather than silently dropping the captions.
$('video').addEventListener('webkitbeginfullscreen', () => {
  $('hint').innerHTML = '<span class="warn">Safari puts the video into its own '
    + "fullscreen, which leaves the captions behind. Use the frame's fullscreen "
    + 'or a Chromium browser.</span>';
});
</script>
</body>
</html>`;
}
