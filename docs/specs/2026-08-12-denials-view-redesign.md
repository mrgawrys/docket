# Denials view redesign — Design

> **To act on this design:** pick a mode — *vibe* (inline, no machinery),
> *review each task* (per-task diffs), *review at the end* (one subagent
> builds, one review at the end), or *plan first* (`writing-plans`, then how it
> gets built). Unattended end-to-end is `/autopilot`. Ask the user which; don't
> pick for them.

Supersedes the UI half of
[2026-08-07-first-run-wizard-and-denial-surfacing-design.md](2026-08-07-first-run-wizard-and-denial-surfacing-design.md)
§2. Detection, grouping and classification in `src/denials.ts` stand as built;
only what the TUI does with them changes.

## Why

The shipped view failed its first test drive. Four findings, each traceable to
one cause:

- **Nothing invites you in.** A row carries a `⊘ 38` chip. A chip is a label,
  not an offer — it never says a fix is one key away, or which key.
- **The legend lies.** `Legend` renders the queue's keymap in every view
  (`src/tui/app.tsx:378`), so it advertises `enter claude` at the moment
  `enter` does nothing (`app.tsx:324`). The denials keys appear only as
  right-aligned bar text (`app.tsx:390`), the first thing a narrow terminal
  truncates.
- **Hand-off hides.** `h` and `H` exist in the keymap and nowhere on screen.
- **`a` explains nothing.** The help reads `apply (denials view)`, naming
  neither what is applied nor what it is applied to.

The cause is one design choice: the view was built as a mode but dressed as a
panel. A mode owes the user its own chrome — its own legend, its own verbs, its
own way out. Here the chrome stayed global and only the body swapped.

A second decision reshapes the view itself. Denials are worth reading per
group and not worth acting on per group: either the run's blocked calls get
addressed or they don't. Dropping per-group action removes the cursor, the
per-row verbs, and the ambiguity about what any key acts on.

## 1. The queue panel teaches

The detail panel under the queue gains a denials section, above the summary. It
is the only thing that must be discoverable; everything else follows from it.

```
  ▸  1 mrgawrys/docket#6      failed    ⚠ 3 issues  ⊘ 39
     2 mrgawrys/clankit#12    ready     ⚠ 1 issue

─ mrgawrys/docket#6 ──────────────────────────────────────────────────
  39 calls were blocked — the review worked around them.
    Bash(rg:*)              ×24
    Bash(gh pr comment:*)   ×8    ⚠ write-shaped
    Bash(git push:*)        ×4    ⚠ write-shaped
  + 3 more · D works through them

  risk: medium · 3 issues · security: none
```

Three groups at most, then the remainder and the key. The row chip stays: it is
the at-a-glance column, and the panel is the explanation.

`D` remains the key. In the queue `enter` resumes the review's claude session
(`app.tsx:332`), the more common verb, so it does not move.

## 2. The view reads and scrolls

No cursor, no selection, no per-group verbs. Every group renders; the action
block sits at the foot as panel content.

```
─ denials: mrgawrys/docket#6 ─────────────── 6 rules, 39 blocked calls ─

  Bash(rg:*)                ×24
      rg -n 'TODO' src/
      rg --files-with-matches denials
  Bash(gh pr comment:*)     ×8    ⚠ write-shaped
      gh pr comment 6 --body 'nit'
  Bash(git push:*)          ×4    ⚠ write-shaped
      git push origin HEAD
  Bash(sed:*)               ×1    ⚠ write-shaped
      sed -i '' 's/foo/bar/' src/denials.ts
  Bash(gh pr diff:*)        ×1    ✓ already in your config
  Write                     ×1    ⚠ write-shaped

  ⏎  hand all of this to claude
  a  add the 1 safe rule to your config (5 skipped: 4 write-shaped, 1 already there)
  esc back to the queue · j/k scroll
```

The action block is panel content, not bar text. Bar text is right-aligned and
truncates; these lines wrap and survive a narrow terminal. `j/k` scrolls by
line, which replaces the block-scrolling arithmetic the cursor required.

After `a` writes, the block reports what landed and offers the next step:

