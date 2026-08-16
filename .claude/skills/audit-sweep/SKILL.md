---
name: audit-sweep
description: Run one iteration of the d1zzle sweep — one of three rotating review lenses (feature, efficiency+bugs, security) over the whole codebase, a coder batch committed to its own branch, up to two review rounds, then a merge to main. State and the rotation pointer live in AUDIT.md. Intended to be driven on an interval by /loop.
---

# One sweep iteration

State lives in `AUDIT.md` at the repo root, not in your context — this runs unattended
for hours across compaction, so **read `AUDIT.md` first, every time**, and write your
result back to it before you finish.

The cycle is fixed. Do not reorder it, and do not skip the second reviewer pass because
the first one looked clean:

```
lens → branch → reviewer → coder   → reviewer → coder   → reviewer → merge
                (codebase) (commit)  (round 1)  (commit)  (round 2)  (main)
```

The coder commits to the sweep branch as it goes. `main` is written exactly once per
iteration, by the merge in step 7, and only under the rule in that step.

## The three lenses

Each iteration runs **exactly one** lens, and they rotate. Three consecutive iterations
cover all three; the fourth starts over. One lens at a time is the point — a reviewer
asked for everything at once returns a shallow pass on each.

| # | Lens | Looks for |
|---|---|---|
| 1 | **feature** | Gaps against Drizzle and other ORMs; adapter compatibility |
| 2 | **efficiency + bugs** | Wasted work, wasted bytes, and defects that produce wrong results |
| 3 | **security** | Injection, leakage, weakened constraints, data loss, disclosure |

### The rotation pointer

`AUDIT.md` carries a `## Rotation` section. It is the only record of where the cycle is —
your context is not:

```markdown
## Rotation
- Next lens: **efficiency + bugs**
- Last ran: feature — 2026-07-31, merged 1a2b3c4 (or: blocked / converged)
```

Read it in step 1, advance it in step 8. **Advance it in every terminal case** — merged,
blocked, red gate, nothing found. A lens that keeps failing must not pin the rotation and
starve the other two. If the section is missing or unparseable, start at **feature** and
write the section.

## Branching

This overrides `CLAUDE.md`'s "don't create branches, commit to the current branch" — the
human asked for this flow explicitly, and that instruction assumed the sweep committed
straight to `main`. Everything else in `CLAUDE.md` still binds.

One branch per iteration, cut from `main` at step 2, named for its lens:

```bash
git checkout main
git checkout -b "sweep/<lens>-$(date -u +%Y%m%d-%H%M%S)"    # e.g. sweep/security-20260731-0142
```

Never rebase, force-push, or amend a commit that already exists. The branch is
append-only; a bad commit is answered with another commit, or the branch is abandoned
unmerged.

## Context discipline

Every `reviewer` and `coder` spawn is a **fresh subagent with empty context**. That is the
whole mechanism — there is no operation a subagent can perform to compact or clear this
conversation, so "the reviewer works from a clean slate" is achieved by spawning a new one
and handing it only its inputs, never by trying to reset anything in place.

Concretely: do **not** paste the coder's reasoning into the reviewer, or one review
round's prose into the next. The reviewer that checks the diff proposed the findings a
moment ago; if it is shown its own earlier argument it will confirm itself.

Your own context is the one thing that accumulates. Keep only what the next step needs —
the lens, the finding list, the round count, the verdicts — and push everything else into
`AUDIT.md` as you go. If you cannot reconstruct the iteration from `AUDIT.md` alone, you
have kept too much in your head and the next run after a compaction will lose it.

## 1. Read the rotation pointer

Read `AUDIT.md`. Take `Next lens`. That is this iteration's lens and it does not change
partway through — a reviewer that wanders into another lens's territory gets its
off-lens findings **recorded in `AUDIT.md`, not implemented**; the iteration that owns
that lens will pick them up.

## 2. Green gate and a clean tree, before anything else

```bash
git status --porcelain --untracked-files=no
npm run check
```

**If any tracked file is modified**, stop. Do not branch, do not sweep, do not stash. That
is somebody's work in progress and folding it into a sweep commit is how it gets lost.
Report what is dirty and stop.

`--untracked-files=no` is load-bearing, not tidiness: `AUDIT.md` — this sweep's own state
file — is untracked, as are `CLAUDE.md`, `.claude/` and the devcontainer files. A bare
`git status --porcelain` reports all of them every single iteration, and the sweep would
refuse to start forever.

