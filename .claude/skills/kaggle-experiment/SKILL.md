---
name: kaggle-experiment
description: Stage 4 — the solution-tree experiment loop (PROPOSE → DEVELOP → REVIEW → SCORE → DECIDE). Use when the comp has a frozen CV (folds.json) and a baseline champion, and the human says "run experiments", "/kaggle-experiment", "improve the model", "go auto", or after /kaggle-baseline submits. Drives one node per turn in interactive mode (Decision Card + gated submit) or hands the fan-out to the experiment-loop workflow in auto mode.
argument-hint: "[interactive|auto] [--node-id NNNN] [--draft|--improve|--debug]"
allowed-tools: Bash, Read, Write, Edit
---

# kaggle-experiment — the tree loop

You grow `comps/<slug>/tree.md`. Each **node = one atomic change** attached to the
deepest ancestor whose work it keeps. You PROPOSE an operator+parent, DEVELOP it
(via the `kaggle-developer` subagent), REVIEW it (via the `kaggle-reviewer`
subagent — **you sequence developer→reviewer because subagents can't nest**),
SCORE its CV, DECIDE promotion. Read CLAUDE.md for the standing contract; this
skill is the procedure.

## 0 · Orient (every entry)
Resolve `<slug>` from `comps/` (or `$ARGUMENTS`). Then:
- `DATE=$(date -u +%Y-%m-%dT%H:%MZ)` — never type a date.
- Read `comps/<slug>/config.md` → autonomy mode. `auto_except_submit`/`full_auto`
  ⇒ **AUTO**; `interactive` ⇒ **INTERACTIVE**. CLI arg overrides.
- Read `comps/<slug>/spec.md` machine block: `metric, direction (minimize|maximize),
  target, target_cols, id, task_type, time_col?, group_key?`.
- Read `tree.md` to rebuild the frontier (statuses: pending·running·buggy·valid·
  champion·dead) and `journal.md` tail. Confirm `folds.json` + `champion/` exist
  (else tell the human to run `/kaggle-validate` + `/kaggle-baseline` first).
- **Resume first:** if any node is `running`, open its `nodes/node_NNNN/node.md`
  and resume at the first unchecked box (artifact-then-tick — verify each ticked
  box against its named artifact; a box with no artifact is a lie, redo it). A
  `running` node with unchecked boxes and zero artifacts ⇒ mark `dead`, move on.

## 1 · Search policy — pick operator + parent
Count `valid`+`champion` root-branch families. `num_drafts` default **4**;
`debug-depth` ≤ **5** attempts. In order:
1. **draft** while valid-root-families < `num_drafts` → new branch under root, a
   *structurally different* approach (e.g. GBDT vs NN vs Darts). Parent = root.
2. else **debug** the shallowest `buggy` node within depth → child of the buggy
   node. Regenerate the node from scratch after **3** failed attempts; prune to
   `dead` after **5**.
3. else **improve** the best `valid`/`champion` node with **exactly one** atomic
   change → child of that node. A/B against its parent; reject on CV regress.
- **Keep ≥2 families alive.** If the best lineage hasn't beaten CV by more than
  one parent-SEM over **5 consecutive improves**, force a **draft** of a
  different family — pivot architecture, don't keep tuning.
- Parent rule: attach to the *deepest ancestor whose work the change keeps*.

## 2 · Create the node
`NNNN` = next zero-padded id. `mkdir -p comps/<slug>/nodes/node_NNNN/src`.
Write `node.md` from CLAUDE.md's template, filling the `## plan` with real detail:
**built on** (parent + what stays byte-identical), **change** (2–4 lines, the
concrete HOW the developer will implement and the `solution.py` docstring will
expand), **hypothesis**, **target**. Then `created: $DATE`, lifecycle all
unchecked. Add a `pending`→`running` row to `tree.md` (`| node_NNNN |
<op>(parent=<id>) | <family> | running | — | <one-line change> |`). Tick `[x] proposed`.

## 3 · DEVELOP — delegate to `kaggle-developer`
Spawn the **kaggle-developer** subagent (fresh context). Hand it explicitly:
- spec path `comps/<slug>/spec.md`, folds path `comps/<slug>/folds.json`;
- **parent src path** = `champion/src` for a draft off baseline, else
  `nodes/node_<parent>/src`; target node `nodes/node_NNNN/`;
- the **one-line atomic change**, and the metric+direction.
It must: copy parent src → node `src/`, apply only that change, write
`src/solution.py` that (a) loops `folds.json`, (b) **fits every transform
inside the train fold only**, (c) writes per-fold scores to `metrics.md`, OOF +
`submission.csv`, a `features.txt` (one feature col per line) for the scan, and
(d) runs the **shuffled-label control** in its own CV harness (import
`shuffled_label_ok` from `tools/leakage_scan.py`). Long train → marker file:
```bash
DONE=/tmp/<slug>_node_NNNN.done ; rm -f "$DONE"
(uv run python comps/<slug>/nodes/node_NNNN/src/solution.py \
   > comps/<slug>/nodes/node_NNNN/train.log 2>&1 ; touch "$DONE") &
# wait on [ -f "$DONE" ]; tail filtered for: cv=|Traceback|Error|Killed|OOM
```
On a clean run (no traceback in `train.log`) tick `[x] code written` + `[x] ran
clean`. A traceback ⇒ node `buggy` in `tree.md`, loop back to §1 (debug).

## 4 · REVIEW — sequence the `kaggle-reviewer` subagent
After the developer returns, **you** spawn the **kaggle-reviewer** subagent on
`nodes/node_NNNN/`. It runs unit tests + the leakage suite and returns PASS/FAIL.
The structural scan it drives:
```bash
uv run tools/leakage_scan.py \
  --train comps/<slug>/data/train.csv --test comps/<slug>/data/test.csv \
  --target <target> --target-cols <target_cols> --id <id> \
  --features-file comps/<slug>/nodes/node_NNNN/src/features.txt \
  --source comps/<slug>/nodes/node_NNNN/src/solution.py \
  --out    comps/<slug>/nodes/node_NNNN/leakage_scan.json
```
Plus the in-harness **shuffled-label control** (CV must collapse to the random
baseline) and `cv_too_good` tripwire — surface a tripwire to the human before any
submission. **Any `error`-severity check ⇒ the CV is void**, no matter how good:
mark the node `buggy` (or `dead` if the leak is intrinsic to the change), tick
nothing past `[x] ran clean`, return to §1. PASS + leak-clean ⇒ tick `[x] unit
tests pass` + `[x] leakage clean`.

## 5 · SCORE — compute CV (mean ± sem)
From `metrics.md` per-fold scores compute `mean` and `sem = std(ddof=1)/sqrt(k)`.
Record `cv: <mean> ± <sem>` in `metrics.md` and `node.md` result. Tick `[x] cv
computed`. Set `tree.md` status `valid`, fill its CV cell.

## 6 · DECIDE — promote or keep
Compare against the current champion CV (read `champion/README` /
`history`-equivalent in `tree.md`). Let `k=2`. **Accept as new champion** iff
**all** hold:
- CV beats champion **beyond k·sem** in the spec's `direction` (a within-noise
  win is *not* a promotion — log it `valid`, keep champion);
