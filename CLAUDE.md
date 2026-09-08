# CLAUDE.md — velve-auth

Rules for every agent and every human working in this repository. They are not
advice. A change that violates them does not get merged.

The binding specification is `VELVE-AUTH-ARCHITEKTUR.md` in the repository root.
It is written in German and it is the source of truth for the schema, the public
interface, the security requirements `S-<class>-<n>`, the test cases
`T-<class>-<n>`, the decided gaps `L-1` to `L-13` and the decision log `E-01` to
`E-46`. Where this file and the architecture disagree, the architecture wins —
and the disagreement is a bug in this file that must be fixed before continuing.

---

## 1. Language

**Everything in this repository is written in English.** Source code,
identifiers, commit messages, pull requests, `README.md`, `DOCUMENTATION.md`,
`CASE-STUDY.md`, inline text and error codes. There is no exception, and
`CASE-STUDY.md` — which used to be one — is explicitly not one.

`CASE-STUDY.md` was German until this rule changed. It is being migrated to
English in a single central pass, so that the migration does not collide with
the feature branches appending to it. Until that pass has run the file holds
both languages. A German entry still in it is outstanding work, not a permitted
exception, and no entry written from now on may be German.

That pass rewrites the file's own header too. The header states the language and
the entry format of everything below it, and a translation that leaves it
standing leaves the file describing itself wrongly — in German, and in the old
`Kontext · Verworfen · Grund · Preis` shape §6 has replaced.

The decision log continues architecture section 7, and section 7 is German. A
continued entry is **translated, not quoted**: the case study no longer
reproduces section 7's German verbatim. How a translation must read is fixed in
§6, and it is the one place where the no-retroactive-rationalisation rule is
easiest to break by accident.

The rule that is decided once and does not get revisited is this one — English
everywhere, `CASE-STUDY.md` included. The package is a public MIT library on
npm; its readers are not assumed to read German.

## 2. Scope

The library answers exactly one question: **who is signed in.**

No roles. No permissions. No organisations. No teams. No profile data. A feature
request that adds any of those is rejected, not deferred. Architecture section
3.14 lists what is deliberately absent; that list is a promise, not a backlog.

## 3. Code style

The code must be readable without comments.

- Every function is named so that its purpose follows from reading it. If a name
  needs a comment to be understood, the name is wrong — rename it.
- **A comment that explains _what_ the code does is a defect.** It is reported by
  the reviewer and fixed by renaming or by splitting the function.
- Comments are permitted only where the reason for the code cannot be expressed
  in code: a specification clause being satisfied, a deliberate deviation from a
  standard, a non-obvious ordering constraint. Then **one sentence**, no more.
- A reference to the specification is a legitimate comment and is encouraged
  where the code exists solely because of it: `S-OWNER-3`, `L-12`, `E-23`.
- No `any` in the public surface. No `@ts-ignore`, no `@ts-expect-error` without
  a failing-by-design test next to it. No `console.log`. No dead code, no unused
  exports — `knip` enforces this.
- The public interface must be usable without reading the documentation. If a
  parameter needs prose to be understood, the parameter is shaped wrong.
- No default export. Named exports only.
- Errors carry a stable machine-readable code. What the outside learns is decided
  in exactly one place, `src/core/http/error-map.ts`; no other module decides what
  a caller is allowed to see.

## 4. Branch discipline

- **Never work on `main`.** No agent has write access to it. `main` changes only
  through a pull request that the main gate has approved.
- One feature, one branch, one worktree: branch `feature/<feature>`, worktree
  `../velve-auth-wt-<feature>`.
- **Push the branch immediately after creating it**, before the first content
  change, so that progress is visible from the outside. Push again after every
  completed building block — not only at the end.
- Conventional Commits, English subject line, imperative mood:
  `feat:`, `fix:`, `refactor:`, `chore:`, `docs:`, `test:`, `ci:`, `build:`,
  `perf:`, `security:`, `revert:`.
- Commit every self-contained change separately. Do not batch unrelated work.
- A commit message says **what changed and why**, and cites the specification
  where the change follows from it.

### No AI attribution

Nothing in this repository refers to an AI model, an assistant, or a session.
Not in commit messages, not in pull request titles or bodies, not in code
comments, not in the documentation, not in file headers.