**If the gate fails** and the failure is not from this iteration's work, stop immediately,
write what failed under `## Blocked` in `AUDIT.md`, advance the rotation, and report it.
Never start new work on a red gate, and never "fix" an unrelated failure to make the gate
green — that is how a sweep turns into an unreviewable diff.

(Exception: environment, not code. In this devcontainer `node_modules` is a **named
volume**, so a fresh container starts empty and needs `npm ci` once — that installs from
the lockfile and cannot modify tracked files. If the volume is instead bind-mounted from a
macOS host, platform binaries can be the wrong architecture:
`node node_modules/esbuild/install.js` repairs esbuild, and
`npm i --no-save @typescript/native-preview-linux-x64@<version>` repairs tsgo.)

Only once both are clean, cut the branch.

## 3. Reviewer — the whole codebase, through this iteration's lens

Spawn the `reviewer` subagent over the repository with **only** this lens's brief. Then,
in every lens, append these two paragraphs:

> These findings are already known — do not report them again: <titles from AUDIT.md>
>
> For each finding give `path:line`, one sentence of defect, a concrete failure scenario,
> the exact fix, and the test that proves it. A finding without a failure scenario is a
> style opinion; drop it. If something outside this brief looks serious, say so under a
> heading `OFF-LENS` — it will be recorded for another iteration, not fixed now.

### Lens 1 — feature

> Review this repository for **feature gaps**, against two references: `drizzle-orm` /
> `drizzle-kit`, and what a competent SQLite ORM is expected to do. Then check **adapter
> compatibility**: adapters such as Pothos' drizzle plugin and `better-auth` read
> Drizzle's *internal representation*, so a symbol that exists but carries a different
> shape underneath is a live break, not a cosmetic difference.
>
> Sort every finding into exactly one of these, and label it:
>
> - `COMPAT-DEFECT` — a symbol d1zzle already exposes under a Drizzle spelling that
>   behaves differently, incompletely, or wrongly against Drizzle's own semantics, or an
>   internal representation an adapter reads and gets wrong. **This is a bug**, it is
>   implementable now, and it is what this lens is most valuable for.
> - `NEW-SURFACE` — anything that would add a spelling, an option, or an export that does
>   not exist today. Describe it and argue for it, but understand it will not be built by
>   this sweep. See below.
>
> Note `docs/04`: a symbol usable in a schema must also exist in Drizzle. A proposal that
> invents a spelling Drizzle lacks is a proposal to change what this ORM *is*.

**`NEW-SURFACE` never reaches the coder.** Adding to the published API is forbidden here
(see *Never*, below), so a feature iteration usually merges nothing and that is the
correct outcome — its deliverable is a well-argued proposal parked as `needs-human` for a
human to accept or reject. Do not let this tempt you into reclassifying a `NEW-SURFACE`
item as a defect to give the iteration something to commit. Only `COMPAT-DEFECT` items go
into the batch.

### Lens 2 — efficiency + bugs

> Review this repository for **efficiency** defects and **bugs**.
>
> Efficiency means: work done per row that could be hoisted per query; allocation and
> string building on the hot path in `src/sql/` and `src/plan/`; unbounded `in (...)`
> lists or unbounded batches; bytes added to the Worker bundle, which is parsed on every
> cold isolate and billed as startup CPU.
>
> Bugs means the classes in `CLAUDE.md`, in its order of severity: constraints silently
> dropped by DDL rendering, snapshotting or diffing (`unique`, composite PK, `check`, FK
> `on delete`/`on update`, `not null`, defaults, collation, generated columns, partial
> index `where`, `STRICT`, `WITHOUT ROWID`); SQL that parses but is wrong (`and`/`or`
> nesting and precedence, placeholder vs. bind order, join order, `limit` applied before
> aggregation); wrong rows (`Many` resolving to a single object, parent duplication after
> a join, a left join degrading to inner, an all-null row materialised as an object).

### Lens 3 — security

> Review this repository for **security** defects.
>
> That means: any user value reaching SQL unbound, or any identifier reaching it unquoted
> or with embedded quotes unescaped; a `src/` path that leaks data across tenants,
> requests, or isolates; anything that weakens or bypasses `STRICT`, a `check`, or a
> foreign key; a destructive statement reachable without `--accept-data-loss`; a
> migration applier path that can lose data on partial failure; secrets, credentials, or
> a private product's schema and column names in anything published to npm or committed
> to public history.

Append everything that comes back to `## Findings` in `AUDIT.md`, tagged with the lens,
**before** you spawn the coder — if the iteration dies mid-way, the findings survive.
Record `OFF-LENS` items as `todo` tagged with the lens that owns them.

