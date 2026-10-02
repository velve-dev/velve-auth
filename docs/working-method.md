# Working method — velve-auth

This file holds the explanations, measurements and histories behind the rules in `CLAUDE.md`, moved here word for word so that the rules file states rules. `CLAUDE.md` binds; nothing here adds a rule, and where the two seem to disagree, `CLAUDE.md` is right.

## From the preamble — the translation check

`test/architecture-translation.test.ts` compares their structure and their identifiers so that a divergence of that kind fails rather than waits to be noticed.

## From §1 — language

The header states the language and the entry format of everything below it, and a translation that leaves it standing leaves the file describing itself wrongly — in German, and in the old `Kontext · Verworfen · Grund · Preis` shape §6 has replaced.

How a translation must read is fixed in §6, and it is the one place where the no-retroactive-rationalisation rule is easiest to break by accident.

The package is a public Apache-2.0 library on npm; its readers are not assumed to read German.

## From §3 — the comment rule as it stood before the plain-sentence form

- Comments are permitted only where the reason for the code cannot be expressed in code: a specification clause being satisfied, a deliberate deviation from a standard, a non-obvious ordering constraint. Then **one sentence**, no more.
- A reference to the specification is a legitimate comment and is encouraged where the code exists solely because of it: `S-OWNER-3`, `L-12`, `E-23`.
- **A comment in `src/` is read by this repository's static scans as though it were code.** Around twenty-two files under `test/` and `tools/` match a regular expression against raw source text, so prose that resembles a statement, an identifier or an option this library refuses can redden a case in a file nobody touched — and several of those cases accuse a security requirement. **Three still redden today**, and these are the ones to try: the word *caching* in a comment under `src/core/session` reddens the case for `S-CACHE-1`; a comment naming a PKCE option that does not exist reddens the case for `S-REPLAY-6`; a comment spelling a brand's phantom field reddens the census in `test/brand-invariants.test.ts`. **Two more no longer redden anything** — plain prose naming `velve.password_credential`, and a comment shaped like the statement `S-FIX-2` forbids. The scans that read those two were repaired, and planting both together now leaves the whole suite green; they are cited as the measurement that motivated the repair and **not** as something to try (E-1653, E-1661). Four test files and the `check:session-owner` step strip comments first — `tools/source-text.mjs` is the one to reach for — three more strip them with a string-blind regular expression, and the rest read the text raw (E-1654). The file count is a proxy and not a census: two proxies answered twenty-one and twenty-two, and a count of *cases* is not offered at all. Write the comment, then run `pnpm test`; a hit is the scan being wrong rather than the prose, and the repair belongs at the scan.

## From §4 — the attribution check

The tree scan cannot see text a later commit removed; the diff scan cannot see text that predates the branch. Both run.

## From §5 — parallelism and file ownership

**This one is enforced by the reviewer noticing, not by a check.** Nothing reads the structure of `DOCUMENTATION.md`: a number outside a reserved range fails in `test/decision-log.test.ts` on the branch that took it, but a paragraph written into a neighbour's chapter fails nowhere. The two bullets look alike and are not equally enforced, and the second is worth exactly what the reviewer checking it is worth.

It fell to three of eleven entries before this rule existed, because chapters were added by whoever wrote them and the index was owned by nobody.

All three exceptions rest on the partition existing **beforehand**. Until wave 3 there was no chapter partition, and the contradiction between this rule and item 3 of the definition of done was resolved by editing `DOCUMENTATION.md` anyway; all four wave-2 features did. That merged cleanly by luck, not by construction — four writers appending at end of file land on the same line, and four writers appending into four disjoint stubs cannot.

## From §5 — the main gate

It buys the announcement and not the refusal, because re-recording is one command. What it does **not** cover is listed at the check and is longer than this line: it normalises member order and string-literal-union order in **45 of the 79 files**, wherever they occur and not only where the build is unstable; it records more than the public surface; it reads the last build rather than the tree; it says nothing about `dist/*.mjs`; and it does not reach a type resolved from a dependency (E-1376, E-1378, E-1383, E-1384)

