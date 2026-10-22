# Contributing

How work moves from an idea to a release. It applies to every change,
including ones made by an AI assistant.

## Branches

| Branch | Holds | Changes by |
|---|---|---|
| `Trunk` | Released code only. Every release is a tag on it. | A pull request from `dev` (or a hotfix branch), never a direct push |
| `dev` | Finished work waiting for the next release | Pull requests from feature branches |
| `feat/…`, `fix/…`, `docs/…`, … | One change | Commits, while it is being built |

`Trunk` is protected on GitHub: it takes pull requests only, and only once
CI has passed. It never takes a force push.

### A change

1. Branch from an up-to-date `dev`, named for the type of change and what
   it does: `feat/ink-file-restore`, `fix/pdf-save-overlap`,
   `docs/contributing`.
2. Commit as you go (see below). `npm run build`, `npm run lint` and
   `npm test` must pass before every commit.
3. Before opening the pull request, rebase the branch onto `dev`
   (`git fetch && git rebase origin/dev`) so it lands as a straight line. A
   feature branch is yours to rewrite until it is merged; `dev` and `Trunk`
   never are.
4. Open a pull request into `dev`. CI runs on it. Merge with **Rebase and
   merge**, which keeps each commit and its message. The branch is deleted
   on merge.

### Testing on real devices

Tests prove the source; they do not prove the plugin works on a tablet.
Anything touching drawing, saving, PDFs or workers is checked in the running
app before it goes to `Trunk`: build, copy `main.js`, `manifest.json` and
`styles.css` into the vault's `.obsidian/plugins/inkling-expanded/`, and reload the
plugin. Obsidian never reloads a plugin on its own, so a synced device keeps
running the old code until the plugin is toggled off and on there.

### A release

1. On `dev`, bump the version: `npm version 1.1.0 --no-git-tag-version`.
   This updates `package.json`, `manifest.json` and `versions.json`. Commit
   them as `chore(release): 1.1.0`.
2. Open a pull request from `dev` into `Trunk` titled `Release 1.1.0`, and
   merge it with **Create a merge commit**. Not rebase or squash: those
   would give `Trunk` copies of `dev`'s commits under new ids, and the two
   branches would stop sharing history.
3. Tag the merge commit on `Trunk` with the bare version, no `v` — Obsidian
   requires the tag to equal `manifest.json`'s version exactly:

   ```bash
   git checkout Trunk && git pull
   git tag -a 1.1.0 -m "Inkling 1.1.0"
   git push origin 1.1.0
   ```

4. The release workflow runs lint, tests and the build, and creates a
   **draft** release holding `main.js`, `manifest.json` and `styles.css`.
   Read it over and publish it on GitHub.
5. Bring `dev` up to the merge commit: `git checkout dev && git merge
   --ff-only origin/Trunk && git push`.

Versions follow semantic versioning: a fix is a patch (1.0.1), a feature a
minor version (1.1.0), and a change that breaks existing notes or files a
major one. A change that makes files an older version cannot read is major
even when it is small.

### A hotfix

For a bug in a release that cannot wait for `dev`: branch `hotfix/…` from
`Trunk`, open the pull request into `Trunk`, and release it as a patch as
above. Then merge `Trunk` into `dev` so the fix is not lost from the next
release.

## Commit messages

[Conventional Commits](https://www.conventionalcommits.org/): a typed
subject, then a prose body.

```
fix(pdf): save a PDF one write at a time

On the tablet, a stroke drawn while the previous one was still saving came
back as "could not save annotations to this file", and the stroke was gone.
...
```

- **Subject:** `type(scope): what the change does`, in the imperative, lower
  case after the colon, no full stop, under about 70 characters.
- **Types:** `feat` (something new a user can do), `fix` (something that was
  wrong), `perf`, `refactor` (no change in behaviour), `test`, `docs`,
  `build`, `ci`, `chore`.
- **Scopes**, optional: `pdf`, `ink` (Markdown ink blocks and ink files),
  `annotate` (the drawing surface and tools), `extract`, `settings`,
  `notes` (handwritten note creation), `release`.
- **Body:** plain prose saying why, not what — the diff already says what.
  What went wrong, what the cause was, and what the change does about it.
- **Breaking changes:** add `!` after the type (`feat(ink)!: …`) and a
  `BREAKING CHANGE:` paragraph saying what an existing vault has to do.

## Checks

```bash
npm run build   # type-check and production bundle
npm run lint
npm test
```

CI runs all three on every push and pull request, and the release workflow
runs them again on the tag. Design documents and implementation plans live
in `docs/superpowers/`.
