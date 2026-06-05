export const meta = {
  name: 'experiment-loop',
  description: 'AUTO-mode best-first solution-tree fan-out for a Kaggle competition: each round a planner picks operators (draft/improve/debug), developers implement nodes in parallel, reviewers gate them (leakage voids the CV), a summarizer updates tree.md/journal.md. Loops best-first until the day budget is spent, the search stalls, or the deadline is reached. In auto_except_submit it queues the best node for the human; in full_auto a submit agent may spend a slot within budget. No human pauses, no file reads in the script — agents do all work and persist state under comps/<slug>/.',
  phases: [
    { title: 'Orient', detail: 'planner rebuilds the frontier from tree.md + spec.md + journal.md' },
    { title: 'Expand', detail: 'develop → review up to `width` independent frontier nodes per round, in parallel' },
    { title: 'Decide', detail: 'summarizer scores CVs, updates tree.md/journal.md, reports accepted/stalled/budget/deadline' },
    { title: 'Submit', detail: 'queue the champion (auto_except_submit) or spend one slot within budget (full_auto)' },
  ],
}

// ---------------------------------------------------------------------------
// args: { slug, mode, maxRounds, width }
//   slug       — competition slug (comps/<slug>/ already bootstrapped, validated, baselined)
//   mode       — 'auto_except_submit' (default) | 'full_auto'
//   maxRounds  — hard cap on rounds (default 12)
//   width      — independent frontier nodes expanded per round (default 2)
// The script never reads/writes files itself — agents persist everything under
// comps/<slug>/ (tree.md, journal.md, nodes/node_NNNN/, champion/) and return summaries.
// ---------------------------------------------------------------------------
const SLUG = args.slug
const MODE = args.mode || 'auto_except_submit'
const MAX_ROUNDS = args.maxRounds || 12
const WIDTH = Math.max(1, args.width || 2)
const ROOT = `comps/${SLUG}`

if (!SLUG) {
  return { error: 'args.slug is required (the competition slug under comps/<slug>/)' }
}

// ===== schemas =============================================================

// Planner returns the operators to expand this round + a one-line frontier read.
const PLAN_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['frontier_summary', 'families_alive', 'stall_count', 'champion_node', 'champion_cv', 'metric', 'direction', 'nodes', 'stop_now', 'stop_reason'],
  properties: {
    frontier_summary: { type: 'string', description: 'one line: counts by status + the current champion' },
    families_alive: { type: 'integer', description: 'distinct valid/champion root-branch families' },
    stall_count: { type: 'integer', description: 'consecutive improves on the best lineage with no >1·SEM CV gain' },
    champion_node: { type: 'string' },
    champion_cv: { type: 'number', description: 'NaN-safe: champion CV mean under the official direction' },
    metric: { type: 'string' },
    direction: { type: 'string', enum: ['minimize', 'maximize'] },
    stop_now: { type: 'boolean', description: 'true if the deadline is reached or the search is exhausted (no useful operator left)' },
    stop_reason: { type: 'string' },
    nodes: {
      type: 'array',
      description: 'up to `width` INDEPENDENT node specs to expand this round (distinct parents / families so they can run in parallel)',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['node_id', 'operator', 'parent_id', 'parent_src', 'family', 'change'],
        properties: {
          node_id: { type: 'string', description: 'next zero-padded id, e.g. node_0007 (already reserved + row added to tree.md by the planner)' },
          operator: { type: 'string', enum: ['draft', 'improve', 'debug'] },
          parent_id: { type: 'string', description: 'deepest ancestor whose work this change keeps; "root" for a draft off baseline' },
          parent_src: { type: 'string', description: 'repo-relative parent src dir to copy from, e.g. comps/<slug>/champion/src or comps/<slug>/nodes/node_0003/src' },
          family: { type: 'string', description: 'gbdt|nn|linear|darts|… — drafts must be a structurally different family' },
          change: { type: 'string', description: 'the ONE atomic change, in one line' },
        },
      },
    },
  },
}

