# Inkling

Handwritten and text annotation for PDFs and Markdown notes in Obsidian,
built mobile-first for stylus input.

Inkling exists for one reason: **the knowledge stays in the vault.** Xodo
and GoodNotes are excellent PDF annotators, and if annotating the PDF were
the point you should use one of them. The point is that a highlight in a
textbook becomes a searchable, linkable Markdown note sitting beside
everything else you know — without leaving the app you keep it all in.

<p>
  <img src="docs/demo-materials/annotate-view.png" width="49%" alt="A textbook page in Inkling's annotate view on a tablet: the toolbar across the top, a highlighted sentence, and handwritten notes in the margin">
  <img src="docs/demo-materials/markdown-blocks.png" width="49%" alt="A physics exercise note with an ink block holding a handwritten worked solution between the problem text and the next exercise">
</p>

**Writing on a textbook page**

https://github.com/user-attachments/assets/f55a433e-ef7c-4e35-8456-6de9dec51359

**Extracting annotations to a note**

https://github.com/user-attachments/assets/40446953-9efd-4fca-be6c-e2305961d351

## What it does

**Annotate PDFs.** Pen, highlighter, eraser, shapes, and lasso selection,
over any PDF in your vault. Ink is written into the file as real PDF
annotations, so it shows up in Obsidian's own reader, in Xodo, in Acrobat —
anywhere.

**Feels like ink.** Every stylus sample is captured, not just the one per
frame the browser volunteers; the hand's tremor and the stylus's noisy
pressure are steadied out without the line lagging behind the tip; and
every stroke, pressure strokes included, is a smooth curve with round ends
rather than a run of straight edges.

**Two pens.** Press the pen again while it is in hand to choose between a
round pen — smooth, with round ends — and a sharp pen that follows your
hand exactly, corners and all, and ends square. Each has its own switch
for pressure: on, a harder press draws a thicker line; off, the line stays
one width however hard you press. Each also remembers its own colour and
width.

**Highlights become notes.** Drag the highlighter over text and it snaps to
the lines it swept — and remembers the words it covered. "Extract
annotations to a note" turns those into Markdown, grouped by page, each
entry linking back to `[[book.pdf#page=42]]` and carrying a block reference
so you can link to one specific highlight.

That works retroactively, on highlights made before you installed this and
on highlights made in other PDF software: the match is geometric, so
anything with a rectangle over text can have its quote recomputed.

**Comments.** Tap with the note tool, type, and it commits as a standard
PDF sticky note — which means other readers show it too.

**Handwritten notes.** Create a blank, lined, or dot-grid PDF and write
straight into it, adding pages as you fill them.

**Import.** The toolbar's import button inserts the pages of another PDF
after the one you are on, or places a picture on the page — from the
vault, or from the device's own file picker, photos and camera included.
A picture lies under the ink, so you can write on it, and moves, scales
and deletes with the lasso. Other PDF readers show it too.

**Two devices at once.** Open the same PDF on a tablet and a laptop and
write on both: each one's ink appears on the other as soon as your sync
(Obsidian Sync, Syncthing, …) brings the file over, merged stroke by
stroke with anything not yet saved, rather than one device's save
overwriting the other's.

**Infinite canvas.** Pick "Infinite canvas" as the paper when creating a
note, and it starts as one sheet that grows in whichever direction you
write: ink near an edge pushes that edge out by a page, and scrolling up
against an edge next to your ink makes room there before you start. It is
still an ordinary one-page PDF — the ruling is a repeating pattern, so the
file stays a kilobyte or two however large the sheet gets — and it opens in
any other PDF reader.