If the pass returns nothing implementable, say so, delete the empty branch, advance the
rotation, and stop without spawning a coder.

## 4. Coder — implement the batch, commit to the branch

Spawn the `coder` subagent with **every** implementable finding from this pass, verbatim:
file and line, the exact change, the invariant it must preserve, and the test to add.
State explicitly what is out of scope. Tell it to commit to the current branch when done:

```bash
git add -A && git commit -m "<type>: <what this batch fixed>"
```

Exclude these from the batch, marking them in `AUDIT.md` instead of handing them over:

- Every `NEW-SURFACE` item, and anything else changing the published API surface or
  `docs/` describing it — `needs-human`.
- Anything needing a design decision — `needs-human`, with the question. The coder runs at
  low effort by design and will invent an answer if you let it.
- `OFF-LENS` items — `todo`, tagged for the lens that owns them.

If the pass produced more than **eight** implementable findings, hand over the eight
highest-severity and write the remainder into `AUDIT.md` as `todo` with a line saying they
were deferred from this iteration for batch size. Defer explicitly or not at all — a
silently truncated batch reads afterwards as a clean sweep that covered everything.

## 5–6. Review rounds — at most two

A round is: reviewer reads the branch diff against `main`, then the coder answers it with
another commit. Spawn a **new** `reviewer` each round, in fresh context, seeing only the
diff and the findings it is meant to close:

> Review `git diff main...HEAD` against these findings: <the batch>. For each one, confirm
> the failure scenario no longer reproduces. Then check the diff for new instances of the
> bug classes in your instructions — a fix that closes one hole and opens another is a
> rejection. Report gaps that affect correctness, security, or efficiency only.
>
> End with a single line: `VERDICT: approved` or `VERDICT: rejected`.

**Round 1.** If approved, go straight to step 7. If rejected, spawn a **new** `coder` with
its gaps verbatim; that coder commits its answer to the branch.

**Round 2.** Review again. Approved or not, this is the last round — there is no round 3.
Record the verdict and go to step 7.

Track the round count yourself. The reviewer does not know which round it is in, and must
not be told: "this is your last look" changes how it reviews.

## 7. Merge to main

Run the gate once more on the branch:

```bash
npm run check
```

Then apply this rule exactly:

| Verdict | Gate | Action |
|---|---|---|
| approved (round 1 or 2) | green | **merge** |
| rejected after 2 rounds | green | **merge**, and record the unresolved objection |
| anything | red | **do not merge** — mark `blocked`, leave the branch |

The reviewer's verdict gates the merge, but *you* execute it: the rule depends on the
round count and the gate result, and a reviewer only ever sees its own round. A red gate
is the one hard stop — no verdict overrides it.

```bash
git checkout main
git merge --no-ff <branch> -m "<type>(<lens>): <what this batch fixed>"
git branch -d <branch>
```

`--no-ff` keeps the batch revertible as one unit, which is the whole reason a batch is
allowed to be a batch. When the merge happens over an unresolved rejection, write the
reviewer's objection into `AUDIT.md` verbatim under the finding it belongs to — that
objection is now a claim about code on `main`, and a later iteration's reviewer will be
looking at it.

When the gate is red, leave the branch in place unmerged, mark every finding in the batch
`blocked` with the reason and the branch name, and stop. Do not delete the branch, and do
not `git restore` over it — the work is the record of what was tried.

## 8. Write back and advance the rotation

Update `AUDIT.md`:

- each finding's status, tagged with its lens
- the merge SHA, or the blocking reason and branch name
- anything deferred for batch size, any `NEW-SURFACE` proposal, any `OFF-LENS` item
- any unresolved reviewer objection that was merged anyway
- **`## Rotation`: set `Next lens` to the next of the three, and record what this one did**

Then report in two or three lines what happened, naming the lens and what the next one
will be — that is what the human skims when they come back.

## Never, during an unattended sweep

- Rebase, force-push, or amend a commit that already exists
- Commit directly to `main`, or merge anything the gate does not pass
- Weaken or skip a test to make the gate pass
- Add a dependency, or bump one
- Change the published API surface (`src/index.ts`, `src/sqlite-core.ts`, `kit` exports)
  or anything in `docs/` describing it — park it as `needs-human`
- Add a schema-facing spelling that `drizzle-orm/sqlite-core` does not have (`docs/04`)
- Release, version-bump, or touch `RELEASING.md` / `Makefile`
- Copy another project's schema into this repo (see the fixture note in `AUDIT.md`)
