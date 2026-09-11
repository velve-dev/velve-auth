# CLAUDE.md — velve-auth

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
`test/architecture-translation.test.ts` compares their structure and their
identifiers so that a divergence of that kind fails rather than waits to be noticed.

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
everywhere, `CASE-STUDY.md` included. The package is a public Apache-2.0 library on
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
writers share a file.**

There are exactly three sanctioned exceptions, and all of them are safe for the
same reason: the file is **partitioned before the wave starts**, and a feature
writes only inside the partition it was given. The exception is never "this file
is shared" — it is "this file has disjoint parts, and one of them is yours".

- **`CASE-STUDY.md`** — every feature appends entries to it. The partition is a
  reserved range of decision numbers, handed out before the writer starts; §6
  sets the ranges out and `test/decision-log.test.ts` enforces them.
- **`DOCUMENTATION.md`** — every feature documents itself in it, because item 3
  of the definition of done below requires it. The partition is the chapter:
  **a feature owns the `##` chapter named for it — one for every feature of the
  wave — and appends nowhere else in the file.** The chapter, its position and
  its `## Contents` line are created as empty stubs before the wave starts, so
  no writer inserts a heading and no two writers ever touch the same region.
  **This one is enforced by the reviewer noticing, not by a check.** Nothing
  reads the structure of `DOCUMENTATION.md`: a number outside a reserved range
  fails in `test/decision-log.test.ts` on the branch that took it, but a
  paragraph written into a neighbour's chapter fails nowhere. The two bullets
  look alike and are not equally enforced, and the second is worth exactly what
  the reviewer checking it is worth.
- **`README.md`** — item 4 of the definition of done points every feature at it
  whenever the outside picture changes, and wave 4 changes that picture three
  times. The partition is the `###` region under **What works today** named for
  what the feature builds, cut before the wave like a chapter. A feature rewrites
  its own region and nothing else in the file; the sentence above the regions
  that says what works end to end belongs to no feature, so a change to it is
  reported rather than made.

A feature that needs a change in another feature's chapter, or in a chapter no
feature owns, stops and reports it — exactly as it would for any other file it
does not own.

**`## Contents` belongs to the stub cut, not to any feature.** A chapter and its
index line are created together, before the wave, and that is the only moment
either changes — so no feature ever needs a line in the index, and the index
cannot fall behind the headings without the pre-wave pass having skipped one.
It fell to three of eleven entries before this rule existed, because chapters
were added by whoever wrote them and the index was owned by nobody.

All three exceptions rest on the partition existing **beforehand**. Until wave 3 there
was no chapter partition, and the contradiction between this rule and item 3 of
the definition of done was resolved by editing `DOCUMENTATION.md` anyway; all
four wave-2 features did. That merged cleanly by luck, not by construction —
four writers appending at end of file land on the same line, and four writers
appending into four disjoint stubs cannot.

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
5. `CASE-STUDY.md` records the decisions actually taken while building.
6. The main gate has approved.

### The main gate

Runs before every merge into `main` and blocks it on any finding. It does not
repair anything itself.

- `pnpm build` without errors **and without warnings**
- `pnpm typecheck` under `strict`, no `any` in the public surface type
- `pnpm lint` without findings, formatting applied
- `pnpm check:reviewable` — no NUL byte hides a file from review or from the scan
- `pnpm check:session-owner` — no session owner reassigned in SQL (S-FIX-2, E-23)
- `pnpm check:lock-order` — every row lock is `FOR NO KEY UPDATE`, declares
  `velve.user`, and is written in `src/core/db/lock.ts`; the order two transactions take
  their locks in is decided by `test/lock-order-race.test.ts` and not here
- `pnpm check:sql-collapse` — no line comment swallows the rest of its statement
- `pnpm check:log-append` — the decision log deletes no line it had at the merge
  base, and the branch has added at least one (§6, E-538)
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
- `README.md`, `DOCUMENTATION.md` and `CASE-STUDY.md` extended for the feature
- no AI attribution anywhere in the diff or the branch's commit history
- the shipped type declarations have not changed unrecorded — `test/api-surface.test.ts`
  compares every `dist/**/*.d.mts` against a committed copy. It buys the announcement and
  not the refusal, because re-recording is one command. What it does **not** cover is
  listed at the check and is longer than this line: it normalises member order and
  string-literal-union order in **45 of the 79 files**, wherever they occur and not only
  where the build is unstable; it records more than the public surface; it reads the last
  build rather than the tree; it says nothing about `dist/*.mjs`; and it does not reach a
  type resolved from a dependency (E-1376, E-1378, E-1383, E-1384)

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
- **`CLAUDE-SKILL.md`**, and `CODEX-SKILL.md` generated from it — kept current in
  its **method**, and never in its content. What that means is the opposite of
  what it means for the three above, so read the subsection below before touching
  it; a reader who takes "keep it current" at face value breaks the file by
  helping.

