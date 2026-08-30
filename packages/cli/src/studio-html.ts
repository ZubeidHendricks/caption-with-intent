/**
 * The Studio page.
 *
 * One file, no build step, no bundler, no framework. That is a deliberate
 * constraint rather than minimalism for its own sake: this ships inside a CLI
 * package, and a page that needed compiling would need a toolchain in the
 * tarball and would rot the first time that toolchain moved.
 *
 * The renderer itself is the real one, imported from @corerus/chorus-web and
 * served by the studio server. What the operator previews here is what the
 * export writes, because it is the same code drawing it.
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
    --bg: #0d0f13; --panel: #161a21; --line: #262c36; --ink: #e8ecf2;
    --dim: #8a94a6; --accent: #9E60FB; --ok: #A8F906; --warn: #FCE99C; --bad: #E95935;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; background: var(--bg); color: var(--ink);
    font: 15px/1.55 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
  }
  header {
    padding: 18px 24px; border-bottom: 1px solid var(--line);
    display: flex; align-items: baseline; gap: 14px;
  }
  h1 { font-size: 17px; margin: 0; font-weight: 620; letter-spacing: -0.01em; }
  .sub { color: var(--dim); font-size: 13px; }
  main { display: grid; grid-template-columns: 380px 1fr; gap: 0; min-height: calc(100vh - 61px); }
  aside { border-right: 1px solid var(--line); padding: 20px; overflow-y: auto; }
  section.stage { padding: 20px 24px; }
  .step { margin-bottom: 22px; padding-bottom: 20px; border-bottom: 1px solid var(--line); }
  .step:last-child { border-bottom: 0; }
  .step h2 {
    font-size: 12px; text-transform: uppercase; letter-spacing: 0.08em;
    color: var(--dim); margin: 0 0 10px; font-weight: 600;
  }
  .drop {
    border: 1.5px dashed var(--line); border-radius: 10px; padding: 22px 16px;
    text-align: center; color: var(--dim); cursor: pointer; transition: .15s;
  }
  .drop:hover, .drop.over { border-color: var(--accent); color: var(--ink); background: #1a1522; }
  .drop strong { display: block; color: var(--ink); font-weight: 560; margin-bottom: 3px; }
  button {
    font: inherit; font-weight: 560; padding: 9px 16px; border-radius: 8px;
    border: 1px solid var(--line); background: var(--panel); color: var(--ink); cursor: pointer;
  }
  button.primary { background: var(--accent); border-color: var(--accent); color: #14081f; }
  button:disabled { opacity: .4; cursor: not-allowed; }
  button + button { margin-left: 8px; }
  .frame {
    position: relative; background: #000; border-radius: 10px; overflow: hidden;
    aspect-ratio: 16/9; max-height: 62vh; margin: 0 auto;
  }
  .frame video { width: 100%; height: 100%; display: block; }
  /* Fullscreen applies to the frame, not the video, so the captions come with
     it. Without these the frame keeps its 16/9 box and sits in the middle of a
     black screen. */
  .frame:fullscreen { aspect-ratio: auto; max-height: none; width: 100vw; height: 100vh;
    border-radius: 0; display: flex; align-items: center; justify-content: center; }
  .frame:fullscreen video { width: 100%; height: 100%; object-fit: contain; }
  .note { color: var(--dim); font-size: 13px; margin: 8px 0 0; }
  .bad { color: var(--bad); } .ok { color: var(--ok); } .warn { color: var(--warn); }
  .bar { height: 4px; background: var(--line); border-radius: 2px; overflow: hidden; margin-top: 10px; }
  .bar i { display: block; height: 100%; background: var(--accent); width: 0; transition: width .2s; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; margin-top: 8px; }
  td { padding: 5px 4px; border-bottom: 1px solid var(--line); }
  .swatch { width: 13px; height: 13px; border-radius: 3px; display: inline-block; vertical-align: -2px; }
  select, input[type=text] {
    font: inherit; background: var(--panel); color: var(--ink);
    border: 1px solid var(--line); border-radius: 7px; padding: 7px 9px; width: 100%;
  }
  .row { display: flex; gap: 8px; align-items: center; }
  .hidden { display: none; }
  code { background: var(--panel); padding: 1px 5px; border-radius: 4px; font-size: 12.5px; }
