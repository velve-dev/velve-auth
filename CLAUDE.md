# CLAUDE.md — velve-auth

The explanations, measurements and histories behind these rules are in
`docs/working-method.md`.

Rules for every agent and every human working in this repository. They are not
advice. A change that violates them does not get merged.

The binding specification is `VELVE-AUTH-ARCHITEKTUR.md` in the repository root.
It is written in German and it is the source of truth for the schema, the public
interface, the security requirements `S-<class>-<n>`, the test cases
`T-<class>-<n>`, the decided gaps `L-1` to `L-13` and the decision log `E-01` to
`E-46`. Where this file and the architecture disagree, the architecture wins —
and the disagreement is a bug in this file that must be fixed before continuing.

`VELVE-AUTH-ARCHITECTURE.md` is an English translation of it, and is **not** a
second source of truth. Read whichever you prefer; decide from the German. Where
they differ on a number, an identifier, a threshold or a requirement, the German
is right and the translation has a bug to be fixed — never the other way round.

## 1. Language

**Everything in this repository is written in English.** Source code,
identifiers, commit messages, pull requests, `README.md`, `DOCUMENTATION.md`,
`CASE-STUDY.md`, inline text and error codes. There is no exception, and
`docs/decisions/log.md` — which used to be one — is explicitly not one.

`docs/decisions/log.md` was German until this rule changed. It is being migrated to
English in a single central pass, so that the migration does not collide with
the feature branches appending to it.

**The central pass is this one change, carried by one branch, and nothing else
(E-2990).** It translates the 167 German entries — E-01 … E-71, E-80 … E-101,
E-110 … E-131, E-140 … E-148, E-190 … E-212 and E-250 … E-269 — together with
the file's German header and its German section headings. It is the single
sanctioned exception to *an entry that existed at the merge base is never
edited* (§6), and §6 fixes the shape a translated entry takes and the rules its
text obeys. Until that pass has merged the file holds both languages, and a
German entry still in it is outstanding work, not a permitted exception. Once it
has merged, no German entry, no German heading and no German form remains, and
no entry written from now on may be German.

That pass rewrites the file's own header too.

The decision log continues architecture section 7, and section 7 is German. A
continued entry is **translated, not quoted**, and `CASE-STUDY.md` quotes
section 7 from its English translation (E-1970).

The rule that is decided once and does not get revisited is this one — English
everywhere, `docs/decisions/log.md` included.

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
- A comment is `//` with no space, lower case, one sentence in plain words, no
  full stop. The sentence says what must hold and is understandable without the
  bracket. At the end, in parentheses, comes exactly one identifier, `S-` for a
  security requirement or `E-` for a decision, and only where the code is the
  way it is because of it. No dash, no colon, no "because", no "so that". A
  sentence longer than one line is a log entry, not a comment.

  ```
  //changing a password needs to make all sessions invalid (S-FIX-6)
  //revoking a session that isnt yours must look the same as a missing one (E-233)
  //freshness check uses the db time not the server time (E-238)
  //refresh only extends the idle timeout
  ```

- Comments are permitted only where the reason for the code cannot be expressed
  in code: a specification clause being satisfied, a deliberate deviation from a
  standard, a non-obvious ordering constraint. Then **one sentence**, no more.
- Doc comments on exported symbols stay doc comments of one plain sentence
  without an identifier, because a user reads them in the editor (E-1943). `pnpm
  check:decision-refs` fails on an identifier no document defines.
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
- Commit subjects are Conventional Commits with a scope — `fix(oauth): …`,
  `refactor(session): …` — and the sentence that used to be the subject goes in
  the body; history is not rewritten.
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
branch, with a full-text search over the tree, and with one over the branch
diff. A single hit blocks the merge.

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
writers share a file.**

There are exactly two sanctioned exceptions, and both of them are safe for the
same reason: the file is **partitioned before the wave starts**, and a feature
writes only inside the partition it was given. The exception is never "this file
is shared" — it is "this file has disjoint parts, and one of them is yours".

- **`docs/decisions/log.md`** — every feature appends entries to it. The partition is a
  reserved range of decision numbers, handed out before the writer starts; §6
  sets the ranges out and `test/decision-log.test.ts` enforces them.
