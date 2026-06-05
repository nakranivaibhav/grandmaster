# kaggleforge

A **human-in-the-loop Kaggle solver that runs inside Claude Code.** Paste a
competition link; Claude understands the problem, builds and validates models,
and submits — pausing for you at the important moments, working on its own in
between.

The "program" is **markdown**: a playbook ([`CLAUDE.md`](CLAUDE.md)), per-stage
**skills**, **subagents**, and one **workflow**. The only real code is a thin
`tools/` of `uv run` scripts (folds, leakage scan, Kaggle I/O, submission check).
Everything competition-specific is bootstrapped per competition into `comps/<slug>/`.

## Setup

```bash
uv sync                 # tools/ deps (pandas, numpy, sklearn)
uv add kaggle           # the Kaggle CLI
cp .env.example .env     # then fill in your creds (kaggle.com → Settings → "Create New Token")
export $(grep -v '^#' .env | xargs)   # load them (or pass --env-file .env to uv run)
```

**Two one-time browser steps per competition** that Claude can't do (it stops and
asks): **accept the competition rules**, and **phone-verify** your account. Skip
them and downloads/submits return 403.

## Use it

Open Claude Code in this repo and **paste the competition link** — Claude drives
the whole pipeline (start → eda → validate → baseline → experiment → final),
pausing only at gated **Decision Cards**. You never have to type the `/kaggle-*`
commands; they exist only if you want to run a stage by hand.

**Autonomy dial** (in `comps/<slug>/config.md`; flip it by voice — "go auto" / "pause"):

| mode | pauses at |
|---|---|
| `interactive` (default) | every gate |
| `auto_except_submit` | only `understand` + `submit` |
| `full_auto` | nothing |

**Run with no prompts:** this repo ships [`.claude/settings.json`](.claude/settings.json)
(`acceptEdits` + an allow-list) so the normal loop barely prompts. For a fully
hands-off run, add a local, git-ignored **`.claude/settings.local.json`** (this
repo already has one):

```jsonc
// .claude/settings.local.json  — personal, never committed
{ "permissions": { "defaultMode": "bypassPermissions" } }
```

## Safety rails

The CV is **frozen once** and never refit across folds; every transform is fit
**inside the fold**. The **leakage suite is a gate, not a warning** — a leaky node
is void no matter its CV. Claude **trusts a well-built CV over the public LB**.
The submission budget (~5/day) and dates come from UTC timestamps, so they
survive a resume. The whole run is **resumable** from `comps/<slug>/`.

**Full rules, repo layout, and the node/graph model → [`CLAUDE.md`](CLAUDE.md).**