// Developer (kaggle-developer subagent) returns the built node + clean-run signal.
const DEV_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['node_id', 'ran_clean', 'cv_printed', 'submission_written', 'shuffle_control_ran', 'notes'],
  properties: {
    node_id: { type: 'string' },
    ran_clean: { type: 'boolean', description: 'train.log has no Traceback/Error/Killed/OOM' },
    cv_printed: { type: 'number', description: 'the cv=<score> the script printed (NaN if it crashed)' },
    submission_written: { type: 'boolean' },
    shuffle_control_ran: { type: 'boolean', description: 'in-harness shuffled-label control executed' },
    notes: { type: 'string', description: 'one line; if it crashed, the failing line / cause' },
  },
}

// Reviewer (kaggle-reviewer subagent) gates one node — leakage voids the CV.
const REVIEW_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['node_id', 'verdict', 'leak_clean', 'unit_tests_pass', 'shuffle_collapsed', 'cv_too_good', 'cv_mean', 'cv_sem', 'reasons'],
  properties: {
    node_id: { type: 'string' },
    verdict: { type: 'string', enum: ['valid', 'buggy', 'dead'], description: 'valid=passed; buggy=fixable (unit fail / crash); dead=intrinsic leak' },
    leak_clean: { type: 'boolean', description: 'false => CV is VOID regardless of value' },
    unit_tests_pass: { type: 'boolean' },
    shuffle_collapsed: { type: 'boolean', description: 'shuffled-label CV collapsed to the random baseline' },
    cv_too_good: { type: 'boolean', description: 'tripwire — surface to the human before any submission' },
    cv_mean: { type: 'number', description: 'NaN if void/crashed' },
    cv_sem: { type: 'number' },
    reasons: { type: 'string' },
  },
}

// Summarizer folds the round into the tree + journal and reports loop control.
const SUMMARY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['accepted', 'new_champion_node', 'champion_cv', 'cv', 'stalled', 'families_alive', 'budget_left', 'deadline_reached', 'tree_line'],
  properties: {
    accepted: { type: 'boolean', description: 'a node this round beat the champion beyond 2·SEM, leak-clean' },
    new_champion_node: { type: 'string', description: 'node id if promoted, else the unchanged champion id' },
    champion_cv: { type: 'number', description: 'champion CV after this round' },
    cv: { type: 'number', description: 'best valid CV produced THIS round (NaN if none valid)' },
    stalled: { type: 'integer', description: 'running count of consecutive improves with no >1·SEM gain on the best lineage' },
    families_alive: { type: 'integer' },
    budget_left: { type: 'integer', description: 'submission slots remaining today, from `uv run tools/kaggle_io.py budget` (UTC-derived)' },
    deadline_reached: { type: 'boolean', description: 'days_left <= 0 from spec deadline vs `date -u`' },
    tree_line: { type: 'string', description: 'one line summarizing the tree state after the round' },
  },
}

// Submit agent (full_auto only) spends at most one slot.
const SUBMIT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['submitted', 'node_id', 'lb', 'budget_left', 'reason'],
  properties: {
    submitted: { type: 'boolean' },
    node_id: { type: 'string' },
    lb: { type: 'string', description: 'public score if it came back during the poll window, else "pending"' },
    budget_left: { type: 'integer' },
    reason: { type: 'string' },
  },
}

// ===== prompts =============================================================

const STANDING = `Standing contract: ${ROOT}/CLAUDE.md (tree semantics, search policy, leakage discipline,
artifact-then-tick, dates from \`date -u\` UTC, every script via \`uv run\`, reusable code in tools/).
Spec machine block: ${ROOT}/spec.md. Frozen CV: ${ROOT}/folds.json. Champion: ${ROOT}/champion/.
NEVER re-split with a new seed (auto-reject). Leakage VOIDS a CV no matter how good it looks.`

