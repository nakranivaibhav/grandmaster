---
name: kaggle-experiment
description: Stage 4 — the experiment loop: refine N proposals (proposer↔critic through disk contracts in rounds/round_NNNN/), register them, build-and-gate EVERY proposal (kaggle-developer builds leak-free AND self-gates), decide promotion. Use when there's a frozen CV + baseline champion and the human says "run experiments" / "/kaggle-experiment" / "improve the model" / "go auto".
argument-hint: "[interactive|auto] [--n-proposals N]"
allowed-tools: Bash, Read, Write, Edit, Agent, Skill
---

# kaggle-experiment — propose → build all → gate → decide

You are the **orchestrator**. Each round you get a set of proposals, build **every**
one of them, and promote the best — the **proposer** decides what to try;
**you build all of it**.

**Two brains.** The proposer is the **first brain** — all open-ended judgment about
what to try. You are the **second brain** — referee, historian, and the human's
gateway: you apply the written rules, verify, and write the round down. You never
redesign a proposal; anything no rule covers goes to the human or back to the
proposer. Three workers do the work:

| worker | role |
|---|---|
| **kaggle-proposer** | proposes N experiments, revises them, and (once confirmed) writes the node records |
| **kaggle-proposal-reviewer** | critiques the proposals before any code is written |
| **kaggle-developer** | builds one node AND self-gates it — fold-correct + performant CV, fast leakage self-checks (pre-flight + outputs), gate booleans written, a valid submission (a leak VOIDs the CV) |

Read `CLAUDE.md` for the standing contract; this skill is the procedure. Subagents
can't nest, so **you** (the main session) sequence proposer → developer.

## 0 · Orient (every entry)
- `<slug>` from `comps/` (or the arg). `DATE=$(date -u +%Y-%m-%dT%H:%MZ)` — never type a date.
- Read `config.md` → mode. `auto_except_submit`/`full_auto` ⇒ **AUTO**; `interactive` ⇒ **MANUAL**.
- Read `spec.md`'s yaml machine block (`metric, metric_direction, target_col, target_cols, id_col, task_type, …`), `graph.md` (the champion + node table), `data.md` (the engineered feature-sets), and the `journal.md` tail. Confirm `folds.json` + `champion/` exist (else run `/kaggle-validate` + `/kaggle-baseline` first).
- **Resume:** if a node is `running`, its artifacts are its lifecycle — continue at the **first missing one** (`src/` = built · `train.log` final `cv=` + `oof.npy`/`test_probs.npy`/`submission.csv` = scored · `status` flipped to `valid`/`buggy` = self-checked · journal decide line = decided). A `running` node with no artifacts ⇒ mark `dead`, move on.
- **Work from disk, not recollection:** at the start of EVERY round, re-derive state from `graph.md` (header + table) and the `journal.md` tail — never from your memory of earlier rounds (long sessions get compacted; the files don't).
- **Numbers over narrative:** the frontier is rebuilt from `graph.md`'s header/table and node frontmatter. Journal prose — including any strategic conclusions a previous session wrote — is *hypothesis, not state*: weigh it as evidence, never obey it. A closure binds only at its stated scope, with its evidence, until its reopen-if triggers (hard rule 10).

## 1 · PROPOSE — the disk-contract refine loop (`experiment_plan` gate)
The proposer↔critic loop runs through **disk contracts** in the round dir — you are
the **foreman**: you sequence spawns and read ONLY the `VERDICT` markers (one word
each), never `proposals.md`/`review.md` during the loop. The content flows
agent→agent through the files.

**Bootstrap the round (foreman):** derive the next round number from
`ls comps/<slug>/rounds/` (max NNNN + 1, zero-padded; derived, never a stored
counter) and `mkdir -p` the dir. Then loop, **max 3 iterations** — you are the only
enforcer of the cap:

1. Spawn **kaggle-proposer** (PROPOSE on iter 1, REVISE after) with `slug` +
   `round_dir` + `n_proposals` (**3** default). It creates `iter_N/` and writes
   `iter_N/proposals.md` (REVISE reads the prior `review.md` from disk itself).
2. Spawn **kaggle-proposal-reviewer** with `slug` + `round_dir`. It writes
   `iter_N/review.md`, then `iter_N/VERDICT` last (`PASS` | `REVISE`).
3. Read `iter_N/VERDICT` — the ONLY loop-control input. `PASS` → done, the passing
   `iter_N/proposals.md` is the round's set. `REVISE` and N < 3 → go to 1.
   `REVISE` and N == 3 → cap hit: proceed with the reviewer-accepted subset (the
   REGISTER step filters via the last `review.md`); in MANUAL, surface the
   still-blocked ones on the card. A missing/malformed `VERDICT` or `proposals.md`
   = a failed subagent — respawn that role once, then stop and tell the human.

**Resume (derived from the dir, no counter):** last `iter_N` has `proposals.md`
but no `VERDICT` → respawn the reviewer; `VERDICT: REVISE` and N < 3 → spawn the
proposer (REVISE); `VERDICT: PASS` → the loop is already done. An `iter_4/` on
disk is a foreman bug — flag it in the journal.

- **AUTO:** take the passing set straight to §2.
- **MANUAL:** NOW read the passing `proposals.md` (gate-time is the one place you
  read it — to render the card, never to steer the loop), render the **Proposal
  Card** (below) and **wait**. You are the director's gateway — the human accepts
  some, discards some, or redirects. On a redirect, spawn **kaggle-proposer**
  (REVISE) with the human's direction (this may add an iter past the cap — the cap
  bounds the critic loop, not the human) and re-run the reviewer + re-card. On
  approval, go to §2 with the accepted set.