`CASE-STUDY.md` has one rule that matters more than the others: **no retroactive
rationalisation.** If a decision was made for a bad reason and turned out right,
the bad reason is what gets written down. The log is written during the build so
that the reasons are the actual ones and not the reconstructed ones.

Five further markdown files exist in the repository root, two of them the skill's,
and this is the complete list:

- **`CLAUDE.md`** — this file.
- **`VELVE-AUTH-ARCHITEKTUR.md`** — the binding specification, German.
- **`VELVE-AUTH-ARCHITECTURE.md`** — a translation of it into English. Faithful and
  **not binding**; where the two differ the German is right and the translation has a
  bug. It exists because §1 makes this repository English and the specification was
  the one holdout, and because the agent skill below points readers at it.
- **`CLAUDE-SKILL.md`** — the `velve-auth` agent skill: instructions that make a
  coding agent read this repository live before answering, refuse what §2 refuses,
  and say so rather than approximating.
- **`CODEX-SKILL.md`** — the same instructions for an agent that takes one file.
  It is **produced from `CLAUDE-SKILL.md` rather than written**, because the two
  carried different rules once and the one shipping without skill machinery was the
  weaker. `tools/codex-skill.mjs` is that transform and is therefore this file's
  definition; `pnpm check:codex-skill` regenerates it and fails on any difference,
  so a hand-edit of it does not survive the gate. Regenerate with
  `node tools/check-codex-skill.mjs --write` — never by editing the file.

Do not create any markdown file in the repository root outside that list. No summary
files, no progress reports, no `NOTES.md`. Markdown that belongs to something else —
a test snapshot under `test/__snapshots__/`, for instance — is not a document and is
not covered by this rule.

### Keeping the skill current is the opposite of keeping the documentation current

The documentation is kept current **by describing the features**. The skill is kept
current **by continuing to describe none of them.**

It carries no fact about the library on purpose — no feature list, no count, no
"not built yet", no published version — because it reads the live documents at the
moment it answers, and any fact copied into it is a copy with an expiry date nobody
writes down. Its own §1 states that as a rule about itself.

So a change to the library is a reason to **check** that the skill still navigates
this repository correctly, and it is almost never a reason to change a sentence of
it. What is kept current is the **method**: the sources it names, the URLs it
fetches, the shape of the tree it walks, the paths it installs to, the identifiers
it teaches a reader to cite. If a release looks as though it requires a sentence of
the skill to change, read that sentence again — a fact has almost certainly leaked
in, and the repair is to delete the fact, not to update it.

**Adding a feature of the library to the skill is a defect, not an omission being
repaired.** One such sentence turns every subsequent release into a skill release:
the file then goes stale on a schedule the library sets, and every reader has to
install an update to stop being told something false. That is the property this rule
exists to protect, and it is lost in a single helpful edit.

**A fact about the agent's own runtime is a different case, and it is permitted.** The
skill has to explain its own installation — the path it is written to, the URL it is
fetched from, when a new copy takes effect — and each of those is a fact about the tool
rather than about the library. What separates them is not the subject. The
library's documents are among the sources the skill fetches at the moment it answers, so
a fact about the library is always replaceable by a pointer and forbidding every one of
them costs nothing. The tool's documentation is fetchable too — one file, one `curl` —
so this is a **choice not to make it a seventh source**, and not an impossibility. The
reasons for declining are that the URL is not this project's to keep stable, its
structure is a third party's to change, and a skill that must reach a site this project
does not control in order to explain its own installation has taken on a dependency
worse than the copy. So a runtime fact is stated — the minimum installation needs, and
no more — and **stated from the tool's documentation, never from inference.** A
plausible mechanism is not a source: E-893 records "skills are loaded at start, so
restart" being written into three files by inference and being false, and E-895 records
that this paragraph first claimed an impossibility where a choice had been made.