Three of this repository's checks were written so it could not — a scan reporting success because it matched no files, a shell condition testing a pipeline that exits zero on empty input, an exclusion that deleted the text it was meant to examine. Each looked green.

## From §6 — documentation duty

What that means is the opposite of what it means for the three above, so read the subsection below before touching it; a reader who takes "keep it current" at face value breaks the file by helping.

The log is written during the build so that the reasons are the actual ones and not the reconstructed ones.

It exists because §1 makes this repository English and the specification was the one holdout, and because the agent skill below points readers at it.

`tools/codex-skill.mjs` is that transform and is therefore this file's definition; `pnpm check:codex-skill` regenerates it and fails on any difference, so a hand-edit of it does not survive the gate.

## From §6 — keeping the skill current

It carries no fact about the library on purpose — no feature list, no count, no "not built yet", no published version — because it reads the live documents at the moment it answers, and any fact copied into it is a copy with an expiry date nobody writes down. Its own §1 states that as a rule about itself.

So a change to the library is a reason to **check** that the skill still navigates this repository correctly, and it is almost never a reason to change a sentence of it. What is kept current is the **method**: the sources it names, the URLs it fetches, the shape of the tree it walks, the paths it installs to, the identifiers it teaches a reader to cite. If a release looks as though it requires a sentence of the skill to change, read that sentence again — a fact has almost certainly leaked in, and the repair is to delete the fact, not to update it.

One such sentence turns every subsequent release into a skill release: the file then goes stale on a schedule the library sets, and every reader has to install an update to stop being told something false. That is the property this rule exists to protect, and it is lost in a single helpful edit.

The skill has to explain its own installation — the path it is written to, the URL it is fetched from, when a new copy takes effect — and each of those is a fact about the tool rather than about the library. What separates them is not the subject. The library's documents are among the sources the skill fetches at the moment it answers, so a fact about the library is always replaceable by a pointer and forbidding every one of them costs nothing. The tool's documentation is fetchable too — one file, one `curl` — so this is a **choice not to make it a seventh source**, and not an impossibility. The reasons for declining are that the URL is not this project's to keep stable, its structure is a third party's to change, and a skill that must reach a site this project does not control in order to explain its own installation has taken on a dependency worse than the copy. A plausible mechanism is not a source: E-893 records "skills are loaded at start, so restart" being written into three files by inference and being false, and E-895 records that this paragraph first claimed an impossibility where a choice had been made.

The version line at the top of the file is what the skill compares against the published copy to tell a reader whether what they are running is current, and a change that leaves the number alone makes that comparison lie. `CODEX-SKILL.md` is generated from `CLAUDE-SKILL.md` and states the same line, so the two rise together.

The check measures against the merge base, so a branch that touches a skill file five times raises the version once, and a branch that introduces the version line raises it from nothing. Raising it per commit would publish version numbers no reader ever saw and could never compare against.

The rule is that a change raises the version, not that a raise accompanies a change, and refusing a lone raise would refuse the repair of a commit that forgot one.

## From §6 — the entry format

**Heading position** is what the test means by it: a line that opens a markdown block — it is the first line of the file, or it follows a blank line or an ATX heading — and that begins, after any markdown decoration, with an `E-nnn` that is not followed by prose. `###`, `-`, `*`, `+`, `>` and backticks are decoration, so leaving the number in the `###` heading is caught, and so is a list item, an italic line or a blockquote carrying one. A wrapped prose line never opens a block, so a citation that happens to land at a line start is not a heading and is not reported.

## From §6 — translating an entry

Translation is the sharpest edge the no-retroactive-rationalisation rule has, because a translator reads a weak argument and improves it without noticing.

## From §6 — correcting an entry before it merges

The rule above protects a reason from being rewritten *after it has been read*, and an entry on an unmerged branch has been read by nobody. Forbidding the in-branch correction produces the opposite of what that rule wants: a writer who may not change `ten of thirteen` to `eleven of fourteen` in their own unpublished entry has to publish a number they know is wrong and aim a second entry at it, and the wrong number becomes permanent.

