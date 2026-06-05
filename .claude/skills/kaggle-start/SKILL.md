---
name: kaggle-start
description: ENTRY point for a new Kaggle competition. Use when the human pastes a Kaggle competition URL or slug. Bootstraps comps/<slug>/, surfaces the one-time human provisioning (API token, accept rules, phone-verify), downloads the data + sample_submission via kaggle-io, writes spec.md (prose + machine yaml block), then renders the UNDERSTAND and TOOLKIT Decision Cards. Ends by pointing to /kaggle-eda.
argument-hint: "<competition-url-or-slug>"
allowed-tools: Bash, Read, Write, Edit
---

# /kaggle-start — stage 0, bootstrap + understand + toolkit

You are at the very front of the pipeline (see CLAUDE.md "Stage flow"). Gates you
own: **understand** and **toolkit**. Both are human gates unless
`config.md` says `full_auto`. Do the work, then render the cards and wait.

## 0 · derive the slug

The arg is a URL or a bare slug. Strip it to the slug:

```bash
ARG="$1"
SLUG=$(printf '%s' "$ARG" | sed -E 's#https?://[^/]*kaggle.com/(c/|competitions/)?##; s#/.*##' | tr -d ' ')
COMP="comps/$SLUG"; echo "slug=$SLUG"
```

If `$SLUG` is empty or still contains a scheme, ask the human for the plain slug
and stop.

**Resume check.** If `$COMP/progress.md` already exists, this comp was started
before — read it, resume at the first unchecked box, do NOT re-scaffold. Only
continue below if it is absent.

## 1 · scaffold comps/<slug>/

Dates come from the shell, never memory:

```bash
TODAY=$(date -u +%F)              # 2025-01-31
NOW=$(date -u +%Y-%m-%dT%H:%MZ)   # 2025-01-31T09:12Z
mkdir -p "$COMP/data" "$COMP/champion"
```

Create these files. Touch the empty append-only logs first:

```bash
: > "$COMP/journal.md"; : > "$COMP/submissions.md"; : > "$COMP/tree.md"
```

`config.md` — autonomy dial defaults to interactive:

```markdown
# config — <slug>
autonomy: interactive
# interactive | auto_except_submit | full_auto  (flip by voice; see CLAUDE.md)
```

`progress.md` — the macro resume file. The header line is derived from `date -u`
(regenerate it on every read; deadline filled from spec.md once written):

```markdown
# progress — <slug>
today (UTC): <TODAY>   submissions: 0/5 (resets 00:00 UTC)   deadline: <tbd from spec>

## one-time setup (human)
- [ ] KAGGLE_USERNAME + KAGGLE_KEY in env        → kaggle_io ensure_auth passes
- [ ] competition rules accepted in browser      → download returns 200
- [ ] account phone-verified (GPU/internet)      → only if kernels needed
- [ ] data downloaded + unzipped                 → comps/<slug>/data/
- [ ] spec.md written                            → comps/<slug>/spec.md

## stages
- [ ] understand   (card approved)
- [ ] toolkit      (card approved)
- [ ] eda          → /kaggle-eda
- [ ] validate     → /kaggle-validate
- [ ] baseline     → /kaggle-baseline
- [ ] experiment   → /kaggle-experiment
```

Append the first journal line (timestamped, one line per event); leave
`submissions.md` and `tree.md` empty (downstream stages own them):

```bash
printf '%s  bootstrap comps/%s  (autonomy=interactive)\n' "$NOW" "$SLUG" >> "$COMP/journal.md"
```

## 2 · surface the one-time human provisioning, then maybe STOP

Three things are **non-automatable** and must be done by the human once (CLAUDE.md
"Kaggle integration"). Check auth and probe the download; if it fails, map the
error and STOP — do not retry around a 403.

```bash
[ -n "$KAGGLE_USERNAME" ] && [ -n "$KAGGLE_KEY" ] && echo "auth env: present" || echo "auth env: MISSING"
```

If auth env is missing, tell the human verbatim:

> Before I can pull data I need a Kaggle API token. Go to kaggle.com → your
> profile → Settings → API → "Create New Token" (downloads `kaggle.json`), then
> set in this shell: `export KAGGLE_USERNAME=...  KAGGLE_KEY=...`. Also (one time
> per comp): **accept the competition rules** on the comp page, and
> **phone-verify** your account if you'll use GPU/internet kernels. Tell me when
> done and I'll retry.

Then **stop and wait**. Do not proceed without auth.

## 3 · download data + sample_submission (kaggle-io)

Pull everything for the comp (the wrapper unzips automatically):

```bash
uv run tools/kaggle_io.py download "$SLUG" --dest "$COMP/data"
RC=$?
```

If `RC != 0`, classify the failure and act — never silently retry a 403:

```bash
# capture the stderr line you saw, e.g. "403 Forbidden"
uv run tools/kaggle_io.py classify-error --text "<paste the error line>"
```

- `rules_not_accepted` (this is what **403** maps to — the #1 misdiagnosis is
  reading it as bad creds): tell the human to **accept the rules in the browser**
  (and phone-verify), then **STOP**. Do not loop.
- `auth`: re-surface the env-token instructions from step 2 and STOP.
- `not_found`: the slug is wrong — confirm it with the human and STOP.
- `rate_limited`: the wrapper already backed off; if it still failed, wait and
  retry once.

On success, list what landed and locate the sample submission:

```bash
ls -R "$COMP/data" | head -50
SAMPLE=$(ls "$COMP"/data/{sample_submission*,*sample*sub*,SampleSubmission*} 2>/dev/null | head -1)
echo "sample_submission: ${SAMPLE:-NOT FOUND}"
```

If there is no sample_submission (common in code-/vision comps), note it:
`submission_columns` and `n_test_rows` come from the overview/test set instead
and `sample_submission` is `null` in the yaml. Tick "data downloaded" in
`progress.md`.

## 4 · read overview + sample_submission → write spec.md

Fetch the competition overview + evaluation pages for the metric and rules:

```bash
echo "fetch: https://www.kaggle.com/competitions/$SLUG/overview"
echo "fetch: https://www.kaggle.com/competitions/$SLUG/overview/evaluation"
```

Use WebFetch on those two URLs (Description, Evaluation, the submission-format
section, and the deadline). Then inspect the sample submission to lock columns,
the id/target columns, and the row count:

```bash
[ -n "$SAMPLE" ] && head -3 "$SAMPLE" && wc -l "$SAMPLE"
```

`n_test_rows` = `(line count − 1)` of the sample submission (or the test set row
count if there is no sample). `submission_columns` = its header. Identify
`id_col` (first/index column) and `target_col(s)` (the rest). For multilabel /
multi-target, fill `target_cols[]` and set `target_col` to null; for single
target, set `target_col` and leave `target_cols[]` empty.

Pick `task_type` and `metric_direction` from the Evaluation section:
regression | classification_binary | classification_multiclass |
classification_multilabel | timeseries | vision | nlp | other; direction is
`minimize` for error metrics (RMSE, MAE, logloss, MAPE) and `maximize` for
score metrics (AUC, accuracy, F1, MAP). When unsure, say so in the prose and
let the human correct it at the understand gate — a wrong metric reading
poisons everything (CLAUDE.md hard rule).

Resolve the deadline to an absolute UTC date from the overview's Timeline (final
submission deadline). Write `spec.md` with the **prose summary first** (a `#
spec — <Title>` heading + 2–4 plain sentences: what you predict, on what data,
scored how, how a submission is shaped, any notable rule like code-competition /
no-external-data / daily limit), **then** a `## machine` heading followed by the
block below wrapped in a triple-backtick ```yaml ... ``` fence (downstream skills
parse exactly these keys, so keep every one — use `null`/`[]` when N/A):

    slug: <slug>
    title: <title>
    task_type: <regression|classification_binary|classification_multiclass|classification_multilabel|timeseries|vision|nlp|other>
    metric: <e.g. RMSE>
    metric_direction: <minimize|maximize>
    id_col: <col or null>
    target_col: <col or null>          # null when multi-target
    target_cols: []                    # filled for multilabel/multi-target
    group_key: <col or null>           # a unit that must not straddle folds
    time_col: <col or null>            # set for timeseries
    submission_columns: [<col>, ...]
    sample_submission: <comps/<slug>/data/sample_submission.csv or null>
    n_test_rows: <int>
    daily_submission_limit: 5
    deadline: <YYYY-MM-DD>             # absolute UTC, from the Timeline