**Every change to a skill file raises its version. Always.** A typo, a reworded
sentence, a fixed link — each of them. The version line at the top of the file is
what the skill compares against the published copy to tell a reader whether what
they are running is current, and a change that leaves the number alone makes that
comparison lie. `CODEX-SKILL.md` is generated from `CLAUDE-SKILL.md` and states the
same line, so the two rise together. `pnpm check:skill-version` enforces it against
the merge base.

**The unit is the change that merges, not the commit.** The check measures against
the merge base, so a branch that touches a skill file five times raises the version
once, and a branch that introduces the version line raises it from nothing. Raising
it per commit would publish version numbers no reader ever saw and could never
compare against.

A version raised without a change is **not** a fault and the check permits one. The
rule is that a change raises the version, not that a raise accompanies a change, and
refusing a lone raise would refuse the repair of a commit that forgot one.

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

### Correcting an entry before it merges

**On your own branch, before merge, a measurement may be restated in place; a
reason may not. An entry that existed at the merge base is never edited.**

The rule above protects a reason from being rewritten *after it has been read*,
and an entry on an unmerged branch has been read by nobody. Forbidding the
in-branch correction produces the opposite of what that rule wants: a writer who
may not change `ten of thirteen` to `eleven of fourteen` in their own unpublished
entry has to publish a number they know is wrong and aim a second entry at it,
and the wrong number becomes permanent.

**A measurement is a number or a count the entry states about the work** — `ten
of thirteen cases`, `six plants`, `40 of 60`. Everything else in an entry is a
reason, including a statement about what the specification says, which is
checkable but is not a measurement. The distinction is the whole load-bearing
part of this rule and it has already needed adjudicating once, in E-538.

The sharp edge is the honest half. The same latitude covers rewriting a **reason**
on an unmerged branch, which is retroactive rationalisation, and **no diff of any
form separates the two cases** — an edit to an entry the branch itself introduced
nets out to an addition against the merge base whichever way the edit went. This
rule needs a human. E-536 found that boundary; E-538 records an instance where a
wrong reason was corrected in place anyway, deliberately and disclosed in the
entry. What disclosure does and does not buy is settled next.

**Disclosure is not a remedy, and E-538 is not a precedent.** A reason that was
**wrong when it was written** is corrected by a new entry citing the old one, and
never by an edit to the old one's text — disclosed or not. The prohibition above
is stated flatly; E-538's own "anyway" concedes a violation rather than licensing
one; and reading disclosure as a remedy empties the prohibition of everything it
forbids, because any edit can be disclosed. That reason is the thing a later
reader would otherwise find and believe, which is the whole point of the rule.

**The half a writer actually hits is the other one.** An entry that was correct
when written and was made stale by the branch's **own later change to the thing
the entry describes** may be brought into step in place, with the change
disclosed in the entry. An entry saying *"clause X now reads Y"* whose branch
then changes X to read Z rationalises nothing; leaving it standing publishes an
entry describing text the tree does not contain. So the line is: **an entry may
be brought into step with its own artefact; the reason a decision was taken may
not be rewritten.**

**Neither half has a diff signature, and a reader is the mechanism for both.** An
edit bringing an entry into step with its amended artefact and an edit rewriting
a reason are the same shape in `git diff`, and `check:log-append` is blind to
both, for the reason the paragraph below gives. Disclosure in the entry and a
reviewer reading it are the whole enforcement, and this file says so rather than
presenting the rule as decidable — a rule presented as decidable when it is not
is how E-1032 happened (E-1139). What follows adds a signature that is **not** a
diff property and does not change any of that.

**The permitted half does have a signature, and it is syntactic rather than
differential.** What distinguishes an annotation is the shape of the result, not
the shape of its diff: **the original text survives unmodified and still renders,
and the addition is a complete unit inserted at a boundary between standing
sentences.** E-1098's edit on `fix/specification-defects-wave5` exhibits it — a
460-character italicised note between two finished sentences, every original
character intact and rendering, so a reader recovers the original exactly by
deleting the italics. The note sits at a **sentence** boundary inside a single
paragraph, not at a block boundary, because a log paragraph is one block. That is
what makes an annotation an annotation: **the reader sees both claims**, which is
what a disclosure is for (E-1140, E-1145).

