# kaggleforge

A **human-in-the-loop, markdown-driven Kaggle solver that runs inside Claude
Code.** You paste a competition link; Claude takes it from understanding the
problem all the way to submissions — pausing at the right moments for you and
grinding autonomously in between.

There is almost no application here. The "program" is **markdown**: a standing
playbook ([`CLAUDE.md`](CLAUDE.md)), per-stage **skills**, parallel **subagents**,
and one **workflow** for the auto-mode grind. The only real code is a thin
`tools/` of reusable `uv run` scripts (folds, leakage scan, Kaggle I/O,
submission validation). Everything competition-specific — the data pipeline, the
features, the models — is **bootstrapped per competition** into `comps/<slug>/`,
never pinned globally.

[`CLAUDE.md`](CLAUDE.md) is the full playbook (autonomy dial, Decision Card
format, stage flow, tree semantics, leakage discipline, resume model, budget
rules). This README is the practical front door.

---

## 1. One-time setup

```bash
uv sync                      # install the tools/ deps (pandas, numpy, sklearn)
uv add kaggle                # the Kaggle CLI, invoked via subprocess by tools/kaggle_io.py

# Kaggle auth — set BEFORE any kaggle call (the client authenticates at import;
# env vars also dodge the chmod-600 ~/.kaggle/kaggle.json warning).
export KAGGLE_USERNAME=<your-username>
export KAGGLE_KEY=<your-api-key>          # from kaggle.com → Settings → Create New Token
```

Sanity-check auth and the budget reader before you start:

```bash
uv run tools/kaggle_io.py --selftest
```

### Two human gates that cannot be automated

Per competition, you (the human) must do these in a browser — Claude will surface
them and **stop**, it will not retry around them:

1. **Accept the competition rules** on the competition page.
2. **Phone-verify** your Kaggle account (required for GPU/internet on kernels).

If either is missing, downloads and submits return **403** — which means "rules
not accepted / unverified," *not* bad credentials (the #1 misdiagnosis).
`uv run tools/kaggle_io.py classify-error --text "<error>"` maps it for you.

---

## 2. Quickstart

Inside a Claude Code session in this repo, **just paste the competition link** —
Claude reads [`CLAUDE.md`](CLAUDE.md) and drives the whole pipeline itself (start →
eda → validate → baseline → experiment → final), pausing only at the gated
**Decision Cards** per the autonomy dial. You do **not** need to type the
`/kaggle-*` commands; they're listed here only because you can also run or re-run a
single stage by hand.

```
/kaggle-start <competition-url-or-slug>   # stage 0 — bootstrap comps/<slug>/, spec.md, download data
/kaggle-eda                               # stage 1 — understand + clean the data
/kaggle-validate                          # stage 2 — freeze the CV (folds.json) + holdout
/kaggle-baseline                          # stage 3 — dumb baseline → first submission → champion/
/kaggle-experiment                        # stage 4 — the tree loop: propose → develop → review → score → decide
```

Helpers, any time:

```
/kaggle-submit     # budget-gated submit + async poll for the public score
/kaggle-final      # near the deadline — lock the 2 finals (best single + de-correlated blend)
/kaggle-status     # plain-language readout of where everything stands (read-only)
```

### Autonomy dial — flip it by voice

Stored in `comps/<slug>/config.md`; change it any time by just saying so.

| mode | pauses at | use when |
|---|---|---|
| `interactive` (default) | **every** gate | new comp, learning the data |
| `auto_except_submit` | only `understand` + `submit` | the experiment grind |
| `full_auto` | nothing | walk away |

Say **"go auto"** / **"ask me before submitting"** / **"pause"** and Claude
updates `config.md`. `understand` and `submit` stay human except in `full_auto`:
a misread metric poisons everything downstream, and a real submission is the only
irreversible, rate-limited, public action.

### Running unattended (permissions)

For a hands-off run you don't want a permission prompt on every command. Two
layers:

- **This repo ships [`.claude/settings.json`](.claude/settings.json)** with
  `acceptEdits` + a broad allow-list (uv, the `tools/`, file writes under
  `comps/`, git except `push`) — so the normal loop runs with essentially no
  prompts. That's the most a *checked-in* file is allowed to do.
