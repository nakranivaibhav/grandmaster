---
name: kaggle-baseline
description: Stage 3 of kaggleforge. Build the dumbest defensible prediction (mean/median for regression, base-rate/majority for classification) as node_0000, compute its CV under the frozen folds.json, validate the submission file, promote it to champion, then make the FIRST real submission to prove the whole pipe end-to-end. Use when validation is frozen (folds.json + validation.md exist) and there is no champion yet, or the human says "baseline" / "first submission" / "/kaggle-baseline".
argument-hint: <slug>
allowed-tools: Bash, Read, Write, Edit
---

# kaggle-baseline — the dumb baseline that becomes the first champion

Goal: build the **simplest prediction that cannot be wrong about the schema**, prove
it scores under our own frozen CV, validate the submission file, promote it to
`champion/`, and spend submission #1 on it. This proves the data → CV → submission
→ Kaggle pipe works *before* a single model is trained. If this stage is green,
every later node only changes the prediction, never the plumbing.

`<slug>` comes from `$1` (or the only `comps/` dir). All paths below are
`comps/<slug>/...`. Dates are ALWAYS `date -u` — never typed.

## Preconditions (read, don't assume)
1. `Read comps/<slug>/spec.md` — pull the machine block: `target`, `id` column,
   `metric`, `direction` (minimize|maximize), `task_type`
   (regression|classification_*), and the sample-submission value column name(s).
2. `Read comps/<slug>/validation.md` and confirm `comps/<slug>/folds.json` exists.
   If folds.json is missing, STOP — go run `/kaggle-validate` first.