**Zero deletions is not that signature, and reading it as one briefly put a false
rule in this file.** Insert `not ` into a reason and it says the opposite: `+1 −1`
under `--numstat`, **zero** removed tokens under `--word-diff=porcelain`, and
longest common prefix plus suffix equal to the whole original — the same signature
as the permitted case under every measurement, with one reason inverted and
nothing standing beside it. Wrap a reason in an HTML comment and insert a
replacement and it is `+3 −0` with zero removed tokens, and the original does not
render at all. So an insertion-only edit **can** be the forbidden half, and no
diff granularity repairs that (E-1144).

**The syntactic property is necessary and not sufficient either, and it is loose
in three ways.** A writer can insert a complete, well-formed note at a proper
boundary that **contradicts** the reason above it, and the result satisfies every
clause of the property. A **measurement** restated in place is a deletion this
section allows, so a deletion-bearing edit is not thereby a violation. And both of
those presuppose what the third does not — that the original survives as a
readable claim at all, which an insertion inside a sentence and an insertion that
suppresses the original from rendering each defeat. What the property buys is that
the reader is shown both claims; whether the second is fair is not something any
of this decides.

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

**The last clause carries weight the property does not, and is not a restatement
of it.** A note appended as a near-duplicate of the sentence it corrects —
identical but for one word — satisfies every clause of the property and defeats
what the property is for: both claims render, neither is modified, and a reader
still cannot tell which is the original or that a correction happened at all.
Saying what changed is the only thing that separates them. So the imperative does
**not** remove the *was it true when written* judgement — nothing here does — but
it guarantees a reader can answer it, because both claims are in front of them
**and labelled** (E-1142, E-1147).

**Nothing enforces the property, and no script is proposed here.** It is stated so
that a reviewer can apply it. `check:log-append` counts lines with `--numstat` and
a log paragraph is one long line, so an insertion into a standing paragraph reads
to it as `−1 +1`; finer granularity does not rescue it, because the counterexample
above removes zero tokens at word granularity too. A check for this would have to
compare **rendered blocks** rather than diff hunks. Whether one belongs in
`pnpm gate`, in §5's reviewer checklist or nowhere is a decision with its own cost
and is left open as a hand-off in E-1143.

What a script can read is the second sentence, and `pnpm check:log-append` reads
it: `git diff <merge-base>...HEAD --numstat -- CASE-STUDY.md` must report zero
deletions. The **three-dot** form is the form. Two-dot is not a stricter version
of the property but a wrong one — where the base has moved and has not been
merged, it counts deletions `main`'s own commits made as though this branch had
made them (E-538). The check is structurally blind to an edit of an entry the
same branch introduced, because at the merge base that entry did not exist. That
blindness is exactly right: it is the case this rule permits.

**The loss the step guards against is a merge conflict resolved badly, and it
guards one of the two directions.** Features append to `CASE-STUDY.md` in every
wave — three of them in wave 5 — so a branch that merges `main` gets a conflict
in it, and a conflict offers two bad resolutions rather than one. The step
answers them differently, and the difference is the whole of what follows.

**Keeping one's own side** drops what `main` carries. Those entries are at the
merge base by construction, because `main` is the base, so dropping them is a
deletion and the **first** clause fires. Reconstructed at `27e291e`: the step
reports 764 lines lost and exits 1, and `test/decision-log.test.ts` is red on 74
citations resolving to no entry (E-1131).

**Keeping `main`'s side** drops the branch's own entries, which were never at the
base — so nothing is deleted, and the first clause sees nothing. What fires
instead is the **second**, `commits > 0 && additions === 0`, and it fires only
while the branch has added no line to the file at all. **Any addition anywhere in
the file defeats it.** Two lines of unrelated comment turn a resolution that lost
68 entries green at `+2 −0` (E-1132). **And its window is the merge commit and
nothing after it**, because the next commit is the one recording the merge, which
item 5 of the definition of done requires: measured one commit later at `+44 −0`,
exit 0, with the same 68 entries still missing (E-1133).

So `check:log-append` is a **detector of one direction, at one commit** — not the
mechanism against a badly resolved conflict. **`test/decision-log.test.ts` is the
mechanism**, which is the mirror of what this section says of it under the range
table below: decision identifiers are cited from code, tests and documentation,
and a citation resolving to no entry is a failure whichever side was dropped. It
is red in both directions and stays red after the commits that close the other
step's window (E-1134).

**What a merger does with that.** Run `pnpm check:log-append` on the merge commit
itself, before committing anything on top of it — or do not lean on it and read
`pnpm test`'s decision-log failure instead. Run after the entries that record the
merge, it is being run outside the window in which it can answer.

