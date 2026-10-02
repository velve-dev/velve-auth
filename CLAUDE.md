# CLAUDE.md — velve-auth

The explanations, measurements and histories behind these rules are in `docs/working-method.md`.

Rules for every agent and every human working in this repository. They are not advice. A change that violates them does not get merged.

The binding specification is `VELVE-AUTH-ARCHITEKTUR.md` in the repository root. It is written in German and it is the source of truth for the schema, the public interface, the security requirements `S-<class>-<n>`, the test cases `T-<class>-<n>`, the decided gaps `L-1` to `L-13` and the decision log `E-01` to `E-46`. Where this file and the architecture disagree, the architecture wins — and the disagreement is a bug in this file that must be fixed before continuing.

`VELVE-AUTH-ARCHITECTURE.md` is an English translation of it, and is **not** a second source of truth. Read whichever you prefer; decide from the German. Where they differ on a number, an identifier, a threshold or a requirement, the German is right and the translation has a bug to be fixed — never the other way round.

## 1. Language

**Everything in this repository is written in English.** Source code, identifiers, commit messages, pull requests, `README.md`, `DOCUMENTATION.md`, `CASE-STUDY.md`, inline text and error codes. There is no exception, and `CASE-STUDY.md` — which used to be one — is explicitly not one.

`CASE-STUDY.md` was German until this rule changed. It is being migrated to English in a single central pass, so that the migration does not collide with the feature branches appending to it. Until that pass has run the file holds both languages. A German entry still in it is outstanding work, not a permitted exception, and no entry written from now on may be German.

That pass rewrites the file's own header too.

The decision log continues architecture section 7, and section 7 is German. A continued entry is **translated, not quoted**: the case study no longer reproduces section 7's German verbatim.

The rule that is decided once and does not get revisited is this one — English everywhere, `CASE-STUDY.md` included.

## 2. Scope

The library answers exactly one question: **who is signed in.**

No roles. No permissions. No organisations. No teams. No profile data. A feature request that adds any of those is rejected, not deferred. Architecture section 3.14 lists what is deliberately absent; that list is a promise, not a backlog.

## 3. Code style

The code must be readable without comments.

- Every function is named so that its purpose follows from reading it. If a name needs a comment to be understood, the name is wrong — rename it.
- **A comment that explains _what_ the code does is a defect.** It is reported by the reviewer and fixed by renaming or by splitting the function.
- A comment is `//` with no space, lower case, one sentence in plain words, no full stop. The sentence says what must hold and is understandable without the bracket. At the end, in parentheses, comes exactly one identifier, `S-` for a security requirement or `E-` for a decision, and only where the code is the way it is because of it. No dash, no colon, no "because", no "so that". A sentence longer than one line is a log entry, not a comment.

  ```
  //changing a password needs to make all sessions invalid (S-FIX-6)
  //revoking a session that isnt yours must look the same as a missing one (E-233)
  //freshness check uses the db time not the server time (E-238)
  //refresh only extends the idle timeout
  ```

- Doc comments on exported symbols stay doc comments of one plain sentence without an identifier, because a user reads them in the editor (E-1943). `pnpm check:decision-refs` fails on an identifier no document defines.
- No `any` in the public surface. No `@ts-ignore`, no `@ts-expect-error` without a failing-by-design test next to it. No `console.log`. No dead code, no unused exports — `knip` enforces this.
- The public interface must be usable without reading the documentation. If a parameter needs prose to be understood, the parameter is shaped wrong.
- No default export. Named exports only.
- Errors carry a stable machine-readable code. What the outside learns is decided in exactly one place, `src/core/http/error-map.ts`; no other module decides what a caller is allowed to see.

## 4. Branch discipline

- **Never work on `main`.** No agent has write access to it. `main` changes only through a pull request that the main gate has approved.
- One feature, one branch, one worktree: branch `feature/<feature>`, worktree `../velve-auth-wt-<feature>`.
- **Push the branch immediately after creating it**, before the first content change, so that progress is visible from the outside. Push again after every completed building block — not only at the end.
- Conventional Commits, English subject line, imperative mood: `feat:`, `fix:`, `refactor:`, `chore:`, `docs:`, `test:`, `ci:`, `build:`, `perf:`, `security:`, `revert:`.
- Commit subjects are Conventional Commits with a scope — `fix(oauth): …`, `refactor(session): …` — and the sentence that used to be the subject goes in the body; history is not rewritten.
- Commit every self-contained change separately. Do not batch unrelated work.
- A commit message says **what changed and why**, and cites the specification where the change follows from it.