- leakage-clean (§4 passed, no void);
- **CV↔LB not diverging** — if this lineage has a submitted LB, the CV gain is
  directionally consistent with LB (a gap is *surfaced*, never an auto-demote;
  CV still decides what to submit).

On **accept**: byte-copy (cp, never symlink)
`nodes/node_NNNN/src` + `submission.csv` → `champion/`, update `champion/README`
(node id, cv±sem, $DATE, one-line change), set `tree.md` status `champion` and
demote the prior champion to `valid`. On **reject**: leave `champion/` untouched,
status stays `valid` (or `buggy`/`dead`). Either way tick `[x] decided`.
Append one timestamped journal line:
```bash
echo "- $DATE  node_NNNN  <op>(parent=<id>)  cv=<mean>±<sem>  leak=clean  -> <champion|valid|buggy|dead>: <one-line reason>" \
  >> comps/<slug>/journal.md
```

## 7 · SUBMIT (gated — only the best beats the last submitted CV)
Submit only a node whose CV beats the **last submitted CV** by more than
fold-noise (k·sem) — never spend a slot to A/B on the LB. Check budget:
`uv run tools/kaggle_io.py budget --ledger comps/<slug>/submissions.md` (used is
derived from today's UTC rows; resets 00:00 UTC). Validate before spending a slot:
```bash
uv run tools/validate_submission.py \
  --submission comps/<slug>/nodes/node_NNNN/submission.csv \
  --sample comps/<slug>/data/sample_submission.csv --id <id>
```
- **INTERACTIVE / `auto_except_submit`:** render a **Decision Card** (below) and
  **wait** — the human owns every real submission.
- **`full_auto` + budget remaining:**
  `uv run tools/kaggle_io.py submit <slug> --file …/submission.csv --message "node_NNNN cv=<mean>"`,
  append the row to `submissions.md` (`| $DATE | node_NNNN | <cv> | <lb-pending> |`),
  poll `uv run tools/kaggle_io.py submissions <slug>` for the public score, write
  it back. A 403 ⇒ rules-not-accepted/unverified (human gate), **not** bad creds.
Tick `[x] submitted` once the ledger row exists.

## Decision Card (render at every interactive gate)
```
📋 experiment · node_NNNN <op>(parent=<id>)
What's going on:   <plain sentence of the change>
Found / propose:   • cv <mean>±<sem> vs champ <champ_cv> (<beats by Nσ | within noise>)
                   • leakage: clean · families alive: <n> · stall-count: <m>/5
                   • <submit this? slot N/5 today | keep exploring>
Why:               <one line>
Cost:              <~mins · cpu/gpu · submissions N/5 today>
Your call:         [Approve] [Change something] [Skip] [Tell me more]
Autonomy: <mode> — waiting
```

## Modes
- **INTERACTIVE** — exactly **one node per turn**: §1→§6, render the Card, stop.
  Resume next turn at §0. Every submission is human-gated (§7).
- **AUTO** — invoke the workflow for the best-first fan-out instead of looping by
  hand: `.claude/workflows/experiment-loop.js` (it sequences developer→reviewer
  per node across the frontier and applies §1's policy). It can't show cards: in
  `auto_except_submit` it **queues** the best node and *this* main session
  surfaces the Decision Card before submitting; in `full_auto` it submits within
  budget. When the workflow returns, re-orient (§0) and continue.

## Invariants
- Artifact-then-tick — a checkbox never runs ahead of its named artifact.
- One atomic change per node; every CV delta is attributable.
- Leakage voids the score — a leaky node never counts, never promotes.
- Trust CV over LB; a CV↔LB gap is a diagnostic to surface, not an auto-demote.
- All dates from `date -u`; all scripts via `uv run`; reusable code stays in `tools/`.