The distinction is the whole load-bearing part of this rule and it has already needed adjudicating once, in E-538.

The sharp edge is the honest half. The same latitude covers rewriting a **reason** on an unmerged branch, which is retroactive rationalisation, and **no diff of any form separates the two cases** — an edit to an entry the branch itself introduced nets out to an addition against the merge base whichever way the edit went. This rule needs a human. E-536 found that boundary; E-538 records an instance where a wrong reason was corrected in place anyway, deliberately and disclosed in the entry. What disclosure does and does not buy is settled next.

**Disclosure is not a remedy, and E-538 is not a precedent.** The prohibition above is stated flatly; E-538's own "anyway" concedes a violation rather than licensing one; and reading disclosure as a remedy empties the prohibition of everything it forbids, because any edit can be disclosed. That reason is the thing a later reader would otherwise find and believe, which is the whole point of the rule.

**The half a writer actually hits is the other one.** An entry saying *"clause X now reads Y"* whose branch then changes X to read Z rationalises nothing; leaving it standing publishes an entry describing text the tree does not contain.

**Neither half has a diff signature, and a reader is the mechanism for both.** An edit bringing an entry into step with its amended artefact and an edit rewriting a reason are the same shape in `git diff`, and `check:log-append` is blind to both, for the reason the paragraph below gives. Disclosure in the entry and a reviewer reading it are the whole enforcement, and this file says so rather than presenting the rule as decidable — a rule presented as decidable when it is not is how E-1032 happened (E-1139). What follows adds a signature that is **not** a diff property and does not change any of that.

**The permitted half does have a signature, and it is syntactic rather than differential.** What distinguishes an annotation is the shape of the result, not the shape of its diff: **the original text survives unmodified and still renders, and the addition is a complete unit inserted at a boundary between standing sentences.** E-1098's edit on `fix/specification-defects-wave5` exhibits it — a 460-character italicised note between two finished sentences, every original character intact and rendering, so a reader recovers the original exactly by deleting the italics. The note sits at a **sentence** boundary inside a single paragraph, not at a block boundary, because a log paragraph is one block. That is what makes an annotation an annotation: **the reader sees both claims**, which is what a disclosure is for (E-1140, E-1145).

**Zero deletions is not that signature, and reading it as one briefly put a false rule in this file.** Insert `not ` into a reason and it says the opposite: `+1 −1` under `--numstat`, **zero** removed tokens under `--word-diff=porcelain`, and longest common prefix plus suffix equal to the whole original — the same signature as the permitted case under every measurement, with one reason inverted and nothing standing beside it. Wrap a reason in an HTML comment and insert a replacement and it is `+3 −0` with zero removed tokens, and the original does not render at all. So an insertion-only edit **can** be the forbidden half, and no diff granularity repairs that (E-1144).

**The syntactic property is necessary and not sufficient either, and it is loose in three ways.** A writer can insert a complete, well-formed note at a proper boundary that **contradicts** the reason above it, and the result satisfies every clause of the property. A **measurement** restated in place is a deletion this section allows, so a deletion-bearing edit is not thereby a violation. And both of those presuppose what the third does not — that the original survives as a readable claim at all, which an insertion inside a sentence and an insertion that suppresses the original from rendering each defeat. What the property buys is that the reader is shown both claims; whether the second is fair is not something any of this decides.

That is the rule itself rather than a consequence of one, so it holds whatever a diff says: leave every original **sentence** standing verbatim and rendering, put the note inside the entry it corrects at a boundary between finished sentences, and say in the note what changed. Sentence, not word — a rule that asks only for the words to survive is satisfied by inserting `not ` into one of them, which is the counterexample this whole subsection was rewritten around (E-1147).