function plannerPrompt(round) {
  return `${STANDING}

You are the PLANNER for AUTO-mode round ${round} of competition "${SLUG}" (best-first solution-tree search).
Read ${ROOT}/tree.md (node statuses: pending·running·buggy·valid·champion·dead), ${ROOT}/journal.md (tail),
and ${ROOT}/spec.md (metric, direction, target(s), id, task_type, time_col?, group_key?).

Apply the search policy from CLAUDE.md to choose up to ${WIDTH} INDEPENDENT nodes to expand this round
(distinct parents/families so developers can run in parallel without colliding):
  1. draft  — while valid/champion root-families < 4: a structurally DIFFERENT family (gbdt vs nn vs linear vs darts). parent_id="root", parent_src="${ROOT}/champion/src".
  2. debug  — else the shallowest 'buggy' node within depth (regenerate from scratch after 3 failed attempts; dead after 5). parent = the buggy node.
  3. improve— else the best valid/champion node, EXACTLY ONE atomic change, A/B vs its parent. parent_src="${ROOT}/nodes/<parent>/src".
  - Keep >=2 families alive: if the best lineage hasn't beaten CV by >1·SEM over 5 consecutive improves, force a draft of a different family.

For EACH chosen node: reserve the next zero-padded node_id, \`mkdir -p ${ROOT}/nodes/<node_id>/src\`,
write its node.md from CLAUDE.md's template — fill the \`## plan\` with detail: built on (parent + what
stays byte-identical), change (2-4 lines, the concrete HOW the developer implements and the solution.py
docstring expands), hypothesis, target; created=\`date -u +%Y-%m-%dT%H:%MZ\`, lifecycle all unchecked
except \`[x] proposed\` — and add a 'running' row to ${ROOT}/tree.md.
Return the node specs plus the frontier read. Set stop_now=true ONLY if the deadline is reached (compare spec deadline to \`date -u +%F\`)
or no useful operator remains (search exhausted). Return ONLY the structured object.`
}

function developerPrompt(node) {
  return `${STANDING}

Implement ONE solution-tree node in isolation (fresh context). You are the kaggle-developer.
  node: ${node.node_id}   operator: ${node.operator}(parent=${node.parent_id})   family: ${node.family}
  parent src to copy: ${node.parent_src}
  target node dir: ${ROOT}/nodes/${node.node_id}/   (src/, node.md, train.log, metrics.md, submission.csv, features.txt)
  ONE atomic change: ${node.change}

Steps:
1. Copy ${node.parent_src} -> ${ROOT}/nodes/${node.node_id}/src/, then apply ONLY the one change above.
2. Write src/solution.py that: loads ${ROOT}/data/train.csv + test.csv; loops the folds in ${ROOT}/folds.json;
   FITS EVERY transform (scaler/encoder/imputer/target-encoder/selector) INSIDE the train fold only;
   computes OOF predictions + the official metric per fold; writes per-fold scores to metrics.md and the
   feature columns (one per line) to src/features.txt; writes submission.csv (schema = sample_submission);
   runs the in-harness SHUFFLED-LABEL control (import shuffled_label_ok from tools/leakage_scan.py) so a
   permuted-label refit collapses to the random baseline; and PRINTS a final \`cv=<mean>\` line.
3. Run it backgrounded with the marker-file pattern (CLAUDE.md) — never pgrep:
     DONE=/tmp/${SLUG}_${node.node_id}.done ; rm -f "\$DONE"
     (uv run python ${ROOT}/nodes/${node.node_id}/src/solution.py > ${ROOT}/nodes/${node.node_id}/train.log 2>&1 ; touch "\$DONE") &
   wait on [ -f "\$DONE" ]; tail the log filtered for: cv=|Traceback|Error|Killed|OOM.
4. Validate the file: \`uv run tools/validate_submission.py --submission ${ROOT}/nodes/${node.node_id}/submission.csv --sample ${ROOT}/data/sample_submission.csv --id <id_col from spec>\`.
Add any per-comp modelling dep with \`uv add <pkg>\`. Tick node.md boxes artifact-then-tick.
If train.log has no traceback, ran_clean=true. Return ONLY the structured object.`
}