- **`DOCUMENTATION.md`** — every feature documents itself in it, because item 3
  of the definition of done below requires it. The partition is the chapter:
  **a feature owns the `##` chapter named for it — one for every feature of the
  wave — and appends nowhere else in the file.** The chapter, its position and
  its `## Contents` line are created as empty stubs before the wave starts, so
  no writer inserts a heading and no two writers ever touch the same region.

`README.md` is not partitioned. It describes the library as a whole, so a
feature that changes the outside picture reports the README change rather than
making it (E-2090).

A feature that needs a change in another feature's chapter, or in a chapter no
feature owns, stops and reports it — exactly as it would for any other file it
does not own.

**`## Contents` belongs to the stub cut, not to any feature.** A chapter and its
index line are created together, before the wave, and that is the only moment
either changes — so no feature ever needs a line in the index, and the index
cannot fall behind the headings without the pre-wave pass having skipped one.

The set of files a feature may touch is fixed before it starts and is binding. A
feature that needs a change outside its area stops and reports it instead of
editing the file.

### Definition of done

A feature is finished when **all six** hold:

1. The code is in the worktree, built, type-checked, linted.
2. The reviewer's tests pass, and every assigned `S-…` requirement has at least
   one test meeting the threshold fixed in architecture section 6.
3. `DOCUMENTATION.md` covers every new function, parameter and configuration.
4. `README.md` is updated if the outside picture changed.
5. `docs/decisions/log.md` records the decisions actually taken while building.
6. The main gate has approved.

### The main gate

Runs before every merge into `main` and blocks it on any finding. It does not
repair anything itself.

- `pnpm build` without errors **and without warnings**
- `pnpm typecheck` under `strict`, no `any` in the public surface type
- `pnpm lint` without findings, formatting applied
- `pnpm check:reviewable` — no NUL byte hides a file from review or from the scan
- `pnpm check:session-owner` — no session owner reassigned in SQL (S-FIX-2, E-23),
  and a tree or a build it could not read refused in words that are not a security
  finding, a partial build included
- `pnpm check:lock-order` — every row lock is `FOR NO KEY UPDATE`, declares
  `velve.user`, and is written in `src/core/db/lock.ts`; the order two transactions take
  their locks in is decided by `test/lock-order-race.test.ts` and not here
- `pnpm check:token-after-lock` — no transaction takes the account row and then
  reaches `velve.one_time_token`, which is the second ordering §7 states and
  nothing decided until now (E-1616)
- `pnpm check:egress` — nothing in `src/` reaches the network or names an
  external host outside the one provider seam and the one file that enumerates
  the providers, which is what `README.md` has always promised (E-1844)
- `pnpm check:decision-refs` — every `S-…` and `E-…` a comment in `src/`
  cites is defined in the specification or the decision log
- `pnpm check:sql-collapse` — no line comment swallows the rest of its statement
- `pnpm check:log-append` — the decision log deletes no line it had at the merge
  base except a German entry, header or section heading the central translation
  pass replaced, and the branch has added at least one (§6, E-538, E-2991)
- `pnpm check:skill-version` — a skill file changed against the merge base raises
  the version it states, and both skill files state the same one (§6)
- `pnpm check:codex-skill` — `CODEX-SKILL.md` is byte-identical to what
  `CLAUDE-SKILL.md` produces, so it is generated and not written (§6)
- `pnpm check:attribution` — §4 over the tracked tree, the branch's commit
  messages and the branch's diff, searched with the patterns `ci.yml`'s own
  job states rather than with a second copy of them (E-1439)
- `pnpm knip` — no dead code, no unused export
- `pnpm test` green, no skipped test without a reason stated in the code
- `pnpm publint` — the package's exports resolve as published
- `pnpm attw` — the types resolve under every module mode the package claims
- `DOCUMENTATION.md` and `docs/decisions/log.md` extended for the feature, and
  `README.md` where the outside picture changed
- no AI attribution anywhere in the diff or the branch's commit history
- the shipped type declarations have not changed unrecorded —
  `test/api-surface.test.ts` compares every `dist/**/*.d.mts` against a
  committed copy.