### No AI attribution

Nothing in this repository refers to an AI model, an assistant, or a session. Not in commit messages, not in pull request titles or bodies, not in code comments, not in the documentation, not in file headers.

Specifically forbidden: `Co-Authored-By` lines naming an assistant, "Generated with" footers, 🤖 or similar markers, session identifiers or session URLs, and the words Claude, Anthropic, ChatGPT, OpenAI, Copilot or "AI-generated" used to describe the authorship of anything here.

The main gate verifies this with `git log --format=%B` over every commit on the branch, with a full-text search over the tree, and with one over the branch diff. A single hit blocks the merge.

Three files are exempt because they must name the forbidden terms: the specification, this rule, and the check itself. Nothing else is exempt — text that would trip the check gets reworded rather than excused.

## 5. Working method

### Writer and reviewer

Every feature gets a writer and an independent reviewer. They run **one after the other** in the same worktree. The reviewer does not receive the writer's summary and does not work from the writer's assumptions — the reviewer's brief is the architecture and the assigned `S-…` requirements.

**The reviewer writes the tests.** Not tests for the writer's code, but tests for the requirement against the result. When the reviewer finds a deviation, the failing test is written first, then the work goes back to the writer.

A reviewer checks, in this order:

1. Does the code satisfy each assigned `S-…` requirement? Each one individually, with evidence.
2. Is it understandable without comments? Every comment that describes _what_ the code does is a finding.
3. Is there dead code, an unused export, an `any`, a `@ts-ignore`, a `console.log`?
4. Do the error paths reveal nothing beyond what the specification allows?
5. Is this feature's documentation written — not announced?

### Parallelism and file ownership

At most **four agents run at the same time**. This is a hard limit.

Features in the same wave run in parallel; waves run one after another. **No two writers share a file.**

There are exactly three sanctioned exceptions, and all of them are safe for the same reason: the file is **partitioned before the wave starts**, and a feature writes only inside the partition it was given. The exception is never "this file is shared" — it is "this file has disjoint parts, and one of them is yours".

- **`CASE-STUDY.md`** — every feature appends entries to it. The partition is a reserved range of decision numbers, handed out before the writer starts; §6 sets the ranges out and `test/decision-log.test.ts` enforces them.
- **`DOCUMENTATION.md`** — every feature documents itself in it, because item 3 of the definition of done below requires it. The partition is the chapter: **a feature owns the `##` chapter named for it — one for every feature of the wave — and appends nowhere else in the file.** The chapter, its position and its `## Contents` line are created as empty stubs before the wave starts, so no writer inserts a heading and no two writers ever touch the same region.
- **`README.md`** — item 4 of the definition of done points every feature at it whenever the outside picture changes, and wave 4 changes that picture three times. The partition is the `###` region under **What works today** named for what the feature builds, cut before the wave like a chapter. A feature rewrites its own region and nothing else in the file; the sentence above the regions that says what works end to end belongs to no feature, so a change to it is reported rather than made.

A feature that needs a change in another feature's chapter, or in a chapter no feature owns, stops and reports it — exactly as it would for any other file it does not own.

**`## Contents` belongs to the stub cut, not to any feature.** A chapter and its index line are created together, before the wave, and that is the only moment either changes — so no feature ever needs a line in the index, and the index cannot fall behind the headings without the pre-wave pass having skipped one.

The set of files a feature may touch is fixed before it starts and is binding. A feature that needs a change outside its area stops and reports it instead of editing the file.

### Definition of done

A feature is finished when **all six** hold:

1. The code is in the worktree, built, type-checked, linted.
2. The reviewer's tests pass, and every assigned `S-…` requirement has at least one test meeting the threshold fixed in architecture section 6.
3. `DOCUMENTATION.md` covers every new function, parameter and configuration.
4. `README.md` is updated if the outside picture changed.
5. `CASE-STUDY.md` records the decisions actually taken while building.
6. The main gate has approved.