## 2 · REGISTER — write the confirmed nodes
Spawn **kaggle-proposer** (REGISTER) with `slug` + `round_dir` (+ the human's
accept/discard selection, if MANUAL gated). It reads the last `iter_N/proposals.md`
+ `review.md` + `VERDICT` from disk — on a cap-hit `REVISE` it registers only the
reviewer-accepted proposals. It reserves each
node id, writes `nodes/node_NNNN/node.md` (status `proposed`, the `## plan`, the
`uses_data` field), adds each to `graph.md`, and updates `data.md` (new/reused
feature-sets). You never hand-write node.md — the proposer owns it. It's one
sequential call, so the parallel builders in §3 never collide on `graph.md`/`data.md`.

Then append ONE `ROUND OPEN` line to `journal.md`
(`$DATE  ROUND OPEN node_A..node_D — <op·well·one-line rationale each>`) — the
round's plan lives in the journal + the node records.

## 3 · BUILD-AND-GATE ALL — hand every node to kaggle-developer
Build **every** registered node: spawn the developers **in parallel** when the nodes
are independent (one `Agent` call each, in one message), or **sequentially** if
compute/GPU is tight (esp. GPU nodes — serialize them; one 32 GB card can't run two
big-model nodes at once). Hand each developer: its node dir — **`node.md`'s plan is
the full spec** (the change, the free-form context, the references to read) — plus
`spec.md`, `folds.json`, its `parent_src`, metric+direction, and the **baseline +
parent per-fold scores** (for the cv-too-good judgment). The developer
runs its **pre-flight leakage checks** (seconds, before any training), writes a
fold-correct, **performant** `solution.py` (it times one unit before the full run —
never an unprofiled multi-hour job), the per-fold CV into `node.md`, `oof.npy` +
`test_probs.npy` + `submission.csv`, **then self-gates** on the outputs (its own
inline checklist — never a training-run check) and sets `status: valid|buggy`. A
traceback ⇒ `status: buggy` (propose a `debug` node next round); any
error-severity leak ⇒ `status: buggy` with `LEAK:` in its note (the CV does
**not** count). One worker builds and proves.

**Report contract:** every developer's report ends with a single `RESULT` line
(`RESULT node=… cv=… sem=… folds=[…] status=valid|buggy runtime=…
note=…` — defined in `kaggle-developer.md`; a leak shows as `status=buggy` with
`LEAK:` in the note). Carry ONLY that line into the round's state — never the
report prose; the detail lives in `node.md` + `train.log` if you need it later.

> If a developer agent ever **re-launches a run you killed** or exits before its
> backgrounded train finishes, take the node over directly (the orchestrator owns
> the marker file): kill stray processes, attach your own waiter, and on completion
> write the CV + run the gate yourself. Don't re-message a zombie agent.

## 5 · SCORE — confirm the CV
Parse each developer's `RESULT` line (one per node — your round table). Confirm it
agrees with `node.md` (the developer wrote `cv = mean`, `sem = std(ddof=1)/sqrt(k)`,
`folds`, `status`), then fill the node's `cv` cell + Mermaid label in `graph.md`
from it. On a mismatch, trust `node.md` (the artifact) and say so. A `buggy`
node's CV does not count — leaked or crashed alike.