The in-branch edit E-538 records is the narrower case and the one the step cannot
see.

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
| E-1600 … E-1649 | outside the waves · `lock-order` — the two deadlock cycles reachable on `main`. Fiftieth row of this table, counted over the forty-nine standing at a9b0aec plus this one; a range between the row above and this one is reserved on a branch this table cannot show, so fifty counts rows and not reservations |

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

### How wide a range has to be

Thirty was a guess, and wave 2 measured it. `password` used all thirty of its
range and needed a second one. `session` used all thirty and has a second one
reserved. `identity` used twenty-three, `token` twenty.

Five rows in the table above end exactly on their last number, which is not a
snug fit — it is what a range that ran out looks like from the outside. Two of
those five prove nothing: the architecture's own log and wave 0 were sized after
their contents were known. The other three were handed out in advance and filled
to the brim — `password`, `session`, and the gate block itself.

What exhausted them was not the feature. **The tail of every exhausted range
went to corrections, not to decisions about the thing being built.** `session`
spent its last three numbers correcting three of its own earlier entries after
its gate had run. `token` needed five corrections of its own entries. `password`
spent its last number on the log's format migration. The working ratio is
roughly twenty decisions plus ten corrections per thirty — and the corrections
arrive *after* the writer believes the feature is finished, which is the worst
moment to have to stop and ask for numbers.

Wave 3 is cut against that ratio instead of against a round thirty.

- **`auth-core` gets sixty.** It is the assembly point: configuration, startup
  errors, the flow layer, the route table, the package entry point and the API
  snapshot. On top of its own decisions it inherits twelve explicit hand-offs
  from waves 1 and 2 — entries that say in so many words that a requirement is
  currently unfulfilled and invisible — and each of those is answered by a
  decision here or is carried forward again in writing.
- **`factor-webauthn` gets forty-five.** The authenticator simulator, the
  backup-eligible and backup-state policy, `signCount` regression, and a
  documented deviation from WebAuthn Level 3 §7.2 each generate decisions with
  no requirement number to anchor them, which is exactly the kind that has to be
  argued in the log rather than cited from the specification.
- **`factor-totp` gets forty-five**, because it also owns recovery codes.
- **`rate` gets twenty-five.** It is the narrowest feature of the wave: one
  statement, three counters and the seam the HTTP layer already declares.
- **Gate and infrastructure gets a second block of twenty, and needs it now.**
  Its first block is **full** — all twenty of E-140 … E-159 are used — so the
  second block is not a precaution against wave 3's demand, it is the only
  source of gate numbers that exists. That block is where every broken-check
  finding lands; there are already thirty-eight of those in the log, running at
  roughly four per feature, and wave 3 runs four features at once.

Wave 3 has merged, so the ratio has a second measurement. Counted against
`CASE-STUDY.md` on `main`, wave 3 used `auth-core` **40 of 60**, `rate`
**17 of 25**, `factor-totp` **27 of 45**, `factor-webauthn` **35 of 45**, the
gate's second range **11 of 20** and its third range **24 of 25**.

Two things fall out of that, and they point in opposite directions. Every
**feature** range came in between sixty and eighty per cent, so cutting wave 3
against the ratio rather than against a round thirty was right and none of those
four needed a second row. Every **gate** range that was actually worked ran to
its edge: the first block is exhausted at twenty of twenty, and the third stopped
one number short. The second block reads as slack and is not — it was cut for the
wave-3 preparation and the relicensing, the seam cut ran beside it and had to
take a disjoint range, and its nine unused numbers are the gap §6 says a range
leaves behind, not headroom anyone can reach for.

Wave 4 is cut against that, and it is **one feature**.

- **The spine gets sixty, and is wave 4 on its own.** Between the services wave 3
  built and the flows the next wave wants there is an assembly layer that does not
  exist: `RequestContext` has no `plugin` field (3.15 D.1) and no OAuth state
  token, the seven hook points of 3.11 have no dispatcher and no ordering behind
  the security middleware (`S-CSRF-6`), `signIn.oauth.*` and `signIn.magicLink.*`
  belong to the one `signIn` namespace 3.15 B.1 declares, `SignInResult`,
  `SignUpResult`, `OAuthRedirect` and `OAuthCallbackResult` appear nowhere in the
  tree, nothing computes `availableFactors` (3.6), `mountAuth` takes no overrides,
  and `src/index.ts` and the API snapshot belong to nobody. Each of those has
  specification behind it and all three of the following features depend on all of
  them. A thing with its own requirements that three features depend on is a
  feature, not a seam — sixty because it is the same kind of work `auth-core` was
  and `auth-core` used forty of sixty.