### The main gate

Runs before every merge into `main` and blocks it on any finding. It does not repair anything itself.

- `pnpm build` without errors **and without warnings**
- `pnpm typecheck` under `strict`, no `any` in the public surface type
- `pnpm lint` without findings, formatting applied
- `pnpm check:reviewable` — no NUL byte hides a file from review or from the scan
- `pnpm check:session-owner` — no session owner reassigned in SQL (S-FIX-2, E-23), and a tree or a build it could not read refused in words that are not a security finding, a partial build included
- `pnpm check:lock-order` — every row lock is `FOR NO KEY UPDATE`, declares `velve.user`, and is written in `src/core/db/lock.ts`; the order two transactions take their locks in is decided by `test/lock-order-race.test.ts` and not here
- `pnpm check:token-after-lock` — no transaction takes the account row and then reaches `velve.one_time_token`, which is the second ordering §7 states and nothing decided until now (E-1616)
- `pnpm check:egress` — nothing in `src/` reaches the network or names an external host outside the one provider seam and the one file that enumerates the providers, which is what `README.md` has always promised (E-1844)
- `pnpm check:decision-refs` — every `S-…` and `E-…` a comment in `src/` cites is defined in the specification or the decision log
- `pnpm check:sql-collapse` — no line comment swallows the rest of its statement
- `pnpm check:log-append` — the decision log deletes no line it had at the merge base, and the branch has added at least one (§6, E-538)
- `pnpm check:skill-version` — a skill file changed against the merge base raises the version it states, and both skill files state the same one (§6)
- `pnpm check:codex-skill` — `CODEX-SKILL.md` is byte-identical to what `CLAUDE-SKILL.md` produces, so it is generated and not written (§6)
- `pnpm check:attribution` — §4 over the tracked tree, the branch's commit messages and the branch's diff, searched with the patterns `ci.yml`'s own job states rather than with a second copy of them (E-1439)
- `pnpm knip` — no dead code, no unused export
- `pnpm test` green, no skipped test without a reason stated in the code
- `pnpm publint` — the package's exports resolve as published
- `pnpm attw` — the types resolve under every module mode the package claims
- `README.md`, `DOCUMENTATION.md` and `CASE-STUDY.md` extended for the feature
- no AI attribution anywhere in the diff or the branch's commit history
- the shipped type declarations have not changed unrecorded — `test/api-surface.test.ts` compares every `dist/**/*.d.mts` against a committed copy.

A check must be able to tell **found nothing** from **found a fault**. When you add a check, prove it fails on a planted fault before you trust it passing.

## 6. Documentation duty

Documentation is written **while** building, never afterwards. A feature whose documentation is "to be written" is not finished.

- **`README.md`** — what it is, why it exists, how to install it, what it does, and what it deliberately does not do.
- **`DOCUMENTATION.md`** — every function, every parameter, every configuration option, every schema table. The reference.
- **`CASE-STUDY.md`** — grows with the build. Every design decision with its reason, every rejected alternative, every problem and its solution, in the entry format fixed below.
- **`CLAUDE-SKILL.md`**, and `CODEX-SKILL.md` generated from it — kept current in its **method**, and never in its content.

`CASE-STUDY.md` has one rule that matters more than the others: **no retroactive rationalisation.** If a decision was made for a bad reason and turned out right, the bad reason is what gets written down.

Five further markdown files exist in the repository root, two of them the skill's, and this is the complete list:

- **`CLAUDE.md`** — this file.
- **`VELVE-AUTH-ARCHITEKTUR.md`** — the binding specification, German.
- **`VELVE-AUTH-ARCHITECTURE.md`** — a translation of it into English. Faithful and **not binding**; where the two differ the German is right and the translation has a bug.
- **`CLAUDE-SKILL.md`** — the `velve-auth` agent skill: instructions that make a coding agent read this repository live before answering, refuse what §2 refuses, and say so rather than approximating.
- **`CODEX-SKILL.md`** — the same instructions for an agent that takes one file. It is **produced from `CLAUDE-SKILL.md` rather than written**, because the two carried different rules once and the one shipping without skill machinery was the weaker. Regenerate with `node tools/check-codex-skill.mjs --write` — never by editing the file.