A check must be able to tell **found nothing** from **found a fault**. When you
add a check, prove it fails on a planted fault before you trust it passing.

## 6. Documentation duty

Documentation is written **while** building, never afterwards. A feature whose
documentation is "to be written" is not finished.

- **`README.md`** — what it is, why it exists, how to install it, what it does,
  and what it deliberately does not do.
- **`DOCUMENTATION.md`** — every function, every parameter, every configuration
  option, every schema table. The reference.
- **`docs/decisions/log.md`** — grows with the build. Every design decision with its
  reason, every rejected alternative, every problem and its solution, in the
  entry format fixed below.
- **`CASE-STUDY.md`** — a curated selection of `docs/decisions/log.md` for a
  first reader. Its entries are copied from the log, and nothing is appended to the
  selection.
- **`CLAUDE-SKILL.md`**, and `CODEX-SKILL.md` generated from it — kept current
  in its **method**, and never in its content.

`docs/decisions/log.md` has one rule that matters more than the others: **no retroactive
rationalisation.** If a decision was made for a bad reason and turned out right,
the bad reason is what gets written down.

Five further markdown files exist in the repository root, two of them the skill's,
and this is the complete list:

- **`CLAUDE.md`** — this file.
- **`VELVE-AUTH-ARCHITEKTUR.md`** — the binding specification, German.
- **`VELVE-AUTH-ARCHITECTURE.md`** — a translation of it into English. Faithful
  and **not binding**; where the two differ the German is right and the
  translation has a bug.
- **`CLAUDE-SKILL.md`** — the `velve-auth` agent skill: instructions that make a
  coding agent read this repository live before answering, refuse what §2 refuses,
  and say so rather than approximating.
- **`CODEX-SKILL.md`** — the same instructions for an agent that takes one file.
  It is **produced from `CLAUDE-SKILL.md` rather than written**, because the two
  carried different rules once and the one shipping without skill machinery was
  the weaker. Regenerate with `node tools/check-codex-skill.mjs --write` — never
  by editing the file.

Do not create any markdown file in the repository root outside that list. No summary
files, no progress reports, no `NOTES.md`. Markdown that belongs to something else —
a test snapshot under `test/__snapshots__/`, for instance — is not a document and is
not covered by this rule.

### Keeping the skill current is the opposite of keeping the documentation current

The documentation is kept current **by describing the features**. The skill is kept
current **by continuing to describe none of them.**

**Adding a feature of the library to the skill is a defect, not an omission
being repaired.**

**A fact about the agent's own runtime is a different case, and it is
permitted.** So a runtime fact is stated — the minimum installation needs, and
no more — and **stated from the tool's documentation, never from inference.**

**Every change to a skill file raises its version. Always.** A typo, a reworded
sentence, a fixed link — each of them. `pnpm check:skill-version` enforces it
against the merge base.

**The unit is the change that merges, not the commit.** A version raised without
a change is **not** a fault and the check permits one.

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

The central pass of §1 gives each German entry exactly this shape:

```
<a id="e-01"></a>

### <the German bold decision sentence, translated, without the trailing full stop>
`E-01` · architecture · translated from the German original

**Context.** …
**Rejected.** …
**Reason.** …
**Price.** …
```

- The anchor stays exactly as it was.
- `*Kontext:*` becomes `**Context.**`, `*Verworfen:*` becomes `**Rejected.**`,
  `*Grund:*` becomes `**Reason.**` and `*Preis:*` becomes `**Price.**`. Any
  other italic field label the German used is translated in place, in the same
  position.
- The owner is the one the range table below gives the number, and is never
  chosen: E-01 … E-46 `architecture`, E-47 … E-58 `scaffold`, E-59 … E-71
  `keys`, E-80 … E-101 `db`, E-110 … E-131 `http`, E-140 … E-148 `gate and
  infrastructure`, E-190 … E-212 `identity`, E-250 … E-269 `token`.
- The tag is always `translated from the German original`. It says where the
  text came from and supplies no reason the writer did not give, and no entry
  outside the pass carries it.