**All of that governs argument-bearing text.** A **measurement** restated in place is the one edit that needs none of it: the opening of this subsection permits it outright, and the paragraph defining a measurement above makes that partition exhaustive — a number or a count the entry states about the work is a measurement, and *everything else in an entry is a reason*. So the property and the imperative are about reasons, which is what they were always for, and saying so here sharpens the boundary rather than carving an exception into it. Without this clause the two paragraphs contradict each other for the ordinary case of a number sitting inside a sentence, and a reader reconciles them by picking whichever half suits them (E-1150).

**The last clause carries weight the property does not, and is not a restatement of it.** A note appended as a near-duplicate of the sentence it corrects — identical but for one word — satisfies every clause of the property and defeats what the property is for: both claims render, neither is modified, and a reader still cannot tell which is the original or that a correction happened at all. Saying what changed is the only thing that separates them. So the imperative does **not** remove the *was it true when written* judgement — nothing here does — but it guarantees a reader can answer it, because both claims are in front of them **and labelled** (E-1142, E-1147).

**Nothing enforces the property, and no script is proposed here.** It is stated so that a reviewer can apply it. `check:log-append` counts lines with `--numstat` and a log paragraph is one long line, so an insertion into a standing paragraph reads to it as `−1 +1`; finer granularity does not rescue it, because the counterexample above removes zero tokens at word granularity too. A check for this would have to compare **rendered blocks** rather than diff hunks. Whether one belongs in `pnpm gate`, in §5's reviewer checklist or nowhere is a decision with its own cost and is left open as a hand-off in E-1143.

Two-dot is not a stricter version of the property but a wrong one — where the base has moved and has not been merged, it counts deletions `main`'s own commits made as though this branch had made them (E-538). The check is structurally blind to an edit of an entry the same branch introduced, because at the merge base that entry did not exist. That blindness is exactly right: it is the case this rule permits.

**The loss the step guards against is a merge conflict resolved badly, and it guards one of the two directions.** Features append to `CASE-STUDY.md` in every wave — three of them in wave 5 — so a branch that merges `main` gets a conflict in it, and a conflict offers two bad resolutions rather than one. The step answers them differently, and the difference is the whole of what follows.

**Keeping one's own side** drops what `main` carries. Those entries are at the merge base by construction, because `main` is the base, so dropping them is a deletion and the **first** clause fires. Reconstructed at `27e291e`: the step reports 764 lines lost and exits 1, and `test/decision-log.test.ts` is red on 74 citations resolving to no entry (E-1131).

**Keeping `main`'s side** drops the branch's own entries, which were never at the base — so nothing is deleted, and the first clause sees nothing. What fires instead is the **second**, `commits > 0 && additions === 0`, and it fires only while the branch has added no line to the file at all. **Any addition anywhere in the file defeats it.** Two lines of unrelated comment turn a resolution that lost 68 entries green at `+2 −0` (E-1132). **And its window is the merge commit and nothing after it**, because the next commit is the one recording the merge, which item 5 of the definition of done requires: measured one commit later at `+44 −0`, exit 0, with the same 68 entries still missing (E-1133).

So `check:log-append` is a **detector of one direction, at one commit** — not the mechanism against a badly resolved conflict. **`test/decision-log.test.ts` is the mechanism**, which is the mirror of what this section says of it under the range table below: decision identifiers are cited from code, tests and documentation, and a citation resolving to no entry is a failure whichever side was dropped. It is red in both directions and stays red after the commits that close the other step's window (E-1134).

**What a merger does with that.** Run after the entries that record the merge, it is being run outside the window in which it can answer.

The in-branch edit E-538 records is the narrower case and the one the step cannot see.

## From §6 — numbering the decision log

`CASE-STUDY.md` is the one file every feature appends to. That is a deliberate exception to the file-ownership rule in §5, and it works only because of how the numbers are handed out.

### How wide a range has to be

Thirty was a guess, and wave 2 measured it. `password` used all thirty of its range and needed a second one. `session` used all thirty and has a second one reserved. `identity` used twenty-three, `token` twenty.

Five rows in the table above end exactly on their last number, which is not a snug fit — it is what a range that ran out looks like from the outside. Two of those five prove nothing: the architecture's own log and wave 0 were sized after their contents were known. The other three were handed out in advance and filled to the brim — `password`, `session`, and the gate block itself.

