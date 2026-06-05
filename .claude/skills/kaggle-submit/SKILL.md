---
name: kaggle-submit
description: Budget-gated Kaggle submission with async public-score poll. Use when a valid node's CV beats the last-submitted CV by more than fold-noise and you want to spend one of the day's 5 submission slots, or when `/kaggle-baseline` / `/kaggle-experiment` reach the `submit` gate. Computes today's budget from the UTC ledger (never a stored counter), blocks the 6th/day, renders the SUBMIT Decision Card (gated except `full_auto`), submits, polls the async public score, appends a UTC row to submissions.md, ticks the node's `submitted` box, and logs the CV↔LB gap as a diagnostic.
argument-hint: <slug> <node_id>   e.g. titanic node_0007
allowed-tools: Bash, Read, Write, Edit
---

# /kaggle-submit — budget-gated submit + async poll

Spend ONE of the day's 5 submission slots on the single best-justified node, then
poll for its public score. **CV decides WHAT to submit; the LB is never an A/B
target** (Hard rule 6). A slot only goes to a node that beats the last-submitted
CV by more than fold-noise.

Resolve `<slug>` and `<node_id>` from args. If `<node_id>` is omitted, use the
current champion (`comps/<slug>/champion/`). All paths below are repo-relative.

---

## 0 · Preconditions (read, don't retry around the human gates)

- `comps/<slug>/nodes/<node_id>/submission.csv` exists, and its `node.md`
  shows `leakage clean` and `cv computed` already ticked. A node that hasn't
  cleared the leakage suite **cannot** be submitted — leakage voids the score
  (Hard rule 3). If those boxes aren't ticked, stop and say so.
- `KAGGLE_USERNAME` / `KAGGLE_KEY` are in the env (the tool fails with a clear
  message otherwise). A 403 here means **rules-not-accepted / unverified**, not
  bad creds — surface the human gate, don't retry.

Validate the file before spending anything on it (a malformed CSV wastes a slot):
```bash
slug=<slug>; node=<node_id>
ndir=comps/$slug/nodes/$node
id_col=$(grep -E '^id_col:' comps/$slug/spec.md | awk '{print $2}')   # from spec machine block
uv run tools/validate_submission.py \
  --submission $ndir/submission.csv \
  --sample     comps/$slug/data/sample_submission.csv \
  --id         "${id_col:-id}"
```
Non-zero exit ⇒ the CSV is malformed; fix the node, do **not** submit.

---

## 1 · Budget — derived from UTC timestamps, never a counter

```bash
uv run tools/kaggle_io.py budget --ledger comps/$slug/submissions.md
# prints:  <YYYY-MM-DD>  <used>/5 used  (<remaining> remaining, resets 00:00 UTC)
```
- `remaining == 0` (5 already used today) ⇒ **block the 6th**. Print when the
  next slot frees (`00:00 UTC`) and stop. Do not call submit.
- The count is recomputed from the ledger every time, so it can't drift across a
  resume. Never store or trust a mutable counter.

---

## 2 · CV gate — only submit a node that beats the last submitted CV

The last submitted CV is the `cv` column of the **last row** of
`comps/$slug/submissions.md` (empty ledger ⇒ this is the first/baseline submit,
which always passes). Fold-noise is the per-fold SEM recorded in the node's
`metrics.md` (`cv ± sem`).

Submit only if, **in the official metric's improving direction**:
```
| candidate_cv − last_submitted_cv |  >  sem      (the fold-noise band)
```
If the candidate is within fold-noise of what's already on the LB, **do not
spend a slot** — it's an LB A/B, which Hard rule 6 forbids. Say so and stop.
(End-of-comp final-ensemble submits are the one allowed exception; note it
explicitly in the card if you take it.)

Also honor the **CV-too-good tripwire**: if this node's CV jumped implausibly vs
its parent, that's flagged for human eyes *before* a slot is spent — surface it
in the card rather than auto-submitting, regardless of autonomy mode.

---

## 3 · SUBMIT Decision Card (gated except `full_auto`)

The `submit` gate is human in `interactive` and `auto_except_submit`; only
`full_auto` proceeds without waiting (read the mode from `comps/$slug/config.md`).
This costs **1 of the daily 5**.

