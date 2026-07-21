# Contributing

loopkit is published as a **reference / build-in-public** project. It's shared so
you can read it, learn from it, fork it, and build your own thing on top of it.

## Pull requests are not accepted

This repo does **not** take pull requests — any PR is closed automatically. Please
don't take it personally; it just isn't set up for outside contributions right now.

## What you're welcome to do

- **Fork** and **clone** it freely — do whatever you like in your own copy.
- **Star / watch** if you find it useful.
- Open an **Issue** or **Discussion** if you spot a bug or have a question.

## Leak scan (if you publish a public mirror of a working repo)

If you drive this plane against your own repo, it ships a tripwire that blocks secrets
and operator-private residue from ever being committed or pushed:

```sh
sh scripts/install-hooks.sh   # points core.hooksPath at scripts/git-hooks
```

That installs a **pre-commit** (scans staged content) and **pre-push** (scans the
HEAD tree, *and* the commit-message text of everything about to be pushed) hook,
both calling [`scripts/leak-scan.sh`](scripts/leak-scan.sh). The scanner has three
pattern sources: generic secret/PII classes (private keys, cloud/CI/chat tokens,
real emails), a concrete private decision-log id (`D-NNN`, distinct from this repo's
own local `ADR-NNN` scheme) — both live in the script — and an optional
**git-ignored** `.leakpatterns.local` at the repo root where you list your own
private terms (product names, personal email, your home path) — one regex per line.
Because that file is never committed, the denylist itself can't leak. Run
`sh scripts/leak-scan.sh` any time to scan the working tree manually, or
`sh scripts/leak-scan.sh --range <old>..<new>` to scan a range's commit messages.

Thanks for stopping by. 🙌