Do not create any markdown file in the repository root outside that list. No summary files, no progress reports, no `NOTES.md`. Markdown that belongs to something else — a test snapshot under `test/__snapshots__/`, for instance — is not a document and is not covered by this rule.

### Keeping the skill current is the opposite of keeping the documentation current

The documentation is kept current **by describing the features**. The skill is kept current **by continuing to describe none of them.**

**Adding a feature of the library to the skill is a defect, not an omission being repaired.**

**A fact about the agent's own runtime is a different case, and it is permitted.** So a runtime fact is stated — the minimum installation needs, and no more — and **stated from the tool's documentation, never from inference.**

**Every change to a skill file raises its version. Always.** A typo, a reworded sentence, a fixed link — each of them. `pnpm check:skill-version` enforces it against the merge base.

**The unit is the change that merges, not the commit.** A version raised without a change is **not** a fault and the check permits one.

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

- The **heading** carries the title, and nothing else. It is a sentence a reader can scan, not a number.
- The **subordinate line** carries three fields separated by ` · `: the ID in backticks, the feature that owns the number, and a short tag saying what kind of decision it is and whether it is still open — `storage format, frozen`, `revisit after wave 3`.
- All four parts are required, in that order, each opening its own paragraph: `**Context.**`, `**Rejected.**`, `**Reason.**`, `**Price.**`. An entry with nothing rejected still writes `**Rejected.**` and says so.

Until the migration in §1 has run, the file also holds the old German form — `**E-nn — Entscheidung.**` followed by `*Kontext:*`, `*Verworfen:*`, `*Grund:*`, `*Preis:*`. `test/decision-log.test.ts` accepts both, and only both. A heading that is neither is a fault, not an entry, and the test says so rather than skipping it.

### Translating an entry

A translation carries the original argument across unchanged. It may not:

- strengthen a reason, add evidence the original did not have, or supply a justification the writer did not give;
- soften a price, round a measured number, or drop a consequence because it reads badly;
- tidy a false start, a wrong assumption or an admitted mistake out of a context, or reorder the entry so the decision looks more inevitable than it was.

**A translated entry that reads better than the original is a defect.** If the German was confused, the English is confused in the same places. Where the original is genuinely unclear, the translation stays unclear and the entry is reported — it is not repaired in passing, because repairing it invents a reason nobody had.

New information about an old decision belongs in a new entry that cites the old one, never in the old entry's text.

### Correcting an entry before it merges

**On your own branch, before merge, a measurement may be restated in place; a reason may not. An entry that existed at the merge base is never edited.**

**A measurement is a number or a count the entry states about the work** — `ten of thirteen cases`, `six plants`, `40 of 60`. Everything else in an entry is a reason, including a statement about what the specification says, which is checkable but is not a measurement.

A reason that was **wrong when it was written** is corrected by a new entry citing the old one, and never by an edit to the old one's text — disclosed or not.

An entry that was correct when written and was made stale by the branch's **own later change to the thing the entry describes** may be brought into step in place, with the change disclosed in the entry. So the line is: **an entry may be brought into step with its own artefact; the reason a decision was taken may not be rewritten.**

**So insert a complete note between standing sentences. Never edit inside a standing sentence, and never hide the original from rendering.**

What a script can read is the second sentence, and `pnpm check:log-append` reads it: `git diff <merge-base>...HEAD --numstat -- CASE-STUDY.md` must report zero deletions. The **three-dot** form is the form. Run `pnpm check:log-append` on the merge commit itself, before committing anything on top of it — or do not lean on it and read `pnpm test`'s decision-log failure instead.

### Numbering the decision log