</style>
</head>
<body>
<header>
  <h1>Chorus Studio</h1>
  <span class="sub">captions that carry who is speaking and how &mdash; everything stays on this machine</span>
</header>

<main>
<aside>
  <div class="step">
    <h2>1 &middot; Video</h2>
    <div class="drop" id="dropVideo">
      <strong>Drop a video</strong>
      or click to choose
    </div>
    <p class="note" id="videoNote"></p>
  </div>

  <div class="step">
    <h2>2 &middot; The words</h2>
    <div class="drop" id="dropSubs">
      <strong>Drop a subtitle file</strong>
      SRT or WebVTT
    </div>
    <p class="note" id="subsNote"></p>
    <p class="note" id="asrNote"></p>
  </div>

  <div class="step">
    <h2>3 &middot; Design</h2>
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
    <p class="note" id="diarizeNote" style="display:none">Approximate. It separates
       voices that differ in pitch and misses two people in a similar range &mdash;
       including, often, a narrator against someone on camera. Check the cast before
       exporting. Labelled subtitles are exact; this is a guess.</p>
    <button class="primary" id="go" disabled style="margin-top:12px;width:100%">Add captions</button>
    <div class="bar hidden" id="bar"><i></i></div>
    <p class="note" id="status"></p>
  </div>

  <div class="step hidden" id="castStep">
    <h2>Cast</h2>
    <table id="cast"></table>
  </div>

  <div class="step hidden" id="exportStep">
    <h2>4 &middot; Export</h2>
    <div class="row">
      <button class="primary" id="export">Burn into the video</button>
      <button id="exportAlpha">Overlay only</button>
    </div>
    <p class="note">An overlay is a transparent ProRes 4444 track for an editor.
       Burning in produces a finished MP4.</p>
    <p class="note" id="exportNote"></p>
  </div>
</aside>

<section class="stage">
  <div class="frame" id="frame">
    <video id="video" controls playsinline></video>
  </div>
  <p class="note" id="hint">Drop a video and a subtitle file. The words come from the
     subtitles; who is speaking, how loudly and at what pitch come from the soundtrack.</p>
  <div id="langRow" class="row hidden" style="margin-top:12px">
    <span class="note">Subtitle language</span>
    <select id="lang" style="width:auto"></select>
  </div>
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
const state = { job: null, subtitles: null, manifest: null, renderer: null };

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
    + 'subtitle file is optional, and the audio will be transcribed. It does not identify '
    + '<em>who</em> is speaking, so a transcribed track has one speaker until you label '
    + 'them or install WhisperX.';
}

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
  const r = await fetch('/api/upload?name=' + encodeURIComponent(file.name), {
    method: 'POST', body: file,
  });
  const out = await r.json();
  if (out.error) { $('videoNote').innerHTML = '<span class="bad">' + out.error + '</span>'; return; }
  state.job = out.id;
  $('videoNote').textContent = out.name + ' · ' + (out.size / 1e6).toFixed(0) + ' MB';
  $('video').src = '/media/' + out.id;
  refreshGo();
});

dropzone($('dropSubs'), '.srt,.vtt,text/plain', async (file) => {
  if (!state.job) { $('subsNote').innerHTML = '<span class="bad">Add the video first.</span>'; return; }
  const r = await fetch('/api/subtitles?id=' + state.job + '&name=' + encodeURIComponent(file.name), {
    method: 'POST', body: file,
  });
  const out = await r.json();
  if (out.error) { $('subsNote').innerHTML = '<span class="bad">' + out.error + '</span>'; return; }
  state.subtitles = out.path;
  $('subsNote').textContent = out.entries + ' entries · “' + out.first + '…”';
  refreshGo();
});

function refreshGo() {
  $('go').disabled = !state.job || (!state.subtitles && !env.asr);
}