function reviewerPrompt(node) {
  return `${STANDING}

GATE ONE node (you are the kaggle-reviewer; read-only except gate_report.md — do NOT edit solution code).
  node dir: ${ROOT}/nodes/${node.node_id}/

Run the unit tests + the leakage suite, then write ${ROOT}/nodes/${node.node_id}/gate_report.md (PASS/FAIL per check):
- Unit tests: submission schema/rowcount/id-set via \`uv run tools/validate_submission.py\`; OOF coverage == full train set; no NaN/inf; target distribution sane.
- Structural leakage scan:
    uv run tools/leakage_scan.py \\
      --train ${ROOT}/data/train.csv --test ${ROOT}/data/test.csv \\
      --target <target> --target-cols <target_cols> --id <id> \\
      --features-file ${ROOT}/nodes/${node.node_id}/src/features.txt \\
      --source ${ROOT}/nodes/${node.node_id}/src/solution.py \\
      --out    ${ROOT}/nodes/${node.node_id}/leakage_scan.json
  Exit code 1 (any 'error'-severity check) => the CV is VOID.
- Confirm the in-harness shuffled-label control collapsed to the random baseline.
- cv_too_good tripwire: an implausible CV jump is flagged (surface to the human before any submission).
- Inspect per-fold deltas vs champion — one outlier fold must not carry the mean.

Verdict: any error-severity leak => verdict='dead' if the leak is intrinsic to the change, else 'buggy'; leak_clean=false; cv_mean=NaN.
Any failed unit test or crash => 'buggy'. Otherwise 'valid' with cv_mean (from metrics.md) and cv_sem = std(ddof=1)/sqrt(k).
Return ONLY the structured object.`
}

function summarizerPrompt(round, devs, reviews) {
  return `${STANDING}

You are the SUMMARIZER for round ${round} of "${SLUG}". Fold this round's results into the tree + journal and report loop control.

Developer results: ${JSON.stringify(devs)}
Reviewer verdicts:  ${JSON.stringify(reviews)}

For EACH node this round:
- Update its ${ROOT}/tree.md status from the reviewer verdict (valid·buggy·dead), filling the CV cell for valid nodes (mean±sem).
- DECIDE promotion vs the current champion (read ${ROOT}/champion/README + tree.md): accept as new champion IFF the node is
  valid AND leak_clean AND its CV beats the champion BEYOND 2·SEM in the spec's direction AND (if this lineage has a submitted LB)
  the CV gain is directionally consistent with the LB. A within-noise win is NOT a promotion (stays 'valid').
  On accept: byte-copy (cp, never symlink) nodes/<id>/src + submission.csv into ${ROOT}/champion/, update champion/README
  (node id, cv±sem, \`date -u\`, one-line change), set tree.md status 'champion', demote the prior champion to 'valid'.
- Append ONE timestamped journal line per node to ${ROOT}/journal.md:
    - <date -u +%Y-%m-%dT%H:%MZ>  <node_id>  <op>(parent=<id>)  cv=<mean>±<sem>  leak=<clean|VOID>  -> <champion|valid|buggy|dead>: <one-line reason>

Then compute loop control:
- stalled: running count of consecutive IMPROVE nodes (across rounds) with no >1·SEM CV gain on the best lineage — increment if no
  improve beat its parent beyond 1·SEM this round, reset to 0 on any promotion.
- families_alive: distinct valid/champion root-branch families.
- budget_left: parse \`uv run tools/kaggle_io.py budget --ledger ${ROOT}/submissions.md\` (UTC-derived; 5/day, resets 00:00 UTC).
- deadline_reached: days_left = (spec deadline) - (\`date -u +%F\`) <= 0.
Return ONLY the structured object.`
}