**Each feature is given a reserved range of decision numbers when its wave starts, and it uses only that range.** Two features never reach for the same number, so no branch ever has to renumber, and the merge order does not matter.

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
| E-320 … E-379 | wave 3 · `auth-core` |
| E-380 … E-404 | wave 3 · `rate` |
| E-405 … E-449 | wave 3 · `factor-totp`, which owns recovery codes as well as TOTP |
| E-450 … E-494 | wave 3 · `factor-webauthn` |
| E-495 … E-514 | gate and infrastructure, second range |
| E-515 … E-539 | gate and infrastructure, third range |
| E-540 … E-594 | wave 5 · `oauth` |
| E-595 … E-634 | wave 5 · `email-flows` |
| E-635 … E-669 | wave 5 · `plugin` |
| E-670 … E-699 | wave 6 · `client` |
| E-700 … E-734 | gate and infrastructure, fourth range |
| E-735 … E-794 | wave 4 · `spine` |
| E-795 … E-819 | gate and infrastructure, fifth range |
| E-820 … E-844 | outside the waves · `skill` — the English specification and the agent skill |
| E-845 … E-869 | outside the waves · `specfix` — the specification's own defects |
| E-870 … E-879 | outside the waves · `notice` — the attribution line and the licence appendix |
| E-880 … E-899 | outside the waves · `skillver` — the skill's version and its staleness |
| E-930 … E-959 | wave 5 · `email-flows`, second range |
| E-960 … E-979 | wave 5 · `oauth`, second range |
| E-980 … E-999 | wave 5 · `oauth`, third range |
| E-1030 … E-1059 | wave 5 · `email-flows`, third range |
| E-1095 … E-1129 | outside the waves · `specfix`, second range |
| E-1130 … E-1149 | outside the waves · `rules` — the rules file's own defects |
| E-1060 … E-1094 | gate and infrastructure, sixth range |
| E-1150 … E-1179 | outside the waves · `rules`, second range |
| E-1180 … E-1239 | wave 6 · `signin-routes` — the password and second-factor rows of 3.15 D.3 |
| E-1240 … E-1284 | wave 6 · `factor-routes` — the seventeen rows of 3.15 D.3 that no source declares |
| E-900 … E-929 | wave 5 · `plugin`, second range |
| E-1000 … E-1029 | wave 5 · `plugin`, third range |
| E-1285 … E-1329 | outside the waves · `requirement-coverage` — the requirements no test cites |
| E-1330 … E-1369 | outside the waves · `open-requirements` — the two requirements the coverage audit reported as unbuilt |
| E-1370 … E-1409 | gate and infrastructure, seventh range — the two blind spots E-1341 and E-1344 report |
| E-1410 … E-1439 | gate and infrastructure, eighth range — the release workflow and the first published version; eighth on the merge order E-1428 fixes, where the branch reserving E-1370 … E-1409 lands first |
| E-1440 … E-1459 | gate and infrastructure, ninth range — the release workflow's second range, its first block having run out at thirty of thirty |
| E-1460 … E-1499 | gate and infrastructure, tenth range — the four hand-offs E-1446 lists |
| E-1570 … E-1599 | outside the waves · `session-interval` — the interval literal PostgreSQL 14 refuses. The start is counted rather than continued: the highest row of this table at 5e033d9 ends at E-1459, and E-1460 … E-1569 are reserved on branches that have not merged, so this table cannot show them. Two of the three were read from their branches — E-1460 … E-1499 on feature/queued-handoffs and E-1500 … E-1529 on ci/postgres-14. The third, E-1530 … E-1569, is taken from the brief that opened this branch and was found on no ref this repository holds |
| E-1500 … E-1529 | gate and infrastructure, eleventh range — the PostgreSQL 14 tier; eleventh over the eleven rows of this table that name gate and infrastructure, counted after the merge that brought the tenth in. This row first said the tenth was on an unmerged branch and absent from the table, which was true when it was written |
| E-1530 … E-1569 | outside the waves · `timing-power-guard` — the power guard on the two statistical timing cases, E-1149 and E-693 |
| E-1600 … E-1649 | outside the waves · `lock-order` — the two deadlock cycles reachable on `main`. Fifty-first row of this table, counted after merging 93fa31b, which brought in the row above it. It was the fiftieth when written, over the forty-nine standing at a9b0aec; the range that was then reserved on a branch this table could not show is that row now, and the count is of rows rather than of reservations either way |
| E-1650 … E-1689 | outside the waves · `misreporting` — the three instruments that report something other than what they found. Fifty-second row of this table, counted over the fifty-one standing at b005ed3 rather than taken from the row above it; E-1622 records an ordinal here going stale the moment another branch merges a row, and nothing in the tree recomputes one |
| E-1690 … E-1739 | outside the waves · `second-factor` — the three second-factor defects an audit ranked before a stable release. Fifty-third row of this table, counted over the fifty-two standing at f1e9654 rather than taken from the row above it, for the reason that row gives |
| E-1740 … E-1769 | outside the waves · `factor-startup` — the four residues `second-factor` reported and could not touch, all of them in files §5 put outside its set. Fifty-fourth row of this table, counted over the fifty-three standing at 8cebfdd rather than taken from the row above it, for the reason that row gives |
| E-1770 … E-1799 | gate and infrastructure, twelfth range — the first publish of the package, and the latest tag npm gave it anyway. Twelfth over the eleven rows of this table that named gate and infrastructure at 0a938ef; fifty-fifth row overall, counted over the fifty-four standing there rather than taken from the row above it |
| E-1800 … E-1839 | gate and infrastructure, thirteenth range — the stable 1.0.0, and the dist-tag that had been written down rather than derived. Thirteenth over the twelve rows of this table that named gate and infrastructure at 846e72a; fifty-sixth row overall, counted over the fifty-five standing there rather than taken from the row above it |
| E-1840 … E-1879 | outside the waves · `dependency-audit` — the six core dependencies held against the advisory database, the unmaintained test-runner major, and the egress promise nothing enforced. Fifty-seventh row overall, counted over the fifty-six standing at eb4d4ac |
| E-1880 … E-1899 | gate and infrastructure, fourteenth range — the release expression that evaluated to nothing. Fifty-eighth row overall, counted over the fifty-seven standing at dd5c938 |
| E-1900 … E-1939 | outside the waves · `oauth-signup` — the identifier a provider cannot supply, and the acceptance against a real provider. Fifty-ninth row overall, counted over the fifty-eight standing at f4dae39. The start is counted past the fourteenth gate range rather than continued from the highest entry written: E-1885 was reserved first and overlapped it, which `test/decision-log.test.ts` refused |
| E-1940 … E-1969 | outside the waves · `reviewable-source` — the comments in `src/` rewritten as one plain sentence ending in at most one cited identifier. Sixtieth row overall, counted over the fifty-nine standing at 0b50fb0 |

