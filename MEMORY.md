# kaggleforge — cross-competition memory (case bank)

Lessons that generalize **across** competitions. RETRIEVE the relevant ones
*before* proposing a node (retrieve-before-propose), and RETAIN a new one *after*
any promotion or hard-won failure. One line per lesson, ruthlessly short.
Per-competition state lives in `comps/<slug>/`, never here.

Format: `- [<tag>] <lesson> — <why> (<slug | general>)`

## Validation & leakage
- [cv] Trust a well-built CV over the public LB; a CV↔LB gap is a diagnostic, not a demote. — chasing the public LB causes private shake-up (general)
- [leak] Target-encode/scale/impute INSIDE the fold only. — fitting across the fold leaks the val target (general)
- [leak] If an id/entity repeats across rows, GroupKFold is mandatory. — random folds put the same group in train+val (general)
- [leak] Time column ⇒ TimeSeriesSplit + past-only features (no centered windows, no global stats). — future info leaks backward (general)
- [leak] Run the shuffled-label control on every node; if a permuted-label refit doesn't collapse, something leaks. — the cheapest catch-all (general)
- [seed] Freeze folds once; one seed controls ONLY the split. — a seed that also drives init/data order leaks across re-runs (general)

## Search & modelling
- [tree] One atomic change per node so every CV delta is attributable. — bundled changes hide which one helped (general)
- [family] Keep ≥2 model families alive; try a second family before tuning the first. — diversity beats early hyperparameter tuning (general)
- [pivot] After ~5 stalled improves, pivot the architecture, not the hyperparameters. — long flat lineages signal a wrong frame (general)
- [tabular] LightGBM/XGBoost/CatBoost are the default tabular workhorses. — strong, fast, robust to mixed types (general)
- [ensemble] Only blend arms whose per-fold failures are DISJOINT. — correlated arms add no signal and cost a slot (general)
- [ablate] A/B every added block against its parent CV; reject what regresses. — feature/tool additions sometimes hurt (general)

## Process
- [budget] CV decides WHAT to submit; never spend a slot to A/B on the LB. — 5/day is scarce, the LB is the OOD check not the selector (general)
- [metrics] Never promote on CV-mean alone; one outlier fold can carry the mean. — inspect per-fold deltas (general)
- [403] A 403 on download/submit means rules-not-accepted/unverified, NOT bad creds. — the #1 misdiagnosis (general)

## Per-competition lessons (appended on promotion)
<!-- e.g. - [fe] log1p the skewed target before RMSE — residuals become homoscedastic (house-prices) -->
_none yet_