- E-01 … E-46 are taken verbatim from section 7 of `VELVE-AUTH-ARCHITECTURE.md`,
  the existing translation, and are only reshaped into this format, not
  translated a second time (E-1970).
- *Translating an entry* below applies to the pass in full: the translation is
  faithful, and a translated entry that reads better than the original is a
  defect.

Once the pass has merged, no entry in the old German form remains —
`**E-nn — Entscheidung.**` followed by `*Kontext:*`, `*Verworfen:*`, `*Grund:*`,
`*Preis:*` — and `test/decision-log.test.ts` accepts the English form only. It
still recognises the German one, but only to name an entry left in it as a
fault. A heading that is neither is a fault, not an entry, and the test says so
rather than skipping it.

### Translating an entry

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

### Correcting an entry before it merges

**On your own branch, before merge, a measurement may be restated in place; a
reason may not. An entry that existed at the merge base is never edited.**

**The central pass of §1 is the single exception, and it is sanctioned once.**
It replaces each German entry, the German file header and the German section
headings with their translation in the shape *The entry format* fixes, and does
nothing else: it edits no English entry, restates no measurement and corrects no
reason. A fault the translator finds in an original is reported in a new entry
and not repaired in the translation.

**A measurement is a number or a count the entry states about the work** — `ten
of thirteen cases`, `six plants`, `40 of 60`. Everything else in an entry is a
reason, including a statement about what the specification says, which is
checkable but is not a measurement.

A reason that was **wrong when it was written** is corrected by a new entry
citing the old one, and never by an edit to the old one's text — disclosed or
not.

An entry that was correct when written and was made stale by the branch's **own
later change to the thing the entry describes** may be brought into step in
place, with the change disclosed in the entry. So the line is: **an entry may be
brought into step with its own artefact; the reason a decision was taken may not
be rewritten.**

**So insert a complete note between standing sentences. Never edit inside a
standing sentence, and never hide the original from rendering.** That is the rule
itself rather than a consequence of one, so it holds whatever a diff says: leave
every original **sentence** standing verbatim and rendering, put the note inside
the entry it corrects at a boundary between finished sentences, and say in the
note what changed. Sentence, not word — a rule that asks only for the words to
survive is satisfied by inserting `not ` into one of them, which is the
counterexample this whole subsection was rewritten around (E-1147).

**All of that governs argument-bearing text.** A **measurement** restated in place
is the one edit that needs none of it: the opening of this subsection permits it
outright, and the paragraph defining a measurement above makes that partition
exhaustive — a number or a count the entry states about the work is a measurement,
and *everything else in an entry is a reason*. So the property and the imperative
are about reasons, which is what they were always for, and saying so here sharpens
the boundary rather than carving an exception into it. Without this clause the two
paragraphs contradict each other for the ordinary case of a number sitting inside
a sentence, and a reader reconciles them by picking whichever half suits them
(E-1150).

What a script can read is the second sentence, and `pnpm check:log-append` reads
it: `git diff <merge-base>...HEAD --numstat -- docs/decisions/log.md` must report zero
deletions, apart from the lines the central pass replaces. A deleted line is
excused only when, at the merge base, it belongs to a German-form entry whose
anchor HEAD carries directly over an English entry of the same number tagged
`translated from the German original`, or to the German file header or a German
section heading; every other deletion still fails. The **three-dot** form is the form. Run `pnpm check:log-append` on
the merge commit itself, before committing anything on top of it — or do not
lean on it and read `pnpm test`'s decision-log failure instead.

### Numbering the decision log

**Each feature is given a reserved range of decision numbers when its wave
starts, and it uses only that range.** Two features never reach for the same
number, so no branch ever has to renumber, and the merge order does not matter.