- **`oauth`, `email-flows` and `plugin` are wave 5**, three writers, genuinely
  independent once the spine exists. Their ranges are unchanged.
- **`client` is wave 6**, for the reason below.

- **`oauth` gets fifty-five.** `S-LINK-1` to `S-LINK-7` are its, and that number
  is checkable: 5.11 lists exactly seven. Requirements from four other classes
  reach it too — `S-REDIR-6` for outbound endpoints, `S-KEY-7` for the JWKS
  algorithm allowlist, `S-REST-4` and `S-REST-6` for `pkce_verifier_enc` and the
  stored provider tokens — but the specification draws no feature-to-requirement
  map, so any total across classes is a judgement and is not offered as a count.
  Two of its test cases are corpora rather than cases: T-LINK-2's twelve-way
  state matrix and T-REDIR-2's corpus of at least a hundred and twenty malicious
  redirect targets. 3.10 names fourteen providers plus `genericOAuth`, and a
  generic one is a set of endpoints and a subject claim rather than a credential
  pair. It is the widest feature of the wave and the only one that could
  plausibly fill its range. A requirement number does not remove the need for an
  entry, either: the linking rule is where three of the advisories in 5.11 came
  from, and `S-LINK-2`'s three conditions are exactly where a reasonable-looking
  relaxation reintroduces one.
- **`email-flows` gets forty.** It owns `S-LINK-4`, which is the rule the linking
  chapter has to cite rather than restate, and the whole `request…`/`redeem…`
  verb pair of 3.15's rule 2.
- **`plugin` gets thirty-five.** The registry, the topological sort, the frozen
  context and the enumerated hook points are each a boundary that 3.11 states as
  a prohibition, and a prohibition is the kind of thing that generates a decision
  when it is enforced rather than when it is written.
- **`client` gets thirty and is last.** It is narrow for the same reason
  `rate` was of wave 3 — the route table already exists and the client is derived
  from it (3.15 E) — and that derivation is what moves it. 3.15 E requires
  `@velve/auth/client` to carry the table as a value with no server core behind
  it, and under `unbundle: true` every import in a route module survives into
  `dist/client.mjs`. A handler-free table therefore needs either a per-feature
  metadata split, which touches every file the other three writers own, or a
  second table that the first of them to merge makes stale. Neither is a
  partition, so `client` is written after the route surface settles. Its range is
  reserved and untouched; nothing is renumbered.

A wave of one needs no partition, so the spine writes wherever the specification
puts it — `## The instance` and `## HTTP` included — and the three files §5
partitions are partitioned for wave 5, not for it.
- **Gate and infrastructure gets a fourth block of thirty-five, not
  twenty-five.** The measurement above is what argues it. The largest single gate
  cut so far took twenty-four numbers, and a twenty-five-wide block against a
  measured twenty-four is one number of slack — which is exactly the shape this
  section already identifies as a range that ran out. Thirty-five is one clear
  step above the largest cut observed.

Over-reserving costs a gap in the numbering, which §6 has already said is fine.
Under-reserving costs a mid-branch request for numbers at the moment the writer
is least able to absorb one.

### `factor-totp` owns recovery codes

Recovery codes were in no wave at all. They belong to `factor-totp` for wave 3,
and that is a scope decision, not an implementation detail: they share the
pending-authentication state with TOTP, they share the `token-pepper` HMAC, they
share `DELETE … RETURNING` consumption, and they are one of exactly four routes
that accept the `__Host-velve_pending` cookie (architecture 3.6). Splitting them
across two features would put two writers in the same state machine.