Specifically forbidden: `Co-Authored-By` lines naming an assistant, "Generated
with" footers, 🤖 or similar markers, session identifiers or session URLs, and
the words Claude, Anthropic, ChatGPT, OpenAI, Copilot or "AI-generated" used to
describe the authorship of anything here.

The main gate verifies this with `git log --format=%B` over every commit on the
branch, with a full-text search over the tree, and with one over the branch diff.
The tree scan cannot see text a later commit removed; the diff scan cannot see
text that predates the branch. Both run. A single hit blocks the merge.

Three files are exempt because they must name the forbidden terms: the
specification, this rule, and the check itself. Nothing else is exempt — text
that would trip the check gets reworded rather than excused.

## 5. Working method

### Writer and reviewer

Every feature gets a writer and an independent reviewer. They run **one after
the other** in the same worktree. The reviewer does not receive the writer's
summary and does not work from the writer's assumptions — the reviewer's brief is
the architecture and the assigned `S-…` requirements.

**The reviewer writes the tests.** Not tests for the writer's code, but tests for
the requirement against the result. When the reviewer finds a deviation, the
failing test is written first, then the work goes back to the writer.

A reviewer checks, in this order:

1. Does the code satisfy each assigned `S-…` requirement? Each one individually,
   with evidence.
2. Is it understandable without comments? Every comment that describes _what_ the
   code does is a finding.
3. Is there dead code, an unused export, an `any`, a `@ts-ignore`, a
   `console.log`?
4. Do the error paths reveal nothing beyond what the specification allows?
5. Is this feature's documentation written — not announced?

### Parallelism and file ownership

At most **four agents run at the same time**. This is a hard limit.

Features in the same wave run in parallel; waves run one after another. **No two
writers share a file.** The single exception is `CASE-STUDY.md`, which every
feature appends to; §6 explains how that is made safe. The set of files a
feature may touch is fixed before it starts and is binding. A feature that needs
a change outside its area stops and reports it instead of editing the file.

### Definition of done

A feature is finished when **all six** hold:

1. The code is in the worktree, built, type-checked, linted.
2. The reviewer's tests pass, and every assigned `S-…` requirement has at least
   one test meeting the threshold fixed in architecture section 6.
3. `DOCUMENTATION.md` covers every new function, parameter and configuration.
4. `README.md` is updated if the outside picture changed.
5. `CASE-STUDY.md` records the decisions actually taken while building.
6. The main gate has approved.

### The main gate

Runs before every merge into `main` and blocks it on any finding. It does not
repair anything itself.

- `pnpm build` without errors **and without warnings**
- `pnpm typecheck` under `strict`, no `any` in the public surface type
- `pnpm lint` without findings, formatting applied
- `pnpm knip` — no dead code, no unused export
- `pnpm check:session-owner` — no session owner reassigned in SQL (S-FIX-2, E-23)
- `pnpm check:lock-order` — `velve.user` is locked before any other table
- `pnpm check:reviewable` — no NUL byte hides a file from review or from the scan
- `pnpm test` green, no skipped test without a reason stated in the code
- `README.md`, `DOCUMENTATION.md` and `CASE-STUDY.md` extended for the feature
- no AI attribution anywhere in the diff or the branch's commit history
- the public surface has not changed unannounced (API snapshot comparison)

A check must be able to tell **found nothing** from **found a fault**. Three of
this repository's checks were written so it could not — a scan reporting success
because it matched no files, a shell condition testing a pipeline that exits
zero on empty input, an exclusion that deleted the text it was meant to examine.
Each looked green. When you add a check, prove it fails on a planted fault
before you trust it passing.

## 6. Documentation duty

Documentation is written **while** building, never afterwards. A feature whose
documentation is "to be written" is not finished.

- **`README.md`** — what it is, why it exists, how to install it, what it does,
  and what it deliberately does not do.
- **`DOCUMENTATION.md`** — every function, every parameter, every configuration
  option, every schema table. The reference.
- **`CASE-STUDY.md`** — grows with the build. Every design decision with its
  reason, every rejected alternative, every problem and its solution, in the
  entry format fixed below.

`CASE-STUDY.md` has one rule that matters more than the others: **no retroactive
rationalisation.** If a decision was made for a bad reason and turned out right,
the bad reason is what gets written down. The log is written during the build so
that the reasons are the actual ones and not the reconstructed ones.

Do not create any other markdown file. No summary files, no progress reports, no
`NOTES.md`.

### The entry format