3. `Read comps/<slug>/progress.md`; confirm `validation` is ticked and `baseline`
   is not. Confirm `comps/<slug>/data/{train.csv,test.csv,sample_submission.csv}`
   exist (whatever the comp's filenames are — use the ones in spec.md).
4. `Read comps/<slug>/config.md` for the autonomy mode (gates the submit step).
5. If `comps/<slug>/champion/` already has a `submission.csv`, a champion exists —
   this skill is for the FIRST one only. Stop and report.

## Step 1 — create node_0000 and its node.md
```bash
slug=<slug>; node=comps/$slug/nodes/node_0000
mkdir -p $node/src
NOW=$(date -u +%Y-%m-%dT%H:%MZ)
```
Write `$node/node.md` from the CLAUDE.md node template, `operator=draft`,
`parent=root`, `family=baseline`, `status=running`, `created: $NOW`. Fill the
`## plan`: **built on** = root (nothing inherited — this is the floor); **change**
= the constant rule (which constant + why, 1–2 lines, e.g. "predict the global
train median for every test row"); **hypothesis** = "establishes the
schema-correct data→CV→submit pipe and a floor CV every later node must beat";
**target** = the official metric + direction. Tick `- [x] proposed` (this file is
the artifact). Leave the rest unticked — artifact-then-tick.

Append one line to `comps/$slug/journal.md`:
`$NOW node_0000 draft(root) baseline — predict <mean|median|base-rate> · status=running`.

## Step 2 — write the baseline solution (`$node/src/solution.py`)
The script is **self-contained** and does TWO jobs in one run: (a) compute CV
under folds.json, (b) emit `submission.csv`. Pick the constant by task:

| task_type | constant predicted for every row | why |
|---|---|---|
| regression, metric=RMSE/MAE | train **median** of target | median ~minimizes MAE, robust for RMSE |
| regression, metric=RMSLE | `expm1(mean(log1p(y_train)))` | RMSLE optimum is the log-space mean |
| classification (proba metric, e.g. AUC/logloss) | train **base rate** `mean(y==1)` per class | constant prob = the prior |
| classification (label metric, e.g. accuracy/F1) | **majority class** | the mode is the label-metric optimum |

Hard rules the script obeys:
- The constant is fit **inside each train fold only** (recompute per fold from the
  fold's train rows), then scored on that fold's `val_idx`. Never fit on full
  train for the CV number — that is the fit-inside-fold discipline even for a
  constant, and it keeps the leakage scan honest.
- Score with the comp's **official metric** in its **official direction** (read
  from spec.md). Print `cv=<mean>±<sem>` on its own line, plus per-fold values.
- For the *submission*, the constant is fit on **all** train rows (that's correct —
  test is never in the fit) and broadcast to every test id.
- Output columns must byte-match `sample_submission.csv`'s header and id set.
- `features = []` (a constant uses no features) — write
  `$node/src/features.txt` empty (one trailing newline) for the leakage scan.

Sketch (adapt names from spec.md; do not hardcode `Id`/`target`):
```python
import json, numpy as np, pandas as pd
from pathlib import Path
D = Path(__file__).resolve().parents[3]             # comps/<slug>  (src→node→nodes→<slug>)
slug, TARGET, IDC = "<slug>", "<target>", "<id>"
tr = pd.read_csv(D/"data/train.csv"); te = pd.read_csv(D/"data/test.csv")
samp = pd.read_csv(D/"data/sample_submission.csv")
folds = json.loads((D/"folds.json").read_text())["folds"]
def const_from(y):      # the dumb predictor, fit on given rows only
    return float(np.median(y))                      # swap per table above
def metric(y, p):       # official metric, official direction handled by caller
    return float(np.sqrt(np.mean((y-p)**2)))        # swap per spec.md
scores=[]
for f in folds:
    va = np.array(f["val_idx"]); mask=np.ones(len(tr),bool); mask[va]=False
    c = const_from(tr.loc[mask, TARGET].values)     # FIT INSIDE FOLD
    scores.append(metric(tr.loc[va, TARGET].values, np.full(va.shape, c)))
cv=float(np.mean(scores)); sem=float(np.std(scores,ddof=1)/np.sqrt(len(scores)))
print("per_fold="+",".join(f"{s:.6f}" for s in scores)); print(f"cv={cv:.6f}±{sem:.6f}")
c_full = const_from(tr[TARGET].values)              # full-fit ok: test not used
sub = samp.copy(); val_cols=[c for c in samp.columns if c!=IDC]
sub[IDC]=te[IDC].values
for col in val_cols: sub[col]=c_full
sub.to_csv(D/"nodes/node_0000/submission.csv", index=False)
print("wrote submission.csv rows", len(sub))
```
For multi-column classification submissions (one prob column per class), set each
class column to that class's base rate; for a single-prob binary column, use
`mean(y==1)`. Match `sample_submission.csv` exactly.

## Step 3 — run it (capture log, artifact-then-tick)
Fast (seconds), so run foreground; only background per the CLAUDE.md marker
pattern if it ever takes minutes.
```bash
uv run python $node/src/solution.py > $node/train.log 2>&1; echo "exit=$?"
grep -E "cv=|Traceback|Error|Killed" $node/train.log
```
No traceback → tick `- [x] ran clean → train.log`. Then write `$node/metrics.md`
with `cv=<mean>±<sem>`, the per-fold line, the metric name, and the direction;
tick `- [x] cv computed → metrics.md`. (No separate unit-test box for a constant —
the leakage scan + validate are the gates; note that in node.md's test box.)

## Step 4 — leakage scan (constant baseline must pass trivially)
```bash
uv run tools/leakage_scan.py \
  --train comps/$slug/data/train.csv --test comps/$slug/data/test.csv \
  --target <target> --id <id> \
  --features-file $node/src/features.txt --source $node/src/solution.py \
  --out $node/leakage_scan.json
echo "leak_exit=$?"
```
Exit 0 (a constant has no features, so every structural check is vacuously clean).
Tick `- [x] leakage clean → leakage_scan.json`. Exit 1 means the solution
accidentally used a feature/id — fix solution.py, don't override the gate.

## Step 5 — validate the submission file (the schema gate)
```bash
uv run tools/validate_submission.py \
  --submission $node/submission.csv \
  --sample comps/$slug/data/sample_submission.csv --id <id>
echo "valid_exit=$?"
```
Must print `OK:` and exit 0. Any `INVALID:` line (column/row/id/NaN/inf) → fix
solution.py and rerun Steps 3–5. Record the gate result in
`$node/gate_report.md` (one line: `validate_submission OK` + leakage summary);
tick `- [x] unit tests pass → gate_report.md`.

## Step 6 — make node_0000 the champion (in tree, then byte-copy)
This is the first valid node, so it is the champion by definition (best valid CV).
1. Append the node_0000 row to `comps/$slug/tree.md` (create the table with header
   `| node | operator | parent | family | change | cv | status |` if absent),
   `status=champion`.
2. Byte-copy into `champion/` (cp, never symlink — CLAUDE.md tree semantics):
```bash
mkdir -p comps/$slug/champion
cp -r $node/src comps/$slug/champion/src
cp $node/submission.csv comps/$slug/champion/submission.csv
```
3. Write `comps/$slug/champion/README.md`: node_0000, the constant used, `cv=…`,
   metric+direction, and "first champion — dumb baseline, proves the pipe."
4. In `$node/node.md` set `status=valid`, `decided: $(date -u +%Y-%m-%dT%H:%MZ)`,
   fill `## result` (`cv: … leak: clean decision: champion`), tick
   `- [x] decided → tree.md updated (champion?)`. Append a `journal.md` line:
   `<NOW> node_0000 → champion cv=<…> (<metric> <direction>)`.

## Step 7 — SUBMIT GATE (spends 1 of 5/day)
A real submission is irreversible + rate-limited → it is a **hard human gate**
except in `full_auto`. Check the budget first (derived, never stored):
```bash
uv run tools/kaggle_io.py budget --ledger comps/$slug/submissions.md --limit 5
```
Render the Decision Card (CLAUDE.md format):
```
📋 baseline · first submission
What's going on:   the dumbest possible prediction is built and passes our own checks.
Found / propose:   • node_0000 = constant <mean|median|base-rate>, cv=<…> (<metric>)
                   • submission.csv validated against sample_submission (schema OK)
                   • this is a dry run of the whole pipe — not a real model yet
Why:               proves data→CV→submit→Kaggle works before we spend effort modelling.
Cost:              ~0 compute · spends submission 1 of 5 today (resets 00:00 UTC)
Your call:         [Approve] [Change something] [Skip] [Tell me more]
Autonomy: <mode> — <waiting | proceeding>
```
- `interactive` / `auto_except_submit`: **wait** for approval (the submit gate is
  human in both). On "skip", leave node_0000 as champion, do NOT submit, mark
  progress and stop.
- `full_auto`: proceed without waiting.

On approval (and only if `remaining > 0`), hand off to the submit skill so the
ledger/poll logic lives in one place:
```
/kaggle-submit <slug> --node node_0000 --message "node_0000 baseline cv=<cv> (<metric>)"
```
The kaggle-submit skill appends the UTC row to `submissions.md`, polls for the
public score, and logs the CV↔LB gap (surfaced, never auto-acted). When it
returns, tick `- [x] submitted → submissions.md` in node.md and note the public
score + gap in `metrics.md` and `journal.md`. (If a 403 comes back, that's
rules-not-accepted / unverified, NOT bad creds — surface the human gate, don't
retry around it.)

## Step 8 — close the stage
Tick `baseline` in `comps/$slug/progress.md` and regenerate its derived header
(`today (UTC)=$(date -u +%F)`, `submissions=<used>/5`, `deadline … days_left`).
Final readout to the human: champion = node_0000, local CV, public score (if
submitted) and the CV↔LB gap, and that the pipe is proven end-to-end — next is
`/kaggle-experiment` (real models).

## Guardrails
- Never tick a box before its named artifact exists (artifact-then-tick).
- A server-rejected submission does NOT burn the daily quota — safe to fix and
  resubmit; only an *accepted* submit counts.
- Do not add features, models, or tuning here — that is `/kaggle-experiment`.
  One atomic thing: the dumbest constant, proven end-to-end.
- If `solution.py` takes minutes (huge test set), run it backgrounded with the
  marker-file pattern (`DONE=/tmp/${slug}_node_0000.done`) per CLAUDE.md.
