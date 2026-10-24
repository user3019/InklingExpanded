# InklingExpanded

> **An extended version of [Inkling](https://github.com/Bluewolf135/Inkling) by Bluewolf135.**
> Everything Inkling does — handwriting and annotation for PDFs and Markdown
> notes in Obsidian, built mobile-first for stylus input — plus a customisable
> toolbar, an infinite canvas, reader-style zoom, two pens, pictures and PDF
> import, cropping, copy and paste, stylus buttons on Android, live editing on
> two devices at once, and backups before every change to a file's pages.

Like Inkling, it exists for one reason: **the knowledge stays in the vault.**
Ink is written into the PDF itself as real PDF annotations, highlights become
searchable, linkable Markdown notes, and nothing ever leaves your vault — the
plugin makes no network connections.

## Contents

- [What InklingExpanded adds](#what-inklingexpanded-adds)
- [What it keeps from Inkling](#what-it-keeps-from-inkling)
- [How to use the new features](#how-to-use-the-new-features)
- [Keyboard](#keyboard)
- [Installing](#installing)
- [Platforms](#platforms)
- [Limitations](#limitations)
- [Development](#development)
- [Credits and license](#credits-and-license)

## What InklingExpanded adds

### Toolbar and tools

- **Your own toolbar layout, per device.** The **Customize toolbar** button
  (sliders icon) at the end of the toolbar opens an editor: drag the tools into
  the order you want, hide the ones you never use, save. Each device keeps its own layout — a phone can show six
  tools, a laptop all of them.
- **Every setting remembered, per device.** The tool in hand, colours, widths,
  pens, pressure and finger drawing come back exactly as you left them, in
  every note.
- **Two pens.** Tap the pen in hand to choose between a **round pen** (smooth,
  round ends) and a **sharp pen** (follows your hand exactly, corners and all).
  Each has its own pressure switch and remembers its own colour and width.
- **Draw with a finger.** A toolbar switch for phones and for styluses that
  report themselves as a finger; two fingers still zoom and pan.

### Pages and notes

- **Infinite canvas.** Choose "Infinite canvas" when creating a note: one sheet
  that grows smoothly in whichever direction you write, without reloading.
  Still an ordinary one-page PDF that opens anywhere.
- **Page background, after the fact.** Switch any page — or every page — between
  blank, lined and dot grid. Imported pages keep their content; the ruling goes
  underneath.
- **Delete pages** from the page thumbnails in Obsidian's own PDF reader (long
  press on a tablet, right-click on a desktop).
- **Page counts and thumbnails update** in Obsidian's reader as soon as pages
  are added, inserted or deleted.

### Pictures and PDFs

- **Import** the pages of another PDF after the page you are on, or place a
  picture — from the vault, or from the device's file picker, photos and camera.
- **Pictures behave like objects.** Move and resize them with the lasso; long
  press (pen or finger) to pick one up again; select them with a finger on a
  tablet. A small bar above a selected picture has **copy**, **lock** (locked
  pictures cannot be moved by accident), **crop** and **delete**.
- **Crop** a picture with corner and edge grips. The cropped-away part is
  really removed from the file, and undo brings it back.

### Lasso, copy and paste

- **A new lasso.** Drawn like a pen stroke as a dashed loop; what it catches
  gets a thin light-blue outline and a frame with handles to move and resize
  it. The outline follows the selection while it moves.
- **Copy, cut and paste.** Copy from the bar above a selection (or Ctrl/Cmd+C,
  Ctrl/Cmd+X). Hold the lasso still on the spot it should go — pen or finger —
  and tap paste (or Ctrl/Cmd+V at the pointer). A copy pastes at the same size
  on any page, into another PDF or into a note's ink block, and arrives
  selected, ready to move.

### Viewing and zoom

- **Move about while editing the way you do while reading.** Zoom the whole
  document from 25% to 500% — pinch, trackpad pinch, Ctrl+wheel or the
  toolbar — and scroll in every direction with a finger, the trackpad or the
  middle mouse button.
- **Sharp at any zoom.** The part of the page on screen is redrawn at the
  screen's resolution — text, ink, highlights and ink blocks alike — instead of
  turning into pixels.

### Stylus

- **Side button and eraser end.** Hold the side button to erase (or highlight,
  or lasso — a setting) and let go to get your tool back; an eraser end always
  erases. Works with Windows and Wacom pens, and on Android with the Samsung
  S Pen and other pens.
- **A stylus check** command shows exactly what your pen reports — pressure,
  side button, eraser end — for finding out what a device supports.

### Two devices and safety

- **Live editing on two devices.** Open the same PDF on a tablet and a laptop
  and write on both: each one's ink appears on the other as soon as your sync
  brings the file over, merged stroke by stroke.
- **Nothing is saved over another device's save.** Before every save the file
  is checked; a change from elsewhere is taken in first. Pages are matched by
  identity, so ink stays on its page even when pages were added or deleted on
  the other device.
- **Safe page changes.** Adding pages, inserting a PDF and changing backgrounds
  pause drawing for a moment, save what is unsaved first, and never overlap
  with another save.
- **Backups.** A copy of the PDF is kept on the device before each of those
  changes (the last five per note). **"Restore an earlier version of this PDF"**
  brings one back, and keeps the current state as a backup too.

### Cleaner and more robust

- Reworked new-note dialog, settings, outline and find panel, and note editor —
  tidier on phones and tablets.
- Works in popout windows (shortcuts and dark-mode inversion included).
- Many fixes: no lost ink when closing a PDF while a sync lands, no line
  drawings lost when changing a background, reliable palm rejection, safer
  pointer handling, and more.

## What it keeps from Inkling

All of Inkling's features are still here:

- **Annotate any PDF** with pen, highlighter, eraser, shapes and lasso — saved
  as real PDF annotations that Obsidian's reader, Xodo and Acrobat show too.
- **Feels like ink.** Every stylus sample is captured and smoothed into curves;
  pressure varies the width.
- **Highlights become notes.** The highlighter snaps to the lines of text it
  swept and remembers the words. "Extract annotations to a note" turns them
  into Markdown, grouped by page, each linking back to its page — and works on
  highlights made in other PDF software too.
- **Comments** as standard PDF sticky notes.
- **Handwritten notes** as blank, lined or dot-grid PDFs.
- **Ink blocks in Markdown** — a ```` ```inkling ```` block is a drawing surface
  inside an ordinary note, with its strokes kept in an `.ink` file beside it.
- **Getting around:** outline, page jump, find in document, a collapsible
  toolbar, and dark-mode page inversion that leaves your ink's colours alone.

<p>
  <img src="docs/demo-materials/annotate-view.png" width="49%" alt="A textbook page in the annotate view on a tablet: the toolbar across the top, a highlighted sentence, and handwritten notes in the margin">
  <img src="docs/demo-materials/markdown-blocks.png" width="49%" alt="A physics exercise note with an ink block holding a handwritten worked solution between the problem text and the next exercise">
</p>

**Writing on a textbook page** (from Inkling)

https://github.com/user-attachments/assets/f55a433e-ef7c-4e35-8456-6de9dec51359

**Extracting annotations to a note** (from Inkling)

https://github.com/user-attachments/assets/40446953-9efd-4fca-be6c-e2305961d351

## How to use the new features

| To… | Do this |
|---|---|
| Rearrange the toolbar | Toolbar → **Customize toolbar** (sliders icon) → drag, save. |
| Switch pens | Tap the pen while it is already in hand. |
| Create an infinite canvas | "Create handwritten note" → paper: **Infinite canvas**. |
| Change a page's background | Toolbar → **Page background** → this page or all pages. |
| Delete a page | In Obsidian's reader, long-press or right-click its thumbnail → **Delete page**. |
| Import a PDF or picture | Toolbar → **Import**. |
| Pick a picture up again | Long-press it with the pen or a finger. |
| Crop a picture | Select it → crop button → drag the grips → ✓. |
| Copy and paste | Lasso → copy → hold the lasso on the target spot → paste. |
| Erase with the side button | Hold the button and write. On Android, press it with the pen just above the screen, then touch down. |
| Undo a page change | Command palette → **Restore an earlier version of this PDF**. |

## Keyboard

Inside the annotate view:

| Key | Action |
|---|---|
| `s` `p` `h` `e` | Select, pen, highlighter, eraser |
| `l` `r` `o` `a` | Line, rectangle, oval, arrow |
| `1`–`6` | Preset colours |
| `[` `]` | Thinner, thicker |
| `Delete` | Delete selection |
| `Escape` | Let go of a selection, a crop or a paste offer |
| `Mod+C` / `Mod+X` / `Mod+V` | Copy, cut, paste |
| `Mod+Z` / `Mod+Shift+Z` | Undo / redo |
| `PageUp` / `PageDown` | Previous / next page |
| `Mod+=` / `Mod+-` / `Mod+0` | Zoom in / out / reset |

`Mod` is Ctrl on Windows and Linux, Cmd on macOS. Undo and redo are also
palette commands, so you can bind them globally.

## Installing

Not in the community catalogue. Install with
[BRAT](https://github.com/TfTHacker/obsidian42-brat):

1. Install BRAT from Community Plugins.
2. **Add Beta Plugin**, and give it `user3019/InklingExpanded`.
3. Enable **InklingExpanded** in Community Plugins.

Or manually: put `main.js`, `manifest.json` and `styles.css` from a release
into `<vault>/.obsidian/plugins/inkling-expanded/`.

**Turn the original Inkling off first.** InklingExpanded reads and writes the
same files — your existing PDFs, `.ink` files and ```` ```inkling ```` blocks
keep working — and uses the same view and block names, so only one of the two
may be enabled at a time.

## Platforms

Windows, macOS, Linux, Android and iOS/iPadOS — phones, tablets and computers.
No desktop-only APIs are used. Tested on a Samsung tablet with an S Pen and on
Linux.

- **Trackpad pinch on Linux** reaches Obsidian under Wayland; under X11 the
  system does not pass it on. Ctrl+wheel zooms either way.
- **Apple Pencil gestures** (double tap, squeeze) are not available to apps
  running inside Obsidian.

## Limitations

**The side button on Android.** Android keeps a touch made with the side
button held for selecting text and does not pass it to the page.
InklingExpanded follows the pen through that text selection instead, so press
the button with the pen just above the screen, then touch down. The position
comes in small steps, so erasing with the button is a little coarser than
with the eraser tool.

**Some PDFs open read-only, on purpose.** Before rewriting a PDF the plugin
checks it two ways: it compares `pdf-lib`'s reading of the file against
`pdf.js`'s, and it looks for interactive forms and digital signatures. If the
readers disagree, or there is a form or a signature, the document displays
with its annotations but drawing is off, with a banner saying why.

**Some PDFs are rewritten whole on every save.** Most saves append only what
changed — a kilobyte or two — so sync uploads the change rather than the book.
A file that cannot safely be appended to is rewritten whole, and saved less
often the larger it is. Every save is verified before a byte is written.

**An infinite canvas stops growing at 200 inches a side**, the largest page
other PDF readers open.

**Live only as fast as your sync.** Two devices exchange ink through the file
and nothing else. On Android, Obsidian notices a file changed by another app
(Syncthing, say) only when it looks again; Obsidian Sync does not have to wait.

**Backups stay on the device** and are skipped for PDFs over 60 MB (books,
whose printed pages a page change never touches).

**Extraction is one-directional**, ink blocks render only inside Obsidian, and
renaming or moving an `.ink` file breaks its blocks until it is moved back
(renaming the note itself is fine).

## Development

```bash
npm install
npm run dev     # watch build
npm test        # vitest, about 1000 tests
npm run lint
npm run build   # type-check and production bundle
```

`pdf-lib` and `pdfjs-dist` are pinned to exact versions for reasons recorded
at the top of `src/pdfView.ts`. Don't bump them without reading that comment.
Inkling's design documents live in `docs/superpowers/`; branches, commit
messages and releases are described in [CONTRIBUTING.md](CONTRIBUTING.md).

## Credits and license

InklingExpanded is built on [Inkling](https://github.com/Bluewolf135/Inkling)
by Bluewolf135 (William DeStefano) — all of the original plugin's work is
theirs, and the extensions are this fork's.

MIT — see [LICENSE](LICENSE).