An entry looks exactly like this:

```
### Authenticate the envelope header
`E-65` · keys · storage format, frozen

**Context.** …
**Rejected.** …
**Reason.** …
**Price.** …
```

- The **heading** carries the title, and nothing else. It is a sentence a reader
  can scan, not a number.
- The **subordinate line** carries three fields separated by ` · `: the ID in
  backticks, the feature that owns the number, and a short tag saying what kind
  of decision it is and whether it is still open — `storage format, frozen`,
  `revisit after wave 3`.
- All four parts are required, in that order, each opening its own paragraph:
  `**Context.**`, `**Rejected.**`, `**Reason.**`, `**Price.**`. An entry with
  nothing rejected still writes `**Rejected.**` and says so.

Until the migration in §1 has run, the file also holds the old German form —
`**E-nn — Entscheidung.**` followed by `*Kontext:*`, `*Verworfen:*`, `*Grund:*`,
`*Preis:*`. `test/decision-log.test.ts` accepts both, and only both. A heading
that is neither is a fault, not an entry, and the test says so rather than
skipping it.

**Heading position** is what the test means by it: a line that opens a markdown
block — it is the first line of the file, or it follows a blank line or an ATX
heading — and that begins, after any markdown decoration, with an `E-nnn` that
is not followed by prose. `###`, `-`, `*`, `+`, `>` and backticks are decoration,
so leaving the number in the `###` heading is caught, and so is a list item, an
italic line or a blockquote carrying one. A wrapped prose line never opens a
block, so a citation that happens to land at a line start is not a heading and
is not reported.

### Translating an entry

Translation is the sharpest edge the no-retroactive-rationalisation rule has,
because a translator reads a weak argument and improves it without noticing.

A translation carries the original argument across unchanged. It may not:

- strengthen a reason, add evidence the original did not have, or supply a
  justification the writer did not give;
- soften a price, round a measured number, or drop a consequence because it
  reads badly;
- tidy a false start, a wrong assumption or an admitted mistake out of a
  context, or reorder the entry so the decision looks more inevitable than it
  was.

**A translated entry that reads better than the original is a defect.** If the
German was confused, the English is confused in the same places. Where the
original is genuinely unclear, the translation stays unclear and the entry is
reported — it is not repaired in passing, because repairing it invents a reason
nobody had.

New information about an old decision belongs in a new entry that cites the old
one, never in the old entry's text.

### Numbering the decision log

`CASE-STUDY.md` is the one file every feature appends to. That is a deliberate
exception to the file-ownership rule in §5, and it works only because of how the
numbers are handed out.

**Each feature is given a reserved range of decision numbers when its wave
starts, and it uses only that range.** Two features never reach for the same
number, so no branch ever has to renumber, and the merge order does not matter.

| Range | Belongs to |
|---|---|
| E-01 … E-46 | the architecture's own log, section 7 — never extended here |
| E-47 … E-58 | wave 0: the scaffold, the banner and the positioning line |
| E-59 … E-79 | wave 1 · `keys` |
| E-80 … E-109 | wave 1 · `db` |
| E-110 … E-139 | wave 1 · `http` |
| E-140 … E-159 | gate and infrastructure, which belongs to no wave |
| E-160 … E-189 | wave 2 · `password` |
| E-190 … E-219 | wave 2 · `identity` |
| E-220 … E-249 | wave 2 · `session` |
| E-250 … E-279 | wave 2 · `token` |
| E-280 … E-299 | wave 2 · `session`, second range |
| E-300 … E-319 | wave 2 · `password`, second range |
| E-320 … E-349 | wave 3 · `auth-core` |
| E-350 … E-379 | wave 3 · `rate` |
| E-380 … E-409 | wave 3 · `factor-totp` |
| E-410 … E-439 | wave 3 · `factor-webauthn` |

The next wave's ranges are added to that table before its features start,
continuing above the highest number already reserved. A range is assigned before the feature's writer starts and is not
changed afterwards. A feature that runs out asks for a second range rather than
borrowing from a neighbour.

A second range is a **new row**, added at the bottom like any other and marked
`second range`. It never widens or replaces the feature's first row, and the two
rows are not an overlap — they are two disjoint blocks owned by the same
feature, which is exactly what the rule above prescribes. Numbering inside the
second range continues from its own start; the gap left at the end of the first
range stays a gap.