| Range | Belongs to |
|---|---|
| E-01 … E-46 | `architecture` — the architecture's own log, section 7, never extended here |
| E-47 … E-58 | wave 0 · `scaffold` — the scaffold, the banner and the positioning line |
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
| E-1970 … E-1999 | outside the waves · `case-study-curated` — the case study cut to a selection, and the complete log moved to docs/decisions/log.md. Sixty-first row overall, counted over the sixty standing at 38a032e |
| E-2000 … E-2029 | outside the waves · `rules-only` — the rules file cut to rules, with its explanations moved to docs/working-method.md. Sixty-second row overall, counted over the sixty-one standing at ebada0d |
| E-2030 … E-2059 | outside the waves · `readme` — the README cut to what a first reader needs, the rest moved to DOCUMENTATION.md. Counted over the rows standing at ebada0d |
| E-2060 … E-2089 | outside the waves · `first-look` — the repository read as a stranger meets it on GitHub, and what that reading found. Counted over the rows standing at 14fb00b |
| E-2090 … E-2119 | outside the waves · `open-points` — the rules and the README brought into step with the cut documents, and the hand-offs the clean-up left. Counted over the rows standing at 4a00087 |
| E-2120 … E-2149 | outside the waves · `signin-replaces-session` — a sign-in deletes the session the caller presented (S-FIX-1, S-FIX-3). Reserved together before the requirement-audit fixes start, counted over the rows standing at a2a5545 |
| E-2150 … E-2179 | outside the waves · `rehash-after-response` — the background rehash runs after the answer (S-TIM-5). Reserved together before the requirement-audit fixes start, counted over the rows standing at a2a5545 |
| E-2180 … E-2209 | outside the waves · `recovery-reset-rate` — the recovery-code reset counts per account and before the KDF (S-RATE-7). Reserved together before the requirement-audit fixes start, counted over the rows standing at a2a5545 |
| E-2210 … E-2239 | outside the waves · `weakening-report` — every weakening reported at start, and no route without a rate limit (S-DEFAULT-1, S-DEFAULT-3). Reserved together before the requirement-audit fixes start, counted over the rows standing at a2a5545 |
| E-2240 … E-2269 | outside the waves · `input-and-redirect` — contradictory parameters, plugin redirects, malformed identifiers and the one randomness module (S-OWNER-6, S-REDIR-3, S-RAND-5, S-RAND-6). Reserved together before the requirement-audit fixes start, counted over the rows standing at a2a5545 |
| E-2270 … E-2299 | outside the waves · `tests-tim-fix-enum-replay-rand` — the weak tests the requirement audit found in TIM, FIX, ENUM, REPLAY and RAND. Reserved together before the requirement-audit fixes start, counted over the rows standing at a2a5545 |
| E-2300 … E-2329 | outside the waves · `tests-token-rate-cookie-csrf-cache` — the weak tests the requirement audit found in TOKEN, RATE, COOKIE, CSRF and CACHE. Reserved together before the requirement-audit fixes start, counted over the rows standing at a2a5545 |
| E-2330 … E-2359 | outside the waves · `tests-owner-link-redir-rest` — the weak tests the requirement audit found in OWNER, LINK, REDIR and REST. Reserved together before the requirement-audit fixes start, counted over the rows standing at a2a5545 |
| E-2360 … E-2389 | outside the waves · `tests-key-race-default-dos` — the weak tests the requirement audit found in KEY, RACE, DEFAULT and DOS. Reserved together before the requirement-audit fixes start, counted over the rows standing at a2a5545 |
| E-2390 … E-2419 | outside the waves · `same-origin` — reading routes called from the same origin without an Origin header. Reserved together before the requirement-audit fixes start, counted over the rows standing at a2a5545 |
| E-2420 … E-2449 | outside the waves · `owner-actor` — every repository method that reaches rows by owner takes an actor (S-OWNER-1). Reserved together before the requirement-audit fixes start, counted over the rows standing at a2a5545 |
| E-2450 … E-2479 | outside the waves · `plugin-sql-role` — plugin SQL under a database role without rights on the core tables (S-OWNER-10). Reserved together before the requirement-audit fixes start, counted over the rows standing at a2a5545 |
| E-2480 … E-2519 | outside the waves · `external-gate` — what the external review finds, and its repairs. Reserved together before the requirement-audit fixes start, counted over the rows standing at a2a5545 |
| E-2520 … E-2549 | outside the waves · `release-1-2-0` — the 1.2.0 release. Reserved together before the requirement-audit fixes start, counted over the rows standing at a2a5545 |
| E-2550 … E-2579 | outside the waves · `cookie-name` — session.cookieName honoured as the name the session cookie is written and read under. Reserved together before the follow-ups start, counted over the rows standing at da4e632 |
| E-2580 … E-2609 | outside the waves · `revoke-hook` — beforeSessionRevoke called on every revocation the specification names a reason for. Reserved together before the follow-ups start, counted over the rows standing at da4e632 |
| E-2610 … E-2639 | outside the waves · `dos-memory-bound` — the KDF memory bound stated against the import ceiling. Reserved together before the follow-ups start, counted over the rows standing at da4e632 |
| E-2640 … E-2669 | outside the waves · `plugin-login` — plugin SQL over a connection that logs in as the plugin role. Reserved together before the follow-ups start, counted over the rows standing at da4e632 |
| E-2670 … E-2699 | outside the waves · `rate-defaults` — the new rate-limit defaults, the recommended presets, and weakenings and route alarms made visible without a log sink. Reserved together before the follow-ups start, counted over the rows standing at da4e632 |
| E-2700 … E-2729 | outside the waves · `password-set-race` — two password.set calls on one account at the same time. Reserved together before the 1.2.0 follow-ups start, counted over the rows standing at 623dd53 |
| E-2730 … E-2759 | outside the waves · `specfix`, third range — the revoke reason the S-LINK-4 sweep lacks and the wording of T-CSRF-1. Reserved together before the 1.2.0 follow-ups start, counted over the rows standing at 623dd53 |
| E-2760 … E-2789 | gate and infrastructure, fifteenth range — the publish taken out of the release workflow and run from the maintainer's machine, so no registry credential lives on GitHub. Reserved together before the 1.2.0 follow-ups start, counted over the rows standing at 623dd53 |
| E-2790 … E-2829 | outside the waves · `signin-hooks` — the sign-in and sign-up hooks of 3.11 called on the password, passkey and magic-link paths, not only on OAuth. Reserved together before the 1.2.0 follow-ups on feature/release-1-2-0-followups start, counted over the rows standing at e97434b |
| E-2830 … E-2869 | outside the waves · `server-surface` — the stated server methods held to 3.15 B and to the pipeline 3.11 puts in front of direct server calls. Reserved together before the 1.2.0 follow-ups on feature/release-1-2-0-followups start, counted over the rows standing at e97434b |
| E-2870 … E-2899 | outside the waves · `small-fixes` — the owner predicate of a plugin's revokeSession, the TOTP confirmation race, the unique-violation races, the session and token lifetime bounds, and two weak tests. Reserved together before the 1.2.0 follow-ups on feature/release-1-2-0-followups start, counted over the rows standing at e97434b |
| E-2900 … E-2929 | gate and infrastructure, sixteenth range — the nightly tier that never started its provider, and the reference gaps an audit found in DOCUMENTATION.md. Reserved together before the 1.2.0 follow-ups on feature/release-1-2-0-followups start, counted over the rows standing at e97434b |
| E-2930 … E-2959 | outside the waves · `specfix`, fourth range — the specification defects reported and never repaired. Reserved together before the 1.2.0 follow-ups on feature/release-1-2-0-followups start, counted over the rows standing at e97434b |
| E-2960 … E-2989 | outside the waves · `release-1-2-0`, second range — the 1.2.0 release notes brought into step with the follow-ups. Reserved together before the 1.2.0 follow-ups on feature/release-1-2-0-followups start, counted over the rows standing at e97434b |
| E-2990 … E-3019 | outside the waves · `log-migration` — the German entries of docs/decisions/log.md translated into English in the one central pass §1 promises, and the rule change that pass needs. Reserved together before the owner's three rulings on PR #96 are carried out, counted over the rows standing at 2c66a79 |
| E-3020 … E-3049 | outside the waves · `release-2-0-0` — the release cut as 2.0.0 instead of 1.2.0, the empty subpaths removed and the deprecated lookup dropped. Reserved together before the owner's three rulings on PR #96 are carried out, counted over the rows standing at 2c66a79 |
| E-3050 … E-3079 | outside the waves · `webauthn-counter` — the stored WebAuthn signature counter kept at the highest value seen. Reserved together before the owner's three rulings on PR #96 are carried out, counted over the rows standing at 2c66a79 |
| E-3080 … E-3109 | outside the waves · `security-state` — the database-write attacker: the specification, the state-mac and token-mac key purposes and the velve.security_state table every later security-state branch builds on. Reserved together before the security-state work on feature/security-state-integrity starts, counted over the rows standing at 4be78c6 |
| E-3110 … E-3129 | outside the waves · `security-state-envelopes` — every envelope bound to its owner, its row and its purpose (S-INTEG-1). Reserved together before the security-state work on feature/security-state-integrity starts, counted over the rows standing at 4be78c6 |
| E-3130 … E-3149 | outside the waves · `security-state-tokens` — session, one-time and pending tokens stored with a keyed hash bound to owner and purpose (S-INTEG-9). Reserved together before the security-state work on feature/security-state-integrity starts, counted over the rows standing at 4be78c6 |
| E-3150 … E-3169 | outside the waves · `security-state-seal` — the seal over every sign-in method, its reseal on every change and its verification before use (S-INTEG-2 to S-INTEG-6). Reserved together before the security-state work on feature/security-state-integrity starts, counted over the rows standing at 4be78c6 |
| E-3170 … E-3189 | outside the waves · `security-state-administration` — the maintenance step that seals existing accounts and the administrator reseal (S-INTEG-7, S-INTEG-8). Reserved together before the security-state work on feature/security-state-integrity starts, counted over the rows standing at 4be78c6 |
| E-3190 … E-3219 | outside the waves · `security-state`, second range — the foundation's answers to its second review. Its first range, E-3080 … E-3109, was used up to E-3108 when the second review arrived; counted over the rows standing at 6b8847b. From E-3205 on it also holds the items the branches queued after the second review and, from E-3207, the answers to the third review, which this row did not say until E-3291 |
| E-3220 … E-3249 | outside the waves · `security-state-envelopes`, second range — the bound envelopes' answers to their second review. Counted over the rows standing at 2addb33 |
| E-3250 … E-3279 | outside the waves · `security-state-tokens`, second range — the keyed token hashes' answers to their review. Counted over the rows standing at 2addb33 |
| E-3280 … E-3309 | outside the waves · `security-state`, third range — the foundation's answers to its fourth review. Counted over the rows standing at 87fd8f9 |
| E-3310 … E-3339 | outside the waves · `security-state`, fourth range — the foundation's answers to its sixth review. Counted over the rows standing at b718387 |
| E-3340 … E-3369 | outside the waves · `security-state`, fifth range — the foundation's answers to its seventh review. Counted over the rows standing at 5096503 |
| E-3370 … E-3399 | outside the waves · `security-state`, sixth range — the foundation's answers to its ninth and later reviews. Counted over the rows standing at d377d43 |

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