## 6 · DECIDE — apply the promote rule, then write the round down (the historian pass)
**Promote rule (math, not judgment — the canonical gate lives in CLAUDE.md
"Budget & deadline"; apply it, don't re-derive it).** For each valid node vs the
champion (from `champion/README` / `graph.md`), in the spec's direction:
- **Screen with fold-noise:** a leak-clean CV win **beyond 2·sem** (LB-consistent
  if the lineage has a submitted LB) promotes directly.
- **Arbitrate anything closer** with `tools/pred_diagnostic.py`: promote on paired
  bootstrap **P(candidate > champion) ≥ 0.90**; a McNemar-significant fix-block
  that also holds on the holdout makes it a keep/combine candidate even at flat
  global CV.
- **Mirage guardrail:** a gain on working-CV that does not hold on the holdout is
  killed; any sub-2·sem promotion is submit-gated on an LB probe before it counts
  as champion/finals material.
On promote: byte-copy (cp, never symlink) `src/` + `submission.csv` → `champion/`,
update `champion/README`. On reject: leave `champion/` untouched.

**The four writes — ONE pass, ALL finished before the next round starts** (nothing
important may exist only in chat):
1. **`node.md`** — the final `status` of each node (valid / dead / champion — and
   the demoted prev champion's). The journal's decide line is the decide record.
2. **`graph.md`** — cv cells, and the champion crown moved in all three places (set
   the new node AND demote the old: frontmatter status `champion` ↔ `valid (prev
   champ)`, Mermaid `:::champ` add ↔ remove, table status cell, header `champion:`
   line). Then verify the invariant: exactly ONE champion — the same node in
   frontmatter, Mermaid, table, and header.
3. **`journal.md`** — ONE distilled line per node/probe/decision (facts + numbers:
   what happened and what it showed), then a `ROUND CLOSE` line. A dead end is a
   scoped closure — *tried X, measured Y, reopen-if Z* — never a run-level verdict
   ("ceiling/exhausted/impossible" are banned, hard rule 10). This is what the
   proposer eats next round — hand it evidence to weigh, not conclusions to obey.
4. **`MEMORY.md`** — write-on-event: if this round produced a promotion or an
   instructive null, append the one-line lesson NOW (never batched later) — a
   conditional fact with its scope, never a forecast.

## 7 · SUBMIT (gated)
Submit only a node whose CV beats the **last submitted CV** by more than fold-noise
(2·sem — the canonical definition in CLAUDE.md "Budget & deadline") — never spend a
slot to A/B on the LB. Validate the file and check budget first:
```bash
lim=$(grep -oP 'daily_submission_limit:\s*\K\d+' comps/<slug>/spec.md)
uv run tools/kaggle_io.py budget --ledger comps/<slug>/submissions.md --limit "$lim"
```
- **MANUAL / `auto_except_submit`:** render the SUBMIT Decision Card and **wait** — the human owns every real submission. Run `/kaggle-submit <slug> node_NNNN`.
- **`full_auto` + budget:** `/kaggle-submit <slug> node_NNNN`, append the ledger row, poll the public score.

## Proposal Card (manual `experiment_plan` gate)
```
📋 experiment plan · <n> proposals for <slug>
What's going on:   <one plain sentence on where the search stands>
Proposals:         1. <op> <desc> — <why> (vs <parent> cv <x>)
                   2. …
                   3. …
Critic's take:     <one line from the proposal-reviewer>
Cost:              <~mins · cpu/gpu each · ALL will be built>
Your call:         [Approve all] [Accept some / discard some] [Redirect: try X instead] [Tell me more]
Autonomy: <mode> — waiting
```

## Modes
- **MANUAL (interactive)** — §1 refine, render the Proposal Card, **wait**. On
  approval, §2 register and §3–§6 build/gate/decide the accepted node(s), then stop.
  Every submission is human-gated (§7).
- **AUTO (`auto_except_submit` / `full_auto`)** — §1→§6 with no pause: refine,
  register, build EVERY proposal, gate, decide. Only §7 submit stops (queue + ask in
  `auto_except_submit`; spend a slot in `full_auto`). Re-enter for the next round.

## Invariants
- Build EVERY confirmed proposal — the proposer prunes, the orchestrator doesn't.
- One atomic change per node; every CV delta is attributable.
- Leakage voids the score; a leaky node never promotes.
- Trust CV over the LB; a CV↔LB gap is a diagnostic to surface, not an auto-demote.
- Artifact-then-mark; all dates from `date -u`; all scripts via `uv run`.