What exhausted them was not the feature. **The tail of every exhausted range went to corrections, not to decisions about the thing being built.** `session` spent its last three numbers correcting three of its own earlier entries after its gate had run. `token` needed five corrections of its own entries. `password` spent its last number on the log's format migration. The working ratio is roughly twenty decisions plus ten corrections per thirty — and the corrections arrive *after* the writer believes the feature is finished, which is the worst moment to have to stop and ask for numbers.

Wave 3 is cut against that ratio instead of against a round thirty.

- **`auth-core` gets sixty.** It is the assembly point: configuration, startup errors, the flow layer, the route table, the package entry point and the API snapshot. On top of its own decisions it inherits twelve explicit hand-offs from waves 1 and 2 — entries that say in so many words that a requirement is currently unfulfilled and invisible — and each of those is answered by a decision here or is carried forward again in writing.
- **`factor-webauthn` gets forty-five.** The authenticator simulator, the backup-eligible and backup-state policy, `signCount` regression, and a documented deviation from WebAuthn Level 3 §7.2 each generate decisions with no requirement number to anchor them, which is exactly the kind that has to be argued in the log rather than cited from the specification.
- **`factor-totp` gets forty-five**, because it also owns recovery codes.
- **`rate` gets twenty-five.** It is the narrowest feature of the wave: one statement, three counters and the seam the HTTP layer already declares.
- **Gate and infrastructure gets a second block of twenty, and needs it now.** Its first block is **full** — all twenty of E-140 … E-159 are used — so the second block is not a precaution against wave 3's demand, it is the only source of gate numbers that exists. That block is where every broken-check finding lands; there are already thirty-eight of those in the log, running at roughly four per feature, and wave 3 runs four features at once.

Wave 3 has merged, so the ratio has a second measurement. Counted against `CASE-STUDY.md` on `main`, wave 3 used `auth-core` **40 of 60**, `rate` **17 of 25**, `factor-totp` **27 of 45**, `factor-webauthn` **35 of 45**, the gate's second range **11 of 20** and its third range **24 of 25**.

Two things fall out of that, and they point in opposite directions. Every **feature** range came in between sixty and eighty per cent, so cutting wave 3 against the ratio rather than against a round thirty was right and none of those four needed a second row. Every **gate** range that was actually worked ran to its edge: the first block is exhausted at twenty of twenty, and the third stopped one number short. The second block reads as slack and is not — it was cut for the wave-3 preparation and the relicensing, the seam cut ran beside it and had to take a disjoint range, and its nine unused numbers are the gap §6 says a range leaves behind, not headroom anyone can reach for.

Wave 4 is cut against that, and it is **one feature**.

- **The spine gets sixty, and is wave 4 on its own.** Between the services wave 3 built and the flows the next wave wants there is an assembly layer that does not exist: `RequestContext` has no `plugin` field (3.15 D.1) and no OAuth state token, the seven hook points of 3.11 have no dispatcher and no ordering behind the security middleware (`S-CSRF-6`), `signIn.oauth.*` and `signIn.magicLink.*` belong to the one `signIn` namespace 3.15 B.1 declares, `SignInResult`, `SignUpResult`, `OAuthRedirect` and `OAuthCallbackResult` appear nowhere in the tree, nothing computes `availableFactors` (3.6), `mountAuth` takes no overrides, and `src/index.ts` and the API snapshot belong to nobody. Each of those has specification behind it and all three of the following features depend on all of them. A thing with its own requirements that three features depend on is a feature, not a seam — sixty because it is the same kind of work `auth-core` was and `auth-core` used forty of sixty.
- **`oauth`, `email-flows` and `plugin` are wave 5**, three writers, genuinely independent once the spine exists. Their ranges are unchanged.
- **`client` is wave 6**, for the reason below.