`test/decision-log.test.ts` reads that table. Every entry in `docs/decisions/log.md` must
fall inside a declared range, and two ranges may not overlap — so a feature
quietly taking a number it does not own fails on its own branch rather than at
the merge, and a bad assignment fails at wave start while it is still free.

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
- **`velve.user` is locked first, `FOR NO KEY UPDATE`, and a lock declares what
  it locks.** A transaction that writes rows in more than one user-owned table
  takes `SELECT 1 FROM ${schema}.user WHERE id = $1 FOR NO KEY UPDATE /* locks:
  ${schema}.user */` as its first statement after the isolation statement
  (E-3310), and reaches it through
  `src/core/db/lock.ts` — the only file that writes a row lock, so the mode
  cannot vary between call sites. Sign-up is the one exception: the account
  row does not exist yet, so it is created rather than locked, and the
  `email_verify` token minted in the same transaction is safe because no other
  transaction can hold the new row.
- **The mode is not a local choice.** `FOR NO KEY UPDATE` is the strongest
  strength that does **not** conflict with the `FOR KEY SHARE` a foreign key
  takes on `velve.user` for every insert of a user-owned row. So `FOR UPDATE`
  and `FOR SHARE` are used nowhere, and `pnpm check:lock-order` refuses both.
- **The ordering rule reaches explicit locks only, and one exception is
  deliberate.** A redemption learns which account it is acting for by consuming
  a row of `one_time_token`, `pending_authentication`, `oauth_flow` or
  `webauthn_challenge`, so it cannot lock the account row before that row. Those
  four come first; everything else comes after `velve.user`. **Do not read this
  section as a guarantee that the tree holds no cycle.**