**Ink blocks in Markdown.** A ```` ```inkling ```` block is a drawing
surface inside an ordinary note, for a diagram in the middle of a page of
typing. "Insert ink annotation block" leaves a three-line fence in the note
and keeps the strokes in an `.ink` file beside your other attachments, one
per note, so the note stays readable and small. Where those files go is a
setting.

**Getting around.** Move about while annotating the way you do while
reading: zoom the whole document from 25% to 500% (pinch, Ctrl+wheel, a
trackpad pinch, or the toolbar) and scroll it in both directions — one
finger, the trackpad, or dragging with the middle mouse button. Plus an
outline, page jump, find-in-document, a collapsible toolbar, and dark-mode
page inversion that darkens the page without touching the colour of your
ink.

## Keyboard

Inside the annotate view:

| Key | Action |
|---|---|
| `s` `p` `h` `e` | Select, pen, highlighter, eraser |
| `l` `r` `o` `a` | Line, rectangle, oval, arrow |
| `1`–`6` | Preset colours |
| `[` `]` | Thinner, thicker |
| `Delete` | Delete selection |
| `Mod+Z` / `Mod+Shift+Z` | Undo / redo |
| `PageUp` / `PageDown` | Previous / next page |
| `Mod+=` / `Mod+-` / `Mod+0` | Zoom in / out / reset |

Undo and redo are also palette commands, so you can bind them globally.

## Installing

Not in the community catalogue yet. Install with
[BRAT](https://github.com/TfTHacker/obsidian42-brat):

1. Install BRAT from Community Plugins.
2. **Add Beta Plugin**, and give it this repository.
3. Enable **Inkling** in Community Plugins.

Or manually: download `main.js`, `manifest.json` and `styles.css` from a
release into `<vault>/.obsidian/plugins/inkling-expanded/`.

## Mobile and stylus

Built mobile-first, and tested on a Samsung tablet with an S Pen.

- **Palm rejection.** Pen and mouse draw; touch scrolls in any direction
  and pinch-zooms, and two fingers zoom and pan at once.
- **Stylus buttons.** Hold the side button of an S Pen — or of most Android,
  Windows and Wacom pens — to erase (or highlight, or lasso: a setting); an
  eraser end always erases. Apple Pencil's gestures are not available to
  apps running in Obsidian.
- **Drawing with a finger.** For a stylus that reports itself as a finger,
  or a phone with no stylus: the finger button in the toolbar makes one
  finger draw, while two still zoom and pan.
  Touch panning is hand-rolled rather than left to the browser, because
  relying on `touch-action` let a downward pen stroke get taken over
  mid-draw on real hardware.
- **Pressure and tilt.** Pressure varies stroke width where the stylus
  reports it.
- **No desktop-only APIs.** Everything runs on mobile.

## Limitations

**Some PDFs open read-only, on purpose.** Inkling rewrites a PDF through
`pdf-lib`, and before it will do that it checks the document two ways: it
compares `pdf-lib`'s reading of the file against `pdf.js`'s, and it looks
for interactive forms and digital signatures. If the two readers disagree,
or the document has a form or a signature, the book renders and its
existing annotations display but drawing is turned off, with a banner
saying why. Filling in a form and saving it through here would lose the
form; re-serializing a signed document invalidates the signature.

**Some PDFs are rewritten whole on every save.** Most saves append only
what changed to the end of the file — a kilobyte or two, however large the
book — so sync uploads the change rather than the textbook. A file whose
structure Inkling cannot safely append to is rewritten whole instead, and
for those it scales how often it saves to the file's size: ten seconds
under 5 MB, thirty up to 25 MB, a minute above. Either way, every save is
verified against the document it came from before a byte is written.

**An infinite canvas stops growing at 200 inches a side**, the largest
page other PDF readers open. A
very large canvas is drawn with fewer pixels than a small one, because a
phone or tablet browser refuses a single canvas past about 16 megapixels.

**Live only as fast as your sync.** Two devices exchange ink through the
file and nothing else — the plugin makes no network connections — so it
arrives when the sync delivers it. On Android, Obsidian notices a file
changed by another app (Syncthing, say) only when it looks again, which
Obsidian Sync does not wait for.

**Extraction is one-directional.** Editing an extracted note does not
change the PDF.

**Ink blocks render only inside Obsidian**, so a note holding one is less
portable than one holding an image.

**Renaming or moving an `.ink` file breaks its blocks, for now.** The fence
names the file by path, and nothing rewrites it yet, so the blocks show a
read-only "missing" banner and never save over anything. Move the file
back and they return. Renaming or moving the *note* is fine. Blocks made
by earlier versions, with their strokes inside the note, keep working
exactly as they did.

## Development

```bash
npm install
npm run dev     # watch build
npm test        # vitest
npm run lint
npm run build   # type-check and production bundle
```

`pdf-lib` and `pdfjs-dist` are pinned to exact versions for reasons
recorded at the top of `src/pdfView.ts`. Don't bump them without reading
that comment.

Design documents and implementation plans live in `docs/superpowers/`.
Branches, commit messages and releases are described in
[CONTRIBUTING.md](CONTRIBUTING.md).

## License

MIT — see [LICENSE](LICENSE).
