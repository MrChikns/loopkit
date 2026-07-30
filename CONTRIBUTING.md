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
both calling [`scripts/leak-scan.sh`](scripts/leak-scan.sh). The scanner has four
pattern sources: generic secret/PII classes (private keys, cloud/CI/chat tokens,
real emails), AI-agent **session handles** (a `X-Session:` commit trailer, an
account-scoped agent console URL, a bare `session_<id>`), a concrete private
decision-log id (`D-NNN`, distinct from this repo's own local `ADR-NNN` scheme) —
all three live in the script, so every clone and CI runner inherits them — and an
optional **git-ignored** `.leakpatterns.local` at the repo root where you list your
own private terms (product names, personal email, your home path) — one regex per
line. Because that file is never committed, the denylist itself can't leak. Run
`sh scripts/leak-scan.sh` any time to scan the working tree manually, or
`sh scripts/leak-scan.sh --range <old>..<new>` to scan a range's commit messages.

**File content and commit messages are separate channels.** A tree scan
(`--staged`, `--head`, `--worktree`) reads files; it structurally cannot see a
string that exists only in a commit *message*. That matters most for agent
conventions that append a session trailer to every commit, because then the class
never leaks once — it leaks on every commit at the same time. `--range` is the pass
that covers it, and it is also the only tripwire a **merge commit** ever gets (git
does not run pre-commit for merges). Its exit codes are deliberate: `1` = residue
found, `2` = bad usage or an unresolvable range, `3` = *nothing scanned* (the range
resolved to zero commits). Only `0` means "a corpus was scanned and it was clean" —
a range is never inferred for you, because a wrong default that quietly scans
nothing is worse than being asked for an argument.

Two things it still cannot do, both of which stay on you: it reads only the range
you hand it (ancestor commits outside that range go unexamined — see
[the push ritual](docs/public-push-ritual.md), layer 8), and it matches shapes only
— branch and tag names, reflog, git notes, and semantic residue that no regex can
describe are all out of its reach.

## Provenance gate

The same `sh scripts/install-hooks.sh` step also arms a provenance gate on `git push`,
for repos registered as a loopkit target (this one included). It checks that every
commit above a declared baseline has a real ledger receipt and gate evidence before
the push is allowed through — see `AGENTS.md` ("Mechanically enforced (WI-232)") for
the full rule. It needs a built `packages/core/dist` to run and blocks rather than
skips if that's missing. Outside contributors are not required to carry anything
per commit for this — since PRs aren't accepted here anyway (above), it mainly
matters if you're driving the plane against your own fork or target repo.

Thanks for stopping by. 🙌