- **`oauth` gets fifty-five.** `S-LINK-1` to `S-LINK-7` are its, and that number is checkable: 5.11 lists exactly seven. Requirements from four other classes reach it too — `S-REDIR-6` for outbound endpoints, `S-KEY-7` for the JWKS algorithm allowlist, `S-REST-4` and `S-REST-6` for `pkce_verifier_enc` and the stored provider tokens — but the specification draws no feature-to-requirement map, so any total across classes is a judgement and is not offered as a count. Two of its test cases are corpora rather than cases: T-LINK-2's twelve-way state matrix and T-REDIR-2's corpus of at least a hundred and twenty malicious redirect targets. 3.10 names fourteen providers plus `genericOAuth`, and a generic one is a set of endpoints and a subject claim rather than a credential pair. It is the widest feature of the wave and the only one that could plausibly fill its range. A requirement number does not remove the need for an entry, either: the linking rule is where three of the advisories in 5.11 came from, and `S-LINK-2`'s three conditions are exactly where a reasonable-looking relaxation reintroduces one.
- **`email-flows` gets forty.** It owns `S-LINK-4`, which is the rule the linking chapter has to cite rather than restate, and the whole `request…`/`redeem…` verb pair of 3.15's rule 2.
- **`plugin` gets thirty-five.** The registry, the topological sort, the frozen context and the enumerated hook points are each a boundary that 3.11 states as a prohibition, and a prohibition is the kind of thing that generates a decision when it is enforced rather than when it is written.
- **`client` gets thirty and is last.** It is narrow for the same reason `rate` was of wave 3 — the route table already exists and the client is derived from it (3.15 E) — and that derivation is what moves it. 3.15 E requires `@velve/auth/client` to carry the table as a value with no server core behind it, and under `unbundle: true` every import in a route module survives into `dist/client.mjs`. A handler-free table therefore needs either a per-feature metadata split, which touches every file the other three writers own, or a second table that the first of them to merge makes stale. Neither is a partition, so `client` is written after the route surface settles. Its range is reserved and untouched; nothing is renumbered.

A wave of one needs no partition, so the spine writes wherever the specification puts it — `## The instance` and `## HTTP` included — and the three files §5 partitions are partitioned for wave 5, not for it.
- **Gate and infrastructure gets a fourth block of thirty-five, not twenty-five.** The measurement above is what argues it. The largest single gate cut so far took twenty-four numbers, and a twenty-five-wide block against a measured twenty-four is one number of slack — which is exactly the shape this section already identifies as a range that ran out. Thirty-five is one clear step above the largest cut observed.

Over-reserving costs a gap in the numbering, which §6 has already said is fine. Under-reserving costs a mid-branch request for numbers at the moment the writer is least able to absorb one.

### `factor-totp` owns recovery codes

Recovery codes were in no wave at all. They belong to `factor-totp` for wave 3, and that is a scope decision, not an implementation detail: they share the pending-authentication state with TOTP, they share the `token-pepper` HMAC, they share `DELETE … RETURNING` consumption, and they are one of exactly four routes that accept the `__Host-velve_pending` cookie (architecture 3.6). Splitting them across two features would put two writers in the same state machine.

The reason they cannot slip another wave is architecture 5.17. `S-DEFAULT-4` makes `identity: "username"` **without** recovery codes a start error, and that requirement has no implementation and no test today. A wave that ships a second factor and leaves the only recovery path unbuilt ships a lockout.

The reason this matters more than it looks: decision IDs are cited from code, tests and documentation — `E-23` next to the line it explains. A renumber has to move every citation with it, and a citation left behind does not dangle, it **resolves to the wrong decision**. Nothing detects that. Reserved ranges remove the renumber, and removing the renumber removes the whole failure class.

A reserved range that is not used up leaves a gap in the numbering. That is fine and expected. Contiguity is worth nothing here; a silent wrong citation costs a great deal.