The reason they cannot slip another wave is architecture 5.17. `S-DEFAULT-4`
makes `identity: "username"` **without** recovery codes a start error, and that
requirement has no implementation and no test today. A wave that ships a second
factor and leaves the only recovery path unbuilt ships a lockout.

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
- **`velve.user` is locked first, `FOR NO KEY UPDATE`, and a lock declares what it
  locks.** A transaction that writes rows in more than one user-owned table takes
  `SELECT 1 FROM ${schema}.user WHERE id = $1 FOR NO KEY UPDATE /* locks: ${schema}.user */`
  as its first statement, and reaches it through `src/core/db/lock.ts` — the only file
  that writes a row lock, so the mode cannot vary between call sites. Every repository
  builds its table name from the configured schema, so no scan can read the target out
  of the SQL; a check that tried to would pass for the absence of a name rather than the
  presence of the right one, which is what the marker is for. Two features reached for a
  row lock independently and both happened to lock the user row first; the ordering is a
  rule so the next one does not have to guess.
- **The mode is not a local choice.** `FOR NO KEY UPDATE` is the strongest strength that
  does **not** conflict with the `FOR KEY SHARE` a foreign key takes on `velve.user` for
  every insert of a user-owned row. `FOR UPDATE` does conflict with it, and that
  acquisition is taken by a trigger, in a statement this library did not write, at a point
  it does not choose: while `FOR UPDATE` is held it is an edge in a wait-for cycle that no
  reader can find in the SQL, and a deadlock made of exactly that was reproduced against
  PostgreSQL 14.24 and 18.3 (E-1601, E-1604). So `FOR UPDATE` and `FOR SHARE` are used
  nowhere, and `pnpm check:lock-order` refuses both.
- **The ordering rule reaches explicit locks only, and one exception is deliberate.** A
  redemption learns which account it is acting for by consuming a row of
  `one_time_token`, `pending_authentication`, `oauth_flow` or `webauthn_challenge`, so it
  cannot lock the account row before that row. Those four come first; everything else comes
  after `velve.user`. **Two implicit acquisitions matter, and the mode reaches exactly one
  of them.** A foreign key's `FOR KEY SHARE` on `velve.user` is the one the mode disarms:
  measured on 14.24 and on 18.3, it passes while `FOR NO KEY UPDATE` is held on that row
  and blocks while `FOR UPDATE` is. An `ON CONFLICT` index wait is on the **child's** index
  and the account row's mode has nothing to do with it; what orders that one is the mutex,
  as for any other lock on a child. Neither is ordered by this rule. **Do not read this
  section as a guarantee that the tree holds no cycle.** Two were reproduced on `main`; one
  of them obeyed this rule while deadlocking.
- **A second ordering holds and nothing checks it.** Four redeem flows consume a
  `one_time_token` row *before* they reach `lockAccountRow`, so for them the account lock is
  not the transaction's first statement — `velve.one_time_token` is written first. What keeps
  that safe is that `one_time_token` is ordered **before** `velve.user` everywhere: every mint
  runs in a transaction of its own and every redemption runs first, and no transaction that
  takes the account row touches that table at all. Verified by reading every site; **no check
  and no test decides it**, and a transaction that took the account row and then wrote
  `one_time_token` would close a cycle with every redemption (E-1616).
- **Two mechanisms, doing different things.** `pnpm check:lock-order` decides the mode, the
  declaration and the one file — properties of a single statement — and decides **no
  ordering whatever**, which its own output says. The ordering is
  `test/lock-order-race.test.ts`: it drives the two interleavings that deadlocked and
  reads, from the statements the requests actually ran, whether any two transactions take
  two tables in opposite orders in modes that wait for each other. A cycle surfaces as a
  deadlock in production under load and not in a test, because it needs two specific
  transactions interleaving on one account — which is why that file chooses its
  interleaving rather than racing for it. A row lock is also wider than it looks: while it
  is held, every **contending** write of a user-owned row for that account waits, and if
  the transaction contains an outbound call the wait is that call's timeout. An insert's
  foreign key is not contending, and that is what the mode buys.
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
pnpm test:release
                 vitest run over the release project — the cases section 6 puts
                 before every release; a version tag runs it
pnpm knip        dead code and unused exports
pnpm check:session-owner
                 S-FIX-2: no session owner reassigned in SQL
pnpm check:lock-order
                 every row lock is FOR NO KEY UPDATE, declares velve.user and is
                 written in src/core/db/lock.ts. Refuses the run when it scanned
                 no file or found no lock, because both look like a clean tree.
                 It decides no ordering and says so in its own output; the order
                 two transactions take their locks in is what
                 test/lock-order-race.test.ts drives
pnpm check:reviewable
                 no NUL byte hides a file from review
pnpm check:sql-collapse
                 every SQL statement still says what it said once its newlines
                 are normalised away — a marker is a block comment, never a line
                 comment
