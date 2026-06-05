---
name: kaggle-final
description: Deadline-triggered final ensemble + selection for a Kaggle competition. Picks the 2 entries to lock in for private scoring — the best-CV single pipeline and a CV-weighted blend of de-correlated champions/runners-up — gated by an oracle-complementarity check (only blend arms whose per-fold failures are disjoint). Use when the deadline is near (days_left small in progress.md), when /kaggle-experiment reports the deadline reached, or when the human says "final" / "finish" / "/kaggle-final".
argument-hint: <slug>
allowed-tools: Bash, Read, Write, Edit
---

# /kaggle-final — final ensemble + the 2 entries to lock in

Kaggle scores you on **2 selected submissions** at the deadline (default = your 2
best public). Goal: make those 2 the best *CV-justified* pair — the single best
pipeline and, only if it genuinely helps, a blend of **de-correlated** arms. Never
trade a robust CV pick for a public-LB mirage (Hard rule 6).

`<slug>` from `$1`. All paths `comps/<slug>/...`. Dates always `date -u`.

## 0 · Should we be here yet?
```bash
slug=<slug>
deadline=$(grep -E '^deadline:' comps/$slug/spec.md | awk '{print $2}')
days_left=$(( ( $(date -u -d "$deadline" +%s) - $(date -u +%s) ) / 86400 ))
echo "days_left=$days_left"
```
Run this when `days_left` is small (≈≤1) or the human asks. If there's still
runway, say so and stay in `/kaggle-experiment` — finals are cheap to defer.

## 1 · Assemble candidate arms
From `tree.md`, take the champion plus the top valid nodes by CV (leak-clean only),
across **distinct families** where possible. For each arm read its OOF predictions
(`nodes/<id>/src/oof.csv`) and per-fold scores (`metrics.md`). You need the OOFs
aligned to the same frozen `folds.json` row order — they are, because every node
used the same split.

## 2 · Oracle-complementarity check (only blend disjoint failures)
A blend only helps when arms fail on **different** rows. Measure it on OOF, not the
LB:
```bash
uv run python - <<'PY'
import json, numpy as np, pandas as pd
from pathlib import Path
D=Path("comps/<slug>"); folds=json.loads((D/"folds.json").read_text())
y=pd.read_csv(D/"data/train.csv")["<target>"].to_numpy()
arms={"<id_a>":"nodes/<id_a>/src/oof.csv","<id_b>":"nodes/<id_b>/src/oof.csv"}  # champion + runners-up
oof={k:pd.read_csv(D/v).iloc[:,-1].to_numpy() for k,v in arms.items()}
res={k:(y-p) for k,p in oof.items()}                      # residuals (regression); use (y!=pred) for clf
R=np.corrcoef(np.vstack(list(res.values())))
print("arms:",list(arms)); print("residual corr:\n",np.round(R,3))
# de-correlated if off-diagonal |corr| < ~0.95
PY
```
- Off-diagonal residual correlation **< ~0.95** ⇒ arms are complementary, a blend
  is worth trying.
- **≥ ~0.95** (arms fail together) ⇒ a blend buys nothing and costs a slot. Skip
  the blend; the 2 finals become your **two best de-correlated singles** (or the
  single best twice if everything is correlated).

## 3 · Build the CV-weighted blend (only if step 2 passed)
Weight arms by CV (better CV ⇒ more weight), search a small simplex on OOF, and
**accept the blend only if its OOF CV beats the best single under `folds.json`**:
```bash
uv run python - <<'PY'
import json, numpy as np, pandas as pd
from itertools import product
from pathlib import Path
D=Path("comps/<slug>"); y=pd.read_csv(D/"data/train.csv")["<target>"].to_numpy()
def metric(yt,yp): return float(np.sqrt(np.mean((yt-yp)**2)))   # official metric; minimize here
oof={ "<id_a>":pd.read_csv(D/"nodes/<id_a>/src/oof.csv").iloc[:,-1].to_numpy(),
      "<id_b>":pd.read_csv(D/"nodes/<id_b>/src/oof.csv").iloc[:,-1].to_numpy() }
ids=list(oof); P=np.vstack([oof[i] for i in ids])
best=(None,1e18)
for w in product(np.linspace(0,1,11),repeat=len(ids)):
    if abs(sum(w)-1)>1e-6: continue
    s=metric(y, np.average(P,axis=0,weights=w))
    if s<best[1]: best=(w,s)
singles={i:metric(y,oof[i]) for i in ids}
print("singles:",{k:round(v,5) for k,v in singles.items()})
print("best blend w=",np.round(best[0],2)," cv=",round(best[1],5),
      " -> ","USE BLEND" if best[1]<min(singles.values()) else "KEEP SINGLE")
PY
```
If the blend doesn't beat the best single, **don't blend** — submit the single.
If it does, write `nodes/blend_final/src/solution.py` that applies those weights to
the arms' **test** predictions and emits `submission.csv` (validate it like any
node, run the leakage scan on its inputs — the arms already passed).

## 4 · The 2 finals + submit (budget-gated)
Choose the two entries to lock in:
- **Final A** = the best-CV single pipeline (the champion).
- **Final B** = the accepted blend, else the best de-correlated 2nd single.

For any final not already on the leaderboard, submit it via the submit skill
(spends a slot; near the deadline, budget may bind — check it first):
```
/kaggle-submit <slug> blend_final --message "final blend cv=<cv>"
```
Validate every file with `tools/validate_submission.py` before submitting.

## 5 · Lock the selection (a HUMAN browser gate)
Kaggle's **final selection** (choosing which 2 submissions count for the private
score) is done in the browser — like accepting rules, it can't be scripted.
Surface it as a Decision Card:
```
📋 final selection (human, in browser)
What's going on:   pick the 2 entries Kaggle scores privately at the deadline.
Found / propose:   • Final A: <champion node> — cv <cv_a> (single best)
                   • Final B: <blend|2nd single> — cv <cv_b> (<blended w=… | de-correlated single>)
Why:               both are CV-justified; trust CV, not the public board, for the private split.
Cost:              browser action — set these two as your final selections.
Your call:         [I've selected them] [Change something] [Tell me more]
Autonomy: <mode> — <waiting | proceeding>
```

## 6 · Close out
- Append to `journal.md`: `<date -u +%FT%RZ> FINAL A=<node>(cv=<>) B=<node|blend>(cv=<>) — selected`.
- Tick `final ensemble` in `progress.md`; regenerate its header.
- RETAIN any generalizable lesson from this comp into the repo `MEMORY.md`
  (retrieve-before-propose pays off next competition).
- Final readout: the two selected entries, their CVs, public scores if known, and
  the reminder that the private result lands at the deadline.

## Guardrails
- Trust CV over the public LB when choosing finals (private shake-up is real).
- Only blend de-correlated arms (oracle check) — a blend of look-alikes wastes a slot.
- Final selection is a human browser action — never claim it's done until the human confirms.