// --- analysis ---------------------------------------------------------------
$('go').onclick = async () => {
  $('go').disabled = true;
  $('bar').classList.remove('hidden');
  await fetch('/api/analyze', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: state.job, subtitles: state.subtitles, asr: env.asr,
                           profile: $('profile').value,
                           diarize: $('diarize').checked }),
  });
  poll();
};

async function poll() {
  const r = await (await fetch('/api/job?id=' + state.job)).json();
  $('status').textContent = r.message ?? '';
  $('bar').querySelector('i').style.width = ((r.progress ?? 0) * 100) + '%';

  if (r.stage === 'failed') {
    $('status').innerHTML = '<span class="bad">' + (r.error ?? 'failed') + '</span>';
    $('go').disabled = false;
    return;
  }
  if (r.stage === 'ready' && r.manifest) {
    state.manifest = r.manifest;
    mount(r.manifest);
    $('bar').classList.add('hidden');
    $('exportStep').classList.remove('hidden');
    $('go').disabled = false;
    return;
  }
  if (r.stage === 'done') {
    $('exportNote').innerHTML = '<a href="/download/' + state.job + '" download>Download '
      + r.output + '</a>';
    $('bar').classList.add('hidden');
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

  // One speaker means the attribution layer — the reason this design exists —
  // is doing nothing. Almost always the subtitle file simply carries no names,
  // which is invisible unless someone says it out loud.
  if (manifest.characters.length < 2) {
    $('castStep').insertAdjacentHTML('beforeend',
      '<p class="note"><span class="warn">One speaker found.</span> Colour, position '
      + 'and marks all identify <em>who is talking</em>, so with a single speaker none '
      + 'of that is conveying anything. Subtitle files usually carry no names. To get '
      + 'attribution, label the speakers in the file — <code>&lt;v Vale&gt;</code> in '
      + 'WebVTT, or a leading <code>VALE:</code> — or install WhisperX, which '
      + 'diarizes.</p>');
  }

  const cast = $('cast');
  cast.innerHTML = '';
  for (const c of manifest.characters) {
    const tr = document.createElement('tr');
    tr.innerHTML = '<td><span class="swatch" style="background:' + c.color + '"></span></td>'
      + '<td>' + (c.name ?? c.id) + '</td>'
      + '<td class="note">' + (c.position ?? '') + ' ' + (c.glyph ?? '') + '</td>';
    cast.appendChild(tr);
  }
  $('castStep').classList.remove('hidden');

  const langs = state.renderer.languages();
  if (langs.length > 1) {
    $('lang').innerHTML = langs.map((l) => '<option>' + l + '</option>').join('');
    $('lang').onchange = () => state.renderer.setLanguage($('lang').value);
    $('langRow').classList.remove('hidden');
  }
}

// --- export -----------------------------------------------------------------
async function doExport(alpha) {
  $('exportNote').textContent = 'rendering — this runs the real renderer frame by frame';
  $('bar').classList.remove('hidden');
  await fetch('/api/manifest', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: state.job, manifest: state.manifest }),
  });
  await fetch('/api/export', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: state.job, alpha }),
  });
  poll();
}
$('diarize').onchange = () => {
  $('diarizeNote').style.display = $('diarize').checked ? 'block' : 'none';
};

$('export').onclick = () => doExport(false);
$('exportAlpha').onclick = () => doExport(true);

// --- fullscreen -------------------------------------------------------------
// The browser's own fullscreen button fullscreens the <video> element. Our
// captions are a sibling of it, not a child, so they are left behind in the
// hidden page and the viewer gets a full-screen video with no captions at all
// — the one moment they most want them. Catch it, back out, and fullscreen the
// frame instead, which contains both.
document.addEventListener('fullscreenchange', async () => {
  const video = $('video');
  if (document.fullscreenElement === video) {
    await document.exitFullscreen();
    await $('frame').requestFullscreen();
  }
  // The picture box changes size; the renderer re-measures on its own via the
  // ResizeObserver, but the video element needs a beat to settle first.
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