```
  1 rule added — it applies to the next run of this review.
  r  re-run the review now       ⏎  hand the rest to claude
  esc back to the queue
```

"Added just now" is derived, not remembered: a group whose frozen
`alreadyAllowed` is false and whose suggestion `isAllowed()` finds in the
config now was added this session. This deletes the `applied` state
(`app.tsx:293`) and with it the bug where the label reset after a suspend.

## 3. Verbs and rails

| key | does | notes |
| --- | --- | --- |
| `⏎` | hands every group to claude | batch always; `HandoffScope` collapses to one shape |
| `a` | one config write adding every addable rule | write-shaped and already-present groups are filtered out |
| `r` | re-runs this review | acts on the view's key, never the queue cursor; shown once `a` has written |
| `esc`, `D` | back to the queue | |
| `j`, `k` | scroll | |

Today the read-only stance is enforced per keystroke: `a` on a write-shaped
group refuses and writes a status line (`app.tsx:282`). Batch action moves that
decision into a pure selector in `src/denialview.ts`:

```ts
// The groups `a` will write, and why each of the rest was left out. One place
// decides it, so the count in the action line and the rules that reach config
// cannot disagree.
export function addable(groups: DenialGroup[], cfg: Config): {
  add: DenialGroup[];
  writeShaped: DenialGroup[];   // docket never adds these
  present: DenialGroup[];       // adding them again fixes nothing
};
```

`a` folds `applySuggestion` over `add` and calls `writeConfigText` once — one
crash-safe write for N rules rather than N writes. The selector keeps both
checks the keystroke made: the flag frozen when the run ended, and the live
`isWriteShaped`, so a classifier that has since tightened still wins.

When `add` is empty the line renders disabled and says why, rather than
accepting a key that then declines:

```
  a  nothing to add — 3 write-shaped, 1 already in your config
```

## 4. The legend stops lying

`KEYMAP` splits into `QUEUE_KEYS` and `DENIAL_KEYS`. `Legend` takes the active
view and renders that view's keys. `Help` shows both under headings. The
`a`/`h`/`H` entries suffixed `(denials view)` (`src/tui/legend.tsx:16`)
disappear from the queue's list — that suffix was the tell that one keymap
served two screens.

## 5. Modules

- `src/denialview.ts` — the pure centre. Gains `denialTeaser` and `addable`;
  `denialLines` loses `selected` and gains the action block. `clampGroup` goes.
- `src/panel.ts` — `panelLines` takes the denials and the live config so the
  teaser renders with the rest of the detail.
- `src/tui/app.tsx` — deletes both cursor states, the `applied` set, and the
  per-group `a`/`h`/`H` handlers; wires `⏎`, `a`, `r`.
- `src/tui/legend.tsx` — the split above.
- `src/handoff.ts` — `HandoffScope` and its `scopeLabel` branch go; the prompt
  always speaks of the whole set.
- `README.md` — the denials section documents these keys, so it changes with
  them.

`docket doctor` needs no change: this adds no binary, no `ALLOWED_TOOLS` entry
and no config key. The poller and `docket review` are untouched.

## 6. Testing

Logic lives in pure modules and is tested there; TUI tests stay thin
(CLAUDE.md).

- `tests/denialview.test.ts` centres on `addable` — which groups it selects,
  and the three reasons it rejects one. Plus teaser rendering (the cap and the
  remainder), the action-line copy including the disabled form, and the derived
  "added just now".
- `tests/tui.test.tsx` keeps the three tests guarding real loss: `a` writes the
  safe rules and no write-shaped one, it reads config off disk rather than the
  TUI's opening snapshot, and it writes through a symlink instead of replacing
  it. The hand-off scope test collapses to a batch-only assertion. One new
  test: `r` retries the view's own PR, since retrying the wrong row bills a
  second review.
- Deleted with their subjects: the four cursor tests
  (`tests/denialview.test.ts:50`, `:122`, `:131`) and the `applied`-set test
  (`:146`).

## 7. Out of scope

- Aggregate denial reporting across runs, notifications, doctor checks — still
  deferred, as in the original spec.
- The wizard half of PR #6. Untouched.
- Editing a suggestion before adding it. If a rule needs adjusting, that is
  what handing the set to claude is for.
