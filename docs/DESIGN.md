# kaggleforge — design & rationale

This is the *why* behind the playbook. The standing contract is `CLAUDE.md`; the
procedures are the skills in `.claude/skills/`; the workers are the subagents in
`.claude/agents/`; the auto-mode fan-out is `.claude/workflows/experiment-loop.js`;
the reusable code is in `tools/`. This file explains the research lineage we
borrowed from, why we run it as markdown inside Claude Code, the tree/gate/
validation/resume models, the mapping from our sibling neural-ring-detector loop,
and the honest expectations.

---

## 1 · Research lineage — what we took, and from where

Five papers shaped this system. We took one proven lever from each and left the
rest.

**AutoKaggle (arXiv:2410.20424)** — a multi-agent *phase pipeline*
(understand → EDA → engineering → model → submit) with a reader/planner/
developer/reviewer cast. Its two empirically-load-bearing parts are (a) a
**validated tools library** the agents call instead of re-deriving boilerplate,
and (b) **per-phase unit tests**: the paper reports its *completion* rate rising
from **0.10 → 0.85** once each phase had to pass its own tests before the next
began. We took both. Our `tools/` (make_folds, leakage_scan, validate_submission,
kaggle_io) *is* the validated library; "every node — including data-cleaning and
feature nodes — clears the unit-test + leakage suite before its CV counts"
(CLAUDE.md) is the per-phase-test discipline applied at node granularity. We did
**not** keep the rigid linear phase chain — see AIDE.

**AIDE (arXiv:2502.13138)** — a *single-agent best-first **solution-tree
search***. Each node is a complete solution; three operators grow the tree —
**draft** (a fresh approach), **improve** (one change on a working node), **debug**
(repair a broken one) — and the search greedily expands the best valid node.
The decisive idea: **history lives in the tree, not the context window**. The
agent never has to re-summarise its past; the tree *is* the memory, and a node's
parent edge records exactly what was tried. On MLE-bench, AIDE earned **~4× more
medals than the best linear (phase-pipeline) agent**. We adopted the tree wholesale
(§3) and run it as a *supervised* single search rather than the unbounded
autonomous one.

**MLE-bench (arXiv:2410.07095)** — the **medal yardstick**: 75 real Kaggle
competitions, scored against the actual private leaderboards, reporting
any-medal pass rates. Numbers worth internalising for expectation-setting:
o1-preview + AIDE scored **~16.9% any-medal pass@1, rising to ~34.1% pass@8**;
**Claude 3.5 Sonnet + AIDE ~7.6%**. The cost is real — a full sweep is roughly
**~1800 GPU-hours ≈ $3k per seed**. The honest reading: *autonomy medals on a
minority of competitions.* This is precisely why kaggleforge is **human-in-the-loop**
— we spend the human's judgement at the few irreversible gates (metric reading,
real submissions) where being wrong is catastrophic, and let the machine grind
the reversible middle. We treat the official metric on a trustworthy local CV as
the target and the public LB as the out-of-distribution check (CLAUDE.md Mission).

**Agent K (arXiv:2411.03562)** — an **RL-free** agent with a **nested,
cross-competition memory** that accumulates structured experience and reaches
**Kaggle-grandmaster-equivalent** performance without policy-gradient training.
Lesson taken: durable memory > clever weights. Within a comp, our memory is the
append-only `journal.md` + `submissions.md` ledger + the tree statuses; across
comps it is the shared, in-place-extended `tools/` library and these docs. We do
*not* yet carry a cross-comp case bank — that is the natural next increment, and
it would slot into the toolkit gate.

**DS-Agent (arXiv:2402.17453)** — **case-based reasoning**: *retrieve a relevant
past solution before proposing*. We honour the spirit at the toolkit/experiment-
plan gates: the first drafts seed from known-good recipes for the task type
(GBDT-on-tabular, Darts-for-time-series) rather than inventing from scratch, and
the library/family choice at the toolkit gate seeds the root branches. A full
retrieval bank is future work; for now the "cases" are the recipes encoded in the
skills and the operator's parent rule.

**One-line summary of the borrow:** *AutoKaggle's tests + tools, run over AIDE's
tree, measured by MLE-bench's medal yardstick, with Agent-K-style durable memory
and a DS-Agent retrieve-before-propose instinct — all wrapped in a human-gated
shell.*

---

## 2 · Why markdown-driven, inside Claude Code

The whole system is files a fresh Claude session can read and act on — no bespoke
runtime. Four Claude Code primitives map cleanly onto four roles:

| primitive | role here | example |
|---|---|---|
| **skill** (`.claude/skills/*/SKILL.md`) | a **procedure** the main session runs at a gate | `/kaggle-validate` freezes the CV |
| **subagent** (`.claude/agents/*.md`) | an **isolated worker** with fresh context | `kaggle-developer` builds one node |
| **CLAUDE.md** | the **standing rules** every actor obeys | leakage voids a score; one atomic change/node |
| **workflow** (`.claude/workflows/experiment-loop.js`) | the **fan-out** that parallelises the grind | `experiment-loop` expands `width` nodes/round |

**The key constraint that shapes everything: neither subagents nor the workflow
can pause for a human — only the main session can** (CLAUDE.md, "Operating mode").
A subagent runs to completion and returns; the workflow loops without a console.
So the architecture is **"gate the ends, auto the middle"**:

- Every **gate** (`understand · toolkit · eda · validation · experiment_plan ·
  submit`) lives in a **skill in the main session**, because only there can we
  render a Decision Card and *wait*.
- The **experiment grind** — propose → develop → review → score — is the only
  part with no inherent need for a human mid-step, so it (and only it) is
  delegated to subagents and the workflow.

That is why `understand` and `submit` stay human except in `full_auto`: a wrong
reading of the metric poisons every downstream CV, and a real submission is the
one irreversible, rate-limited, public action. The workflow reflects this — in
`auto_except_submit` it *queues* the best node and the main session asks before
spending a slot; in `full_auto` a submit agent may spend one within budget
(see `experiment-loop.js` meta and the Submit phase).

---

## 3 · The tree model

The solution tree (`tree.md`) is the search and the memory at once (the AIDE
idea, arXiv:2502.13138). **Every node is one atomic change** so every CV delta is
attributable, and it **attaches to the deepest ancestor whose work it keeps**:

| change | operator | attaches to |
|---|---|---|
| whole new approach / model family / framing | **draft** | a new branch under root |
| build on a working solution (add feature, swap a part, tune) | **improve** | a child of that node — deepens or forks the lineage |
| fix a broken node | **debug** | a child of the buggy node |

