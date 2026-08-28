# Rendered examples

The argument this project makes is visual — a palette that collapses under
dichromacy, a reveal that stays in step across four writing systems — and it is
hard to make in prose. These are committed so it can be seen without installing
ffmpeg and a headless browser first.

All four are regenerable from what is in this repo. Nothing here is an input.

| file | what it shows |
|---|---|
| `chorus-room.mp4` | The design running: word-level reveal, type size following each actor's delivery, four speakers separated by colour, position and a per-character mark. |
| `profiles-side-by-side.mp4` | The same scene and the same audio under both profiles — **`cwi-1.0` on the left, `chorus-1.0` on the right**. |
| `cwi-room.mp4` | The left half on its own, for a proper look at the published V1.0 design. |
| `four-languages.mp4` | One performance, four subtitle tracks: English top-left, German top-right, Japanese bottom-left, Arabic bottom-right. |

## What to look for

**In the side-by-side.** Under `cwi-1.0` the four speakers' colours reach a
worst-case perceptual separation of ΔE 11.8 across normal vision and the three
dichromacies; under `chorus-1.0` it is 43.6. More importantly the right-hand
version carries speaker identity in *position* and a *mark* as well as hue, so
no pair of speakers depends on colour alone — which is what WCAG 2.2 SC 1.4.1
requires and what colour-only attribution cannot satisfy for any scene with
more than one speaker.

**In the four languages.** Watch the shout. It arrives at the same instant and
the same size in all four quadrants, because loudness, pitch and timbre belong
to the actor's performance and are shared across every subtitle track — only
the text differs. Japanese reveals per character rather than per whitespace
token, because it is written without word spaces and a whitespace tokeniser
would turn the whole line into one "word". Arabic runs right to left while the
speaker's position stays where it is, because position is a spatial attribution
cue and mirroring it would swap who is who.

## Honest limits

The audio is **synthesised** — HeyGen avatars, clean and isolated, with no
score under it and no overlapping dialogue. These files demonstrate the
*renderer*, not the analysis surviving a real mix. What happens to the analysis
on real material is measured separately by `chorus evaluate`, and the one real
film tested so far is discussed in the root README.

The four translations were written by hand for this demo scene. Nothing here
went through a translation service.

## Regenerating

```bash
# The design, burned into the picture
chorus render apps/demo/public/chorus-room.cwi.json \
  --video apps/demo/public/control-room.mp4 --out examples/chorus-room.mp4

# The same scene under the published V1.0 design
chorus render apps/demo/public/control-room.cwi.json \
  --video apps/demo/public/control-room.mp4 --out examples/cwi-room.mp4

# Side by side, V1.0 left and Chorus right
ffmpeg -i examples/cwi-room.mp4 -i examples/chorus-room.mp4 \
  -filter_complex "[0:v]scale=640:360[a];[1:v]scale=640:360[b];[a][b]hstack[v]" \
  -map "[v]" -c:v libx264 -pix_fmt yuv420p examples/profiles-side-by-side.mp4
```

`four-languages.cwi.json` is the multi-track manifest behind the quad view: one
timing-and-acoustics backbone with `tracks.de`, `tracks.ja` and `tracks.ar`
hanging off each cue. It is the shape `chorus add-language` produces, and a
useful thing to read if you are implementing a player.

```bash
chorus languages examples/four-languages.cwi.json
```