The next wave's ranges are added to that table before its features start, continuing above the highest number already reserved. A range is assigned before the feature's writer starts and is not changed afterwards. A feature that runs out asks for a second range rather than borrowing from a neighbour.

A second range is a **new row**, added at the bottom like any other and marked `second range`. It never widens or replaces the feature's first row, and the two rows are not an overlap — they are two disjoint blocks owned by the same feature, which is exactly what the rule above prescribes. Numbering inside the second range continues from its own start; the gap left at the end of the first range stays a gap.

`test/decision-log.test.ts` reads that table. Every entry in `CASE-STUDY.md` must fall inside a declared range, and two ranges may not overlap — so a feature quietly taking a number it does not own fails on its own branch rather than at the merge, and a bad assignment fails at wave start while it is still free.

## 7. Technical constraints

These follow from architecture section 2 and are not open for local decision:

- Pure TypeScript. **No WASM on the required path.** `hash-wasm` is an optional peer dependency and an accelerator only.
- ESM only. No CommonJS build. `dist/*.mjs` and `dist/*.d.mts`, nothing else.
- No `postinstall`, no `node-gyp`, no native binding, no downloader.
- Not used anywhere on the required path: `node:fs`, `node:wasi`, `node:worker_threads`, `node:child_process`. The library assumes Web standards — `globalThis.crypto` with `subtle` and `getRandomValues`, and `fetch`.
- PostgreSQL 14 or newer. Hand-written SQL, no query builder, no ORM. The driver is a parameter, never an import.
- Keys come from a `KeyProvider`, never from `process.env` inside the core.
- **`velve.user` is locked first, `FOR NO KEY UPDATE`, and a lock declares what it locks.** A transaction that writes rows in more than one user-owned table takes `SELECT 1 FROM ${schema}.user WHERE id = $1 FOR NO KEY UPDATE /* locks: ${schema}.user */` as its first statement, and reaches it through `src/core/db/lock.ts` — the only file that writes a row lock, so the mode cannot vary between call sites.
- **The mode is not a local choice.** `FOR NO KEY UPDATE` is the strongest strength that does **not** conflict with the `FOR KEY SHARE` a foreign key takes on `velve.user` for every insert of a user-owned row. So `FOR UPDATE` and `FOR SHARE` are used nowhere, and `pnpm check:lock-order` refuses both.
- **The ordering rule reaches explicit locks only, and one exception is deliberate.** A redemption learns which account it is acting for by consuming a row of `one_time_token`, `pending_authentication`, `oauth_flow` or `webauthn_challenge`, so it cannot lock the account row before that row. Those four come first; everything else comes after `velve.user`. **Do not read this section as a guarantee that the tree holds no cycle.**
- **A second ordering holds and nothing checks it.** Four redeem flows consume a `one_time_token` row *before* they reach `lockAccountRow`, so for them the account lock is not the transaction's first statement — `velve.one_time_token` is written first. What keeps that safe is that `one_time_token` is ordered **before** `velve.user` everywhere: every mint runs in a transaction of its own and every redemption runs first, and no transaction that takes the account row touches that table at all.
- Core dependencies are exactly these six: `@noble/hashes`, `@noble/ciphers`, `bcryptjs`, `otpauth`, `@simplewebauthn/server`, `jose`. Adding a seventh is a decision for `CASE-STUDY.md`, not a routine change.