After writing, back-fill `deadline` into `progress.md`'s header line and tick the
"spec.md written" box.

## 5 · UNDERSTAND Decision Card (gated)

Render the card in the exact CLAUDE.md format. Plain English for a smart
non-specialist — the goal, the metric + direction, how a submission is shaped,
the limits, and where the leaderboard sits (link the comp's leaderboard tab).
No jargon, no thumbnails.

```
📋 understand
What's going on:   <one sentence: predict <target> for <n_test_rows> rows, scored by <metric>.>
Found / propose:   • goal: <plain restatement>
                   • metric: <metric> — <minimize|maximize>; <one line on what moves it>
                   • submit: a CSV with columns <submission_columns>; <daily_limit>/day, resets 00:00 UTC
                   • deadline: <deadline> (<days_left from date -u> left); leaderboard: kaggle.com/competitions/<slug>/leaderboard
Why:               this reading drives every later flag; a wrong metric poisons everything.
Cost:              ~0 compute · 0 submissions
Your call:         [Approve] [Change something] [Skip] [Tell me more]
Autonomy: interactive — waiting
```

Honor the dial: if `config.md` is `full_auto`, print the card and proceed without
waiting; otherwise **wait**. On "Change something", edit `spec.md` (e.g. fix the
metric/direction/columns) and re-render. On approval, tick `understand` in
`progress.md` and append a journal line.

## 6 · TOOLKIT Decision Card (gated)

Propose 3–5 model families / libraries keyed off `task_type`. These **seed the
tree's root branches** (CLAUDE.md "Tree semantics" — each family is its own
branch, e.g. "LightGBM on lag features" vs "Darts"). Keep ≥2 structurally
different families so the search can pivot later. Suggested seeds by task_type:

- **regression / tabular** → LightGBM, XGBoost, CatBoost, ridge/elasticnet baseline.
- **classification_binary/multiclass** → LightGBM/XGBoost, CatBoost, logistic-reg baseline, (TabNet if rich).
- **classification_multilabel** → per-label GBDT, one-vs-rest linear, small MLP.
- **timeseries** → Darts (global models), LightGBM on lag/rolling features, classical ETS/ARIMA baseline.
- **vision** → timm CNN/ViT fine-tune, a frozen-backbone + head baseline.
- **nlp** → a HF transformer fine-tune, TF-IDF + linear baseline.
- **other** → a sensible dumb baseline + one learned family; flag the gap.

Add a per-comp modelling dep only when a node needs it, via `uv add <pkg>` — never
pin modelling libs globally (CLAUDE.md hard rule #1).

```
📋 toolkit
What's going on:   picking the model families to seed the solution tree's branches.
Found / propose:   • branch A: <family> — <one line why it fits <task_type>>
                   • branch B: <family> — <one line>
                   • branch C: <family> — <one line>
                   • baseline: <dumb baseline for /kaggle-baseline>
Why:               keeping ≥2 different families alive lets the search pivot, not just tune.
Cost:              ~0 now · deps added per-node with `uv add` when first used
Your call:         [Approve] [Change something] [Skip] [Tell me more]
Autonomy: interactive — waiting
```

Honor the dial as in step 5. On approval, tick `toolkit` in `progress.md`, append
a journal line recording the seeded families, and **point the human to the next
stage**:

> Bootstrapped. spec + understand + toolkit are locked. Next: run **/kaggle-eda**
> to dig into the data (interactive cleaning, one code+test step at a time).

## guardrails

- Write **only** under `comps/<slug>/`. Never touch `tools/`, `CLAUDE.md`, or `pyproject.toml`.
- Every script runs via `uv run …`; every date comes from `date -u` (UTC).
- A 403 is **rules-not-accepted**, not bad creds — surface to the human and STOP.
- Artifact-then-tick: a `progress.md` checkbox is only ticked after its named file exists.