function submitPrompt(championNode, championCv) {
  return `${STANDING}

You may spend AT MOST ONE of today's submission slots (full_auto). Champion node: ${championNode}  cv=${championCv}.
Hard rules: CV decides WHAT to submit; the LB is never an A/B target. Only submit if the champion's CV beats the
LAST submitted CV (last row of ${ROOT}/submissions.md) by more than fold-noise (>2·SEM). If the ledger is empty,
this is the first post-baseline submit — allowed.

Steps:
1. Budget: \`uv run tools/kaggle_io.py budget --ledger ${ROOT}/submissions.md\`. If 0 remaining (5 used today) => DO NOT submit; submitted=false, reason="budget exhausted".
2. Validate: \`uv run tools/validate_submission.py --submission ${ROOT}/champion/submission.csv --sample ${ROOT}/data/sample_submission.csv --id <id_col>\`. Malformed => do not submit.
3. Submit: \`uv run tools/kaggle_io.py submit ${SLUG} --file ${ROOT}/champion/submission.csv --message "${championNode} cv=${championCv}"\`.
   A 403 => rules-not-accepted/unverified (a human gate), NOT bad creds — do not retry; submitted=false, reason explains the gate.
4. Append a UTC row to ${ROOT}/submissions.md: \`| <date -u +%Y-%m-%dT%H:%MZ> | ${championNode} | ${championCv} | <lb-pending> |\` and tick the node's \`[x] submitted\` box.
5. Poll \`uv run tools/kaggle_io.py submissions ${SLUG}\` once or twice for the async public score; write it back to the row if it arrives, else leave "pending". Log the CV<->LB gap as a diagnostic (never auto-demote).
Return ONLY the structured object.`
}

// ===== loop ================================================================

const tried = []          // {node_id, operator, parent, family, change, verdict, cv}
const rounds = []
let champion = null
let championCv = NaN
let stalled = 0
let budgetLeft = null     // unknown until first summarizer report
let deadlineReached = false
let queuedNote = null
let submittedNote = null
let stopReason = null

