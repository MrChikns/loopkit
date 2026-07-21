# Recording the demo gif (`docs/demo.gif`)

The gif is the single most important asset for the README and the LinkedIn post. It has one job:
land the **"wait — it did that by itself?"** moment in under 40 seconds. One sentence of English
goes in; a tested, merged commit comes out of *your* repo's `git log`.

## The one rule

**Show the payoff, not the plumbing.** A viewer scrubbing a LinkedIn feed gives you ~5 seconds to
hook them and ~40 to close. Cut everything that isn't the story: no `npm install`, no build
output, no environment setup. Do all of that *before* you hit record.

## Pre-roll (do this off-camera, before recording)

```bash
# engine built, demo target materialized, plane created + armed, target connected
cd loopkit && npm install && (cd packages/core && npm run build)
bash examples/setup-demo.sh ~/loopkit-demo/notes
# ...create the plane, copy prompts, LOOPKIT_AUTONOMY=on, `target add` (see README "Try it")
```

Warm the terminal: big font (18–20pt), a clean prompt, window ~100×28. Verify the whole sequence
runs green once, throwaway, so the take you record is a known-good path — the worker call is
non-deterministic, so never record your *first* attempt.

## The shot list (~40s)

| # | Duration | On screen | Narration / caption overlay |
|---|---|---|---|
| 1 | 0–4s | `loopctl board` — empty/near-empty board | "One folder. One AI. No tickets." |
| 2 | 4–9s | Type slowly: `loopctl new "Add a deleteNote(id) function to src/notes.js with tests"` | "I just describe the change." |
| 3 | 9–12s | Output: `→ captured WI-001` | *(let it breathe — this is the setup)* |
| 4 | 12–16s | `loopctl beat reactor` → item routed/queued | "It plans it as a work item…" |
| 5 | 16–28s | `loopctl beat dispatch` → build log scrolls: worktree created → worker → **gate ✓** → merged | "…builds it in an isolated worktree, and runs my tests." **← the tension beat** |
| 6 | 28–33s | `loopctl events --item WI-001` → the captured→built→gated→merged trail | "Every step is an event. Nothing merged until the tests were green." |
| 7 | 33–40s | `cd ~/loopkit-demo/notes && git log --oneline` → the worker's commit sits at HEAD | "…and it's already merged into my repo. I was never interrupted — because this change didn't need me." |

**Payoff frame:** hold shot 7 for a full 2–3s. The commit in `git log` is the whole ad — don't
cut away fast.

This works because the demo target's `loopkit.target.json` declares `src/` as neither a product
surface nor a risk path — the `deleteNote` change lands in the `optional` acceptance tier, which
auto-accepts without asking you (see README "Tiered acceptance"). It is genuinely not interrupting
you; it isn't skipping a step that a real product surface would still show you.

**Optional kicker (best 6 seconds you can add):** end on the *boundary*, and be precise about what
that boundary actually is — a risk path **merges** (the gate proved it), it just never
auto-accepts. Fire a second intent that touches a path listed in the target's
`escalationPatterns` (the demo target flags `src/auth`, `src/payments`, `migrations/`), run the
beats, and show it land on the console's **needs-you** lane as merged-but-awaiting-your-review:
`loopctl board` → item merged, sitting at `must` tier. Caption: "That one merged too — the gate
still proved it — but it waits on MY desk forever, because it touched something risky." The
contrast isn't "ships the safe one, halts the risky one" (nothing halts before merge); it's
*every change gets the same test-then-merge treatment, and only attention is rationed by risk.*
That's the real differentiator and what makes the post more than "another agent that writes code."

## How to record

Recommended: **[VHS](https://github.com/charmbracelet/vhs)** (`brew install vhs`). It runs a
`.tape` script and emits a deterministic gif — reproducible, re-recordable when the CLI output
changes, no hand-timing. Starter tape below; tune `Sleep` values to the real beat durations, and
pre-bake shot 5's long/non-deterministic worker run if you want a clean fixed-length take.

```tape
# demo.tape — render with: vhs demo.tape
Output docs/demo.gif
Set FontSize 20
Set Width 1100
Set Height 620
Set Padding 24
Set Theme "Catppuccin Mocha"

Type "loopctl board"          Enter    Sleep 3s
Type 'loopctl new "Add a deleteNote(id) function to src/notes.js with tests"'   Enter  Sleep 3s
Type "loopctl beat reactor"   Enter    Sleep 3s
Type "loopctl beat dispatch"  Enter    Sleep 10s
Type "loopctl events --item WI-001"  Enter  Sleep 4s
Type "cd ~/loopkit-demo/notes && git log --oneline -3"  Enter  Sleep 4s
```

Alternatives: **asciinema** + `agg` (authentic, but hand-timed), or QuickTime screen capture →
gif (heavier file). Keep the final gif **under ~5 MB** so it loads inline on GitHub and previews on
LinkedIn.

## Sanity checks before you publish the gif

- No absolute paths that leak your machine's username in frame (the demo lives under
  `~/loopkit-demo`, which is fine).
- No secrets, tokens, private hostnames, or unrelated project names anywhere in the terminal
  scrollback.
- The commit SHA/message shown is from the demo notes target, not a real project.

## Regenerating the console screenshot (`docs/console.png`)

`console.png` is the console's **Command** view rendered against a *seeded* ledger of dummy work
items — not a live plane. To refresh it (after a UI change, a renamed view, new tiles, etc.):

1. **Seed a synthetic ledger.** Build a handful of events with `@loopkit/core`'s `makeEvent`,
   spanning the board states (queued · building · parked/needs-you · merged-awaiting-acceptance ·
   accepted) — the shape in [`packages/console/test/fixtures.ts`](../packages/console/test/fixtures.ts)
   (`sampleLedger()`) is the reference. Write them as JSONL into `work-YYYY-MM.jsonl` segment
   files (grouped by the event month) in a scratch ledger dir.
   *Tip:* to make the acceptance card land in the `review` tier instead of `auto`, give the
   `item.merged` event real diff evidence (`baseSha`/`headSha`/`changedFiles` touching a
   `surfacePrefix`) — otherwise it classifies as "no code changed → auto".
2. **Boot the console** against it: `startConsole({ ledgerDir, port: 4137, repoRoot })` from
   `@loopkit/console` (needs `@loopkit/core`, `@loopkit/console`, and `@loopkit/ui` built).
3. **Screenshot** `http://127.0.0.1:4137/command` (the hero) — Missions and Acceptance are the
   alternate views. A browser at ~1280 wide gives the current framing.

## Keep the README current — these assets are point-in-time

The gif, the console shot, and the CLI/output snippets in the README all freeze how the framework
looked on the day they were made. Refresh them when any of these change:

- **CLI surface** — command names/output (`loopctl board|new|beat|events`), the tiered-acceptance
  labels, or the `notifyHook` contract → update the code fences **and** re-record the gif.
- **Console UI** — new views, renamed nav, changed tiles/badges → re-shoot `console.png`.
- **Scope** — anything in the "Honest scope" table (Linux support, multi-target, a real provider
  adapter) → move it from "not yet" to "works today" and reword the status paragraph.
- **New capability worth selling** (e.g. attended mode graduating from roadmap) → extend the
  README with it; consider a second gif.

Rule of thumb: if a reader could clone `main` and see something different from what the README
shows, the README is stale.