`test/decision-log.test.ts` is the backstop, not the mechanism. It catches a number used twice, an entry missing one of its four parts, a citation anywhere in the repository that resolves to no entry at all, and a block that sits in heading position carrying an `E-nnn` but matches neither entry form. That last one exists because without it such a block is skipped in silence: it is not counted, not part-checked and not range-checked, and if its number belongs to a real entry elsewhere the duplicate check does not see it either. It cannot catch a citation that resolves to the wrong entry — only not renumbering can.

## From §7 — technical constraints

Every repository builds its table name from the configured schema, so no scan can read the target out of the SQL; a check that tried to would pass for the absence of a name rather than the presence of the right one, which is what the marker is for. Two features reached for a row lock independently and both happened to lock the user row first; the ordering is a rule so the next one does not have to guess.

`FOR UPDATE` does conflict with it, and that acquisition is taken by a trigger, in a statement this library did not write, at a point it does not choose: while `FOR UPDATE` is held it is an edge in a wait-for cycle that no reader can find in the SQL, and a deadlock made of exactly that was reproduced against PostgreSQL 14.24 and 18.3 (E-1601, E-1604).

**Two implicit acquisitions matter, and the mode reaches exactly one of them.** A foreign key's `FOR KEY SHARE` on `velve.user` is the one the mode disarms: measured on 14.24 and on 18.3, it passes while `FOR NO KEY UPDATE` is held on that row and blocks while `FOR UPDATE` is. An `ON CONFLICT` index wait is on the **child's** index and the account row's mode has nothing to do with it; what orders that one is the mutex, as for any other lock on a child. Neither is ordered by this rule. Two were reproduced on `main`; one of them obeyed this rule while deadlocking.

Verified by reading every site; **no check and no test decides it**, and a transaction that took the account row and then wrote `one_time_token` would close a cycle with every redemption (E-1616).

- **Two mechanisms, doing different things.** `pnpm check:lock-order` decides the mode, the declaration and the one file — properties of a single statement — and decides **no ordering whatever**, which its own output says. The ordering is `test/lock-order-race.test.ts`: it drives the two interleavings that deadlocked and reads, from the statements the requests actually ran, whether any two transactions take two tables in opposite orders in modes that wait for each other. A cycle surfaces as a deadlock in production under load and not in a test, because it needs two specific transactions interleaving on one account — which is why that file chooses its interleaving rather than racing for it. A row lock is also wider than it looks: while it is held, every **contending** write of a user-owned row for that account waits, and if the transaction contains an outbound call the wait is that call's timeout. An insert's foreign key is not contending, and that is what the mode buys.

## From §9 — commands

### `pnpm check:session-owner`

A finding names the file and the statement it found. Three conditions are refused in their own words instead, carrying no offender and no advice line: a working tree that yielded no statement, a dist/ with no built module in it, and a dist/ that has modules but yielded no statement — the last being what an interrupted build leaves. Finding and refusal used to leave by the same door, so a missing build printed the security message and named nobody (E-1651, E-1662)

### `pnpm check:lock-order`

Refuses the run when it scanned no file or found no lock, because both look like a clean tree. It decides no ordering and says so in its own output; the order two transactions take their locks in is what test/lock-order-race.test.ts drives

### `pnpm check:token-after-lock`

Refuses the run when it scanned no file or found no account lock, because both look like a clean tree. It decides a textual order within a file and not a transaction boundary, so it is coarser than the invariant and coarse in the safe direction (E-1616)

### `pnpm check:egress`

fetch, XMLHttpRequest, WebSocket and sendBeacon are all refused elsewhere, and so is a bare host string with no call beside it. A destination is http/https/ws/wss with a dotted host, so an otpauth: URI and a single-label parsing base are not destinations — and neither is an internal single-label host, which is the limit this scan states rather than hides. Refuses the run when it read no file or when the seam itself calls nothing (E-1844)

### `pnpm check:decision-refs`

Reads comments only, so a string is not a citation, and fails on a bracket shaped like a citation that is not an identifier, such as (S-Tim-1). It inherits the blind spots of tools/source-text.mjs, which can lose a comment after a regular expression literal holding // or a quote (E-1941). Refuses the run when it read no file, found no definition in either source, or found no citation, because each looks like a clean tree