- **A second ordering holds, and `pnpm check:token-after-lock` checks it within a
  file (E-1616).** Four redeem flows consume a
  `one_time_token` row *before* they reach `lockAccountRow`, so for them the
  account lock is not the transaction's first statement after the isolation
  statement — `velve.one_time_token` is written first. What keeps that safe is that `one_time_token` is ordered
  **before** `velve.user` everywhere: every mint runs in a transaction of its
  own and every redemption runs first, and no transaction that takes the account
  row touches that table at all.
- Core dependencies are exactly these six: `@noble/hashes`, `@noble/ciphers`,
  `bcryptjs`, `otpauth`, `@simplewebauthn/server`, `jose`. Adding a seventh is a
  decision for `docs/decisions/log.md`, not a routine change.

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
pnpm test:release
                 vitest run over the release project — the cases section 6 puts
                 before every release; release-tier.yml runs it on every push to
                 main, and the publish waits for that run on the commit it
                 publishes
pnpm knip        dead code and unused exports
pnpm check:session-owner
                 S-FIX-2: no session owner reassigned in SQL.
pnpm check:lock-order
                 every row lock is FOR NO KEY UPDATE, declares velve.user and is
                 written in src/core/db/lock.ts.
pnpm check:token-after-lock
                 velve.one_time_token is ordered before velve.user, so no
                 transaction takes the account row and then reaches that table —
                 raw SQL, either repository method or the flows' mintArtefact,
                 comments and imports
                 stripped first so prose about the rule and a named import are
                 not read as reaching for it.
