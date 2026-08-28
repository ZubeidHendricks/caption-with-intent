# chorus-web

Reference web renderer for [Caption with Intention](https://www.captionwithintention.org/)
manifests. DOM plus variable-font axes, drives off any `<video>`.

```bash
npm install chorus-web
```

```js
import { CwiRenderer } from 'chorus-web';

const renderer = new CwiRenderer(document.getElementById('captions'));
renderer.load(manifest);
renderer.bind(document.querySelector('video'));   // or observe() + seek() yourself
```

**Roboto Flex is required.** The intonation layer animates its `wght` and
`wdth` axes; a static font silently loses that entire dimension.

## Two things it gets right that are easy to get wrong

**No reflow.** Each line is laid out once at each word's volume-derived size, so
the white read-ahead text already occupies its final geometry and the 15%
onset pop is a pure `transform`. Animating `font-size` instead reflows the whole
line on every word.

**Frame-relative sizing.** Type size resolves against the *video frame*, not the
DOM element, so letterboxed and pillarboxed playback still yields the spec's 5%
baseline.

## API

- `new CwiRenderer(container, options?)`
- `load(manifest)` — swap the caption track
- `bind(media)` — observe the element and drive from its clock
- `observe(media)` — track its frame box only; you own the timebase
- `seek(seconds)` — render one instant; cheap enough to call per frame
- `setOptions(patch)` / `getOptions()` — override spec constants
- `destroy()`

Honours `prefers-reduced-motion`.

## About the design system

This package implements the [Caption with Intention](https://www.captionwithintention.org/)
design system (V1.0, 2025.1), created by FCB Chicago with the Chicago Hearing
Society. **This toolchain is MIT; the design system is not this project's to
license.** Its specification PDF is marked *All Rights Reserved* and the system
is marked ©, despite widespread "open source" framing in press coverage — there
is no licence file or repository anywhere upstream. Seek written clarification
from `requests@captionwithintention.org` before commercial deployment.

Roboto Flex, which the system requires, is separately available under the SIL
Open Font License.