## 8. Secrets

- Never read, open, print or search `.env`, `.env.local`, `.env.production` or any secrets file.
- Never write a secret value into code, a test fixture, a commit or a log line.
- A missing variable gets its **key** added to `.env.example` and is reported. Do not invent a value.
- Test keys are generated by the test setup, never committed.

## 9. Commands

```
pnpm build                    tsdown — ESM + .d.mts
pnpm typecheck                tsc --noEmit, strict
pnpm lint                     biome check, warnings included
pnpm format                   biome check --write — applies everything lint verifies
pnpm test                     vitest run — the blocking tier
pnpm test:nightly             vitest run with VELVE_NIGHTLY=1 — adds the statistical and high-repetition cases section 6 puts on a nightly schedule
pnpm test:release             vitest run over the release project — the cases section 6 puts before every release; a version tag runs it
pnpm knip                     dead code and unused exports
pnpm check:session-owner      S-FIX-2: no session owner reassigned in SQL.
pnpm check:lock-order         every row lock is FOR NO KEY UPDATE, declares velve.user and is written in src/core/db/lock.ts.
pnpm check:token-after-lock   velve.one_time_token is ordered before velve.user, so no transaction takes the account row and then reaches that table — raw SQL or either repository method, comments and imports stripped first so prose about the rule and a named import are not read as reaching for it.
pnpm check:egress             only src/core/oauth/outbound.ts calls out, through the fetch config.fetch injects, and only src/core/oauth/providers.ts names a provider host; src/client/transport.ts calls the application's own routes and is not egress from the operator.
pnpm check:decision-refs      every S- and E- identifier in a comment in src/ is defined: an S- requirement as a list item of VELVE-AUTH-ARCHITECTURE.md, an E- decision as an entry of CASE-STUDY.md or docs/decisions/log.md.
pnpm check:reviewable         no NUL byte hides a file from review
pnpm check:sql-collapse       every SQL statement still says what it said once its newlines are normalised away — a marker is a block comment, never a line comment
pnpm check:log-append         no line CASE-STUDY.md had at the merge base is deleted or rewritten, and the branch has added at least one.
pnpm check:skill-version      a skill file that changed since the merge base states a higher version than it did there, and both skill files state the same version line.
pnpm check:codex-skill        CODEX-SKILL.md is byte-identical to what tools/codex-skill.mjs produces from CLAUDE-SKILL.md.
pnpm check:attribution        §4 over three surfaces and in four scans: the tracked tree for markers and for authorship claims, the commit messages of the range against origin/main, and that range's diff.
pnpm check:release-tag        the tag a release is cut from names the version package.json states, that version is a semantic one, and a prerelease is not about to be published under latest.
pnpm run release-dist-tag     prints the dist-tag the version in package.json is published under: latest for a stable version, next for a prerelease.
pnpm check:published-version  the registry resolves the version package.json states, the dist-tag points at that version, latest does not point at any prerelease, and it carries a provenance attestation.
pnpm publint                  package export correctness
pnpm attw                     type resolution across module modes
pnpm gate                     everything above, in the order the main gate runs it
```