for (let round = 1; round <= MAX_ROUNDS; round++) {
  phase('Orient')
  const plan = await agent(plannerPrompt(round),
    { label: `plan:r${round}`, phase: 'Orient', schema: PLAN_SCHEMA })

  if (!plan || !plan.nodes || plan.nodes.length === 0) {
    stopReason = plan && plan.stop_reason ? plan.stop_reason : 'planner returned no nodes'
    log(`round ${round}: no nodes to expand — ${stopReason}`)
    break
  }
  if (champion === null) { champion = plan.champion_node; championCv = plan.champion_cv }
  if (plan.stop_now) {
    stopReason = plan.stop_reason || 'planner signalled stop'
    deadlineReached = /deadline/i.test(stopReason)
    log(`round ${round}: planner stop — ${stopReason}`)
    break
  }

  const nodes = plan.nodes.slice(0, WIDTH)
  log(`round ${round}: ${plan.frontier_summary} | expanding ${nodes.map(n => `${n.node_id}:${n.operator}`).join(', ')}`)

  // Expand each frontier node in parallel: develop -> review (sequenced inside the lane,
  // because subagents can't nest — the workflow does the sequencing here).
  phase('Expand')
  const lanes = await parallel(nodes.map(node => async () => {
    const dev = await agent(developerPrompt(node),
      { label: `dev:${node.node_id}`, phase: 'Expand', schema: DEV_SCHEMA, agentType: 'kaggle-developer' })
    if (!dev || !dev.ran_clean) {
      // Crash/non-clean run — skip the reviewer, mark buggy for the summarizer.
      return { node, dev: dev || { node_id: node.node_id, ran_clean: false, notes: 'developer returned nothing' },
               review: { node_id: node.node_id, verdict: 'buggy', leak_clean: false, unit_tests_pass: false,
                         shuffle_collapsed: false, cv_too_good: false, cv_mean: NaN, cv_sem: NaN,
                         reasons: 'did not run clean — no review' } }
    }
    const review = await agent(reviewerPrompt(node),
      { label: `review:${node.node_id}`, phase: 'Expand', schema: REVIEW_SCHEMA, agentType: 'kaggle-reviewer' })
    return { node, dev, review: review || { node_id: node.node_id, verdict: 'buggy', leak_clean: false,
             unit_tests_pass: false, shuffle_collapsed: false, cv_too_good: false, cv_mean: NaN, cv_sem: NaN,
             reasons: 'reviewer returned nothing' } }
  }))

  const devs = lanes.map(l => l.dev)
  const reviews = lanes.map(l => l.review)
  for (const l of lanes) {
    tried.push({ node_id: l.node.node_id, operator: l.node.operator, parent: l.node.parent_id,
                 family: l.node.family, change: l.node.change, verdict: l.review.verdict,
                 cv: l.review.cv_mean, leak_clean: l.review.leak_clean })
  }

  // Summarize: update tree.md/journal.md, decide promotion, report control signals.
  phase('Decide')
  const summary = await agent(summarizerPrompt(round, devs, reviews),
    { label: `summary:r${round}`, phase: 'Decide', schema: SUMMARY_SCHEMA })

  rounds.push({ round, frontier: plan.frontier_summary, nodes: nodes.map(n => n.node_id), summary })

  if (summary) {
    champion = summary.new_champion_node || champion
    championCv = Number.isNaN(summary.champion_cv) ? championCv : summary.champion_cv
    stalled = summary.stalled
    budgetLeft = summary.budget_left
    deadlineReached = summary.deadline_reached
    log(`round ${round}: ${summary.tree_line} | accepted=${summary.accepted} champ=${champion}@${championCv} stalled=${stalled} budget=${budgetLeft} deadline=${deadlineReached}`)

    // Submit policy on a promotion.
    if (summary.accepted) {
      phase('Submit')
      if (MODE === 'full_auto' && budgetLeft > 0) {
        const sub = await agent(submitPrompt(champion, championCv),
          { label: `submit:r${round}`, phase: 'Submit', schema: SUBMIT_SCHEMA })
        if (sub) {
          if (sub.submitted) {
            submittedNote = `${sub.node_id} submitted (lb=${sub.lb})`
            budgetLeft = sub.budget_left
            log(`round ${round}: submitted ${sub.node_id} — lb=${sub.lb}, budget now ${budgetLeft}`)
          } else {
            log(`round ${round}: not submitted — ${sub.reason}`)
          }
        }
      } else {
        // auto_except_submit (or no budget): QUEUE the champion; the main session asks the human.
        queuedNote = `${champion} (cv=${championCv}) queued for human-gated submit — run /kaggle-submit ${SLUG} ${champion}`
        log(`round ${round}: ${queuedNote}`)
      }
    }
  }

  // Loop control: stop best-first when budget is spent, the search stalls, or the deadline passes.
  if (deadlineReached) { stopReason = 'deadline reached'; break }
  if (stalled >= 5) { stopReason = 'stalled >= 5 improves with no CV gain — pivot needed (force a new draft next session)'; break }
  if (budgetLeft !== null && budgetLeft <= 0 && MODE === 'full_auto') {
    stopReason = 'submission budget exhausted for today (resets 00:00 UTC)'; break
  }
}

if (!stopReason) stopReason = `reached maxRounds=${MAX_ROUNDS}`

// ===== report ==============================================================
return {
  slug: SLUG,
  mode: MODE,
  rounds_run: rounds.length,
  stop_reason: stopReason,
  champion: { node: champion, cv: championCv },
  stalled,
  budget_left: budgetLeft,
  deadline_reached: deadlineReached,
  queued_for_submit: queuedNote,   // set in auto_except_submit (human gates the real submission)
  submitted: submittedNote,        // set in full_auto if a slot was spent
  nodes_tried: tried,              // [{node_id, operator, parent, family, change, verdict, cv, leak_clean}]
  rounds,                          // per-round frontier + summarizer signals
  next_action: queuedNote
    ? `Surface the Decision Card for ${champion} and ask the human before submitting (auto_except_submit).`
    : (stalled >= 5
        ? 'Force a draft of a structurally different family next session (search stalled).'
        : 'Re-orient via /kaggle-experiment and continue, or stop if the deadline is near.'),
}
