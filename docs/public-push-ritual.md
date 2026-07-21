# Public-push leak ritual

This repository is public. Every push that adds new content — especially content
copied or derived from a private repository — must pass the seven-layer leak check
before it reaches the remote. `scripts/leak-scan.sh` is the deterministic tripwire
(layers 1–3); the full ritual adds range-level, whole-file, secret-class, and
semantic review on top, because pre-commit hooks skip merge commits and regexes
cannot catch semantic residue.

The canonical checklist lives with the operator's agent tooling
(`public-push-check` skill); the layers are, in short:

1. `leak-scan.sh --head` — committed tree, exit 0.
2. `leak-scan.sh --worktree` — working tree, exit 0.
3. `leak-scan.sh --range <old>..<new>` (or `<sha> --not --remotes` for a new
   ref) — commit SUBJECT+BODY text for the push range, exit 0. Tree scans
   (1–2) never see this: a decision id or private term can leak straight into
   a commit message even when the diff itself is clean.
4. Per-pattern, word-bounded grep of the full push-range diff against the
   local denylist (`.leakpatterns.local`, git-ignored — the denylist itself
   must never be committed).
5. Full-content scan of every path ADDED in the range (not just diff hunks).
6. Generic secret classes: keys, tokens, `secret="…"` literals, emails,
   absolute home paths, real hostnames.
7. Semantic review of prose-heavy additions (docs, comments, fixtures,
   examples) for residue no regex can catch: identifying business context,
   people, employers, infrastructure.
8. **Reachable-history audit — not just the push range.** A clean `leak-scan.sh`
   run only proves the current tree and the caller-supplied range are clean; it
   says nothing about blobs still reachable from ancestor commits (a file
   deleted three commits ago, an old value before a later "fix" commit swapped
   it out, a squashed-away draft). This matters most right after an extraction
   or a history rewrite, where the new default branch can look clean while its
   ancestry still carries the source repo's residue. Before the FIRST push of a
   new or rewritten history, and periodically after: `git log --all -p` (or
   `git rev-list --objects --all` piped through a full-content grep) over the
   *whole* ancestry, not `HEAD` or the push range — looking for the same
   classes as layers 4–7 (denylist terms, secrets, identifying prose) plus
   anything that only exists in a blob no live path points to. If a rewrite
   was done to remove something, verify the removal by scanning the rewritten
   history itself, not by trusting the rewrite happened correctly.

Push only on all-clean. Any finding: scrub commit → re-run the full ritual on
the new range. Record the evidence (hit counts, verdict, range SHAs) wherever
the push is reported.

## Two independent reviewers, not one

Layers 1–8 above are the deterministic/mechanical pass (Claude, or whichever
agent is driving the push, runs it). Before any push that adds meaningfully
new content (a fresh extraction, a history rewrite, a large doc/prose
addition), **Codex runs an independent second leak pass over the same
range/history** — a semantic reviewer with no context from the agent that
wrote the content, looking specifically for identifying residue a same-author
review is prone to miss (the person who wrote a sentence is the worst-placed
reader to spot what it accidentally reveals). Both passes must come back
clean before the push; a Codex finding is scrubbed and both passes re-run on
the new range, the same as any other finding above. If Codex is unavailable
or its quota is depleted, say so explicitly in the push record and proceed on
the Claude pass alone rather than stalling — but note the gap, don't silently
skip it.