`test/decision-log.test.ts` reads that table. Every entry in `CASE-STUDY.md` must
fall inside a declared range, and two ranges may not overlap — so a feature
quietly taking a number it does not own fails on its own branch rather than at
the merge, and a bad assignment fails at wave start while it is still free.

The reason this matters more than it looks: decision IDs are cited from code,
tests and documentation — `E-23` next to the line it explains. A renumber has to
move every citation with it, and a citation left behind does not dangle, it
**resolves to the wrong decision**. Nothing detects that. Reserved ranges remove
the renumber, and removing the renumber removes the whole failure class.

A reserved range that is not used up leaves a gap in the numbering. That is
fine and expected. Contiguity is worth nothing here; a silent wrong citation
costs a great deal.

`test/decision-log.test.ts` is the backstop, not the mechanism. It catches a
number used twice, an entry missing one of its four parts, a citation anywhere
in the repository that resolves to no entry at all, and a block that sits in
heading position carrying an `E-nnn` but matches neither entry form. That last
one exists because without it such a block is skipped in silence: it is not
counted, not part-checked and not range-checked, and if its number belongs to a
real entry elsewhere the duplicate check does not see it either. It cannot catch
a citation that resolves to the wrong entry — only not renumbering can.

## 7. Technical constraints

These follow from architecture section 2 and are not open for local decision:

- Pure TypeScript. **No WASM on the required path.** `hash-wasm` is an optional
  peer dependency and an accelerator only.
- ESM only. No CommonJS build. `dist/*.mjs` and `dist/*.d.mts`, nothing else.
- No `postinstall`, no `node-gyp`, no native binding, no downloader.
- Not used anywhere on the required path: `node:fs`, `node:wasi`,
  `node:worker_threads`, `node:child_process`. The library assumes Web standards
  — `globalThis.crypto` with `subtle` and `getRandomValues`, and `fetch`.
- PostgreSQL 14 or newer. Hand-written SQL, no query builder, no ORM. The driver
  is a parameter, never an import.
- Keys come from a `KeyProvider`, never from `process.env` inside the core.
- **`velve.user` is locked first, and a lock declares what it locks.** A transaction
  that takes a row lock — `SELECT … FOR UPDATE` or `FOR NO KEY UPDATE` — takes it on
  `velve.user` before it locks a row in any other table, and the statement says so in
  a block comment: `/* locks: ${schema}.user */`. Every repository builds its table
  name from the configured schema, so no scan can read the target out of the SQL; a
  check that tried to would pass for the absence of a name rather than the presence
  of the right one. Two features reached for a row lock
  independently and both happened to lock the user row first; the ordering is a
  rule so the next one does not have to guess. A cycle here surfaces as a
  deadlock in production under load, not in a test, because it needs two specific
  transactions interleaving on the same account. `pnpm check:lock-order` enforces
  it. A row lock is also wider than it looks: while it is held, every write of a
  user-owned row for that account waits, and if the transaction contains an
  outbound call the wait is that call's timeout.
- Core dependencies are exactly these six: `@noble/hashes`, `@noble/ciphers`,
  `bcryptjs`, `otpauth`, `@simplewebauthn/server`, `jose`. Adding a seventh is a
  decision for `CASE-STUDY.md`, not a routine change.

## 8. Secrets

- Never read, open, print or search `.env`, `.env.local`, `.env.production` or
  any secrets file.
- Never write a secret value into code, a test fixture, a commit or a log line.
- A missing variable gets its **key** added to `.env.example` and is reported. Do
  not invent a value.
- Test keys are generated by the test setup, never committed.

## 9. Commands

```
pnpm build       tsdown — ESM + .d.mts
pnpm typecheck   tsc --noEmit, strict
pnpm lint        biome check, warnings included
pnpm format      biome check --write — applies everything lint verifies
pnpm test        vitest run — the blocking tier
pnpm test:nightly
                 vitest run with VELVE_NIGHTLY=1 — adds the statistical and
                 high-repetition cases section 6 puts on a nightly schedule
pnpm knip        dead code and unused exports
pnpm check:session-owner
                 S-FIX-2: no session owner reassigned in SQL
pnpm check:lock-order
                 velve.user is locked before any other table
pnpm check:reviewable
                 no NUL byte hides a file from review
pnpm publint     package export correctness
pnpm attw        type resolution across module modes
pnpm gate        everything above, in the order the main gate runs it
```