pnpm check:egress
                 only src/core/oauth/outbound.ts calls out, through the fetch
                 config.fetch injects, and only src/core/oauth/providers.ts
                 names a provider host; src/client/transport.ts calls the
                 application's own routes and is not egress from the operator.
pnpm check:decision-refs
                 every S- and E- identifier in a comment in src/ is defined: an
                 S- requirement as a list item of VELVE-AUTH-ARCHITECTURE.md, an
                 E- decision as an entry of CASE-STUDY.md or
                 docs/decisions/log.md.
pnpm check:reviewable
                 no NUL byte hides a file from review
pnpm check:sql-collapse
                 every SQL statement still says what it said once its newlines
                 are normalised away — a marker is a block comment, never a line
                 comment
pnpm check:log-append
                 no line docs/decisions/log.md had at the merge base is deleted or
                 rewritten, except a German entry, header or section heading
                 the central translation pass replaced, the entry under its
                 own anchor; and the branch has added at least one.
pnpm check:skill-version
                 a skill file that changed since the merge base states a higher
                 version than it did there, and both skill files state the same
                 version line.
pnpm check:codex-skill
                 CODEX-SKILL.md is byte-identical to what tools/codex-skill.mjs
                 produces from CLAUDE-SKILL.md.
pnpm check:attribution
                 §4 over three surfaces and in four scans: the tracked tree for
                 markers and for authorship claims, the commit messages of the
                 range against origin/main, and that range's diff.
pnpm check:release-tag
                 the tag a release is cut from names the version package.json
                 states, that version is a semantic one, and a prerelease is not
                 about to be published under latest.
pnpm check:release-tier <commit>
                 GitHub's public API has a successful release-tier.yml run on
                 that commit; exit 1 when it has none, exit 2 when it could not
                 be asked. Run by the maintainer before publishing.
pnpm run release-dist-tag
                 prints the dist-tag the version in package.json is published
                 under: latest for a stable version, next for a prerelease.
pnpm check:published-version
                 the registry resolves the version package.json states, the
                 dist-tag points at that version, and latest does not point at
                 any prerelease. Run by the maintainer after publishing from
                 their own machine; no workflow publishes.
pnpm publint     package export correctness
pnpm attw        type resolution across module modes
pnpm gate        everything above, in the order the main gate runs it
```