- **For true zero-prompt autonomy, use the launch flag** — a project file
  **cannot** self-grant bypass (Claude Code v2.1.142+ ignores `bypassPermissions`
  from a repo, by design):
  ```bash
  claude --dangerously-skip-permissions
  ```
  …or set it once at the **user** level (applies to ALL your projects — use with
  care):
  ```jsonc
  // ~/.claude/settings.json
  { "permissions": { "defaultMode": "bypassPermissions" } }
  ```
  Pair the `full_auto` dial with the flag for a genuine walk-away run.

---

## 3. Repo layout

```
kaggleforge/
  CLAUDE.md                       # the full operating playbook (read this for the rules)
  README.md                       # this file
  pyproject.toml  uv.lock         # tools/ deps only (modelling libs added per-comp)
  tools/                          # the thin reusable uv-run scripts (the only real code)
    make_folds.py                 #   leak-correct CV scheme → folds.json
    leakage_scan.py               #   the static + control leakage suite
    kaggle_io.py                  #   download / submit / submissions / budget / classify-error
    validate_submission.py        #   shape/columns check vs sample_submission
  .claude/
    skills/                       # the per-stage procedures (one folder per slash command)
      kaggle-start  kaggle-eda  kaggle-validate  kaggle-baseline
      kaggle-experiment  kaggle-submit  kaggle-final  kaggle-status  kaggle-io  kaggle-leakage
    settings.json                 # acceptEdits + allow-list so the loop runs without prompts
    agents/                       # parallel workers (fresh context, can't pause)
      kaggle-developer.md         #   implements one node in isolation
      kaggle-reviewer.md          #   runs unit-test + leakage suite, PASS/FAIL, voids on leak
      kaggle-eda-explorer.md      #   fans out EDA probes
    workflows/
      experiment-loop.js          # auto-mode best-first fan-out over the tree
  comps/                          # one folder per competition (data gitignored)
    <slug>/ …                     # see below
```

### Per-competition layout — `comps/<slug>/`

Everything is markdown except the data and the frozen fold indices.

```
comps/<slug>/
  progress.md      # MACRO resume: setup checklist + stage checkboxes + derived date/budget/deadline header
  spec.md          # the contract — prose + a fenced machine block of key fields (metric, target, id, deadline)
  config.md        # autonomy mode
  eda.md           # findings + cleaning rationale (prose, no checkboxes)
  validation.md    # the frozen CV scheme + why it matches the official metric
  folds.json       # frozen fold indices (split-seed only)
  tree.md          # the solution tree — one row per node, with STATUS (pending/running/buggy/valid/champion/dead)
  journal.md       # append-only, one timestamped line per node
  submissions.md   # append-only, UTC-timestamped ledger — the source of truth for budget
  champion/        # the best valid node's src/ + submission.csv + README (byte-copied, never symlinked)
  nodes/node_NNNN/ # node.md (micro resume checklist), src/, train.log, metrics.md, gate_report.md,
                   #   leakage_scan.json, submission.csv
  data/            # downloaded + unzipped (gitignored)
```

---

## 4. Safety rails (in one paragraph)

The CV is **frozen once** at `/kaggle-validate` (`uv run tools/make_folds.py`
picks the leak-correct scheme — time/group/stratified/plain — with an inviolable
holdout) and never refit across folds; every transform is fit **inside the train
fold only**. The leakage suite (`uv run tools/leakage_scan.py` plus an in-node
shuffled-label control) is a **gate, not a warning**: a node that leaks is
**void**, no matter how good its CV. Claude **trusts a well-built CV over the
public LB** — the LB is a small noisy slice, so a CV↔LB gap is surfaced as a
diagnostic, never auto-acted. The submission **budget and deadline are derived
from UTC timestamps** in `submissions.md` at read time (≈5/day, resets 00:00 UTC)
so they can't drift across a resume; dates always come from `date -u`, never
memory. The whole run is **resumable**: macro state in `progress.md` checkboxes,
micro per-node state in `node.md` checkboxes (one named artifact per box,
artifact-then-tick) — on restart, resume at the first unchecked stage, rebuild the
search frontier from `tree.md` statuses, and continue the in-progress node at its
first unchecked box.

---

**For the full rules — the Decision Card format, tree operators
(draft/improve/debug), the complete leakage suite, the marker-file pattern for
long trainings, and the subagent/workflow split — read [`CLAUDE.md`](CLAUDE.md).**