```
📋 submit
What's going on:   Node <node_id> (<one-line change>) beats the last submitted CV — spending a slot to see it on the public board.
Found / propose:   • candidate CV <cv> ± <sem> vs last submitted <last_cv> (Δ <delta>, > fold-noise)
                   • <used>/5 used today, <remaining> remaining (resets 00:00 UTC)
                   • file validates against sample_submission; leakage suite clean
                   • <deadline> — <days_left> days left
Why:               CV cleared the fold-noise band; the LB is the OOD check, not the selector.
Cost:              ~1–2 min · no compute · 1 of the daily 5 submissions
Your call:         [Approve] [Change something] [Skip] [Tell me more]
Autonomy: <mode> — <waiting | proceeding>
```
Compute `<days_left>` and every date from the shell (`date -u`), never memory:
```bash
deadline=$(grep -E '^deadline:' comps/$slug/spec.md | awk '{print $2}')
days_left=$(( ( $(date -u -d "$deadline" +%s) - $(date -u +%s) ) / 86400 ))
```
In `interactive` / `auto_except_submit`: **wait** here. Proceed only on approve
(or in `full_auto`).

---

## 4 · Submit (a server-rejected submit does NOT burn the quota)

```bash
msg="$node cv=$cv"
uv run tools/kaggle_io.py submit $slug --file $ndir/submission.csv --message "$msg"
```
- Exit 0 ⇒ accepted by the server, now scoring asynchronously → go poll.
- Non-zero ⇒ classify before reacting; a **server-rejected** submission is safe
  to resubmit (it didn't burn the slot):
  ```bash
  uv run tools/kaggle_io.py classify-error --text "<the stderr line>"
  ```
  `rules_not_accepted` (403) ⇒ surface the human browser/verify gate, stop.
  `rate_limited` (429) ⇒ already backed off by the tool; if still failing, wait
  and retry once. `auth` ⇒ env vars; stop. Only append a ledger row **after** an
  accepted submit (exit 0) — never on a rejected one.

---

## 5 · Poll the async public score (event-driven, no tight loop)

Scoring is async. Poll `submissions` with a marker-file waiter so you wake when a
public score appears, not on a timer — and never tight-poll (the tool backs off
429s, but you should still space reads):
```bash
DONE=/tmp/${slug}_${node}_scored.done ; rm -f "$DONE"
(
  for i in $(seq 1 20); do                       # ~ up to 10 min, 30s spacing
    out=$(uv run tools/kaggle_io.py submissions $slug)
    # newest row first; "complete" + a numeric publicScore means it finished
    echo "$out" | grep -iE 'complete' | grep -qE '[0-9]' && { echo "$out" > /tmp/${slug}_${node}_sub.txt; break; }
    sleep 30
  done
  touch "$DONE"
) &
# wait on [ -f "$DONE" ]; then read /tmp/${slug}_${node}_sub.txt for the public score
```
Pull the **public score** for *this* submission (match the `$msg` / newest row)
into `lb`. If still `pending` after the window, record `lb=pending` and note that
the row will be backfilled on the next poll — don't block the loop.

---

## 6 · Append the ledger row — EXACT format the budget reader counts

`tools/kaggle_io.py read_budget` counts a row iff it `startswith("| <today-UTC>")`.
Append **after** an accepted submit, with the timestamp from the shell:
```bash
ts=$(date -u +%FT%RZ)                 # e.g. 2026-06-05T14:07Z  (UTC, minute precision)
printf '| %s | %s | %s | %s |\n' "$ts" "$node" "$cv" "$lb" >> comps/$slug/submissions.md
```
This produces exactly: `| <date -u +%FT%RZ> | node_NNNN | <cv> | <lb> |`.
If the ledger has no header yet, write it once first (header rows don't start
with `| <date>` so they're never miscounted):
```
| ts (UTC)            | node      | cv     | lb      |
|---------------------|-----------|--------|---------|
```

---

## 7 · Tick the box, log the gap (artifact-then-tick, never auto-demote)

1. In `comps/$slug/nodes/$node/node.md`, tick the last lifecycle box **only now**
   that the row exists (Hard rule 5 — artifact then tick):
   `- [x] submitted     → submissions.md  (only if best & budget)`.
2. Append one timestamped line to `comps/$slug/journal.md`:
   ```
   <date -u +%FT%RZ>  $node  submit  cv=$cv  lb=$lb  gap=$(cv−lb)  used=<used+1>/5
   ```
3. **Log the CV↔LB gap as a diagnostic, never an auto-demote** (Hard rule 6). A
   large gap is something to *surface to the human* (and consider a one-off
   adversarial-validation diagnostic next round), not a reason to change the
   champion. The champion is decided by CV in `tree.md`; submitting does not
   re-rank it.

---

## Done — closing readout

State, in plain language: which node was submitted, its CV, the public score (or
`pending`), the CV↔LB gap, and how many of the day's 5 slots remain. Point to the
ledger (`comps/$slug/submissions.md`) and the node dir for full detail. If the
budget was already exhausted, say so and when the next slot opens (00:00 UTC).