- The **toolkit gate seeds the root branches**: "use Darts" and "LightGBM on lag
  features" are branch A and branch B — two families, not two experiments inside
  one branch (this is where DS-Agent's retrieve-before-propose lands).
- The **champion is the best *valid* node anywhere in the tree** — best CV under
  the official direction, leakage-clean. On promotion, byte-copy its `src/` +
  `submission.csv` into `champion/` (cp, never symlink); a rejected node leaves
  `champion/` untouched.
- **Keep ≥2 families alive.** If the best lineage hasn't beaten CV by more than
  one parent-SEM over **5 consecutive improves**, force a **draft** of a
  structurally different family — *pivot the architecture, don't keep tuning*.
  This is the anti-local-minimum rule; tuning that stalls is the signal to draft.
- Status, not checkboxes. `tree.md` carries `pending · running · buggy · valid ·
  champion · dead` per node; **the statuses are the search frontier**, so a
  restart rebuilds the frontier by reading them.

**Search policy (operator selection each round):** draft while valid-root-families
< `num_drafts` (default 4) → else debug the shallowest buggy node within depth
(≤5 attempts; regenerate from scratch after 3 fails; prune to `dead` after 5) →
else improve the best valid node with exactly one atomic change, A/B'd against its
parent and rejected on CV regress. The workflow's planner applies the same policy
across up to `width` independent nodes per round.

---

## 4 · Human-in-the-loop gates, the autonomy dial, Decision Cards

Each stage ends with a **Decision Card** — a plain-language readout (what's going
on / found or propose / why / cost in time·compute·submissions-out-of-5 / your
call), written for a smart non-specialist. We never show in-chat thumbnails as
proof; we report numbers + file paths and let the human open files at full
resolution (a lesson carried straight from the neural-ring-detector memory —
in-chat thumbnails hide 10-px offsets).

The **autonomy dial** (stored in `config.md`, flipped any time by voice) decides
which gates actually pause:

| mode | pauses at |
|---|---|
| `interactive` (default) | **every** gate — new comp, learning the data |
| `auto_except_submit` | only `understand` + `submit` — the experiment grind |
| `full_auto` | nothing — walk away |

`understand` and `submit` are the two gates kept human except in `full_auto`,
for the reasons in §2 (metric-poisoning, irreversibility). The dial is the single
control surface; the rest of the system reads it and behaves accordingly.

---

## 5 · Validation & leakage discipline

A leaky CV is worse than no CV — it *confidently* misleads. So validation is
frozen once and policed hard.

- **Freeze the CV once** (`/kaggle-validate` → `tools/make_folds.py`) and never
  refit across folds. `make_folds.py` picks the leak-correct scheme from the spec:
  `TimeSeriesSplit` if a time column, else `GroupKFold` if a group key, else
  `StratifiedKFold` for classification, else `KFold`. **The seed controls only the
  split.** Output is `folds.json` (positional integer indices). Carve an inviolable
  holdout never touched in training or feature-fit.
- **Fit inside the fold.** Every transform (scaler/encoder/imputer/target-encoder/
  selector) is fit on the train fold only — `make_folds.py` writes indices, the
  node's harness loops them, and `leakage_scan.py`'s static scan flags a global
  `.fit(` on full/concatenated train+test (`uv run tools/leakage_scan.py …`).
- **The surviving suite** (each a check in `tools/leakage_scan.py`, void-on-fail
  for `error` severity): fit-inside-fold, target leakage (no feature with
  near-perfect correlation to the target; target absent from features),
  id/order leakage, group leakage, temporal leakage (past-only lags/rolling, no
  centered windows, no global stats), **shuffled-label control**, duplicate
  detection (train↔test), and the CV-too-good tripwire.
- **The shuffled-label control** is the load-bearing one: permute the labels,
  refit; CV must collapse to the random baseline. If it doesn't, something leaks.
  It needs the model's fit/predict callable, so it lives in the node's CV harness
  and imports `shuffled_label_ok` from `tools/leakage_scan.py` — the developer
  subagent wires it in.
- **CV↔LB is a diagnostic, not a trigger.** A gap is *logged and surfaced*, never
  auto-acted; chasing the public LB causes private shake-up. **Trust a well-built
  CV over the public LB** (CLAUDE.md Hard rule 6). A submission slot only goes to
  a node that beats the last submitted CV by more than fold-noise — never to A/B
  on the LB.
- **Adversarial validation was dropped as a standing gate** — it is available
  only as a one-off diagnostic when a big unexplained CV↔LB gap appears, not run
  every node. The CV-too-good tripwire covers the routine "implausible jump" case
  and flags it for human eyes before a slot is spent.

This is AutoKaggle's per-phase-test lever (arXiv:2410.20424) applied at node
granularity: a feature that "improves CV" but fails fit-inside-fold is **buggy,
not good**, and its CV does not count.

---

## 6 · The resume model

A competition spans days and gets resumed, so state must survive a cold start
with zero in-context memory. Two rules make that safe.

- **Checkboxes live in exactly two places** — genuine interruptible linear
  sequences — and everything else is status fields or append-only logs:
  - **`progress.md`** (macro) — the one-time setup checklist + stage checkboxes +
    a derived header. Re-entry resumes at the first unchecked stage.
  - **`node.md`** (micro) — the per-node lifecycle, **one artifact named per box**
    (proposed→node.md, code written→src/solution.py, ran clean→train.log, tests→
    gate_report.md, leakage→leakage_scan.json, cv→metrics.md, decided→tree.md,
    submitted→submissions.md). A `running` node resumes at its first unchecked box.
- **Artifact-then-tick** (CLAUDE.md Hard rule 5): do the work → write the artifact
  → *then* tick the box. Because each box names its artifact, a stale checkbox can
  never mislead — you verify against the artifact, and a box with no artifact is a
  lie to be redone. A `running` node with unchecked boxes and zero artifacts is
  marked `dead`.
- **Everywhere else is status or append-only:** `tree.md` statuses *are* the
  frontier; `journal.md` and `submissions.md` are append-only logs.
- **Dates from `date -u` UTC, never memory** (`date -u +%Y-%m-%dT%H:%MZ`); your
  sense of "today" is stale on resume.
- **Budget & deadline are derived, never stored as a mutable counter.**
  `submissions.md` is the append-only UTC-timestamped ledger; "used today" is
  *computed* at read time (`grep -c "^| $(date -u +%F)" …submissions.md`, or
  `uv run tools/kaggle_io.py budget --ledger comps/<slug>/submissions.md`), so it
  can't drift across a resume. `progress.md`'s header is regenerated on read;
  `days_left = deadline − today`; when it shrinks, the loop switches to final
  ensemble.

The canonical restart path is `/kaggle-status`: read `progress.md` → find the
in-progress stage → if experiments, read `tree.md` statuses to rebuild the
frontier → open any `running` node's `node.md` and resume at its first unchecked
box.

---

## 7 · Mapping from the sibling neural-ring-detector loop

kaggleforge is the same autonomous-loop shape as the sibling neural-ring-detector
"AutoResearch" agent, retargeted from "best ring model" to "best Kaggle solution."
The concepts map one-to-one — which is why the operating discipline feels familiar:

| neural-ring-detector | kaggleforge analogue |
|---|---|
| champion / challenger (best model so far vs the run) | **champion node** = best valid node in the tree; each new node is the challenger, A/B'd against its parent |
| per-experiment file isolation (`experiments/exp_NNN/src/`, self-contained) | per-node isolation (`comps/<slug>/nodes/node_NNNN/src/`, copy-parent-then-one-change); reusable code in `tools/` is extended in place, never forked |
| marker-file auto-polling (`[ -f $DONE ]`, never `pgrep -f` which self-matches) | identical marker-file pattern for long local trainings (`DONE=/tmp/<slug>_node_NNNN.done`; wait on `[ -f "$DONE" ]`), event-driven, no timers |
| `journal.md` (append-only, one dense line per experiment) | `journal.md` (append-only, one UTC line per node) + `submissions.md` ledger |
| `history.json` (champion record + experiments list) | `tree.md` statuses + `champion/` byte-copy (the durable, resumable record) |
| visual_score ≥ 9.0 LLM-judge gate (Claude Vision rates eval cards) | **official-metric CV gate** + the human Decision-Card gate; the LLM-judge role is replaced by a *numeric* gate (the metric) plus *human* sign-off at submit, because Kaggle gives a real metric where ring-fit only had perceptual quality |
| "numeric metric is a proxy; visual quality is primary" | "well-built local CV is the target; public LB is the OOD check" — CV is the trustworthy signal, LB is the proxy that can mislead |
| `exp_NNN` ids, `experiments/` tree | `node_NNNN` ids, `tree.md` tree with draft/improve/debug operators |
| "silence is a bug — add prints and re-run" | same: a node that returns nothing/hangs gets log visibility, not a guess; `train.log` is tailed filtered for `cv=|Traceback|Error|Killed|OOM` |

The one substantive difference: ring-detection had **no ground-truth metric**, so
its gate was an LLM vision judge scoring perceptual ring-fit. Kaggle *does* have a
ground-truth metric, so the automatable gate is the numeric CV and the human is
reserved for the two judgement calls a number can't make — reading the metric
right (`understand`) and spending an irreversible public slot (`submit`).

---

## 8 · Known risks & honest expectations

- **Autonomy medals on a minority.** Per MLE-bench (arXiv:2410.07095), strong
  agent+scaffold combos clear any-medal on roughly **8–34%** of comps
  (Claude 3.5 Sonnet + AIDE ~7.6%; o1-preview + AIDE ~16.9% pass@1 → ~34.1%
  pass@8). Expect *competent, often-unplaced* runs, not routine gold. Set this
  expectation in the first Decision Card.
- **Compute & money are real.** A full bench sweep is ~1800 GPU-h ≈ $3k/seed
  (arXiv:2410.07095); a single comp is far less, but a stalled tree can burn time
  for nothing. The ≥2-families / pivot-after-5-stalled-improves rule is the
  circuit-breaker; the deadline-derived header is the hard stop.
- **The CV can still lie.** The leakage suite catches the common modes, but a
  novel leak (a sneaky group key, a time-ordered id) can slip the static scan.
  The shuffled-label control is the backstop; when CV looks too good, the tripwire
  forces human eyes before a slot is spent.
- **Public-LB temptation.** The single most common self-inflicted loss is chasing
  the public LB into a private shake-up. The discipline (trust CV, log-don't-act
  on the gap, slot only for a CV win) is a guardrail, not a guarantee — a human in
  `interactive` mode is the real safety net.
- **Two non-automatable Kaggle gates** (accept rules in the browser, phone-verify
  for GPU/internet) block downloads/submits and *cannot be retried around* — a
  403 means "rules not accepted / unverified," **not** bad creds (the #1
  misdiagnosis; `tools/kaggle_io.py classify-error` maps it). Surface them; don't
  loop.
- **No cross-comp case bank yet.** Agent K's nested memory (arXiv:2411.03562) and
  DS-Agent's retrieval (arXiv:2402.17453) are only partially realised — the
  "cases" are the recipes baked into skills and the in-place `tools/` library, not
  a queryable bank. That is the clearest next increment.
- **Single-agent search, supervised.** We deliberately run AIDE's tree
  (arXiv:2502.13138) as one human-gated search rather than an unbounded swarm.
  This trades raw throughput for attributable deltas and a human able to veto at
  the two gates that matter — the right trade when a wrong submission is public
  and rate-limited.