pnpm check:log-append
                 no line CASE-STUDY.md had at the merge base is deleted or
                 rewritten, and the branch has added at least one. Refuses the
                 run if the base cannot be resolved; VELVE_LOG_BASE names a base
                 other than origin/main. Alone among the gate's steps it reads
                 committed history and not the working tree, so an uncommitted
                 deletion is invisible to it — and to every other step as well,
                 which is why §6 states it rather than a check catching it
pnpm check:skill-version
                 a skill file that changed since the merge base states a higher
                 version than it did there, and both skill files state the same
                 version line. Refuses the run if the base cannot be resolved or
                 if a version line cannot be read in either file at HEAD;
                 VELVE_SKILL_BASE names a base other than origin/main. Like
                 check:log-append and unlike every other step, it reads committed
                 history and not the working tree, so an uncommitted edit to a
                 skill file is invisible to it
pnpm check:codex-skill
                 CODEX-SKILL.md is byte-identical to what tools/codex-skill.mjs
                 produces from CLAUDE-SKILL.md. Refuses the run if the skill
                 cannot be read or if the transform no longer applies to it — a
                 rewording it can no longer find is a refusal, not a pass. Add
                 --write to regenerate the file instead of comparing it, which is
                 the only way the file is ever changed
pnpm check:attribution
                 §4 over three surfaces and in four scans: the tracked tree for
                 markers and for authorship claims, the commit messages of the
                 range against origin/main, and that range's diff. It states no
                 pattern of its own — it reads them out of
                 .github/workflows/ci.yml, which §4 exempts, so that a second
                 copy does not become a fourth file needing exemption. It
                 performs the one shell expansion the detector's values use and
                 refuses by name every other spelling it knows of — which is an
                 enumeration and not a proof: two spellings have been found
                 missing from it by a reader rather than by anything that runs,
                 and a third would be performed by the detector's shell and left
                 literal here, so the two would search with different patterns.
                 Refuses the run if
                 the detector cannot be read or is reworded past what it can
                 parse, if a value still names an expansion it does not perform,
                 if any branch of a pattern cannot be sampled or does not match
                 the sample built from it, if the base cannot be resolved, or if
                 a surface came back empty where emptiness is not an answer. No
                 refusal prints a pattern. VELVE_ATTRIBUTION_BASE names a base
                 other than origin/main. It reads committed history for the
                 messages and the diff and the working tree for the tree scan,
                 so an uncommitted marker is found and an uncommitted commit
                 message is not a thing that exists. What it cannot see is a
                 branch the detector no longer states, because every branch it
                 proves is derived from the detector; test/gate-commands.test.ts
                 states that shape where it is not derived from it, and is what
                 fails on a deletion. A spelling missing from the enumeration
                 above lands on a second guard rather than on nothing: what it
                 leaves behind is a literal $ mid-branch, the sample built for
                 that branch drops it, and the branch then fails against its own
                 sample. That holds on an engine treating a mid-pattern $ as an
                 anchor or as an ordinary character, and not on one that ignores
                 it. Measured on BSD grep 2.6.0-FreeBSD, which is what this
                 machine resolves grep to; not measured on GNU grep, which is
                 what CI runs
pnpm check:release-tag
                 the tag a release is cut from names the version package.json
                 states, that version is a semantic one, and a prerelease is not
                 about to be published under latest. Takes the tag and the
                 dist-tag as arguments, or reads them from GITHUB_REF_NAME and
                 VELVE_RELEASE_DIST_TAG. Refuses the run if either is missing or
                 the manifest cannot be read as an object — an unchecked tag is
                 not a matching one. release.yml runs it before the publish;
                 pnpm gate does not, because an ordinary branch carries no tag
                 for it to check and it would refuse every one of them
pnpm check:published-version
                 the registry resolves the version package.json states, the
                 dist-tag points at that version, and it carries a provenance
                 attestation. Takes the dist-tag as its argument; VELVE_REGISTRY
                 names a registry other than npm's and VELVE_REGISTRY_DEADLINE_MS
                 how long it polls for a publish to become readable. Tells a
                 registry saying the version is absent from one that could not be
                 asked, and refuses only on the second. release.yml runs it after
                 the publish; pnpm gate does not, because a version nobody has
                 published has nothing to resolve
pnpm publint     package export correctness
pnpm attw        type resolution across module modes
pnpm gate        everything above, in the order the main gate runs it
```
