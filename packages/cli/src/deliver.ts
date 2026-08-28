/**
 * Package a caption track for a delivery target.
 *
 * A CWI title is always *two* artifacts, never one, and shipping only the first
 * is a compliance mistake:
 *
 *   1. Picture with captions burned in. No caption decoder anywhere can render
 *      CWI — not YouTube's, not a set-top box's, not a cinema caption device's —
 *      so the design only reaches viewers as pixels. Spec 3.2 says this
 *      explicitly and expects it to stay true until decoders catch up.
 *
 *   2. A conventional sidecar caption file. Closed captioning is legally
 *      mandated (FCC/CVAA in the US, the European Accessibility Act since June
 *      2025), and spec 3.4 is unambiguous that CWI is *additive* — "in addition
 *      to the regulated and mandated use of the Closed Captions system", not a
 *      replacement. It is also what makes the dialogue searchable and
 *      translatable, which is why platforms index it.
 *
 * Ship one without the other and you have either an inaccessible file or an
 * illegal one.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { CwiError, readManifest, exportCaptions, stats } from './ops.js';
import { render, PRESETS } from './render.js';

export interface Target {
  label: string;
  preset: keyof typeof PRESETS | string;
  sidecar: 'vtt' | 'ass' | 'none';
  videoName: string;
  instructions: (ctx: { video: string; sidecar: string | null }) => string[];
}

export const TARGETS: Record<string, Target> = {
  youtube: {
    label: 'YouTube',
    preset: 'youtube',
    sidecar: 'vtt',
    videoName: 'video.mp4',
    instructions: ({ video, sidecar }) => [
      'YouTube cannot render Caption with Intention. Its caption engine has no',
      'variable-font axes, no per-word colour and no animation, so the design',
      'only reaches viewers burned into the picture.',
      '',
      `1. Upload ${video} as the video.`,
      `2. Add ${sidecar} under Subtitles as a normal caption track.`,
      '   This is the legally-mandated closed caption track, and it is what makes',
      '   the dialogue searchable and auto-translatable. Do not skip it because',
      '   the picture already shows captions.',
      '3. In the description, note that open captions are burned in, so viewers',
      '   who turn captions off still see them.',
      '',
      'Consider a second, caption-free upload if you serve an audience that finds',
      'permanent on-screen text intrusive — burned-in captions cannot be disabled.',
    ],
  },
  web: {
    label: 'Web / self-hosted',
    preset: 'web',
    sidecar: 'vtt',
    videoName: 'video.mp4',
    instructions: ({ video, sidecar }) => [
      `Serve ${video} with HTTP range support, or seeking will not work.`,
      `Attach ${sidecar} as <track kind="captions"> for the toggleable track.`,
      '',
      'If you control the player, prefer the @chorus/web renderer over burned-in',
      'captions: it keeps the captions selectable and re-styleable, which burned',
      'pixels cannot be.',
    ],
  },
  cinema: {
    label: 'Cinema (DCP source master)',
    preset: 'cinema',
    sidecar: 'vtt',
    videoName: 'master.mp4',
    instructions: ({ video, sidecar }) => [
      'This is a picture master, NOT a DCP. A DCP needs JPEG2000 in MXF, XYZ',
      'colour and usually a KDM — build it with DCP-o-matic or OpenDCP from this',
      'file.',
      '',
      `1. Ingest ${video} as the picture source.`,
      '2. Build as OPEN CAPTIONS — the captions are already in the picture.',
      '',
      'Why open captions rather than a caption track: cinema closed captioning',
      'means seat-mounted devices (CaptiView, Sony Access Glasses, Rear Window),',
      'which cannot display CWI at all and which Deaf audiences widely dislike.',
      'A DCP subtitle track per SMPTE ST 428-7 can carry PNG subpictures, which',
      'would preserve the typography, but not per-frame animation at 24fps.',
      '',
      `${sidecar} is included for the exhibitor's accessibility filing and for`,
      'any streaming release cut from the same master.',
    ],
  },
};

export interface DeliverOptions {
  manifest: string;
  video?: string;
  target: string;
  outDir: string;
  onProgress?: (done: number, total: number) => void;
}

export interface DeliverResult {
  outDir: string;
  target: string;
  video: string;
  sidecar: string | null;
  readme: string;
  frames: number;
  seconds: number;
  lost: string[];
}

export async function deliver(opts: DeliverOptions): Promise<DeliverResult> {
  const target = TARGETS[opts.target];
  if (!target) {
    throw new CwiError(`Unknown target "${opts.target}".`, `Available: ${Object.keys(TARGETS).join(', ')}`);
  }
  const manifestPath = resolve(opts.manifest);
  const manifest = readManifest(manifestPath);
  const outDir = resolve(opts.outDir);
  mkdirSync(outDir, { recursive: true });

  const videoOut = join(outDir, target.videoName);
  const r = await render({
    manifest: manifestPath,
    video: opts.video,
    out: videoOut,
    preset: target.preset,
    onProgress: opts.onProgress,
  });

  let sidecar: string | null = null;
  let lost: string[] = [];
  if (target.sidecar !== 'none') {
    const ex = exportCaptions(manifest, target.sidecar, { frameHeight: r.height });
    sidecar = join(outDir, `captions.${target.sidecar}`);
    writeFileSync(sidecar, ex.content);
    lost = ex.lost;
  }

  const s = stats(manifest);
  const readme = join(outDir, 'DELIVERY.txt');
  writeFileSync(readme, [
    `${target.label} delivery — ${manifest.meta?.title ?? basename(manifestPath)}`,
    '='.repeat(64),
    '',
    `  video      ${target.videoName}   ${r.width}x${r.height} @ ${r.fps}fps, ${r.seconds.toFixed(1)}s`,
    `  captions   ${sidecar ? basename(sidecar) : '(none)'}`,
    `  speakers   ${s.rows.length}   (${s.rows.map((x) => x.name).join(', ')})`,
    '',
    ...target.instructions({ video: target.videoName, sidecar: sidecar ? basename(sidecar) : null }),
    '',
    'The sidecar file is lossy by necessity. It drops:',
    ...lost.map((l) => `  - ${l}`),
    '',
    'That is expected: the sidecar exists for regulatory compliance and search,',
    'and the burned-in picture carries the design.',
    '',
  ].join('\n'));

  return {
    outDir, target: opts.target, video: videoOut, sidecar, readme,
    frames: r.frames, seconds: r.seconds, lost,
  };
}