### `pnpm check:log-append`

Refuses the run if the base cannot be resolved; VELVE_LOG_BASE names a base other than origin/main. Alone among the gate's steps it reads committed history and not the working tree, so an uncommitted deletion is invisible to it — and to every other step as well, which is why §6 states it rather than a check catching it

### `pnpm check:skill-version`

Refuses the run if the base cannot be resolved or if a version line cannot be read in either file at HEAD; VELVE_SKILL_BASE names a base other than origin/main. Like check:log-append and unlike every other step, it reads committed history and not the working tree, so an uncommitted edit to a skill file is invisible to it

### `pnpm check:codex-skill`

Refuses the run if the skill cannot be read or if the transform no longer applies to it — a rewording it can no longer find is a refusal, not a pass. Add --write to regenerate the file instead of comparing it, which is the only way the file is ever changed

### `pnpm check:attribution`

It states no pattern of its own — it reads them out of .github/workflows/ci.yml, which §4 exempts, so that a second copy does not become a fourth file needing exemption. It performs the one shell expansion the detector's values use and refuses by name every other spelling it knows of — which is an enumeration and not a proof: two spellings have been found missing from it by a reader rather than by anything that runs, and a third would be performed by the detector's shell and left literal here, so the two would search with different patterns. Refuses the run if the detector cannot be read or is reworded past what it can parse, if a value still names an expansion it does not perform, if any branch of a pattern cannot be sampled or does not match the sample built from it, if the base cannot be resolved, or if a surface came back empty where emptiness is not an answer. No refusal prints a pattern. VELVE_ATTRIBUTION_BASE names a base other than origin/main. It reads committed history for the messages and the diff and the working tree for the tree scan, so an uncommitted marker is found and an uncommitted commit message is not a thing that exists. What it cannot see is a branch the detector no longer states, because every branch it proves is derived from the detector; test/gate-commands.test.ts states that shape where it is not derived from it, and is what fails on a deletion. A spelling missing from the enumeration above lands on a second guard rather than on nothing: what it leaves behind is a literal $ mid-branch, the sample built for that branch drops it, and the branch then fails against its own sample. That holds on an engine treating a mid-pattern $ as an anchor or as an ordinary character, and not on one that ignores it. Measured on BSD grep 2.6.0-FreeBSD, which is what this machine resolves grep to; not measured on GNU grep, which is what CI runs

### `pnpm check:release-tag`

Takes the tag and the dist-tag as arguments, or reads them from GITHUB_REF_NAME and VELVE_RELEASE_DIST_TAG. Refuses the run if either is missing or the manifest cannot be read as an object — an unchecked tag is not a matching one. It also asks VELVE_REGISTRY, npm's by default, whether the package is published at all: where it is not and the version is a prerelease, it reports before the publish that npm will point latest at it whatever --tag says, which is the one case the latest clause cannot see from the dist-tag alone (E-1771). That is a report and not a refusal, so a first publish stays possible; a registry it could not ask is told apart from one that said absent and reported as unknown. release.yml runs it before the publish; pnpm gate does not, because an ordinary branch carries no tag for it to check and it would refuse every one of them

### `pnpm run release-dist-tag`

release.yml runs it in a job of its own and hands the answer to the three jobs that need it, so the tag is derived once rather than written down in three places (E-1777). It is invoked through `pnpm run` and named so that no pnpm subcommand shadows it: `pnpm dist-tag` runs pnpm's own registry query instead and says nothing about it (E-1881). It writes $GITHUB_OUTPUT itself when that variable is set, so a refusal is the step's exit status; refuses a manifest it cannot read as an object or a version that is not semantic

### `pnpm check:published-version`

Takes the dist-tag as its argument; VELVE_REGISTRY names a registry other than npm's and VELVE_REGISTRY_DEADLINE_MS how long it polls for a publish to become readable. Tells a registry saying the version is absent from one that could not be asked, and refuses only on the second. release.yml runs it after the publish; pnpm gate does not, because a version nobody has published has nothing to resolve
