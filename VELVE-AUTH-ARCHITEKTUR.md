# Velve Auth — Zielarchitektur

**Stand:** 7. September 2026
**Grundlage:** Better Auth v1.7.3, Commit `e025ce665c5e00df6ca8d9f738ac49fa9dcf1b41`, vollständig gelesen
**Ergebnis:** Zielarchitektur und Bauauftrag. Kein Code.

---

## Kurzfassung

Velve Auth ist eine Anmeldebibliothek für TypeScript und PostgreSQL, die im Prozess der Anwendung läuft. Die Nutzer liegen in der Datenbank des Betreibers, kein Dienst eines Dritten ist beteiligt. Sie beantwortet ausschließlich, **wer angemeldet ist**.

**Die Grundlage.** Better Auth wurde vollständig gelesen: 168.194 Zeilen TypeScript ohne Tests, davon 56.097 unter `packages/better-auth/src`, dazu die Dokumentation, das Plugin-System, alle Datenbankadapter, die Migrationsanleitungen und die veröffentlichten Sicherheitsadvisories. Vier Agents haben getrennt gelesen, ihre Befunde wurden gegeneinander geprüft; zehn Widersprüche wurden im Quelltext geklärt (W1–W10). Ergebnis: **618 Funktionen** in dreizehn Bereichen, **78 belegte Lücken**, **33 Sicherheitsadvisories**.

**Die drei Befunde, die den Entwurf bestimmen.**

*Erstens: der Passwortpfad ist eine Sackgasse.* Better Auth speichert `salt_hex:hash_hex` — ohne Algorithmus- und ohne Parameterkennung. Es gibt keinen Rehash bei der Anmeldung (`grep -rn "rehash\|needsRehash"` im gesamten Repository: null Treffer), keine Verifiziererkette, und Argon2id wurde als Vorgabe abgelehnt (Issue #6608, „closed as not planned"). Die Folge steht in den eigenen Migrationsanleitungen: Wer von Supabase, Clerk oder Auth0 kommt, soll die Bibliothek global auf `bcrypt(10)` umstellen — also **auch für alle neuen Nutzer, dauerhaft** (`docs/.../supabase-migration-guide.mdx:971`, wortgleich in `auth0-migration-guide.mdx:595`, sinngleich in `clerk-migration-guide.mdx:47`). Für Firebase, die einzige Quelle mit nicht-trivialem Hash, gibt es gar keine Anleitung.

*Zweitens: die E-Mail ist Pflicht und wird notfalls erfunden.* `user.email` ist `NOT NULL UNIQUE`; die Dokumentation räumt es ein (`concepts/oauth.mdx:409`), Issue #9124 ist offen. Der Ausweg ist kein Ratschlag, sondern Produktionscode: `createPlaceholderEmail` (`core/src/utils/email.ts:24`) erzeugt Adressen der Form `<id>@<ns>.placeholder.invalid` und wird an neun Stellen in acht Modulen aufgerufen — Roblox, TikTok, WeChat, Reddit, Twitter, SIWE, Anonymous, Entra ID. An diese Adressen kann kein Plugin je etwas senden.

*Drittens: die Sicherheitshistorie hat ein Muster.* Von 33 Advisories entfallen **zehn** auf dieselbe Ursache — eine Autorisierungsprüfung auf einem nutzerkontrollierten Schlüssel ohne Eigentümerbindung, mechanisch: die fehlende Zeile `AND user_id = :actor`. Fünf entfallen auf unvollständige URL- und Origin-Prüfung, drei auf unverifizierte E-Mail als Identitätsbeweis (jedes Mal eine Kontoübernahme, zweimal mit CVSS 8,3). Die höchsten Einstufungen erreichen 9,9 (SCIM-Namensraumkollision) und 9,6 (SSRF im SSO-Plugin); die schwerste im Kern-Anmeldepfad ist 9,1 und entstand aus einer Funktionskombination: Der Cookie-Cache legte die Sitzung ab, bevor der zweite Faktor geprüft war. Viele der schwersten Einstufungen hingen an einem **Vorgabewert**, nicht an einem Fehler.

**Die Entscheidungen, die daraus folgen.**

| | Better Auth | Velve Auth |
|---|---|---|
| Passwortspeicher | `salt:hash`, kein Marker | kanonischer PHC-String, verschlüsselt abgelegt |
| Verfahren | eines, global austauschbar | Argon2id erzeugen, sechs Präfixfamilien prüfen |
| Rehash | keiner | still nach der Anmeldung, per Vergleich-und-Tausch |
| Identität | E-Mail zwingend | drei Konfigurationen, E-Mail nirgends Pflicht |
| Sitzungstoken | Klartext in der Datenbank | nur `sha256` gespeichert |
| Sitzungsfrist | ein gleitendes Fenster | Leerlauf **und** absolut |
| Cookie-Cache | Vorgabe `compact`, unverschlüsselt | keiner, in keiner Variante |
| Reset widerruft Sitzungen | Option ohne Vorgabewert | immer, ohne Schalter |
| Cookie-Präfix | `__Host-` definiert, nie gesetzt | `__Host-` durchgängig |
| Verknüpfung | E-Mail als Schlüssel möglich | ausschließlich `(provider, subject)` |
| Plugins | dürfen Kern und fremde Plugins überschreiben | aufgezählte Punkte, Kollision ist Startfehler |
| Datenbanken | elf Adapter, kleinster Nenner | PostgreSQL, handgeschriebenes SQL |
| Migration | fünf Anleitungen, drei davon mit bcrypt-Umstellung | Kernfunktion, fünf Quellen, Trockenlauf verpflichtend |
| Laufzeit | scrypt über Export-Bedingung | reines TypeScript, austauschbare Rechenmaschine |

**Der Umfang.** Von 618 Funktionen werden 111 übernommen, 157 anders gelöst, **322 weggelassen** und 28 übertroffen. Die Weglassungen sind keine Sparmaßnahme: 133 entfallen auf Autorisierung und die Rolle als Identitätsanbieter — ein eigenes Produkt —, 32 auf Sitzungsvarianten, die dem Widerrufsversprechen widersprechen, 28 auf Datenbankabstraktion, die mit der Festlegung auf PostgreSQL entfällt. **36 Fähigkeiten** haben in Better Auth kein Gegenstück.

**Die Laufzeit.** Reines TypeScript, kein eigenes Rust/WASM-Modul, sechs Abhängigkeiten ohne native Bindungen. Gemessen auf 2 vCPU, also Größenordnung statt Absolutwert: Argon2id bei OWASP-Parametern kostet 263 ms in JavaScript gegen 76 ms in WASM — aber WASM scheitert in Cloudflare Workers an `Wasm code generation disallowed by embedder` und ist auf Caprock unerprobt (SCHÄTZUNG), und ein eigenes Rust-Modul wäre gegenüber fertigem WASM nur 1,6-mal schneller, um den Preis einer zweiten Werkzeugkette und eines unprüfbaren Binärblobs. Der entscheidende Befund: `@noble/hashes`, `hash-wasm` und eine Rust-WASI-Variante erzeugen **bytegleiche** Argon2id-Hashes. Die Rechenmaschine ist damit austauschbar, ohne einen einzigen gespeicherten Hash anzufassen.

**Die Absicherung.** 123 Sicherheitsanforderungen in achtzehn Fehlerklassen, jede mit mindestens einem Testfall und einer vorab festgelegten Zahl als Schwelle; 127 Testfälle, von denen 109 jeden Commit blockieren. Fünfzehn der 33 Better-Auth-Advisories sind unmittelbar auf Velve Auth übertragbar und werden von benannten Anforderungen ausgeschlossen; achtzehn sind nicht anwendbar, weil die betroffene Funktion nicht existiert.

**Ehrlich benannte Grenzen.** In der Konfiguration `username` gibt es kein Zurücksetzen per E-Mail — die Bibliothek verweigert dort den Start, wenn keine Wiederherstellungscodes konfiguriert sind. Benutzernamen sind per Definition aufzählbar, sobald eine Verfügbarkeitsprüfung angeboten wird; das steht im Datenblatt statt als stille Lücke im Code. Der verschlüsselte Kennwortspeicher bedeutet: Schlüsselverlust ist Kennwortverlust. Importierte bcrypt-Hashes prüfen nur die ersten 72 Byte, bis der Rehash sie ersetzt hat. Und ob Node auf Caprock startet und der gewählte PostgreSQL-Treiber dort funktioniert, ist die einzige nennenswerte ungeprüfte Annahme des ganzen Entwurfs.

---

## Inhalt

1. Funktionsvergleich — jede der 618 Better-Auth-Funktionen mit Entscheidung und Begründung
2. Sprache und Laufzeit — die Bewertung, die Messungen, die Empfehlung
3. Zielarchitektur — Paketstruktur, Schema, Sitzungen, Prüfpfad, Identität, zweiter Faktor, Tokens, Schlüssel, Ratenbegrenzung, Drittanbieter, Plugins, öffentliche Schnittstelle, Fehlerbehandlung, entschiedene Lücken
4. Migrationsmodul — fünf Quellen, je Quellschema, Zuordnung, Hash-Übernahme, Verluste, Folgearbeit
5. Sicherheitsanforderungen — 123 Anforderungen in achtzehn Fehlerklassen, mit Abdeckungstabelle der 33 Advisories
6. Prüfplan — 127 Testfälle mit vorab festgelegten Schwellen
7. Entscheidungsprotokoll — E-01 bis E-46, Ausgangsbestand für die Fallstudie

Der Bauauftrag liegt getrennt als `CLAUDE-CODE-AUFTRAG.md`.

---
## 1. Funktionsvergleich

Grundlage ist die Inventur `findings/08-funktionsinventur.md` (618 Funktionen, Abschnitte A–M,
Better Auth v1.7.3, Commit `e025ce6`) und die Zielarchitektur in Abschnitt 3 einschließlich der entschiedenen Lücken (3.16) und der Schemaänderungen (3.17).
Die Gliederung folgt der Inventur. Jede Zeile trägt genau eine der vier Einordnungen
**Übernehmen**, **Anders lösen**, **Weglassen**, **Übertreffen**.

Gruppiert wird ausschließlich dort, wo der Auftrag es erlaubt: die 36 eingebauten OAuth-Anbieter
(C1–C36), die 10 vorkonfigurierten Generic-OAuth-Helfer (C37–C46) und die Framework-Zeilen (K).
Jede Gruppe steht als eigene Zeile und nennt ihre Einzelposten. Alles andere ist einzeln
aufgeführt. Die Plugins sind zusätzlich Plugin für Plugin in Abschnitt G.2 aufgeführt.

Fundstellen sind relativ zu `/home/claude/better-auth/` und stammen aus den Vorberichten. Eine Begründung, die mit „Wie Xn" oder „Entfällt mit Xn" beginnt, übernimmt die Begründung der Zeile Xn und nennt dahinter, was für diese Zeile hinzukommt.

---

### A. Kern-Authentifizierung (52)

| Funktion | Better Auth | Velve Auth | Begründung |
|---|---|---|---|
| A1 Registrierung mit Kennwort | `POST /sign-up/email`, legt `user` + `account(providerId:"credential")` an (`api/routes/sign-up.ts`) | Übernehmen | `auth.signUp()` legt `velve.user` + `velve.password_credential` in einer Transaktion an. Der Anmeldename kommt aus der Identitätskonfiguration, das Eingabeschema der Route wird daraus abgeleitet. |
| A2 `emailAndPassword.enabled` | Globaler Schalter, Vorgabe `false` (`core/src/types/init-options.ts:777`) | Anders lösen | Kein boolescher Schalter: der Kennwortpfad existiert genau dann, wenn die Option `password` gesetzt ist. Ein abgeschalteter Pfad hat keine Route und keine Servermethode, statt eine Route zu haben, die 4xx antwortet. |
| A3 `disableSignUp` | Verbietet Neuregistrierung über den Credential-Pfad (`init-options.ts:783`) | Übernehmen | `signUp: false` entfernt die Registrierungsroute aus der Routendeklaration. |
| A4 `autoSignIn` | Session direkt nach Registrierung, Vorgabe an (`init-options.ts:855`) | Übernehmen | Gleiches Verhalten, ohne Schalter: Die Registrierung liefert immer eine Sitzung, auch bei unbestätigter Adresse (A5). |
| A5 `requireEmailVerification` | Verweigert Session, solange die E-Mail unbestätigt ist (`init-options.ts:791`) | Anders lösen | Es gibt die Option nicht. Anmeldung und Registrierung liefern immer eine Sitzung; `User.emailVerifiedAt` sagt der Anwendung, ob die Adresse bestätigt ist, und die Anwendung entscheidet, was eine unbestätigte Sitzung darf. Eine Anmeldesperre wäre erstens ein Aufzählungskanal (S-TIM-7) und zweitens eine Sackgasse: `email.requestVerification` verlangt eine Sitzung, und wer die Registrierungssitzung verloren hat, käme ohne Anmeldung nie wieder an eine Bestätigungsmail (Abschnitt 3.15, B.5). |
| A6 Passwort-Längenpolitik | `minPasswordLength` 8 / `maxPasswordLength` 128 (`context/create-context.ts:372-373`) | Anders lösen | Mindestlänge 8 nach L-7, nach oben konfigurierbar; die Obergrenze ist keine Politik, sondern eine harte Sicherheitsgrenze von 4096 Byte, geprüft **vor** jedem KDF-Aufruf (Abschnitt 3.3, Schritt 1). Better Auth prüft bei `/sign-in/email` gar nicht vor dem KDF (Inventur N1-9). |
| A7 Passwort-Hashing (scrypt) | scrypt N=16384, r=16, p=1, dkLen=64 als einziges Verfahren (`crypto/password.ts:8-23` re-exportiert nur; Parameter und Format belegt in `crypto/password.test.ts:68-80` und `@better-auth/utils@0.5.0 dist/password.node.mjs:3-30`) | Übertreffen | Argon2id (m=19456, t=2, p=1) ist Standard; scrypt bleibt als Prüfverfahren erhalten. Es gibt nicht ein Verfahren, sondern eine Weiche über sechs Präfixfamilien (Abschnitt 3.3). |
| A8 Runtime-Auswahl der scrypt-Implementierung | `node:crypto` auf Node/Bun/Deno, `@noble/hashes` sonst (`crypto/password.ts:1-6`) | Anders lösen | `@noble/hashes` ist der Pflichtpfad, damit das Verhalten überall identisch ist. `hash-wasm` ist eine optionale Peer-Abhängigkeit als Beschleuniger mit bitgleicher Ausgabe; ein Wechsel erfordert keine Migration (Abschnitt 2.1). |
| A9 Hash-Speicherformat `salt:hex` | 161-Zeichen-String ohne Algorithmus-, Parameter- oder Versionskennung (`crypto/password.test.ts:11`) | Übertreffen | Kanonischer PHC-String mit Verfahren und Parametern, in der Spalte AES-256-GCM-verschlüsselt unter dem Zweck `password-enc` (L-2). Eine Parameteränderung entwertet keine Bestände mehr, sondern erzeugt nur `needsRehash`. |
| A10 Austauschbares Hashing | `password.hash` / `.verify` ersetzen die Vorgabe vollständig (`create-context.ts:368-376`) | Weglassen | Niemand übernimmt das, und das ist richtig: ein austauschbarer Verifier hebelt Verfahrensweiche, Rehash-Politik, Dummy-Hash-Zeitverhalten und den Semaphor über die KDF-Aufrufe zugleich aus. Ein Plugin darf den Passwort-Verifier nicht ersetzen (Abschnitt 3.11). Fremde Bestände kommen über `@velve/auth/import` in PHC-Form herein. |
| A11 Anmeldung mit Kennwort | `POST /sign-in/email` (`api/routes/sign-in.ts:406-620`) | Übernehmen | `auth.signIn.password()`; in der Konfiguration `username_email` akzeptiert dieselbe Route beide Anmeldenamen. |
| A12 Form-CSRF auf Credential-Routen | Fetch-Metadata-Schutz auf `/sign-in/email` und `/sign-up/email` (`api/middlewares/origin-check.ts:303-375`) | Anders lösen | Eine einzige Origin-/Fetch-Metadata-Prüfung vor der Routendeklaration, nicht als Sonderfall für zwei Routen — und sie läuft auch bei direkten Serveraufrufen. Bei Better Auth sehen `middlewares`/`onRequest` den Pfad `auth.api.*` nicht (`api/to-auth-endpoints.ts:88-116`). |
| A13 Dummy-Hash bei unbekanntem Nutzer | Rechnet trotzdem einen Hash (`sign-in.ts:536-556`) | Übernehmen | Dummy-PHC mit den **konfigurierten** Standardparametern, derselbe Codepfad, derselbe Semaphor (Abschnitt 3.3, Schritt 2). |
| A14 Synthetische Duplikat-Antwort bei Sign-up | Erfindet eine plausible Erfolgsantwort, aber nur bei `requireEmailVerification` oder `autoSignIn:false` (`sign-up.ts:236-305`) | Anders lösen | Keine Sonderbedingung und kein erfundenes User-Objekt: die Registrierung antwortet immer byteweise identisch, der Unterschied wandert vollständig in die versendete Nachricht (Abschnitt 3.13). |
| A15 `customSyntheticUser` | Erlaubt, das synthetische User-Objekt inkl. Plugin-Feldern selbst zu bauen (`init-options.ts:899`) | Weglassen | Niemand. Die Option existiert nur, weil die Duplikat-Antwort einen User-Körper enthält; Velve Auth gibt bei der Registrierung keinen aus, also gibt es nichts zu fälschen. |
| A16 `onExistingUserSignUp` | Callback bei Registrierung auf vergebene Adresse (`init-options.ts:868`) | Anders lösen | Kein eigener Hook: der Fall erreicht die Anwendung über denselben `email.send`-Callback wie alle anderen Nachrichten, mit einer eigenen Nachrichtenart und einem Anmelde- statt Bestätigungslink (Abschnitt 3.13). |
| A17 `EMAIL_NOT_VERIFIED`-Abbruch | Blockt die Anmeldung nach erfolgreicher Kennwortprüfung (`sign-in.ts:569-601`) | Anders lösen | Kein Abbruch und kein Fehlercode (A5): Die Anmeldung liefert die Sitzung, und `User.emailVerifiedAt` trägt den Zustand. Der Abbruch nach der Kennwortprüfung war ein Statuscode-Orakel für die Existenz bestätigter Konten (S-TIM-7). |
| A18 `sendOnSignIn` | Verifikationsmail bei Anmeldung eines unverifizierten Kontos (`init-options.ts:736`) | Übernehmen | Unverändert, über den `email.send`-Callback. |
| A19 Abmeldung | `POST /sign-out` löscht Session und Cookies (`api/routes/sign-out.ts:36-100`) | Übernehmen | `DELETE` der Sitzungszeile plus Löschen des `__Host-`-Cookies. |
| A20 RP-initiated Logout beim Sign-out | Baut die `end_session`-URL eines verknüpften OIDC-Providers und redirected (`sign-out.ts:101-164`) | Weglassen | Die Anwendung übernimmt: die Claims des Anbieters liegen in `velve.identity.profile`, die Abmeldung beim Anbieter ist eine Produktentscheidung und keine Aufgabe der Sitzungsverwaltung. |
| A21 Verifikationstoken erzeugen | HS256-JWT über `secret` mit `{email, updateTo?}` (`email-verification.ts:17-43`) | Anders lösen | Einmal-Artefakt in `velve.one_time_token` mit `sha256(token)` als Primärschlüssel, konsumiert per `DELETE … RETURNING` (Abschnitt 3.7). Better Auths Token ist zustandslos, wiederverwendbar und nicht an eine Nutzer-ID gebunden (Inventur N3-21). |
| A22 `GET /verify-email` | Prüft das JWT, setzt `emailVerified`, redirected (`email-verification.ts:225-340`) | Übernehmen | Als `POST /email/redeem-verification` (Abschnitt 3.15): konsumiert das Artefakt atomar, setzt `email_verified_at` und antwortet mit `{ user }`. Die Bibliothek baut keine URL und leitet nicht um; die Seite, auf der der Link landet, gehört der Anwendung. |
| A23 `POST /send-verification-email` | Auch unauthentifiziert, mit harter 500-ms-Mindestlaufzeit (`email-verification.ts:80-220`) | Anders lösen | Die Gleichförmigkeit kommt aus byteweise identischen Antworten und dem Token-Bucket, nicht aus einer künstlichen Mindestlaufzeit, die unter Last selbst zum Signal wird. |
| A24 `sendVerificationEmail`-Callback | Pflicht-Callback, kein eingebauter Mailer (`init-options.ts:702`) | Übernehmen | Ein einziger `email.send(message)`-Callback für alle Nachrichtenarten (Abschnitt 3.12). Kein eingebauter Versand — ausdrücklich (Abschnitt 3.14). |
| A25 `sendOnSignUp` | Verifikationsmail nach der Registrierung (`init-options.ts:729`) | Übernehmen | Unverändert. |
| A26 `autoSignInAfterVerification` | Session beim Anklicken des Verifikationslinks (`email-verification.ts:507-535`) | Anders lösen | `email.redeemVerification` setzt `email_verified_at` und liefert `{ user }`, aber keine Sitzung — ein Bestätigungslink ist kein Anmeldeweg. Genau diese Gleichsetzung machte Better Auths wiederverwendbares Verifikations-JWT zum dauerhaften Login (Abschnitt 1, A25). Die Sitzung hat der Nutzer bereits aus Registrierung oder Anmeldung (A5). |
| A27 `emailVerification.expiresIn` | Eine Option, Vorgabe 3600 s (`init-options.ts:746`) | Anders lösen | Fristen sind zweckgebunden festgelegt (Bestätigung 24 h, Reset 1 h, Wechsel 1 h, Magic Link 10 min, Abschnitt 3.7) statt über eine gemeinsame Option, die für den kurzlebigsten Zweck immer zu lang ist. |
| A28 `beforeEmailVerification` / `afterEmailVerification` | Zwei Hooks um den Verifikationsvorgang (`init-options.ts:752,761`) | Weglassen | Die Anwendung übernimmt: die Erweiterungspunkte sind aufgezählt (Abschnitt 3.11) und enthalten keine Verifikations-Hooks. Der Rückgabewert der Route sagt dasselbe, ohne dass Fremdcode im Vorgang steht. |
| A29 Kennwort-Reset anfordern | `POST /request-password-reset`, Antwort immer `{status:true}` (`api/routes/password.ts:35-150`) | Übernehmen | Als `POST /password/request-reset` mit Antwort 204 ohne Körper, Artefakt mit `purpose='password_reset'`, Frist 1 h; ein neu angeforderter Token löscht die vorherigen desselben Nutzers. |
| A30 Reset-Link-Einstieg | `GET /reset-password/:token` redirected mit `?token=` (`password.ts:152-227`) | Übernehmen | Der Einstieg per Link bleibt; die Landeseite ist eine Seite der Anwendung, die das Token an `POST /password/redeem-reset` weiterreicht. Einen umleitenden Endpunkt gibt es nicht, weil die Bibliothek keine URLs baut (Abschnitt 3.15, A.7) — und damit auch keine, die sie validieren müsste. |
| A31 Kennwort zurücksetzen | `POST /reset-password`, Token atomar konsumiert (`password.ts:229-335`) | Übernehmen | Als `POST /password/redeem-reset`: Konsum und Kennwortschreiben in einer Transaktion; die Antwort trägt ein neues Sitzungstoken, alle anderen Sitzungen sind widerrufen (A34). |
| A32 `resetPasswordTokenExpiresIn` | Option, Vorgabe 3600 s (`init-options.ts:826`) | Anders lösen | Feste Frist von 1 h, siehe A27. |
| A33 `onPasswordReset` | Callback nach erfolgreichem Reset (`init-options.ts:831`) | Weglassen | Die Anwendung übernimmt: sie ruft die Route selbst auf bzw. bekommt deren Ergebnis. Ein zusätzlicher Callback bringt hier keinen Zustand, den der Aufrufer nicht schon hat. |
| A34 `revokeSessionsOnPasswordReset` | Widerruft alle Sessions — **Vorgabe aus** (`password.ts:328-330`) | Übertreffen | Kennwort-Reset und Kennwortänderung widerrufen alle anderen Sitzungen. Das ist kein Schalter (Abschnitt 3.5). Ein Reset, der die Sitzung des Angreifers stehen lässt, ist kein Reset. |
| A35 Kennwort ändern | `POST /change-password` mit `currentPassword`, optional `revokeOtherSessions` (`update-user.ts:147-310`) | Übernehmen | Gleiche Route; der Widerruf ist obligatorisch (A34), die aktuelle Sitzung wird neu vergeben. |
| A36 Kennwort setzen ohne altes | `POST /set-password`, serverOnly (`update-user.ts:314-345`) | Übernehmen | Als Servermethode ohne HTTP-Route, deklariert mit `http: false` in derselben Routendeklaration (Abschnitt 3.12). |
| A37 Kennwort verifizieren | `POST /verify-password`, serverOnly (`password.ts:337-360`) | Übernehmen | Ebenfalls als Servermethode; durchläuft dieselbe Weiche, denselben Semaphor und dieselbe Ratenbegrenzung. |
| A38 E-Mail-Wechsel anstoßen | `POST /change-email` mit Dummy-Token bei existierender Zieladresse (`update-user.ts:668-800`) | Übernehmen | Gleiche Route; der Enumerationsschutz ist hier kein Sonderpfad, sondern die allgemeine Regel byteweise identischer Antworten. |
| A39 Zweistufiger E-Mail-Wechsel | `sendChangeEmailConfirmation` von der alten Adresse (`init-options.ts:970`) | Übernehmen | Unverändert: Bestätigung von der alten, danach Bestätigung der neuen Adresse, beides als Einmal-Artefakte. |
| A40 `updateEmailWithoutVerification` | Ändert die E-Mail sofort, wenn die alte unverifiziert war (`init-options.ts:983`) | Weglassen | Niemand. Genau dieser Zustand — ein unverifiziertes Konto, das jemand vorab angelegt hat — ist die Ursache von GHSA-qq9h-g4jm-xgf3 und CVE-2026-53516. Der Wechsel läuft immer über ein Artefakt an die neue Adresse. |
| A41 `user.changeEmail.enabled` | Schaltet den Wechsel frei (`init-options.ts:964`) | Übernehmen | Option bleibt; in der Konfiguration `username` existiert die Route nicht. |
| A42 Kontolöschung anstoßen | `POST /delete-user` mit Passwort, Token oder direkt (`update-user.ts:370-560`) | Übernehmen | Gleiche Route; „direkt" nur als Servermethode, nie über HTTP ohne Nachweis. |
| A43 Kontolöschung bestätigen | `GET /delete-user/callback` (`update-user.ts:565-660`) | Übernehmen | Einmal-Artefakt mit eigenem `purpose`; die Löschung kaskadiert über die Fremdschlüssel. |
| A44 `sendDeleteAccountVerification` | Callback für die Lösch-Bestätigungsmail (`init-options.ts:1000`) | Übernehmen | Über denselben `email.send`-Callback als eigene Nachrichtenart. |
| A45 `beforeDelete` / `afterDelete` | Hooks um die Kontolöschung (`init-options.ts:1013,1019`) | Weglassen | Die Anwendung übernimmt: ihre eigenen Tabellen hängen per `ON DELETE CASCADE` an `velve.user`, oder sie räumt vor dem Aufruf auf. Die Erweiterungspunkte sind aufgezählt und enthalten keinen Löschhook. |
| A46 `deleteTokenExpiresIn` | Gültigkeit des Lösch-Tokens (`init-options.ts:1025`) | Anders lösen | Feste, zweckgebundene Frist, siehe A27. |
| A47 Nutzerdaten ändern | `POST /update-user` für `name`, `image`, `additionalFields` (`update-user.ts:60-145`) | Weglassen | Die Anwendung übernimmt. Velve Auth hält keine Profildaten (Abschnitt 3.14); `name` und `image` gehören in eine Anwendungstabelle mit `user_id`-Fremdschlüssel. Eine generische Schreibroute auf die Nutzerzeile ist außerdem der Weg, über den Plugin-Felder beschreibbar wurden (Inventur N5-60). |
| A48 `checkPassword`-Helfer | Zentraler Verify-Helfer, hasht auch ohne Credential-Account (`utils/password.ts:24-44`) | Übernehmen | Der Prüfpfad ist genau eine Funktion in `core/password/`, und sie ist der einzige Ort, an dem ein KDF aufgerufen wird. |
| A49 Leak-Prüfung (HaveIBeenPwned) | k-Anonymity gegen HIBP, fail-closed, ersetzt `ctx.password.hash` (`plugins/haveibeenpwned/index.ts:129-150`) | Weglassen | Die Anwendung übernimmt: sie prüft das Kennwort, bevor sie `signUp`/`resetPassword` aufruft. Ein Plugin kann es nicht, weil der Kern kein Klartextkennwort an Hooks reicht und der Verifier nicht ersetzbar ist (Abschnitt 3.11) — und ein Nachbau, der einen Netzwerkaufruf in den Anmeldepfad legt, macht die Anmeldung von einem fremden Dienst abhängig. |
| A50 CAPTCHA-Zwang auf Auth-Routen | Turnstile/reCAPTCHA/hCaptcha/CaptchaFox als `onRequest` (`plugins/captcha/`) | Weglassen | Die Anwendung übernimmt, vor ihren eigenen Formularen. Better Auths Umsetzung als `onRequest` wirkt bei direkten Serveraufrufen gar nicht (`api/to-auth-endpoints.ts:88-116`) — ein Nachbau würde eine Schutzwirkung suggerieren, die auf dem Servermethodenpfad nicht besteht. |
| A51 Health-Endpunkt `GET /ok` | Liefert `{ok:true}` (`api/routes/ok.ts`) | Weglassen | Die Anwendung übernimmt. Ein Health-Check gehört zur Anwendung, nicht zu einer Bibliothek, die im selben Prozess läuft. |
| A52 Fehlerseite `GET /error` | HTML in Dev, 302 in Prod (`api/routes/error.ts:374-437`) | Weglassen | Niemand rendert HTML. Velve Auth liefert stabile Fehlercodes (Abschnitt 3.13); die Anwendung stellt sie dar. Das Zurückspiegeln eines Query-Parameters als HTML war GHSA-9x4v-xfq5-m8x5. |

**A: Übernehmen 23 · Anders lösen 14 · Weglassen 12 · Übertreffen 3**

---

### B. Sitzungen (46)

| Funktion | Better Auth | Velve Auth | Begründung |
|---|---|---|---|
| B1 Session-Erzeugung | `createSession` legt Zeile mit Token, `expiresAt`, IP, User-Agent an (`db/internal-adapter.ts:483-519`) | Übernehmen | Gleiche Struktur, ergänzt um `factors`, zwei Fristen und `token_sha256` statt Klartext. |
| B2 Session-Token | 32 Zeichen aus 62er-Alphabet, **im Klartext gespeichert** (`internal-adapter.ts:513`) | Übertreffen | 32 Byte aus `crypto.getRandomValues` (256 bit), gespeichert wird ausschließlich `sha256(token)`. Ein Datenbankleck gibt keine Sitzungen preis (Inventur N3-19). |
| B3 Session-Fixierungsschutz | Übergebene IDs werden ignoriert (`internal-adapter.ts:483-487`) | Übernehmen | Verschärft: Neuvergabe ist immer `INSERT` + `DELETE` in einer Transaktion; ein `UPDATE velve.session SET user_id` existiert nicht und wird per Lint-Regel und Datenbank-Trigger verhindert (Abschnitt 3.5). |
| B4 IP- und User-Agent-Erfassung | Werden gespeichert, aber nie zur Validierung benutzt (`internal-adapter.ts:501-502`) | Übernehmen | Gespeichert wird per Vorgabe gekürzt (`sessionMetadata: "truncated"`, L-10): IPv4 auf `/24`, IPv6 auf `/64`, User-Agent auf Browser- und Systemfamilie; die volle Adresse nur auf ausdrückliche Einstellung, `ip` als `inet` statt `text`. Auch hier keine Validierung: eine an die Adresse gebundene Sitzung bricht bei jedem Mobilfunkwechsel. |
| B5 `session.expiresIn` | Eine Lebensdauer, Vorgabe 7 Tage (`create-context.ts:313`) | Anders lösen | Zwei Fristen statt einer: `idle_expires_at` (Standard 7 Tage, verlängerbar) und `absolute_expires_at` (Standard 30 Tage, nie verlängert). Eine einzige, gleitende Frist hat keine Obergrenze. |
| B6 `updateAge` (Sliding Window) | Verlängert `expiresAt` bei Zugriff, Vorgabe alle 24 h (`api/routes/session.ts:324-412`) | Anders lösen | Verlängert wird nur die Leerlauffrist, höchstens einmal pro Stunde geschrieben; die absolute Frist bleibt unberührt. |
| B7 `session.freshAge` | Definiert „frische" Session, Vorgabe 1 Tag (`session.ts:598-616`) | Anders lösen | `session.freshnessWindow` (Vorgabe 15 min) misst gegen `created_at`, nicht gegen die letzte Nutzung, und wird nur durch eine neue Anmeldung wiederhergestellt (Abschnitt 3.15, Abweichung 7). Welche Route Frische verlangt, steht als `freshness: "required"` in ihrer Deklaration; das Kennwortändern verlangt zusätzlich das aktuelle Kennwort. |
| B8 `freshSessionMiddleware` | Erzwingt Frische für sensible Endpunkte (`session.ts:598-616`) | Weglassen | Niemand als Middleware. Frische ist ein Feld der Routendeklaration (B7), nicht eine Schicht, die man auf eine Route vergessen kann; und Routen, die einen Zustand unumkehrbar ändern, verlangen zusätzlich einen Nachweis (Kennwort oder Faktorcode), weil ein Zeitfenster nicht gegen einen Angreifer schützt, der gerade erst übernommen hat. |
| B9 `sensitiveSessionMiddleware` | Erzwingt eine autoritative Session aus DB/Secondary Storage, umgeht den Cookie-Cache (`session.ts:527-572`) | Weglassen | Niemand, und das ist der Punkt: die Middleware existiert nur, weil es einen Cache gibt. Ohne Cookie-Cache ist jede Auflösung autoritativ, und es gibt keine zweite Klasse von Routen, die man vergessen kann (vgl. GHSA-xg6x-h9c9-2m83). |
| B10 `disableSessionRefresh` | Schaltet die Verlängerung global ab (`session.ts:339-341`) | Weglassen | Niemand. Der Schalter existiert wegen der Schreiblast; die harte Grenze „höchstens ein Schreibvorgang pro Stunde und Sitzung" nimmt ihm den Zweck. |
| B11 `?disableRefresh=` je Request | Unterdrückt die Verlängerung für einen Aufruf (`cookies/session-store.ts:293-299`) | Weglassen | Niemand, gleiche Begründung wie B10. Ein Query-Parameter, der das Sitzungsverhalten ändert, ist außerdem angreiferkontrolliert. |
| B12 `setShouldSkipSessionRefresh` | Request-State-Schalter für Plugins/Server-Code (`api/state/should-session-refresh.ts:11-14`) | Weglassen | Niemand, gleiche Begründung. Ein Plugin darf ohnehin nicht in die Sitzungsauflösung eingreifen (Abschnitt 3.11). |
| B13 `deferSessionRefresh` | GET liefert `needsRefresh:true`, Schreiben per POST (`session.ts:75-84,350-365`) | Weglassen | Niemand. Der zweistufige Ablauf existiert nur, weil GET auf manchen Plattformen nicht schreiben darf; bei stündlicher Schreibgrenze ist der Schreibvorgang selten genug, um ihn direkt zu erledigen. |
| B14 `rememberMe: false` | 1 Tag, Session-Cookie ohne `maxAge`, plus `dont_remember`-Cookie (`cookies/index.ts:373-394`) | Anders lösen | Gleiche Wirkung ohne zweites Cookie: die kürzeren Fristen stehen in der Sitzungszeile, das Cookie wird ohne `Max-Age` gesetzt. Ein zusätzliches Cookie, das das Verhalten steuert, ist Zustand außerhalb der Datenbank. |
| B15 Session abfragen | `GET /get-session` liefert `{session,user}` oder `null` (`session.ts:60-460`) | Übernehmen | `auth.session.resolve(token)`: **eine** Abfrage mit Join auf `velve.user`, gefiltert nach beiden Fristen; `disabled_at` wird in derselben Abfrage gelesen und führt, wenn gesetzt, zu `account_disabled` statt zu einer Sitzung (Abschnitt 3.5, L-4). |
| B16 `?disableCookieCache=` | Erzwingt den Datenbankzugriff für einen Aufruf (`session.ts:110-135`) | Weglassen | Niemand — es gibt keinen Cache, den man umgehen müsste. |
| B17 Sessions auflisten | `GET /list-sessions` (`session.ts:620-670`) | Übernehmen | Liefert `created_at`, `last_used_at`, `ip`, `user_agent`, `factors`; nie das Token. |
| B18 Einzelne Session widerrufen | `POST /revoke-session` mit Ownership-Prüfung (`session.ts:676-753`) | Übernehmen | Unverändert, mit Eigentümerprüfung im `WHERE`-Prädikat statt in JavaScript. |
| B19 Alle Sessions widerrufen | `POST /revoke-sessions` (`session.ts:757-810`) | Übernehmen | Unverändert. |
| B20 Alle anderen Sessions widerrufen | `POST /revoke-other-sessions` (`session.ts:812-871`) | Übernehmen | Unverändert; zusätzlich der Vorgabepfad nach Kennwortänderung (A34). |
| B21 Session-Felder aktualisieren | `POST /update-session` schreibt `additionalFields` (`api/routes/update-session.ts`) | Weglassen | Die Anwendung übernimmt, in eigenen Tabellen. Eine generische Schreibroute auf die Sitzungszeile ist der Weg, über den Plugin-Felder von außen beschreibbar wurden — im Better-Auth-Code selbst als Problem markiert (`db/schema.ts:43-47`, Inventur N5-60). |
| B22 `session.additionalFields` | Eigene Spalten an der Session-Tabelle (`core/src/db/get-tables.ts:190-191`) | Weglassen | Die Anwendung bzw. ein Plugin übernimmt, in einer eigenen Tabelle mit Präfix `<plugin-id>_` im Schema `velve` (Abschnitt 3.11). Kerntabellen bekommen keine Fremdspalten. |
| B23 Cookie-Cache aktivieren | `session.cookieCache.enabled` legt die Session in ein zweites Cookie (`cookies/index.ts:196-246`) | Weglassen | Niemand, ausdrücklich. Autorisierungsentscheidungen werden nie aus einem Cache beantwortet — daran hing GHSA-xg6x-h9c9-2m83 (CVSS 9.1, 2FA-Bypass, weil die Session vor der Zweitfaktor-Prüfung im Cache lag). |
| B24 Cookie-Cache-Strategie `compact` | base64url(JSON) + HMAC, **unverschlüsselt**, Vorgabe (`cookies/index.ts:223-241`) | Weglassen | Entfällt mit B23. Zusätzlich: die Vorgabe legt die Nutzerzeile lesbar im Browser ab. |
| B25 Cookie-Cache-Strategie `jwt` | HS256-JWT über `secret` (`cookies/index.ts:214-222`) | Weglassen | Entfällt mit B23. Ein signiertes JWT im Cookie ist eine Sitzungsaussage, die nach dem Widerruf in der Datenbank weiterlebt — dieselbe Klasse wie B27. |
| B26 Cookie-Cache-Strategie `jwe` | JWE `dir` + `A256CBC-HS512`, HKDF-Schlüssel (`crypto/jwt.ts:49-110`) | Weglassen | Entfällt mit B23. Verschlüsselung ändert nichts daran, dass die Entscheidung aus dem Cookie statt aus der Datenbank kommt. |
| B27 `cookieCache.maxAge` | Lebensdauer des Caches, Vorgabe 5 min (`cookies/index.ts:126`) | Weglassen | Entfällt mit B23. Diese Option ist die Zeit, die ein widerrufenes Token weiterlebt (Inventur N3-25). |
| B28 `cookieCache.refreshCache` | Erneuert den Cache bei jedem Zugriff (`init-options.ts:1120`) | Weglassen | Entfällt mit B23; ein Cache, der sich bei jedem Zugriff verlängert, macht seine Lebensdauer zur Sitzungsdauer. |
| B29 `cookieCache.version` | Versionsmarker, invalidiert alle Caches (`session.ts:139-154`) | Weglassen | Entfällt mit B23. Ein globaler Invalidierungsschalter ist der Beleg dafür, dass einzelner Widerruf nicht funktioniert. |
| B30 Cookie-Stückelung | Splittet Cache-Cookies >4050 Byte auf `name.0…name.99` (`cookies/session-store.ts:19-131`) | Weglassen | Niemand. Das Sitzungscookie trägt 43 Zeichen; ohne Cache gibt es nichts zu stückeln. |
| B31 Stateless Sessions | Ohne `database` automatisch `jwe`-Cookie-Cache mit 7 Tagen (`create-context.ts:102-117`) | Weglassen | Niemand, ausdrücklich. PostgreSQL ist Pflicht (Abschnitt 3.2); eine Sitzung, die nicht widerrufen werden kann, ist mit dem sofortigen Widerruf aus Abschnitt 3.5 unvereinbar. |
| B32 Secondary Storage für Sessions | Redis/KV als Session-Speicher (`internal-adapter.ts:557-609`) | Weglassen | Niemand. Zwei Wahrheiten über den Sitzungszustand erzeugen genau die Klasse von Fehlern aus GHSA-2vg6-77g8-24mp: vier Codestellen löschten den Nutzer, ohne die Sitzungen im Secondary Storage zu entfernen — Tokens blieben bis zu sieben Tage gültig. |
| B33 `storeSessionInDatabase` | Schreibt Sessions zusätzlich in die DB (`init-options.ts:1070`) | Weglassen | Entfällt mit B32: die Datenbank ist der einzige Ort. |
| B34 `preserveSessionInDatabase` | Behält DB-Zeilen beim Löschen aus dem Secondary Storage (`init-options.ts:1080`) | Weglassen | Entfällt mit B32. Die Option regelt, welche der zwei Wahrheiten beim Löschen gewinnt; ohne zweite Wahrheit gibt es nichts zu regeln. |
| B35 Redis-Implementierung des Secondary Storage | `SecondaryStorage` mit atomarem GET+DEL per Lua (`packages/redis-storage/src/redis-storage.ts:36-53`) | Weglassen | Entfällt mit B32. Das atomare GET+DEL per Lua ist handwerklich richtig und zeigt zugleich, wie viel Sorgfalt ein zweiter Speicher kostet, den `DELETE … RETURNING` in PostgreSQL umsonst liefert. |
| B36 Multi-Session (mehrere Konten pro Gerät) | Pro Session ein eigenes signiertes Cookie `<name>_multi-<token>` (`plugins/multi-session/index.ts`) | Weglassen | Die Anwendung oder ein Plugin unter `/x/multi-session/…` übernimmt. Der Kern kennt genau ein Sitzungscookie `__Host-velve_session`; ein Cookie-Fächer war die Angriffsfläche von GHSA-wmjr-v86c-m9jj (Signout akzeptierte gefälschte Cookie-Werte ungeprüft). |
| B37 `maximumSessions` | Deckelt die parallelen Gerätesessions, Vorgabe 5 (`multi-session/index.ts:53`) | Weglassen | Entfällt mit B36. Eine Obergrenze über alle Geräte hinweg ist außerdem eine Selbstverdrängung: der Angreifer verdrängt den Nutzer genauso wie umgekehrt. |
| B38 Geräte-Sessions auflisten | `GET /multi-session/list-device-sessions` | Weglassen | Entfällt mit B36; `list-sessions` (B17) listet die Sitzungen eines Nutzers. |
| B39 Konto wechseln | `POST /multi-session/set-active` | Weglassen | Entfällt mit B36. Bei genau einem Sitzungscookie ist ein Kontowechsel eine Abmeldung plus Anmeldung; die Anwendung kann beides verketten. |
| B40 Einzelne Geräte-Session widerrufen | `POST /multi-session/revoke` | Weglassen | Entfällt mit B36; das Widerrufen einer einzelnen Sitzung leistet B18 über `targetSessionId`. |
| B41 Session-Impersonation | `POST /admin/impersonate-user` mit `session.impersonatedBy` (`plugins/admin/`) | Weglassen | Die Anwendung übernimmt. Wer wen imitieren darf, ist eine Berechtigungsfrage, und Berechtigungen sind ausdrücklich nicht Aufgabe der Bibliothek (Abschnitt 3.14). |
| B42 Impersonation beenden | `POST /admin/stop-impersonating` | Weglassen | Entfällt mit B41. Ohne Impersonation gibt es keinen Zustand, in den man zurückkehren müsste; der Rückweg wäre sonst eine Sitzungsneuvergabe ohne Nachweis. |
| B43 Sitzungsantwort umbauen | `customSession` ersetzt `/get-session` (`plugins/custom-session/index.ts`) | Weglassen | Die Anwendung übernimmt, nach dem Aufruf. Der Rückgabetyp steht in der Routendeklaration, und ein Plugin darf Kernrouten nicht überschreiben — bei Better Auth ist genau das eine Reihenfolgefalle (`custom-session/index.ts:71`). |
| B44 Session-Transfer per Einmal-Token | `/one-time-token/generate` + `/verify` (`plugins/one-time-token/index.ts`) | Weglassen | Die Anwendung übernimmt. Better Auth legt den Sitzungstoken als Wert des Einmal-Tokens ab (`one-time-token/index.ts:106`) und speichert ihn per Vorgabe im Klartext (`:76`) — wer das Token abfängt, bekommt die Sitzung. |
| B45 Session per `Authorization: Bearer` | Plugin übersetzt Bearer-Token in einen Cookie-Header (`plugins/bearer/index.ts`) | Anders lösen | `auth.session.resolve(token)` nimmt das Token direkt entgegen, gleich woher die Anwendung es bezieht; es gibt keine Umschreibung von Headern in Cookies. Better Auths `requireSignature` steht per Vorgabe auf `false` und akzeptiert damit unsignierte Tokens (`bearer/index.ts:78-85`). |
| B46 Reaktive Session im Client | `useSession`-Atom mit Focus-/Online-Manager und BroadcastChannel (`client/session-atom.ts`) | Weglassen | Die Anwendung übernimmt. Der Client ist ein typisierter Aufrufer ohne Zustandsverwaltung; Reaktivität gehört in die Datenschicht der Anwendung, die sie ohnehin für alles andere hat. |

**B: Übernehmen 8 · Anders lösen 5 · Weglassen 32 · Übertreffen 1**

---

### C. Soziale Anmeldung / OAuth (96)

#### C.1 Eingebaute Anbieter (36) und Generic OAuth (11) — zusammengefasst

| Funktion | Better Auth | Velve Auth | Begründung |
|---|---|---|---|
| C1–C36 Die 36 eingebauten Social Provider | Apple, Atlassian, Cloudflare, Cognito, Discord, Dropbox, Facebook, Figma, GitHub, GitLab, Google, Hugging Face, Kakao, Kick, LINE, Linear, LinkedIn, Microsoft Entra ID, Naver, Notion, Paybin, PayPal, Polar, Railway, Reddit, Roblox, Salesforce, Slack, Spotify, TikTok, Twitch, Twitter/X, Vercel, VK, WeChat, Zoom (`packages/core/src/social-providers/`, registriert `index.ts:40-76`) | Anders lösen | Zum Start 14 Anbieter (Google, GitHub, Apple, Microsoft/Entra, GitLab, Discord, Facebook, LinkedIn, Twitch, Spotify, Slack, Notion, Zoom, Dropbox) plus `genericOAuth` für alles Weitere; der Mechanismus ist ein Anbieter-Deskriptor statt einer Datei je Anbieter (Abschnitt 3.10). Kein Wettlauf um die Anzahl — und die fünf Anbieter, die bei Better Auth Platzhalter-Adressen erfinden (Reddit, Roblox, TikTok, Twitter/X, WeChat, `core/src/utils/email.ts`), funktionieren hier mit `email IS NULL`. |
| C37–C46 Vorkonfigurierte Generic-OAuth-Helfer | Auth0, Gumroad, HubSpot, Keycloak, LINE, Microsoft Entra ID, Okta, Patreon, Slack, Yandex (`plugins/generic-oauth/providers/`) | Anders lösen | Vier davon (Auth0, Keycloak, Okta, Entra ID) sind OIDC-Anbieter mit Discovery-Dokument und über `issuer` erreichbar; die übrigen sechs sind OAuth2-Anbieter mit festen Endpunkten, die der Anbieter-Deskriptor als `authorizationEndpoint`, `tokenEndpoint`, `userInfoEndpoint` entgegennimmt (Abschnitt 3.15, A.8). Mitgelieferte Voreinstellungen veralten still, sobald der Anbieter einen Endpunkt verschiebt. |
| C47 Beliebiger OAuth2/OIDC-Provider zur Laufzeit | `genericOAuth({config:[…]})` hängt Provider in `ctx.socialProviders` (`generic-oauth/index.ts:511-523`) | Übernehmen | `genericOAuth` ist Kernbestandteil, nicht Plugin. Anbieter werden als Konfiguration deklariert und können eingebaute Anbieter nicht überschatten — bei Better Auth werden sie vorangestellt und überschatten sie, mit bloßer Warnung (`:513-518`). |

#### C.2 OAuth-Mechanik (49)

| Funktion | Better Auth | Velve Auth | Begründung |
|---|---|---|---|
| C48 Social-Anmeldung starten | `POST /sign-in/social` liefert Authorize-URL oder redirected | Übernehmen | Gleiche Route; der Flow-Zustand entsteht als Zeile in `velve.oauth_flow`. |
| C49 OAuth-Callback | `GET/POST /callback/:id` (`api/routes/callback.ts`) | Übernehmen | Gleiche Route; Codeeinlösung, Identitätsauflösung und Sitzungserzeugung in einer Transaktion. |
| C50 POST-Callback → GET-Redirect | Wandelt `form_post` in GET um, damit Cookies mitgehen (`callback.ts:62-78`) | Übernehmen | Notwendig für Apple; unverändert übernommen. |
| C51 PKCE (S256) | Angewandt, „sobald ein `codeVerifier` existiert" (`core/src/oauth2/create-authorization-url.ts:88-92`) | Übertreffen | PKCE S256 ist verpflichtend, nicht bedingt; der Verifier liegt AES-256-GCM-verschlüsselt in `velve.oauth_flow.pkce_verifier_enc`, nicht im Cookie. Better Auths eigener OIDC-Provider stufte fehlendes `code_challenge_method` still auf `plain` herunter (GHSA-9h47-pqcx-hjr4). |
| C52 State-Strategie `database` | State als Verification-Zeile (10 min) plus signiertem Cookie (5 min) (`better-auth/src/state.ts:118-153`) | Übernehmen | Das ist die einzige Strategie: `state_sha256` als Primärschlüssel, das Cookie hält nur den Zeiger. |
| C53 State-Strategie `cookie` | State verschlüsselt in einem 600-s-Cookie (`better-auth/src/state.ts:94-108`) | Weglassen | Niemand. Der Cookie-Zweig verglich die gespeicherte Nonce nie mit dem eingehenden `state` (GHSA-wxw3-q3m9-c3jr). Ein serverseitiger Zustand kann diesen Fehler nicht haben. |
| C54 `account.skipStateCookieCheck` | Globaler Schalter, der die State-Cookie-Bindung deaktiviert (`init-options.ts:1302`) | Weglassen | Niemand. Es gibt keinen Schalter, der eine Sicherheitsprüfung abschaltet; die Bindung an die Zeile ist der Mechanismus. |
| C55 Nonce im Redirect-Flow | Serverseitig gemintet, im State gehalten, fail-closed geprüft (`oauth2/state.ts:16-20`) | Übernehmen | Unverändert, als Spalte `velve.oauth_flow.nonce`, geprüft bei OIDC. |
| C56 ID-Token-Anmeldung (nativ/mobil) | `POST /sign-in/social` mit `idToken` + `nonce` statt Redirect (`sign-in.ts:287-361`) | Weglassen | Niemand. Native Anwendungen laufen über den Autorisierungscode-Fluss mit PKCE im System-Browser (RFC 8252). Ein zweiter Einstiegspfad, der ein fremdes Token statt eines Codes annimmt, verdoppelt die Prüflogik an der empfindlichsten Stelle. |
| C57 Zentrale ID-Token-Verifikation | Signatur gegen JWKS, `iss`, `aud`, `nonce`, Ablauf (`oauth2/verify-id-token.ts:59-117`) | Übernehmen | Gleiche Prüfungen, aber nur im Callback — es gibt keinen zweiten Aufrufer (C56). |
| C58 `verifyIdToken`-Override je Provider | Eigene Verifikationslogik einhängen (`oauth-provider.ts`) | Weglassen | Niemand. Die Signatur- und Claim-Prüfung ist nicht ersetzbar; ein Plugin darf sie nicht überschreiben (Abschnitt 3.11). |
| C59 `disableIdTokenSignIn` | Verbietet den ID-Token-Pfad je Provider | Weglassen | Entfällt mit C56: der Pfad existiert nicht, also braucht er keinen Schalter. |
| C60 RFC-9207-`iss`-Prüfung | Vergleicht den `iss`-Parameter mit dem Provider-Issuer (`callback.ts:176-185`) | Übernehmen | Unverändert, verpflichtend (Abschnitt 3.10). |
| C61 Keine Redirect-Verfolgung bei Token-Requests | 3xx-Antworten des Token-Endpunkts werden abgelehnt (`oauth2/reject-redirects.ts`) | Übernehmen | SSRF-Härtung, unverändert übernommen. |
| C62 `accountSubject` | Pflicht-Resolver für die stabile Provider-Identität (`oauth-provider.ts:176-184`) | Übertreffen | `(provider, subject)` ist nicht nur Konvention, sondern `CONSTRAINT identity_provider_subject UNIQUE` in der Datenbank. Better Auth prüft die Eindeutigkeit in JavaScript und ist damit anfällig für Wettläufe (Inventur N4-43). |
| C63 `mapProfileToUser` | Bildet Provider-Profil auf User-Felder ab (`oauth-provider.ts`) | Weglassen | Die Anwendung übernimmt. Es gibt keine Profilfelder, auf die abgebildet werden könnte; die rohen Claims liegen unverändert in `velve.identity.profile` (jsonb), die Bibliothek liest sie nicht. |
| C64 `getUserInfo`-Override | Ersetzt den Userinfo-Abruf vollständig (`oauth-provider.ts`) | Anders lösen | Der Anbieter-Deskriptor deklariert Userinfo-Endpunkt und Claim-Namen als Daten; es gibt keinen austauschbaren Codepfad im Anmeldevorgang. |
| C65 `refreshAccessToken`-Override | Eigene Refresh-Logik je Provider (`oauth-provider.ts`) | Weglassen | Die Anwendung übernimmt. Velve Auth speichert fremde Tokens auf ausdrücklichen Wunsch verschlüsselt, erneuert sie aber nicht — die Nutzung fremder APIs ist Anwendungslogik, nicht Authentifizierung. |
| C66 `validateUserInfo` | Globaler Callback, der Provider-Profile annehmen/ablehnen kann (`init-options.ts:949`) | Anders lösen | Über die aufgezählten Erweiterungspunkte `beforeUserCreate` und `beforeSignIn`, die ablehnen dürfen (Fehler werfen), aber die Antwort nicht ersetzen (Abschnitt 3.11). |
| C67 `scope` / `disableDefaultScope` | Scopes je Provider setzen oder Vorgaben abschalten | Übernehmen | Unverändert. |
| C68 Zusätzliche Scopes nachfordern | `signIn.social` / `linkSocial` mit erweitertem `scopes` (`account.ts:126`) | Übernehmen | Unverändert; die gewährten Scopes landen in `velve.identity.scopes`. |
| C69 `prompt` | `select_account`, `consent`, `login`, `none` | Übernehmen | Unverändert. |
| C70 `responseMode` | `query` oder `form_post` | Übernehmen | Unverändert, notwendig für Apple. |
| C71 `loginHint` | Reicht `login_hint` durch (`sign-in.ts`) | Übernehmen | Unverändert. |
| C72 `additionalParams` | Beliebige Autorisierungsparameter, reservierte geschützt (`create-authorization-url.ts:11-24,108-113`) | Übernehmen | Unverändert, mit derselben Sperrliste für reservierte Parameter. |
| C73 `additionalData` durch den Flow | Eigene Daten bis zum Callback durchreichen (`state.ts`) | Anders lösen | Mitgeführt wird ausschließlich `velve.oauth_flow.redirect_path` — ein Pfad, niemals eine vollständige URL und keine freien Nutzdaten. Beliebige Daten im Flow-Zustand sind eine Umleitung um die Origin-Prüfung. |
| C74 `redirectURI`-Override | Abweichende Callback-URL je Provider | Übernehmen | Unverändert, als Teil des Anbieter-Deskriptors. |
| C75 `authorizationEndpoint`-Override | Abweichender Authorize-Endpunkt je Provider | Übernehmen | Unverändert; notwendig für selbstgehostete GitLab-Instanzen. |
| C76 `disableSignUp` je Provider | Erlaubt nur Anmeldung bestehender Konten | Übernehmen | Unverändert. |
| C77 `disableImplicitSignUp` | Registrierung nur bei explizitem `requestSignUp: true` | Übernehmen | Unverändert. |
| C78 `overrideUserInfoOnSignIn` | Überschreibt bei jeder Anmeldung die Profildaten | Anders lösen | `velve.identity.profile` wird bei jeder Anmeldung mit den aktuellen Claims überschrieben, `velve.user` bleibt unberührt. Es gibt keine Konkurrenz zwischen Anbieterprofil und lokalem Profil, weil es kein lokales Profil gibt. |
| C79 `requireEmailVerification` je Provider | Verlangt `email_verified` vom Provider | Anders lösen | Kein Schalter je Anbieter: `provider_email_verified` ist eine der drei nicht verhandelbaren Bedingungen der Verknüpfungsregel (Abschnitt 3.10). Für die Anmeldung selbst ist der Verifikationsstatus des Anbieters ohne Belang, weil die E-Mail kein Schlüssel ist. |
| C80 Account-Linking global an/aus | `account.accountLinking.enabled`, Vorgabe `true` (`init-options.ts:1188`) | Anders lösen | Kein globaler Schalter. Automatisch verknüpft wird nur, wenn alle drei Bedingungen gelten (Anbieter meldet verifiziert, lokales Konto verifiziert, Anbieter in `trustedProviders`); sonst entsteht ein neues Konto oder es braucht eine ausdrückliche Verknüpfung in einer bestehenden Sitzung. |
| C81 `trustedProviders` | Liste von Providern, deren E-Mail als Eigentumsnachweis gilt (`init-options.ts:1240`) | Übernehmen | Übernommen als eine der drei Bedingungen — aber nie als alleiniger Nachweis. |
| C82 `allowDifferentEmails` | Erlaubt manuelles Verknüpfen bei abweichender E-Mail (`init-options.ts:1264`) | Anders lösen | Braucht keinen Schalter: da die E-Mail nie Verknüpfungsschlüssel ist, ist eine abweichende Adresse beim ausdrücklichen Verknüpfen der Normalfall. |
| C83 `allowUnlinkingAll` | Erlaubt das Entfernen des letzten verknüpften Kontos (`init-options.ts:1270`) | Anders lösen | Statt eines Schalters prüft der Kern, ob nach dem Trennen noch ein Anmeldeweg bleibt (Kennwort, Passkey oder eine weitere Identität), und lehnt sonst mit `last_sign_in_method` ab (L-13). Das ist eine Aussage über den Zustand, keine Voreinstellung. |
| C84 `updateUserInfoOnLink` | Aktualisiert Profildaten beim Verknüpfen (`init-options.ts:1280`) | Weglassen | Entfällt mit C63: es gibt keine Profildaten in `velve.user`. |
| C85 `disableImplicitLinking` | Verbietet automatisches Verknüpfen bei gleicher E-Mail (`init-options.ts:1199`) | Anders lösen | Eine leere `trustedProviders`-Liste schaltet implizites Verknüpfen vollständig ab — es ist die Voreinstellung, nicht ein zusätzlicher Schalter. |
| C86 `requireLocalEmailVerified` | Verlangt zusätzlich, dass der lokale Account verifiziert ist (`init-options.ts:1218`) | Übertreffen | Keine Option, sondern Bedingung 2 der Verknüpfungsregel und nicht abschaltbar. Better Auth hat sie erst als Fix für CVE-2026-53516 (CVSS 8.3) nachgerüstet — das Auto-Link-Gate las das lokale `emailVerified` nie. |
| C87 Konto manuell verknüpfen | `POST /link-social` im eingeloggten Zustand (`account.ts:126`) | Übernehmen | Über `velve.oauth_flow.link_to_user_id`; die Zielsitzung steht damit serverseitig fest und kann nicht aus dem Callback stammen. |
| C88 Konto trennen | `POST /unlink-account` (`account.ts:453`) | Übernehmen | Unverändert, mit der Prüfung aus C83. |
| C89 Verknüpfte Konten auflisten | `GET /list-accounts` (`account.ts:45`) | Übernehmen | Liefert `provider`, `subject`, `provider_email`, `scopes`, Zeitstempel — nie Tokens. |
| C90 Provider-Kontoinfo abrufen | `POST /account-info` liefert das rohe Provider-Profil (`account.ts:954`) | Anders lösen | Gelesen wird `velve.identity.profile` aus der Datenbank; die Bibliothek ruft dafür nicht beim Anbieter an. Ein Live-Abruf aus dem Auth-Pfad heraus macht die Antwortzeit von einem fremden Dienst abhängig. |
| C91 Access-Token holen mit Auto-Refresh | `POST /get-access-token` refresht bei Bedarf (`account.ts:756`) | Weglassen | Die Anwendung übernimmt. Wenn sie `storeTokens` einschaltet, bekommt sie die entschlüsselten Tokens; die Erneuerung gehört zu ihrem API-Client, nicht zur Authentifizierung. |
| C92 Token explizit refreshen | `POST /refresh-token` (`account.ts:808`) | Weglassen | Entfällt mit C91; die Erneuerung gehört zum API-Client der Anwendung, der auch als Einziger weiß, wann sie nötig ist. |
| C93 `encryptOAuthTokens` | Verschlüsselt Tokens at rest, optional (`init-options.ts:1295`) | Übertreffen | Nicht optional: der Standard ist, fremde Tokens gar nicht zu speichern (`storeTokens: false`), und wenn doch, dann AES-256-GCM mit dem zweckgetrennten Schlüssel `oauth-token-enc` und `token_key_version` in der Zeile (Abschnitt 3.8). |
| C94 `storeAccountCookie` | Legt den Account inkl. Tokens verschlüsselt in ein Cookie, wenn keine DB existiert (`init-options.ts:1325`) | Weglassen | Niemand. Es gibt keine Betriebsart ohne Datenbank, und fremde Tokens gehören unter keinen Umständen in ein Cookie. |
| C95 OAuth-Proxy für Preview-Deployments | Leitet Callbacks über eine feste Produktions-URL an Preview-URLs weiter (`plugins/oauth-proxy/`) | Weglassen | Niemand, und das ist richtig: das Plugin umgeht per Entwurf die Origin-Bindung. Preview-Umgebungen registrieren eigene Redirect-URIs beim Anbieter — das ist der vorgesehene Weg. |
| C96 OAuth im Popup-Fenster | `after`-Hook ersetzt den Redirect durch eine `postMessage`-Seite (`plugins/oauth-popup/`) | Weglassen | Die Anwendung übernimmt. Better Auths Umsetzung zieht den Sitzungstoken aus dem `set-cookie`-Header und übergibt ihn per `postMessage` an den Opener (`oauth-popup/index.ts:317-332`) — das Token verlässt damit den Cookie-Kanal. |

**C: Übernehmen 23 · Anders lösen 56 · Weglassen 13 · Übertreffen 4**

---

### D. Zweiter Faktor und alternative Faktoren (52)

| Funktion | Better Auth | Velve Auth | Begründung |
|---|---|---|---|
| D1 2FA aktivieren | `POST /two-factor/enable` erzeugt Secret + Backup-Codes (`plugins/two-factor/index.ts:124-310`) | Übernehmen | Gleiche Fähigkeit, aber im Kern (`core/factor/`) statt in einem Plugin — der Zwischenzustand zwischen Kennwort und Faktor ist Teil des Sitzungsmodells und kann nicht nachgerüstet werden. |
| D2 2FA deaktivieren | `POST /two-factor/disable` mit `sensitiveSessionMiddleware` (`two-factor/index.ts:316-425`) | Übernehmen | Verlangt Kennwort oder einen vorhandenen Faktor; die Wiederherstellungscodes werden in derselben Transaktion gelöscht. |
| D3 TOTP-URI abrufen | `GET /two-factor/get-totp-uri` liefert die entschlüsselte `otpauth://`-URI jederzeit (`totp/index.ts:301-304`) | Anders lösen | Die URI wird genau einmal bei der Einrichtung ausgegeben, vor `confirmed_at`. Danach gibt die Bibliothek das Secret nicht mehr heraus; wer den Authenticator verliert, richtet neu ein. Ein jederzeit abrufbares Secret macht die Sitzungsübernahme zur dauerhaften Faktorübernahme. |
| D4 TOTP prüfen | `POST /two-factor/verify-totp` (`totp/index.ts:329-360`) | Übernehmen | Gleiche Route, zusätzlich Replay-Schutz über `velve.totp_used_step` mit Primärschlüssel `(user_id, time_step)`. |
| D5 TOTP-Parameter | `digits` 6/8, `period` frei, `issuer` konfigurierbar (`totp/index.ts:83-87`) | Anders lösen | Feste RFC-6238-Parameter (SHA-1, 6 Stellen, 30 s); konfigurierbar bleiben `issuer` und die Toleranz (0 oder 1 Schritt, Vorgabe 1; Abschnitt 3.15, A.8). Abweichende Perioden und Stellenzahlen werden von verbreiteten Authenticator-Apps stillschweigend falsch dargestellt. |
| D6 TOTP-Secret verschlüsselt gespeichert | 32 Zeichen Zufall, symmetrisch verschlüsselt (`two-factor/index.ts:247-251`) | Übernehmen | AES-256-GCM mit dem zweckgetrennten Schlüssel `totp-enc`, `key_version` in derselben Zeile (Abschnitt 3.8). |
| D7 TOTP serverseitig erzeugen | `generateTOTP`, serverOnly (`totp/index.ts:101`) | Übernehmen | In `@velve/auth/testing`, zusammen mit Uhrkontrolle — nicht im Produktionspaket. |
| D8 `skipVerificationOnEnable` | Aktiviert 2FA sofort, ohne erste TOTP-Bestätigung (`two-factor/index.ts:252-275`) | Weglassen | Niemand. `confirmed_at` bleibt NULL, bis eine Prüfung gelungen ist; sonst sperrt sich ein Nutzer mit einem falsch übertragenen Secret aus, und genau dieser Fall ist der teuerste Supportvorgang einer Auth-Bibliothek. |
| D9 OTP als Zweitfaktor senden | `POST /two-factor/send-otp`, Transport frei über `sendOTP` (`otp/index.ts:218-224`) | Weglassen | Ein Plugin kann es unter `/x/…` nachrüsten. Ein Code, der über den E-Mail-Kanal kommt, ist kein zweiter Faktor gegenüber einem Kennwort-Reset, der über denselben Kanal läuft — Velve Auth kennt TOTP, WebAuthn und Wiederherstellungscodes (Abschnitt 3.6). |
| D10 OTP als Zweitfaktor prüfen | `POST /two-factor/verify-otp`, Versuchsbudget 5 (`otp/index.ts:334-364`) | Weglassen | Entfällt mit D9; das Versuchsbudget von fünf je Zwischenzustand (L-8) gilt für die Kernfaktoren ohnehin. |
| D11 OTP-Speicherstrategie | `plain` (Vorgabe), `encrypted`, `hashed`, Custom (`otp/index.ts:73-140`) | Weglassen | Entfällt mit D9; `plain` als Vorgabe wäre ohnehin die falsche Wahl. |
| D12 Backup-Codes erzeugen | `POST /two-factor/generate-backup-codes`, 10 Codes à 10 Zeichen (`backup-codes/index.ts:65-70`) | Übernehmen | 10 Stück, je 160 bit, in Gruppen dargestellt; bei einem Verfahrenswechsel werden alle neu erzeugt und die alten in derselben Transaktion gelöscht. |
| D13 Backup-Code einlösen | `POST /two-factor/verify-backup-code`, Compare-and-Set (`backup-codes/index.ts:384-405`) | Übernehmen | Konsum per `DELETE … RETURNING` auf `(user_id, code_hmac)` — ein Index-Treffer statt eines Durchlaufs über alle Codes. |
| D14 Backup-Codes anzeigen | `viewBackupCodes`, serverOnly — nur möglich, weil verschlüsselt gespeichert (`backup-codes/index.ts:552-590`) | Weglassen | Niemand, und das ist der Punkt: Codes liegen als `HMAC-SHA256(pepper, code)` vor und sind nicht wieder darstellbar. Wer sie verliert, erzeugt neue. |
| D15 Backup-Code-Speicherstrategie | `encrypted` (Vorgabe), `plain` oder Custom (`backup-codes/index.ts:44-55`) | Übertreffen | Keine Strategie, sondern genau ein Format: HMAC mit Pepper. Better Auths Vorgabe ist umkehrbar, damit D14 funktioniert — eine Funktion erzwingt dort die schwächere Speicherform. |
| D16 Zwischenzustand nach Kennwortprüfung | Session wird gelöscht, Verification-Record + signiertes `two_factor`-Cookie (`two-factor/index.ts:533-563`) | Übertreffen | Eigenes Artefakt `velve.pending_authentication` mit `factors_completed` und `attempts`, eigenes kurzlebiges Cookie `__Host-velve_pending` (5 min), und genau **vier** Routen akzeptieren es (TOTP, WebAuthn `start`/`finish`, Wiederherstellungscode); jede andere ignoriert es vollständig (Abschnitt 3.6 und 3.15, Abweichung 5). Der Zwischenzustand ist damit strukturell keine Sitzung und kann auch nicht versehentlich zu einer werden. |
| D17 `twoFactorRedirect`-Antwort | `{twoFactorRedirect:true, twoFactorMethods:[…]}` statt einer Session (`two-factor/index.ts:594-597`) | Übernehmen | Stabiler Fehlercode plus die Liste der für diesen Nutzer verfügbaren Faktoren. |
| D18 Client-seitiger 2FA-Redirect | Fetch-Plugin fängt die Antwort ab und navigiert (`two-factor/client.ts:57-83`) | Weglassen | Die Anwendung übernimmt. Der Client navigiert nicht selbst; ein Fetch-Plugin, das Antworten abfängt und Seitenwechsel auslöst, ist Kontrollfluss an der Anwendung vorbei. |
| D19 Challenge-Lebensdauer | `twoFactorCookieMaxAge`, Vorgabe 10 min (`two-factor/constant.ts`) | Anders lösen | Feste 5 Minuten am `pending_authentication`-Artefakt. Die Frist steht in der Datenbankzeile, nicht in der Cookie-Lebensdauer — ein Cookie mit längerer Laufzeit kann so keinen abgelaufenen Zustand wiederbeleben. |
| D20 Per-Challenge-Versuchsbudget | Zweiter Verification-Record `2fa-attempts-…` als atomarer Zähler (`verify-two-factor.ts:145-193`) | Übernehmen | Als Spalte `attempts` in derselben Zeile, atomar erhöht, Grenze fünf (L-8) — kein zweites Artefakt, das auseinanderlaufen kann. |
| D21 Kontosperre bei 2FA | 10 Fehlversuche → 15 min Sperre (`verify-two-factor.ts:216-319`, `constant.ts:10-11`) | Anders lösen | Keine Sperre: nach fünf Fehlversuchen wird der Zwischenzustand gelöscht und der Vorgang beginnt beim Kennwort von vorn (L-8); darüber liegt der Konto-Eimer aus Abschnitt 3.9, dessen Überschreitung eine Ablehnung ist, keine Verzögerung (L-5). Eine Sperre ist eine Dienstverweigerung gegen einen bekannten Nutzer und damit selbst ein Angriffswerkzeug. |
| D22 Atomare Challenge-Einlösung | `consumeVerificationValue` **vor** Session-Erzeugung (`verify-two-factor.ts:73-83`) | Übernehmen | Dasselbe Muster, als einziges Konsummuster: `DELETE … RETURNING` vor jeder Zustandsänderung (Abschnitt 3.7). |
| D23 Trusted Device | HMAC(`userId!trustIdentifier`) + serverseitiger Record, Vorgabe 30 Tage (`verify-two-factor.ts:99-130`) | Weglassen | Niemand. Ein Gerät, das den zweiten Faktor 30 Tage überspringt, ist ein zweiter, schwächerer Anmeldeweg mit eigener Widerrufsfläche. Wer den Faktor selten sehen will, verlängert stattdessen die Leerlauffrist der Sitzung — dann bleibt genau ein Artefakt, das man widerrufen kann. |
| D24 Trust-Record-Rotation | Record wird bei jeder Nutzung gelöscht und neu ausgestellt (`two-factor/index.ts:463-520`) | Weglassen | Entfällt mit D23. Die Rotation ist der beste Teil des Mechanismus — und der Beleg, dass ein Trust-Record ein Sitzungstoken zweiter Klasse ist, mit eigener Widerrufs- und Lebensdauerfrage. |
| D25 `allowPasswordless` | Lockert die Kennwortpflicht beim Aktivieren/Deaktivieren für Konten ohne Credential (`two-factor/index.ts:53`) | Anders lösen | Kein Schalter: Faktoränderungen verlangen einen Nachweis, und welcher zur Verfügung steht, ergibt sich aus dem Konto — Kennwort, WebAuthn oder ein Wiederherstellungscode. |
| D26 Eigener Tabellenname für 2FA | `twoFactorTable` (`two-factor/index.ts:602-610`) | Weglassen | Niemand. Alles liegt im eigenen Schema `velve` (Abschnitt 3.2), damit kollidiert nichts mit den Tabellen der Anwendung, und Namensoptionen werden überflüssig. |
| D27 Rate-Limit auf `/two-factor/*` | 3 Requests / 10 s (`two-factor/index.ts:611-619`) | Übernehmen | Gleiche Größenordnung, Schlüssel ist der aufgelöste Routenname statt des rohen Pfads (GHSA-x732-6j76-qmhm). |
| D28 Passkey registrieren (Optionen) | `GET /passkey/generate-register-options` (`packages/passkey/src/routes.ts:169-355`) | Übernehmen | Challenge als `velve.webauthn_challenge` mit `purpose='register'`, 5 Minuten, per `DELETE … RETURNING` konsumiert. |
| D29 Passkey registrieren (Verifikation) | `POST /passkey/verify-registration` mit Ceremony-Tag-Prüfung (`routes.ts:567-753`) | Übernehmen | Gleiche Prüfung; zusätzlich werden `backup_eligible`, `backup_state`, `aaguid`, `transports` und `user_verified_at_registration` gespeichert. |
| D30 Passkey-Registrierung ohne Session | `registration.requireSession:false` + `resolveUser` (`routes.ts:70-116`) | Übernehmen | Registrierung per Passkey ist ein eigener Anmeldeweg (Abschnitt 3.6), kein Sonderfall mit Callback-Auflösung. |
| D31 `registration.afterVerification` | Nutzer erst nach erfolgreicher WebAuthn-Zeremonie anlegen (`docs/…/passkey.mdx:108-129`) | Anders lösen | Kein Schalter, sondern die einzige Reihenfolge: der Nutzer entsteht erst, wenn die Zeremonie erfolgreich war. Die umgekehrte Reihenfolge hinterlässt Karteileichen, die als unverifizierte Vorab-Konten missbrauchbar sind. |
| D32 Passkey-Login (Optionen) | `GET /passkey/generate-authenticate-options`, ohne Session leere `allowCredentials` (`routes.ts:369-524`) | Übernehmen | Gleiches Verhalten; die Challenge-Zeile hat dann `user_id IS NULL` (auffindbare Anmeldung). |
| D33 Passkey-Login (Verifikation) | `POST /passkey/verify-authentication`, `requireUserVerification: false` (`routes.ts:799-957`, N3-33) | Übertreffen | `userVerification: "required"`; die Sitzung trägt `factors = {webauthn}`, und ein sinkender `sign_count` wird der Anwendung gemeldet. Bei Better Auth ist ein Passkey deshalb kein zweiter Faktor und umgeht zusätzlich erzwungene 2FA (N3-32/33). |
| D34 Usernameless / Discoverable Credentials | Login ohne vorherige Identitätsangabe (`routes.ts:486-499`) | Übernehmen | Unverändert; das ist der Regelfall des Passkey-Anmeldewegs. |
| D35 Conditional UI / Browser-Autofill | `autoFill` Vorgabe `true`, `autocomplete="webauthn"` (`docs/…/passkey.mdx:325-375`) | Weglassen | Die Anwendung übernimmt: das ist ein Attribut in ihrem Markup. Die Bibliothek liefert die Optionen, nicht das Formular. |
| D36 WebAuthn-Extensions | PRF, credProps, largeBlob durchreichbar (`docs/…/passkey.mdx`) | Weglassen | Niemand. Die Zeremonie ist nicht erweiterbar; ausgewertet werden BE/BS und `sign_count`. Wer PRF für Schlüsselableitung braucht, führt eine eigene Zeremonie — eine halb durchgereichte Extension ist schlimmer als keine. |
| D37 `authenticatorSelection` | `residentKey` Vorgabe `preferred`, `userVerification` Vorgabe `preferred` (`routes.ts:304-327`) | Anders lösen | Feste Vorgaben statt Optionen: `residentKey: "required"` und `userVerification: "required"` für den Passkey-Weg, `userVerification: "required"` auch als zweiter Faktor. `preferred` heißt in der Praxis „meistens nicht". |
| D38 `rpID` / `rpName` / `origin` | `origin` fällt auf den Request-Header zurück (`packages/passkey/src/utils.ts:3-8`) | Anders lösen | `rpID` und `origin` sind Pflichtkonfiguration und werden nie aus einem Request-Header abgeleitet. Ein aus dem Request abgeleiteter Origin ist die WebAuthn-Variante von CVE-2025-71401. |
| D39 Passkeys auflisten | `GET /passkey/list-user-passkeys` (`routes.ts:996`) | Übernehmen | Liefert `label`, `aaguid`, `transports`, `backup_eligible`, `backup_state`, `created_at`, `last_used_at`. |
| D40 Passkey löschen | `POST /passkey/delete-passkey` (`routes.ts:1063`) | Übernehmen | Mit Eigentümerprüfung im `WHERE`-Prädikat — genau das fehlte in GHSA-4vcf-q4xf-f48m (IDOR). |
| D41 Passkey umbenennen | `POST /passkey/update-passkey` (`routes.ts:1139`) | Übernehmen | Schreibt `label`, sonst nichts. |
| D42 Authenticator-Erkennung per AAGUID | Mitgelieferte Namenstabelle (`packages/passkey/src/authenticator-metadata.ts`) | Weglassen | Die Anwendung übernimmt. Die `aaguid` wird gespeichert; eine mitgelieferte Namenstabelle veraltet zwischen zwei Releases und ist reine Anzeigelogik. |
| D43 Gerätegebunden vs. synchronisiert | `deviceType` und `backedUp` werden gespeichert (`packages/passkey/src/schema.ts:3-53`) | Übertreffen | BE- und BS-Flag werden getrennt aus den Authenticator-Daten gespeichert und bei jeder Anmeldung aktualisiert; die Anwendung kann darauf eine Richtlinie stützen (z. B. „gerätegebunden zählt als zweiter Faktor"), die Bibliothek erzwingt keine (Abschnitt 3.6). |
| D44 Sign-In with Ethereum (SIWE) | `POST /siwe/verify` prüft die vollständige ERC-4361-Nachricht (`plugins/siwe/index.ts:158-190`) | Weglassen | Ein Plugin übernimmt: eigene Routen unter `/x/siwe/…`, eigene Tabelle `velve.siwe_wallet`. Ein Wallet-Protokoll mit eigener Signaturbibliothek gehört nicht in den Pflichtpfad einer Auth-Bibliothek. |
| D45 SIWE-Nonce | `GET /siwe/nonce`, atomar konsumiert vor der Signaturprüfung (`siwe/index.ts:62-156`) | Weglassen | Entfällt mit D44; das Muster selbst (Konsum vor Prüfung) ist als allgemeine Regel übernommen (Abschnitt 3.7). |
| D46 Wallet-Adressen speichern | Tabelle `walletAddress` mit `chainId`, `isPrimary` (`siwe/schema.ts`) | Weglassen | Entfällt mit D44; die Tabelle gehört dem Plugin, als `velve.siwe_wallet` mit Präfix nach Abschnitt 3.11. |
| D47 Google One Tap | `POST /one-tap/callback` verifiziert das Google-`id_token` (`plugins/one-tap/index.ts:107-118`) | Weglassen | Niemand. Setzt den ID-Token-Direkteinstieg voraus, den es nicht gibt (C56); der Autorisierungscode-Fluss deckt Google vollständig ab. |
| D48 Magic Link | `POST /sign-in/magic-link` + `GET /magic-link/verify`, TTL 5 min (`plugins/magic-link/index.ts`) | Übernehmen | Im Kern statt als Plugin: Einmal-Artefakt mit `purpose='magic_link'`, Frist 10 min, Konsum per `DELETE … RETURNING`. |
| D49 Magic-Link-Token-Speicherstrategie | `plain` (Vorgabe), `hashed` oder Custom (`magic-link/index.ts:163-186`) | Übertreffen | Keine Strategie: Einmal-Artefakte liegen ausnahmslos als `sha256(token)` vor, weil `token_sha256` der Primärschlüssel der Tabelle ist. Der Better-Auth-Vorgabe speichert den Anmeldelink im Klartext in der Datenbank. |
| D50 Anonyme Anmeldung | `POST /sign-in/anonymous` legt einen echten User mit Platzhalter-E-Mail an (`plugins/anonymous/index.ts:104-113`) | Weglassen | Die Anwendung übernimmt: Gastzustand ohne Identität gehört in ihre eigene Tabelle. Better Auth erfindet dafür eine Adresse und legt eine Nutzerzeile an, die anschließend über einen `after`-Hook auf sehr vielen fremden Pfaden wieder eingesammelt werden muss (`:334-418`). |
| D51 Anonymes Konto verknüpfen | `after`-Hook über viele Anmeldepfade ruft `onLinkAccount` (`anonymous/index.ts:334-418`) | Weglassen | Entfällt mit D50. Ein `after`-Hook über viele fremde Anmeldepfade ist zudem genau die Hook-Art, die Abschnitt 3.11 ausschließt. |
| D52 Anonymen Nutzer löschen | `POST /delete-anonymous-user` | Weglassen | Entfällt mit D50; einen Gastzustand löscht die Anwendung in ihrer eigenen Tabelle. |

**D: Übernehmen 20 · Anders lösen 8 · Weglassen 19 · Übertreffen 5**

---

### E. Identität und Benutzermodell (27)

| Funktion | Better Auth | Velve Auth | Begründung |
|---|---|---|---|
| E1 Kern-Usermodell | `id`, `name`, `email`, `emailVerified`, `image`, `createdAt`, `updatedAt` (`core/src/db/get-tables.ts:198-246`) | Anders lösen | `velve.user` führt `id`, `email`, `email_verified_at`, `username`, `username_key`, `disabled_at`, `imported_from`, `imported_at` und Zeitstempel — kein `name`, kein `image`. Profildaten sind ausdrücklich nicht Aufgabe der Bibliothek (Abschnitt 3.14). Statt eines Booleans steht der Zeitpunkt der Verifikation in der Zeile. |
| E2 E-Mail als Pflichtfeld | `email` ist `NOT NULL UNIQUE` (`get-tables.ts:208-216`); Doku: „Better Auth currently requires an email address on every user record" (`docs/…/concepts/oauth.mdx:409`, Issue #9124) | Übertreffen | `email` ist nullable; welche Felder Pflicht sind, entscheidet die gewählte Identitätskonfiguration und wird als CHECK-Constraint in der Migration materialisiert (Abschnitt 3.4). Das ist die Voraussetzung dafür, überhaupt ohne erfundene Adressen auszukommen. |
| E3 Platzhalter-E-Mail-Generator | `createPlaceholderEmail` → `<id>@<ns>.placeholder.invalid`, an neun Stellen in acht Modulen im Produktionscode aufgerufen (definiert in `core/src/utils/email.ts:24`) | Weglassen | Niemand, und das ist der Punkt. Meldet ein Anbieter keine E-Mail, bleibt `user.email` NULL (Abschnitt 3.10). Erfundene Adressen brechen jedes E-Mail-abhängige Verhalten — Bestätigung, Reset, Wechsel — und sind in der Datenbank nicht von echten zu unterscheiden. |
| E4 E-Mail-Normalisierung | `.toLowerCase()` verstreut über mehr als 30 Aufrufstellen (`internal-adapter.ts:241,279,1045,1096`) | Übertreffen | Trimmen, NFKC und `lower()` an genau einer Stelle, und die Datenbank prüft es per `CONSTRAINT user_email_normalized CHECK (email = lower(email))` nach. Eine vergessene Aufrufstelle kann keine zweite Schreibweise derselben Adresse anlegen. |
| E5 `user.additionalFields` | Eigene User-Spalten mit `input`/`returned`/`transform` (`get-tables.ts:243`) | Weglassen | Die Anwendung übernimmt, in einer eigenen Tabelle mit `user_id`-Fremdschlüssel. Fremdfelder in der Nutzerzeile sind bei Better Auth per Vorgabe `input: true` und damit über generische Routen beschreibbar — im Code selbst als Problem markiert (`db/schema.ts:43-47`). |
| E6 `session.additionalFields` | Analog für die Session-Tabelle (`get-tables.ts:191`) | Weglassen | Wie E5; Plugins bekommen eigene Tabellen mit Präfix, keine Spalten an Kerntabellen (Abschnitt 3.11). |
| E7 `account.additionalFields` | Analog für die Account-Tabelle (`get-tables.ts:338`) | Weglassen | Wie E5. Für Anbieterdaten gibt es `velve.identity.profile` (jsonb), das die Bibliothek schreibt und nicht liest. |
| E8 `verification.additionalFields` | Analog für die Verification-Tabelle (`get-tables.ts:124`) | Weglassen | Wie E5. `velve.one_time_token.payload` (jsonb) nimmt zweckgebundene Nutzdaten auf, ohne das Schema zu verändern. |
| E9 Feld-Mapping (`fields`) | Physische Spaltennamen frei umbenennen (`init-options.ts:241`) | Weglassen | Niemand. Alles liegt im eigenen Schema `velve` (Abschnitt 3.2); dort kollidiert nichts, also gibt es nichts umzubenennen. Umbenennbare Spalten machen jedes handgeschriebene SQL unmöglich. |
| E10 Tabellen-Mapping (`modelName`) | Physische Tabellennamen frei umbenennen (`init-options.ts:237`) | Weglassen | Wie E9. Auch `user` braucht im eigenen Schema keine Anführungszeichen-Disziplin. |
| E11 `usePlural` | Hängt pauschal ein „s" an alle Tabellennamen (`schema-diff.ts:59`) | Weglassen | Wie E9; ein pauschal angehängtes „s" ist keine Pluralbildung, sondern eine Umbenennung mit Nebenwirkungen in jedem handgeschriebenen SQL. |
| E12 ID-Strategie: Vorgabe | 32 Zeichen base62, in der Anwendung erzeugt (`core/src/utils/id.ts:3-5`) | Anders lösen | `uuid PRIMARY KEY DEFAULT gen_random_uuid()` — die Datenbank erzeugt die ID. Damit gibt es keinen Pfad, auf dem eine ID von außen mitgegeben werden kann. |
| E13 ID-Strategie: eigene Funktion | `advanced.database.generateId` (`get-id-field.ts:66-70`) | Weglassen | Niemand. Eine ID-Strategie, an einer Stelle. Vier Strategien nebeneinander erzeugen bei Better Auth den Fall, dass der Anwendungstyp `string` sagt und die Spalte `integer` ist (E15). |
| E14 ID-Strategie: `"uuid"` | `uuid`-Spalte mit `DEFAULT gen_random_uuid()` (`db/get-migration.ts:923-924`) | Übernehmen | Das ist die einzige Strategie in Velve Auth. |
| E15 ID-Strategie: `"serial"` | `integer GENERATED BY DEFAULT AS IDENTITY`, im Typ trotzdem `string` (`get-migration.ts:921-922`) | Weglassen | Niemand. Fortlaufende IDs sind aufzählbar, und der Typbruch zwischen Spalte und Anwendungstyp ist eine Fehlerquelle ohne Gegenwert. |
| E16 ID-Strategie: `false` | Datenbank erzeugt die ID (`get-id-field.ts:62-63`) | Übernehmen | Das ist genau das Verhalten von Velve Auth — nur nicht als eine von vier Optionen, sondern als das Verhalten. |
| E17 Adapter-`customIdGenerator` | Adapter-eigener ID-Generator, nur von Mongo genutzt (`db/adapter/index.ts:287`) | Weglassen | Niemand. Die Option existiert, weil MongoDB `ObjectId` statt Strings erzeugt; in PostgreSQL erzeugt die Datenbank die `uuid` selbst (E12), also braucht kein Treiber einen eigenen Generator. |
| E18 `forceAllowId` | Erlaubt ausnahmsweise das Mitgeben einer ID beim `create` (`db/adapter/factory.ts:884-906`) | Anders lösen | Nur `@velve/auth/import` darf IDs mitbringen, damit ein Bestand seine Fremdschlüssel behält; im normalen Betrieb existiert der Pfad nicht. Die Herkunft steht danach in `imported_from`/`imported_at`. |
| E19 Username als zusätzlicher Identifier | `user.username` (unique) + `user.displayUsername` per Plugin (`plugins/username/schema.ts:6-58`) | Übertreffen | Benutzername ist eine der drei Kern-Identitätskonfigurationen, nicht ein Plugin, das eine Spalte an die Nutzertabelle hängt. `username` hält die Anzeigeform, `username_key` die Vergleichsform, beide mit eigenem partiellem Unique-Index und CHECK-Paarungsregel (Abschnitt 3.2 und 3.4). |
| E20 Anmeldung per Username | `POST /sign-in/username` mit Dummy-Hash-Zeitverhalten-Schutz (`plugins/username/index.ts:353-560`) | Übernehmen | Im Kern, über dieselbe Route wie die Kennwortanmeldung; Dummy-PHC und Semaphor sind dieselben wie bei E-Mail. |
| E21 Username-Verfügbarkeit prüfen | `POST /is-username-available`, abschaltbar (`username/index.ts:569`) | Übernehmen | Wird angeboten, hart begrenzt und in der Dokumentation ausdrücklich als aufzählbar bezeichnet, statt sie als geschützt darzustellen (Abschnitt 3.4). |
| E22 Username-Normalisierung | Feld-Level `transform.input` (Vorgabe `toLowerCase`), abschaltbar (`username/index.ts:143-158`) | Anders lösen | NFKC plus `toLowerCase()` in `username_key` an genau einer Stelle im Kern, nicht abschaltbar, per CHECK-Constraint nachgeprüft; die Anzeigeform bleibt erhalten. Eine abschaltbare Normalisierung ist ein abschaltbarer Eindeutigkeitsschutz. |
| E23 Username-Validierung | `min` 3 / `max` 30, Regex `/^[a-zA-Z0-9_.]+$/`, `validationOrder` (`username/index.ts:113-186`) | Anders lösen | Konfigurierbare Zeichenklassen-Erlaubnisliste, Standard `[a-z0-9_-]`, 3–32 Zeichen. Die Erlaubnisliste ist zugleich der Homoglyphenschutz: was nicht zugelassen ist, muss auch nicht verglichen werden. Der Punkt entfällt bewusst, weil er in vielen Schriftarten von anderen Zeichen kaum zu unterscheiden ist. |
| E24 `immutableUsername` | Verbietet Änderungen, sobald gesetzt (`username/index.ts:96-99`) | Übernehmen | Option, unverändert. |
| E25 Telefonnummer als Identität | `user.phoneNumber` (unique) + `user.phoneNumberVerified` (`plugins/phone-number/`) | Weglassen | Ein Plugin übernimmt: eigene Tabelle, eigene Routen unter `/x/…`, SMS-Versand ohnehin als Callback der Anwendung. Es gibt drei Identitätskonfigurationen (Abschnitt 3.4), und eine vierte hätte dieselbe Beweislast wie die anderen drei. |
| E26 Registrierung per Telefonnummer | `signUpOnVerification` legt den Nutzer mit Platzhalter-E-Mail an (`phone-number/routes.ts:578-600`) | Weglassen | Entfällt mit E25 — und wäre in dieser Form ohnehin ausgeschlossen (E3). |
| E27 Letzte Anmeldemethode merken | Cookie (nicht httpOnly) und optional `user.lastLoginMethod` (`plugins/last-login-method/index.ts:186`) | Weglassen | Die Anwendung übernimmt. Ein nicht-httpOnly-Cookie aus einer Auth-Bibliothek heraus ist ein Kanal, den die Bibliothek nicht mehr kontrolliert; die Anwendung kann sich das mit einem eigenen Cookie merken. |

**E: Übernehmen 5 · Anders lösen 5 · Weglassen 14 · Übertreffen 3**

---

### F. Datenbank (58)

| Funktion | Better Auth | Velve Auth | Begründung |
|---|---|---|---|
| F1 Kysely-Adapter (PostgreSQL) | `pg.Pool`-Erkennung, Transaktionen an (`packages/kysely-adapter/src/dialect.ts:116`) | Anders lösen | Kein Kysely und keine Query-Abstraktion: drei schmale Treiber (`@velve/auth/pg`, `/postgres-js`, `/neon`) hinter einer Schnittstelle mit genau zwei Methoden (`query`, `transaction`), alles SQL von Hand für PostgreSQL geschrieben (Abschnitt 3.2). |
| F2 Kysely-Adapter (MySQL) | `mysql2`-Erkennung (`dialect.ts:109`) | Weglassen | Niemand. Genau eine Datenbank: PostgreSQL ≥ 14 (Abschnitt 3.2). Partielle Indizes, `inet`, `text[]`, `jsonb`, `ON CONFLICT … RETURNING`, CHECK-Constraints und Trigger sind tragende Teile des Entwurfs — Eindeutigkeit, Konsum, Ratenbegrenzung und Fixierungsschutz stehen in der Datenbank, nicht im Anwendungscode. Ein zweites Zielsystem müsste jede dieser Zusicherungen entweder nachbauen oder auf den kleinsten gemeinsamen Nenner senken; Better Auths Adapter-API zeigt, was dann übrig bleibt (F23, F48, F54, F55). |
| F3 Kysely-Adapter (better-sqlite3) | Erkennung über `aggregate` (`dialect.ts:103`) | Weglassen | Wie F2. SQLite kennt weder `inet`, `text[]`, `timestamptz` noch `gen_random_uuid()`; Fristenprädikate, IP-Normalisierung und ID-Erzeugung müssten in den Anwendungscode wandern. |
| F4 Kysely-Adapter (Bun SQLite) | Erkennung über `fileControl` (`bun-sqlite-dialect.ts`) | Weglassen | Wie F2; dieselbe SQLite-Grenze wie F3, nur über die Bun-Laufzeit erreicht. |
| F5 Kysely-Adapter (`node:sqlite`) | Erkennung über `createSession` + `DatabaseSync` (`node-sqlite-dialect.ts`) | Weglassen | Wie F2; dieselbe SQLite-Grenze wie F3, über das eingebaute Modul von Node erreicht. |
| F6 Kysely-Adapter (Cloudflare D1) | Eigener Dialekt **ohne** Transaktionen (`d1-sqlite-dialect.ts`) | Weglassen | Wie F2, und schärfer: ohne Transaktionen sind Registrierung, Identitätsverknüpfung und Sitzungsneuvergabe nicht atomar durchführbar. Ein Ziel, das die Zusicherung nicht erfüllt, wird gar nicht erst angeboten. |
| F7 Kysely-Adapter (MS SQL Server) | Über beliebigen Kysely-Dialekt (`dialect.ts`) | Weglassen | Wie F2. MS SQL Server hat kein `ON CONFLICT … RETURNING`; der Upsert der Ratenbegrenzung (Abschnitt 3.9) wäre dort ein `MERGE` mit eigener Nebenläufigkeitsgeschichte. |
| F8 Beliebiger Kysely-Dialekt | `createDriver`-Erkennung für Community-Dialekte (`dialect.ts:95-98`) | Weglassen | Wie F2. Eine Laufzeit-Erkennung fremder Dialekte bedeutet, dass die Bibliothek nicht weiß, wogegen sie läuft. |
| F9 Drizzle-Adapter | pg/mysql/sqlite, Transaktionen **per Vorgabe aus** (`drizzle-adapter.ts:1196`) | Weglassen | Niemand. Die abgeschaltete Vorgabe macht die Registrierung dort nicht atomar (Inventur N4-51) — ein ORM-Adapter, dessen Voreinstellung eine Zusicherung des Kerns aufhebt, ist schlimmer als kein Adapter. |
| F10 Prisma-Adapter | Transaktionen **per Vorgabe aus** (`prisma-adapter.ts:807-813`) | Weglassen | Wie F9. Prisma verlangt zudem ein eigenes Schema-Format neben dem SQL; zwei Beschreibungen derselben Tabellen laufen auseinander. |
| F11 MongoDB-Adapter | Dokumentorientiert, `ObjectId` als ID-Generator (`mongodb-adapter.ts:865`) | Weglassen | Wie F2. Ohne Fremdschlüssel mit `ON DELETE CASCADE` müsste jede Nutzerlöschung ihre Sitzungen, Identitäten und Artefakte im Code nachziehen — die Fehlerklasse, aus der GHSA-2vg6-77g8-24mp stammt. |
| F12 Memory-Adapter | In-Memory für Tests und Prototypen (`memory-adapter.ts`) | Anders lösen | Tests laufen gegen echtes PostgreSQL; `@velve/auth/testing` liefert stattdessen Uhrkontrolle und deterministischen Zufall. Ein zweiter Datenspeicher für Tests prüft nicht das, was in Produktion läuft — Unique-Indizes, CHECK-Constraints und `ON CONFLICT` gibt es dort nicht. |
| F13 Eigenen Adapter bauen | `createAdapterFactory` + `CustomAdapter` (`db/adapter/factory.ts:55-60`) | Anders lösen | Die `Driver`-Schnittstelle hat zwei Methoden; wer einen weiteren Postgres-Treiber anbinden will, implementiert sie. Kein Adapter-Framework mit Feldtyp-Mapping, Where-Übersetzung und atomaren Fallbacks. |
| F14 Adapter-Testsuite | Wiederverwendbare Konformitätstests (`packages/test-utils/src/adapter/`) | Anders lösen | Eine Treiber-Konformitätssuite in `@velve/auth/testing`, die nur die zwei Methoden prüft — im Wesentlichen Parameterbindung, Typrückgabe und Transaktionsverschachtelung. |
| F15 Kernschema `user` | 7 Spalten, `order:1` (`get-tables.ts:198-246`) | Anders lösen | Siehe E1: andere Spalten, `email` nullable, Identitätsregel als CHECK-Constraint, Normalisierung per CHECK nachgeprüft. |
| F16 Kernschema `session` | 8 Spalten, FK auf `user` mit `ON DELETE CASCADE` (`get-tables.ts:130-195`) | Anders lösen | `token_sha256 bytea UNIQUE` statt Klartext-Token, zwei Fristen statt einer, `factors text[]`, `ip inet`, plus `session_sweep_idx` auf `absolute_expires_at`. |
| F17 Kernschema `account` | 13 Spalten, Tokens mit `returned:false` (`get-tables.ts:251-341`) | Anders lösen | Aufgeteilt in `velve.identity` (mit `UNIQUE (provider, subject)` und verschlüsselten Tokens) und `velve.password_credential` (PHC-String). Kennwörter und Fremdidentitäten in derselben Tabelle zu führen ist der Grund, warum Better Auth `providerId:"credential"` als Sonderwert braucht. |
| F18 Kernschema `verification` | 6 Spalten, `identifier` indiziert, nicht unique (`get-tables.ts:89-128`) | Anders lösen | `velve.one_time_token` mit `token_sha256` als Primärschlüssel und `purpose` — kein generischer Identifier/Value-Speicher, in dem 2FA-Challenges, Reset-Tokens, Magic Links, OTP-Zähler und Trust-Records nebeneinander liegen. Zweckbindung ist Teil des Konsumprädikats (Abschnitt 3.7). |
| F19 Optionales Schema `rateLimit` | Nur bei `rateLimit.storage:"database"` (`get-tables.ts:60-84`) | Übernehmen | `velve.rate_bucket` ist immer vorhanden, weil die Datenbank ohnehin Pflicht ist und es keinen zweiten Speicher gibt. |
| F20 Schema aus Config berechnen | `getAuthTables` baut das logische Schema bei jedem Start neu (`get-tables.ts:369`) | Weglassen | Niemand. Das Schema ist statisch und liegt als versionierte SQL-Datei im Paket; die einzige Verzweigung ist der Identitäts-CHECK, den die erste Migration setzt. Ein bei jedem Start neu berechnetes Schema ist die Ursache des fehlenden Versionsvertrags (Inventur N4-52). |
| F21 Plugin-Schemata mergen | Neue Tabellen **und** neue Spalten an Kerntabellen (`get-tables.ts:30-57`) | Anders lösen | Plugins legen ausschließlich eigene Tabellen mit Präfix `<plugin-id>_` im Schema `velve` an; Kerntabellen bleiben unverändert (Abschnitt 3.11). Damit kann kein Plugin ein Kernfeld überschatten — bei Better Auth ist das durch die Reihenfolge der Objekt-Spreads unbeabsichtigt möglich. |
| F22 Physische Schema-Normalisierung | Löst `fieldName`, `references.model` und Indexnamen auf (`db/get-schema.ts:6-56`) | Weglassen | Niemand; es gibt kein Mapping, das aufzulösen wäre (E9/E10). |
| F23 Feldtypen | `string`, `number`, `boolean`, `date`, `json`, `string[]`… (`core/src/db/type.ts:164-171`) | Übertreffen | Keine Typabstraktion, sondern die echten PostgreSQL-Typen: `uuid`, `timestamptz`, `bytea`, `inet`, `text[]`, `jsonb`, plus CHECK-Constraints und partielle Unique-Indizes. Better Auth kann davon nichts (Inventur N4-45/46) und legt `string[]` als JSON-String in `jsonb` ab (N4-47). |
| F24 `bigint`-Flag | Erzeugt `bigint` statt `integer` (`get-tables.ts:77`) | Weglassen | Entfällt mit F23; der Typ steht im SQL. |
| F25 Feld-Indizes | `index: true` / `unique: true` auf Feldebene (`type.ts:248,278`) | Weglassen | Entfällt mit F23; Indizes stehen als `CREATE INDEX` im Migrationsschritt, inklusive partieller Indizes, die das Flag gar nicht ausdrücken kann. |
| F26 Tabellen-Indizes | `indexes: [{fields, name?, unique?}]` (`type.ts:286-293`) | Weglassen | Wie F25. Zusammengesetzte Indizes stehen als `CREATE INDEX` mit ausgeschriebenen Spalten im Migrationsschritt; ein `indexes`-Array kann weder `WHERE` noch Ausdrücke. |
| F27 Index-Namensvergabe | `<table>_<felder>_idx` mit FNV-1a-Kürzung auf 63 Byte (`database-index.ts:52-86,250-351`) | Weglassen | Wie F25. Namen sind ausgeschrieben und stabil; eine Hash-Kürzung erzeugt Namen, die niemand in einem `EXPLAIN` wiedererkennt. |
| F28 Index-Längenbudget für MySQL/MSSQL | Berechnet `varchar(N)` aus Index-Byte-Limits (`database-index.ts:202-242`) | Weglassen | Entfällt mit F2. PostgreSQL braucht für `text` kein `varchar(N)`, das aus einem Index-Byte-Budget zurückgerechnet werden müsste. |
| F29 `transform.input` / `transform.output` | Feld-Level-Transformationen auf jedem Schreib-/Lesepfad (`factory.ts:251-253,354-378`) | Weglassen | Niemand. Normalisierung liegt an genau einer Stelle im Kern (Abschnitt 3.4) und wird von der Datenbank nachgeprüft; unsichtbare Transformationen auf jedem Pfad machen nicht nachvollziehbar, was tatsächlich in der Spalte steht. |
| F30 `returned: false` | Blendet ein Feld aus allen Antworten aus (`db/schema.ts:60-66`) | Anders lösen | Der Ausgabetyp jeder Route steht in der Routendeklaration (Abschnitt 3.12); vertrauliche Werte verlassen die Repositories gar nicht erst, statt am Ende herausgefiltert zu werden. Ein vergessenes Flag ist bei Better Auth ein Leck, hier ein Typfehler. |
| F31 `input: false` | Nimmt ein Feld aus dem Eingabe-Schema heraus (`db/to-zod.ts:23-25`) | Anders lösen | Das Eingabeschema wird nicht aus dem Datenbankschema abgeleitet, sondern in der Routendeklaration geschrieben. Deshalb gibt es kein Feld, das versehentlich beschreibbar wird (Inventur N5-60). |
| F32 CLI `generate` | Erzeugt Schema-Dateien bzw. SQL (`packages/cli/src/commands/generate.ts`) | Anders lösen | `@velve/auth/schema` liefert das SQL als Datei im Paket aus; es wird nicht zur Laufzeit erzeugt und nicht aus der Konfiguration abgeleitet. Was ausgeliefert wird, ist genau das, was läuft. |
| F33 CLI `migrate` | Führt den Plan aus — nur Kysely, nicht transaktional, kein Verlauf (`cli/src/commands/migrate.ts:53-88`, N4-37/39/40) | Übertreffen | Versionierter Migrationsläufer mit `velve.schema_migration` (Version, Name, Zeitpunkt, Prüfsumme), jeder Schritt in einer eigenen Transaktion, Teil der Bibliothek statt eines CLI-Sonderwegs. Plugin-Migrationen laufen im selben Läufer (Abschnitt 3.11). |
| F34 Migrationsplan berechnen | Introspektion + Diff (`get-migration.ts:584-1235`) | Weglassen | Niemand. Es gibt keinen Diff, sondern nummerierte, geschriebene Schritte. Ein aus einem Diff erzeugter Plan kann Spalten nicht umbenennen, löschen oder umtypisieren (N4-38) — genau das, wofür man Migrationen braucht. |
| F35 Programmatische Migration | `getMigrations(config)` liefert Plan und `runMigrations()` (`get-migration.ts`) | Übernehmen | `@velve/auth/schema` exportiert Läufer und Statusabfrage, damit Migrationen im Deployment-Prozess laufen können. |
| F36 „Unsafe change"-Schutz | Verweigert Pflichtspalten ohne Vorgabe an befüllten Tabellen (`get-migration.ts:1024-1039`) | Anders lösen | Die Sicherung ist die Prüfsumme in `velve.schema_migration`: ein nachträglich veränderter Schritt wird beim Start erkannt. Heuristiken über die Gefährlichkeit einer Änderung entfallen, weil die Schritte geschrieben und überprüfbar sind. |
| F37 Schema-Drift-Prüfung zur Laufzeit | `validateSchema` meldet Abweichungen mit Fix-Hinweis (`schema-diff.ts:88-125`) | Anders lösen | Beim Start wird die höchste angewandte `schema_migration.version` gegen die vom Paket erwartete verglichen; Abweichung ist ein Startfehler, keine Warnung. Damit existiert der Versionsvertrag, der Better Auth fehlt (N4-52). |
| F38 `disableMigration` je Tabelle | Nimmt eine Plugin-Tabelle aus Migration und Diff heraus (`core/src/db/plugin.ts:10`) | Weglassen | Niemand. Migrationen sind nicht abwählbar; eine abgewählte Tabelle ist eine Instanz, deren Schema von der Version abweicht, die sie behauptet. |
| F39 Datenbank-Hooks `user` | `create.before/after`, `update.before/after` (`init-options.ts:1405`) | Anders lösen | Über die aufgezählten Punkte `beforeUserCreate` und `afterUserCreate` (Abschnitt 3.11) — an der fachlichen Operation, nicht am CRUD-Vorgang. Ein Hook darf ablehnen oder beobachten, nicht die Antwort ersetzen. |
| F40 Datenbank-Hooks `session` | dito (`init-options.ts:1405`) | Anders lösen | Über `beforeSessionCreate`, `afterSessionCreate`, `beforeSessionRevoke`. Es gibt keinen Update-Hook, weil die Sitzung nicht umgeschrieben, sondern neu vergeben wird (Abschnitt 3.5). |
| F41 Datenbank-Hooks `account` | dito | Weglassen | Niemand. Es gibt keinen Erweiterungspunkt an `velve.identity`; die Verknüpfungsregel (Abschnitt 3.10) ist die eine Stelle, an der über Identitäten entschieden wird, und sie ist nicht verhandelbar. |
| F42 Datenbank-Hooks `verification` | dito | Weglassen | Niemand. Einmal-Artefakte werden ausschließlich vom Kern erzeugt und konsumiert; ein Hook dazwischen wäre ein Weg, den atomaren Konsum zu umgehen. |
| F43 Hook-Ausführung | `createWithHooks` / `updateWithHooks` (`db/with-hooks.ts:35-80`) | Übernehmen | Eine Ausführungskette, topologisch nach `dependsOn` sortiert; ein geworfener Fehler bricht die Operation ab (Vetorecht). |
| F44 Transaktionen | `adapter.transaction(cb)` per `AsyncLocalStorage`, flach, ohne Savepoints (`core/src/context/transaction.ts:100-164`) | Übertreffen | `Driver.transaction` ist Pflichtbestandteil der Treiberschnittstelle; ein Treiber, der sie nicht kann, ist kein Treiber. Kein `AsyncLocalStorage`-Kontext, der bei einem Adapter durchgereicht wird und beim nächsten nicht. |
| F45 `runWithTransaction`-Nutzung | Sign-up, `createOAuthUser`, `consumeVerificationValue`, Account-Linking (`sign-up.ts:183` u. a.) | Übernehmen | Dieselben Stellen plus Sitzungsneuvergabe (INSERT + DELETE) und Wiederherstellungscode-Wechsel. |
| F46 Joins | `advanced.database.joins`, Vorgabe `false` (`factory.ts:628-743`) | Übernehmen | Die Sitzungsauflösung ist eine Abfrage mit Join auf `velve.user` — ohne Option. Die Vorgabe `false` bedeutet bei Better Auth, dass die häufigste Operation überhaupt zwei Round-Trips kostet. |
| F47 Join-Ersatz | Ohne Joins eine separate Query pro Relation (`factory.ts:748-828`) | Weglassen | Niemand; es gibt keinen Fall ohne Join. |
| F48 Where-Operatoren | `eq, ne, lt, …, contains, starts_with` (`db/adapter/index.ts:308-320`) | Weglassen | Niemand. Es gibt keine Query-Abstraktion; das SQL jeder Operation ist geschrieben und liegt im Repository. Damit entfallen auch die Grenzen dieser Abstraktion (N4-48/49). |
| F49 Where-Konnektoren | `AND`/`OR`, flach, nicht klammerbar (`db/adapter/index.ts:324-343`) | Weglassen | Wie F48. Klammerung und Verschachtelung sind im geschriebenen SQL selbstverständlich; eine Abstraktion, die sie nicht kann, zwingt zu mehreren Abfragen, wo eine reicht. |
| F50 `mode: "insensitive"` | Case-insensitives Matching per `LOWER()`/`ILIKE` (`kysely-adapter/src/query-builders.ts:8-58`) | Anders lösen | Die Vergleichsform ist materialisiert (`email` normalisiert, `username_key`), nicht zur Abfragezeit berechnet. Nur so greift der Unique-Index; ein `LOWER()` im `WHERE` erzwingt einen Sequential Scan und lässt Duplikate zu. |
| F51 Sortierung | `sortBy: {field, direction}` — genau ein Feld (`db/adapter/index.ts:422-428`) | Weglassen | Wie F48. Die wenigen Listen (Sitzungen, Identitäten, Passkeys) haben ihre Sortierung im geschriebenen SQL. |
| F52 Limit/Offset | `limit`, `offset`, `defaultFindManyLimit` 100 (`factory.ts:1204-1207`) | Weglassen | Wie F48; Listen sind fest begrenzt, weil sie pro Nutzer klein sind. |
| F53 `consumeOne` | Atomares „löschen und zurückgeben" (`db/adapter/index.ts:591-602`) | Übernehmen | `DELETE … WHERE … AND expires_at > now() RETURNING` ist das einzige Konsummuster für Einmal-Artefakte (Abschnitt 3.7) — die stärkste Idee im Better-Auth-Code, hier ohne Ausnahme angewandt. |
| F54 `incrementOne` | Atomarer geschützter Zähler mit Guard-Bedingungen (`db/adapter/index.ts:603-620`) | Anders lösen | `INSERT … ON CONFLICT DO UPDATE … RETURNING` in einem Round-Trip (Abschnitt 3.9). Better Auth emuliert das mangels Upsert mit bis zu vier Round-Trips (Inventur N4-42). |
| F55 Atomare Fallbacks | Snapshot-Guard bzw. bis zu 5 CAS-Runden, wenn der Adapter nichts Natives hat (`db/adapter/atomic-fallback.ts`) | Weglassen | Niemand. PostgreSQL kann Konsum und Upsert nativ; ein Ersatzpfad ist derselbe Wettlauf, nur leiser — genau die Klasse von CVE-2026-53518 (gleichzeitige Code-Einlösung). |
| F56 `consumeVerificationValue` | Atomares Single-Use-Primitiv für alle Einmal-Tokens (`internal-adapter.ts:1376-1420`) | Übernehmen | Als `token/`-Modul mit genau einer Konsumfunktion, an `purpose` gebunden. |
| F57 `reserveVerificationValue` | Replay-Tombstone mit deterministischem Primary Key (`internal-adapter.ts:1510-1545`) | Anders lösen | Der Replay-Schutz sitzt im Primärschlüssel selbst: `velve.totp_used_step (user_id, time_step)` und `velve.webauthn_challenge (challenge_sha256)`. Ein `INSERT`, der bei Konflikt scheitert, **ist** die Prüfung — kein zweites Artefakt, das man vergessen kann anzulegen. |
| F58 Verification-Cleanup | Löscht abgelaufene Zeilen bei jedem Nachschlagen, abschaltbar (`internal-adapter.ts:1333-1345`) | Anders lösen | Aufräumen läuft über die `*_sweep_idx`-Indizes in einer aufrufbaren Wartungsfunktion, nicht auf dem Antwortpfad. Abgelaufene Zeilen sind ohnehin unwirksam, weil `expires_at > now()` Teil jedes Prädikats ist; Löschen ist Speicherpflege, keine Sicherheitsmaßnahme, und gehört nicht in die Latenz einer Anmeldung. |

**F: Übernehmen 7 · Anders lösen 20 · Weglassen 28 · Übertreffen 3**

---

### G. Erweiterbarkeit (41)

#### G.1 Die Erweiterungspunkte

| Funktion | Better Auth | Velve Auth | Begründung |
|---|---|---|---|
| G1 Server-Plugin-Interface | 16 Felder, u. a. `init`, `middlewares`, `onRequest`, `onResponse`, `adapter` (`core/src/types/plugin.ts:32-163`) | Anders lösen | Kleinere Schnittstelle: `id`, `dependsOn`, `routes`, `hooks` (die sieben aufgezählten Punkte), `tables`, `migrations`, `rateLimit`, `errorCodes`. Kein `init`, kein `middlewares`, kein `onRequest`/`onResponse`, kein `adapter` — ein Plugin ist ein Zuhörer mit Vetorecht, kein Miteigentümer des Kerns (Abschnitt 3.11). |
| G2 Client-Plugin-Interface | `getActions`, `getAtoms`, `pathMethods`, `atomListeners`, `fetchPlugins` (`plugin-client.ts:94`) | Anders lösen | Client-Methoden entstehen aus der Routendeklaration des Plugins, so wie die Kernmethoden aus der des Kerns. Ein Plugin liefert keine eigene Client-Laufzeit. |
| G3 Plugin-Endpunkte | Werden in `auth.api.*` gemerged, überschreiben Kern-Endpunkte bei gleichem Key (`api/index.ts:177-266`) | Anders lösen | Plugin-Routen liegen im reservierten Namensraum `/x/<plugin-id>/…`; Kernrouten sind nicht überschreibbar (Abschnitt 3.11). Bei Better Auth gewinnt das zuletzt registrierte Plugin — die Reihenfolgefalle, an der `custom-session` hängt. |
| G4 Endpunkt-Kollisionserkennung | Erkennt Pfad-Kollisionen, **loggt nur** (`api/index.ts:58-171`) | Übertreffen | Ein Namenskonflikt ist ein Startfehler, keine Warnung (Abschnitt 3.11). Eine Kollision, die nur geloggt wird, ist im Betrieb nicht von einem funktionierenden System zu unterscheiden. |
| G5 `serverOnly`-Endpunkte | Endpunkt ohne HTTP-Route, teils ohne Pfad (`packages/api-key/src/routes/verify-api-key.ts:514`) | Übernehmen | In der Routendeklaration als `http: false`; es entsteht eine Servermethode und keine Route, aber dieselbe Eingabeprüfung. |
| G6 `metadata.isAction:false` / `scope:"http"` | Blendet Endpunkte aus dem Client-Typ aus (`types/api.ts:4-17`) | Übernehmen | Dieselbe Deklaration steuert, ob eine Client-Methode entsteht — an einer Stelle statt in zwei Metadatenfeldern. |
| G7 Plugin-DB-Schema | Neue Tabellen **und** neue Spalten an Kerntabellen (`core/src/db/plugin.ts:3-13`) | Anders lösen | Nur eigene Tabellen mit Präfix `<plugin-id>_`, Migrationen im selben versionierten Läufer; keine Spalten an Kerntabellen (Abschnitt 3.11). |
| G8 Schema-Umbenennung durch den Anwender | `InferOptionSchema` + `mergeSchema` (`db/schema.ts:280-314`) | Weglassen | Niemand; es gibt kein Namensmapping (E9/E10). Nebenbei entfällt damit auch, dass `mergeSchema` das übergebene Objekt in-place mutiert (`:303,:310`). |
| G9 `plugin.init` | Einziger Weg, globalen Kontext und Optionen zu verändern (`context/helpers.ts:23-95`) | Weglassen | Niemand. Der Kernkontext ist eingefroren (`Object.freeze`); ein Plugin bekommt keinen Weg, ihn zu verändern (Abschnitt 3.11). `init` ist bei Better Auth die Wurzel der stripe↔organization-Kopplung und der haveibeenpwned-Kaperung. |
| G10 Kontext-Injektion aus `init` | `{context: {...}}` wird per `Object.assign` gemischt (`types/plugins.ts:40-55`) | Weglassen | Entfällt mit G9. `Object.assign` in den Kontext ist der Weg, über den ein Plugin unbemerkt Kernfunktionen ersetzt (G24). |
| G11 Optionen-Merge aus `init` | `defu(options, restOpts)` (`context/helpers.ts:52`) | Weglassen | Entfällt mit G9. Ein Plugin darf Optionen anderer Plugins weder lesen noch schreiben (Abschnitt 3.11). |
| G12 `hooks.before` (global) | Nutzer-Hook auf beliebige Endpunkte (`api/dispatch.ts:271-278`) | Anders lösen | Die sieben aufgezählten Punkte gelten für Anwendung und Plugins gleichermaßen; es gibt keinen Hook auf einen beliebigen Endpunkt, weil ein solcher Hook die Zusicherungen der Route unterläuft. |
| G13 `hooks.after` (global) | Analog für die Antwortseite (`dispatch.ts:279-286`) | Anders lösen | Wie G12; die `after`-Punkte (`afterSignIn`, `afterSessionCreate`, `afterUserCreate`) beobachten, sie ersetzen nichts. |
| G14 Plugin-`hooks.before` | Matcher-basierte Hooks je Endpunkt (`dispatch.ts:137-219`) | Anders lösen | Wie G12, mit Vetorecht: ein Hook darf einen Fehler werfen und die Operation abbrechen. |
| G15 Plugin-`hooks.after` | Können `APIError` abfangen und die Antwort ersetzen (`dispatch.ts:221-265`) | Weglassen | Niemand. Ein Hook darf die Antwort nicht ersetzen (Abschnitt 3.11). Genau diese Fähigkeit nutzt das i18n-Paket, um Fehlermeldungen zu überschreiben — und mit ihr kann jedes Plugin jede Fehlerantwort umschreiben. |
| G16 Kontext-Patch aus `before` | Rückgabe `{context:{…}}` patcht und die Kette läuft weiter (`dispatch.ts:194-216`) | Weglassen | Entfällt mit dem eingefrorenen Kontext (G9). |
| G17 Short-Circuit aus `before` | Jeder andere Rückgabewert wird die Antwort (`dispatch.ts:215,382-391`) | Anders lösen | Ein Hook darf ablehnen (Fehler werfen), aber keine eigene Erfolgsantwort setzen. Die Unterscheidung „Rückgabewert = Antwort" ist zu leicht versehentlich auszulösen. |
| G18 Antwort ersetzen aus `after` | Rückgabewert `!== undefined` ersetzt `context.returned` (`dispatch.ts:257-259`) | Weglassen | Entfällt mit G15; die Regel „`undefined` heißt unverändert, alles andere ersetzt" ist zu leicht versehentlich auszulösen (G17). |
| G19 Header-/Cookie-Merge aus Hooks | `set-cookie` wird appended (`dispatch.ts:86-100`) | Weglassen | Niemand. Cookies setzt ausschließlich der Kern; ein Plugin, das `set-cookie` anhängen darf, kann das Sitzungscookie überschreiben. |
| G20 `plugin.middlewares` | Router-Middleware mit Pfadmuster, nur auf dem HTTP-Pfad (`api/index.ts:197-228`) | Weglassen | Niemand. Ein Interception-Modell statt vier; Origin-Prüfung und Ratenbegrenzung liegen fest davor und laufen auch bei direkten Serveraufrufen (Abschnitt 3.11). |
| G21 `plugin.onRequest` | Kann Request ersetzen oder die Antwort kapern, nur HTTP-Pfad (`api/index.ts:313-330`) | Weglassen | Wie G20. Bei Better Auth ist genau das die Ursache dafür, dass captcha und die SCIM-Content-Type-Prüfung bei `auth.api.*` wirkungslos sind (Inventur N3-31). |
| G22 `plugin.onResponse` | Antwort ersetzen, nur HTTP-Pfad (`api/index.ts:334-352`) | Weglassen | Wie G20. Eine Antwort, die nach dem Handler noch ersetzt werden kann, macht den Ausgabetyp der Routendeklaration (Abschnitt 3.12) zur Behauptung. |
| G23 Kern-Endpunkt überschreiben | Endpunkt-Key neu belegen (`custom-session/index.ts:71`) | Weglassen | Niemand; es ist ein Startfehler (G4). |
| G24 Kontextfunktionen kapern | z. B. `ctx.password.hash` ersetzen (`haveibeenpwned/index.ts:129-150`) | Weglassen | Niemand. Passwort-Verifier, Sitzungsauflösung und Origin-Prüfung sind ausdrücklich nicht ersetzbar (Abschnitt 3.11) — das sind die drei Stellen, an denen ein Fehler nicht auffällt. |
| G25 `ctx.getPlugin(id)` / `hasPlugin(id)` | Zugriff auf andere Plugins **und deren Optionen** zur Laufzeit (`core/src/types/context.ts:313,342`) | Anders lösen | `dependsOn` deklariert die Abhängigkeit und wird topologisch aufgelöst; das Vorhandensein ist prüfbar, die Optionen des anderen Plugins bleiben unlesbar und unschreibbar. |
| G26 Plugin-Registry (Modul-Augmentation) | `BetterAuthPluginRegistry` macht `getPlugin("two-factor")` typisiert (`context.ts:82`) | Übernehmen | Dieselbe Typbrücke, aufgehängt an `dependsOn` statt an einem globalen Registry-Interface. |
| G27 Plugin-eigene Rate-Limit-Regeln | `rateLimit: [{window, max, pathMatcher}]` (`plugin.ts:148-154`) | Übernehmen | Regeln je Routenname des Plugins; sie laufen im selben Token-Bucket wie die Kernregeln. |
| G28 Plugin-eigene Trusted Origins | Über `init` an `trustedOrigins` anhängen (`context/helpers.ts:61-80`) | Weglassen | Niemand. Origins stehen ausschließlich in der Konfiguration der Anwendung. Ein Plugin, das Origins ergänzen darf, erweitert die CSRF-Grenze — bei Better Auth macht `expo` genau das. |
| G29 Plugin-Fehlercodes | `$ERROR_CODES` landen in `auth.$ERROR_CODES` (`types/plugins.ts:28-33`) | Übernehmen | Unverändert; Codes sind Teil der Routendeklaration des Plugins. |
| G30 Basis-Fehlercodes | 18 dokumentierte Codes (`docs/content/docs/reference/errors/`) | Übernehmen | Stabile Codes für die sichtbare Fehlerklasse; die unsichtbare Klasse hat definitionsgemäß keinen eigenen Code (Abschnitt 3.13). |
| G31 `$Infer`-Typbrücke | Plugin-Typen landen in `auth.$Infer` (`types/auth.ts:21-30`) | Übernehmen | Unverändert, abgeleitet aus der Routendeklaration statt aus einem freien Typfeld. |
| G32 Client-Typinferenz aus Server-Plugins | Endpunkte → Client-Methoden, Schema → Felder (`client/types.ts:28-134`) | Übernehmen | Gleiche Wirkung, aber aus einer einzigen Deklaration erzeugt statt aus dem Endpunkt-Objekt abgeleitet. |
| G33 Pfad→Objekt-Mapping im Client | `/two-factor/verify-totp` → `client.twoFactor.verifyTotp` per Laufzeit-Proxy (`client/path-to-object.ts`, `proxy.ts:36-125`) | Übertreffen | Die Zuordnung steht in der Routendeklaration, es gibt keinen Laufzeit-Proxy. Ein Client-Aufruf, den es nicht gibt, kompiliert nicht — bei Better Auth schickt der Proxy jeden Pfad ab, und Typsicherheit besteht nur zur Compile-Zeit (Inventur N7-77). |
| G34 `getActions` (Client) | Eigene Client-Methoden, `defu`-Merge, erstes Plugin gewinnt (`client/config.ts:177-184`) | Weglassen | Niemand; der Client entsteht vollständig aus der Deklaration. Ein Merge, bei dem „das erste Plugin gewinnt", ist eine stille Namenskollision. |
| G35 `getAtoms` (Client) | nanostores-Atome werden zu `use<Name>`-Hooks (`client/config.ts:149-151`) | Weglassen | Die Anwendung übernimmt; der Client führt keinen Zustand (B46). |
| G36 `pathMethods` (Client) | Erzwingt HTTP-Methoden je Pfad statt der Body-Heuristik (`client/config.ts:152-154`) | Übertreffen | Die Methode steht in der Deklaration. Die Heuristik „Body vorhanden → POST" (`client/proxy.ts:12-34`), die `pathMethods` korrigieren muss, existiert nicht. |
| G37 `atomListeners` (Client) | Signal-Recaller, die Atome invalidieren (`client/config.ts:155-157`) | Weglassen | Entfällt mit G35; ohne Atome gibt es nichts zu invalidieren, und die Datenschicht der Anwendung kennt ihre eigenen Signale. |
| G38 `fetchPlugins` (Client) | better-fetch-Plugins je Client-Plugin (`client/config.ts:52-92`) | Weglassen | Niemand. Der Client nimmt eine `fetch`-Implementierung entgegen; eine Plugin-Kette im Transport ist der Ort, an dem D18 möglich wird. |
| G39 Direkter Serveraufruf `auth.api.*` | Endpunkte ohne HTTP aufrufen; durchläuft nur `hooks.before/after` (`api/to-auth-endpoints.ts:74-118`) | Übertreffen | Die Servermethode stammt aus derselben Deklaration und durchläuft dieselbe Kette **einschließlich** Origin-Prüfung und Ratenbegrenzung (Abschnitt 3.11). Die Asymmetrie, die bei Better Auth captcha und SCIM-Prüfungen aushebelt, existiert nicht. |
| G40 `auth.$context` | Zugriff auf Adapter, Cookies und Secret für Plugins und Tests (`auth/base.ts:110-120`) | Weglassen | Niemand. Ein öffentlicher Zugang zum internen Kontext macht jede Einschränkung der Plugin-Schnittstelle wirkungslos; was Tests brauchen, liefert `@velve/auth/testing`. |
| G41 Zwei Entrypoints | `better-auth` (mit Kysely) und `better-auth/minimal` (`auth/full.ts:27-31`) | Anders lösen | Ein Paket mit Subpfad-Exports (Abschnitt 3.1). Zwei Einstiegspunkte, die sich in ihren Abhängigkeiten unterscheiden, sind zwei Produkte mit einer Versionsnummer. |

**G.1: Übernehmen 8 · Anders lösen 10 · Weglassen 19 · Übertreffen 4**

#### G.2 Plugin für Plugin

Ausdrückliche Vorgabe des Auftraggebers: jedes Plugin bekommt eine eigene Zeile. Diese Tabelle
ist eine **Entscheidung je Paket** und wird in Abschnitt 2.N getrennt gezählt — die Funktionen der
Plugins selbst sind bereits in A–M enthalten und werden hier nicht doppelt gezählt.

**26 Plugins im Hauptpaket** (`packages/better-auth/src/plugins/`)

| Plugin | Better Auth | Velve Auth | Begründung |
|---|---|---|---|
| `two-factor` | TOTP, OTP, Backup-Codes, Trusted Device, Zwischenzustand (`plugins/two-factor/`) | Anders lösen | Der Zwischenzustand zwischen Kennwort und Faktor ist Teil des Sitzungsmodells und kann nicht nachgerüstet werden — TOTP, WebAuthn und Wiederherstellungscodes liegen im Kern (`core/factor/`, Abschnitt 3.6). OTP-über-E-Mail und Trusted Device entfallen (D9, D23). |
| `username` | Zusatzspalte `user.username` + eigene Sign-in-Route (`plugins/username/`) | Anders lösen | Eine der drei Kern-Identitätskonfigurationen mit `username`/`username_key` und CHECK-Constraint (Abschnitt 3.4), kein Plugin, das eine Spalte an die Nutzertabelle hängt. |
| `organization` | Organisationen, Mitglieder, Einladungen, Teams, dynamische Rollen, 44 Funktionen (`plugins/organization/`) | Weglassen | Die Anwendung übernimmt. Rollen, Berechtigungen, Organisationen und Teams sind ausdrücklich nicht Aufgabe der Bibliothek (Abschnitt 3.14). Das Plugin ist außerdem die Quelle der einzigen echten Kern-Kopplung bei Better Auth (`api/middlewares/authorization.ts:91-155`) und von CVE-2026-53514. |
| `access` | Bibliothek für Statements und Rollen (`plugins/access/`) | Weglassen | Die Anwendung übernimmt. Ein Berechtigungsvokabular gehört in die Domäne der Anwendung; eine Auth-Bibliothek, die es mitliefert, definiert deren Datenmodell mit. |
| `admin` | Nutzerverwaltung, Rollen, Ban, Impersonation (`plugins/admin/`) | Weglassen | Die Anwendung übernimmt. Velve Auth stellt `disabled_at` und die Sitzungswiderrufe bereit; wer sie setzen darf, ist eine Berechtigungsfrage. Eine Admin-API ohne Berechtigungsmodell ist eine ungeschützte API. |
| `anonymous` | Gastkonten mit Platzhalter-E-Mail (`plugins/anonymous/`) | Weglassen | Die Anwendung übernimmt (D50). Ein Gast ist kein Nutzer mit erfundener Adresse. |
| `bearer` | Bearer-Token → Session-Cookie, `requireSignature` Vorgabe `false` (`plugins/bearer/index.ts:78-85`) | Anders lösen | `auth.session.resolve(token)` nimmt das Token direkt entgegen (B45); es gibt keine Header-nach-Cookie-Umschreibung und keinen Modus, der unsignierte Tokens akzeptiert. |
| `captcha` | Turnstile/reCAPTCHA/hCaptcha/CaptchaFox als `onRequest` (`plugins/captcha/`) | Weglassen | Die Anwendung übernimmt (A50). Als `onRequest` umgesetzt wäre es bei Serveraufrufen wirkungslos, und `onRequest` gibt es nicht. |
| `custom-session` | Ersetzt den Kern-Endpunkt `/get-session` (`plugins/custom-session/index.ts:71`) | Weglassen | Die Anwendung übernimmt, nach dem Aufruf. Kernrouten sind nicht überschreibbar; ein Plugin, dessen Kern gerade das Überschreiben ist, kann es nicht geben (G3/G23). |
| `device-authorization` | RFC 8628 Device Flow (`plugins/device-authorization/`) | Weglassen | Niemand im Kern; ein Plugin kann es unter `/x/…` bauen. Der Device Flow setzt voraus, dass Velve Auth als Autorisierungsserver auftritt — das tut es nicht (Abschnitt 3.14). CVE-2026-45337 zeigt zudem, dass die Owner-Bindung der eigentliche Inhalt dieses Flows ist. |
| `email-otp` | OTP per E-Mail für Login, Verifikation, Reset, Wechsel; `storeOTP` Vorgabe `plain` (`plugins/email-otp/index.ts:42`) | Weglassen | Ein Plugin übernimmt. Ein Code per E-Mail ist funktional ein Magic Link mit schlechterer Entropie; Velve Auth bietet den Magic Link im Kern (D48) und speichert ihn nie im Klartext. Zudem war dieser Pfad Teil von GHSA-qq9h-g4jm-xgf3. |
| `generic-oauth` | Beliebige OAuth2/OIDC-Provider zur Laufzeit (`plugins/generic-oauth/`) | Übernehmen | Als Kernbestandteil statt als Plugin (C47), ohne die Möglichkeit, eingebaute Anbieter zu überschatten. |
| `haveibeenpwned` | Ersetzt `ctx.password.hash`, prüft gegen HIBP (`plugins/haveibeenpwned/`) | Weglassen | Die Anwendung übernimmt (A49). Der Mechanismus des Plugins — Kaperung der Hash-Funktion — ist ausdrücklich verboten (Abschnitt 3.11). |
| `jwt` | JWKS-Endpunkt, JWT-Ausgabe, JWT-Cookie-Cache-Signer (`plugins/jwt/`) | Weglassen | Die Anwendung übernimmt. Sitzungen sind undurchsichtige Datenbankzeilen; wer ein JWT für einen nachgelagerten Dienst braucht, stellt es aus der aufgelösten Sitzung selbst aus. Der Cookie-Cache-Signer entfällt mit B23. |
| `last-login-method` | Nicht-httpOnly-Cookie mit der letzten Methode (`plugins/last-login-method/index.ts:186`) | Weglassen | Die Anwendung übernimmt (E27). |
| `magic-link` | Login per E-Mail-Link, `storeToken` Vorgabe `plain` (`plugins/magic-link/index.ts:163`) | Übernehmen | Als Kernbestandteil mit `purpose='magic_link'`, Frist 10 min, ausschließlich als `sha256(token)` gespeichert (D48/D49). |
| `multi-session` | Mehrere Konten pro Gerät über einen Cookie-Fächer (`plugins/multi-session/`) | Weglassen | Die Anwendung oder ein Plugin übernimmt (B36). Der Kern kennt genau ein Sitzungscookie. |
| `oauth-popup` | Ersetzt den Callback-Redirect durch `postMessage` an den Opener (`plugins/oauth-popup/`) | Weglassen | Die Anwendung übernimmt (C96). Der Mechanismus gibt den Sitzungstoken aus dem `set-cookie`-Header an ein fremdes Fenster weiter. |
| `oauth-proxy` | Callbacks über eine feste Produktions-URL an Preview-URLs (`plugins/oauth-proxy/`) | Weglassen | Niemand (C95). Per Entwurf ein Umgehen der Origin-Bindung. |
| `one-tap` | Google One Tap über `id_token` (`plugins/one-tap/`) | Weglassen | Niemand (D47); setzt den ID-Token-Direkteinstieg voraus, den es nicht gibt. |
| `one-time-token` | Session-Transfer per Einmal-Token, Vorgabe `plain` (`plugins/one-time-token/index.ts:76,106`) | Weglassen | Die Anwendung übernimmt (B44). Ein Artefakt, dessen Wert ein Sitzungstoken ist, verdoppelt die Angriffsfläche der Sitzung. |
| `open-api` | OpenAPI-Schema + Scalar-Referenzseite von externem CDN (`plugins/open-api/index.ts:65`) | Anders lösen | Das OpenAPI-Dokument wird aus der Routendeklaration erzeugt und ist Kernbestandteil (H51); die Referenzseite entfällt, weil die Bibliothek kein HTML rendert und kein fremdes Skript lädt (H52). |
| `phone-number` | Telefonnummer als Identität + OTP, Registrierung mit Platzhalter-E-Mail (`plugins/phone-number/`) | Weglassen | Ein Plugin übernimmt (E25/E26). |
| `siwe` | Sign-In with Ethereum (`plugins/siwe/`) | Weglassen | Ein Plugin übernimmt (D44). Eigene Routen unter `/x/siwe/…` und eine eigene Tabelle reichen dafür aus. |
| `test-utils` | Setzt Testhelfer in den Produktionskontext (`plugins/test-utils/`) | Anders lösen | `@velve/auth/testing` ist ein eigener Subpfad-Export (Abschnitt 3.1), kein Plugin. Ein Plugin, das „nie in Produktion geladen werden darf", ist ein Plugin, das irgendwann in Produktion geladen wird. |
| `additional-fields` (nur Client) | Typinferenz für `user`/`session`-Zusatzfelder (`plugins/additional-fields/client.ts`) | Weglassen | Niemand; es gibt keine Zusatzfelder an Kerntabellen (E5–E8), also nichts zu inferieren. |

**12 externe Pakete**

| Paket | Better Auth | Velve Auth | Begründung |
|---|---|---|---|
| `@better-auth/passkey` | WebAuthn als eigenes Paket, `attestationType: "none"`, `requireUserVerification: false` (`packages/passkey/`) | Anders lösen | Im Kern statt als Paket, mit `userVerification: "required"` und BE/BS-Auswertung (D33/D43). Ein eigener Anmeldeweg gehört nicht in ein Paket, das man vergessen kann zu installieren. |
| `@better-auth/api-key` | API-Keys mit Rate-Limit, Refill, Permissions; `before`-Hook fabriziert eine Session (`packages/api-key/src/index.ts:169-269`) | Weglassen | Die Anwendung übernimmt. API-Keys sind Maschinenidentitäten, nicht „wer ist angemeldet"; der Mechanismus des Plugins — eine erfundene Session mit dem Klartext-Key als Token (`:245`) — ist mit dem Sitzungsmodell unvereinbar. GHSA-99h5-pjcv-gr6v / CVE-2025-61928 (CVSS 8.6) betraf diese Funktion, damals noch im Kernpaket `better-auth` < 1.3.26. |
| `@better-auth/sso` | OIDC- und SAML2-Service-Provider je Domain/Organisation (`packages/sso/`) | Weglassen | Die Anwendung oder ein dediziertes Produkt übernimmt. Kein SAML, kein SSO (Abschnitt 3.14). Auf dieses eine Paket entfallen vier der schwersten Advisories: GHSA-5rr4-8452-hf4v (CVSS 9.6, SSRF), GHSA-gv74-j8m3-fg5f, GHSA-prpr-5gj3-qqhg, GHSA-8c5h-wx78-2cfg. |
| `@better-auth/oauth-provider` | Vollständiger OAuth-2.1-/OIDC-Autorisierungsserver, 7 Tabellen (`packages/oauth-provider/`) | Weglassen | Niemand. Velve Auth beantwortet, wer angemeldet ist; ein Autorisierungsserver zu sein ist die umgekehrte Rolle mit eigener Bedrohungslage (Abschnitt 3.14). Größte Angriffsfläche im Better-Auth-Repo, mit CVE-2026-53517 und CVE-2026-53518. CVE-2026-53512 und GHSA-9h47-pqcx-hjr4 betreffen dagegen die Vorgängerplugins `oidcProvider`/`mcp` im Paket `better-auth` < 1.6.11, nicht dieses Paket. |
| `@better-auth/mcp` | MCP-Resource-Server, dekoriert `oauthProvider()` (`packages/mcp/src/plugin.ts:170-224`) | Weglassen | Niemand; setzt den Autorisierungsserver voraus. Ausdrücklich ausgeschlossen. |
| `@better-auth/scim` | SCIM-2.0-Provisionierung, 7–9 Tabellen (`packages/scim/`) | Weglassen | Die Anwendung oder ein dediziertes Produkt übernimmt. Kein SCIM (Abschnitt 3.14). Betroffen von GHSA-rjg6-39jm-rgg4 (CVSS 9.9) und GHSA-j8v8-g9cx-5qf4. |
| `@better-auth/stripe` | Abos, Kunden, Seats, Webhooks; mutiert die Optionen des Organization-Plugins (`packages/stripe/src/index.ts:256`) | Weglassen | Die Anwendung übernimmt. Kein Abo-/Bezahlmodul (Abschnitt 3.14). Der Mechanismus — ein Plugin schreibt in die Optionen eines anderen — ist ausdrücklich verboten (Abschnitt 3.11). |
| `@better-auth/expo` | Expo/React-Native: überschreibt den `origin`-Header, hängt `set-cookie` als Query-Parameter an Deep-Links (`packages/expo/src/index.ts:36-102`) | Weglassen | Die Anwendung übernimmt. Beide Kernmechanismen des Pakets — Origin-Override und Cookie-im-Query-Parameter — sind mit der Origin-Prüfung und dem Cookie-Modell unvereinbar. Native Anwendungen laufen über den Autorisierungscode-Fluss im System-Browser. |
| `@better-auth/electron` | Desktop-Login über den System-Browser, `transfer_token`-Cookie (`packages/electron/`) | Weglassen | Die Anwendung übernimmt, nach demselben Muster (RFC 8252, PKCE, eigener Redirect-Handler). Die Bibliothek liefert dafür `genericOAuth` und `session.resolve`, sie braucht kein Desktop-Paket. |
| `@better-auth/i18n` | Übersetzt `APIError`-Messages über einen `after`-Hook mit `matcher: () => true` (`packages/i18n/src/index.ts:155-183`) | Anders lösen | Die Bibliothek liefert stabile Fehlercodes statt Prosatexte; übersetzt wird in der Anwendung (H53). Der Mechanismus des Pakets — ein Hook, der jede Antwort abfängt und ersetzt — existiert nicht (G15). |
| `@better-auth/redis-storage` | `SecondaryStorage`-Implementierung für Redis (`packages/redis-storage/`) | Weglassen | Niemand. Kein Secondary Storage (B32); die Datenbank ist der einzige Ort für Sitzungszustand. |
| `@better-auth/cimd` | Client-ID-Metadata-Document-Auflösung für MCP/OAuth (`packages/cimd/`) | Weglassen | Niemand; setzt den Autorisierungsserver voraus. |

**Plugin-Entscheidungen: Übernehmen 2 · Anders lösen 7 · Weglassen 29** (38 Pakete, getrennt gezählt)

---

### H. Betrieb und Querschnitt (57)

| Funktion | Better Auth | Velve Auth | Begründung |
|---|---|---|---|
| H1 Rate-Limiting global | `onRequest`-Hook vor jeder Endpunkt-Logik; `enabled` = `isProduction` (`api/rate-limiter/index.ts`) | Übertreffen | Immer aktiv, auch in der Entwicklung, und immer vor der Routenlogik — auch bei direkten Serveraufrufen (Abschnitt 3.11). Ein Schutz, der in der Entwicklung aus ist, wird in der Entwicklung nie getestet. |
| H2 Rate-Limit-Vorgaben | `window` 10 s, `max` 100 (`create-context.ts:354-362`) | Anders lösen | Token-Bucket mit kontinuierlicher Nachfüllrate statt eines festen Fensters. Ein festes Fenster erlaubt am Fensterrand die doppelte Rate. |
| H3 Speicher `memory` | Prozesslokale `Map`, gedeckelt auf 100 000 Einträge, Vorgabe (`rate-limiter/index.ts:302-326`) | Weglassen | Niemand. Prozesslokale Zähler sind in Serverless- und Mehrinstanz-Betrieb wirkungslos, und Better Auth warnt nicht einmal (Inventur N7-75). Der Zähler liegt in PostgreSQL, das ohnehin Pflicht ist. |
| H4 Speicher `database` | Tabelle `rateLimit`, race-frei über bedingtes `incrementOne` (`rate-limiter/index.ts:115-245`) | Übertreffen | Ein einziger `INSERT … ON CONFLICT DO UPDATE … RETURNING` je Prüfung (Abschnitt 3.9). Better Auth emuliert den Upsert mangels `ON CONFLICT` in der Adapter-API mit bis zu vier Round-Trips (Inventur N4-42). |
| H5 Speicher `secondary-storage` | Fixed Window über `SecondaryStorage.increment` (`rate-limiter/index.ts:280-301`) | Weglassen | Entfällt mit B32. Ein festes Fenster über `increment` erlaubt zudem am Fensterrand die doppelte Rate (H2). |
| H6 Speicher `customStorage` | Eigene Implementierung einhängen (`init-options.ts:291`) | Weglassen | Niemand. Ein Speicher, in der Datenbank, die immer da ist; eine austauschbare Implementierung der Ratenbegrenzung ist eine austauschbare Sicherheitsgrenze. |
| H7 Endpunkt-spezifische Limits | sign-in/sign-up 3/10 s, reset 3/60 s, Rest 100/10 s (`rate-limiter/index.ts:439-468`) | Übernehmen | Gleiche Größenordnungen, je Routenname deklariert. |
| H8 `customRules` | Eigene Regeln je Pfad, `false` schaltet ab (`rate-limiter/index.ts:381-407`) | Übernehmen | Regeln je **Routenname** statt je Pfadmuster; abschalten kann man eine Regel, nicht den Zähler. |
| H9 Rate-Limit-Schlüssel | `` `${ip}\|${path}` `` — kein Schlüssel pro Konto (`core/src/utils/ip.ts:395-399`) | Übertreffen | Drei Zähler gleichzeitig: IP-Präfix (`/32` bzw. `/64`, CVE-2026-45364), Konto als Eimer mit langsam nachfüllender Rate — Überschreitung ist Ablehnung, keine Verzögerung und keine Sperre (L-5) —, und global je Route als Alarm-Callback statt als Ablehnung. Der Schlüssel enthält den aufgelösten Routennamen, damit `//sign-in` und `/sign-in` derselbe Zähler sind (GHSA-x732-6j76-qmhm). |
| H10 IP-Ermittlung | `x-forwarded-for`, konfigurierbar über `ipAddressHeaders` (`utils/ip.ts:346,354-385`) | Anders lösen | `X-Forwarded-For` wird nur ausgewertet, wenn `trustedProxies` konfiguriert ist; sonst zählt die Verbindungsadresse (Abschnitt 3.9). Kein frei wählbarer Header-Name — ein konfigurierbarer Header ist ein konfigurierbarer Spoofing-Kanal. |
| H11 `trustedProxies` (CIDR) | Läuft die Forwarded-Kette von rechts, fail-closed (`utils/ip.ts:317-331`) | Übernehmen | Unverändert übernommen, einschließlich der fail-closed-Behandlung malformierter Hops. |
| H12 `disableIpTracking` | Schaltet die IP-Erfassung ab (`init-options.ts:298`) | Übernehmen | Als `sessionMetadata: "none"` (L-10); die Vorgabe ist `"truncated"`. Die Ratenbegrenzung arbeitet dann weiter auf der Verbindungsadresse, ohne sie zu speichern. |
| H13 429-Antwort | Setzt `X-Retry-After` statt `Retry-After` (`rate-limiter/index.ts:94-107`) | Anders lösen | `Retry-After` nach RFC 9110, damit Clients und Zwischenschichten den Wert überhaupt auswerten. |
| H14 Cookie-Namensschema | `session_token`, `session_data`, `account_data`, `dont_remember`, `state`, `oauth_state` (`cookies/index.ts:119-154`) | Anders lösen | Zwei Cookies: `__Host-velve_session` und `__Host-velve_pending`. Kein `session_data` (B23), kein `account_data` (C94), kein `dont_remember` (B14); der OAuth-State steht in der Datenbank, das Cookie hält nur einen Zeiger (C52). |
| H15 `advanced.cookiePrefix` | Präfix aller Auth-Cookies frei wählbar (`cookies/index.ts:95`) | Weglassen | Niemand. `__Host-` ist keine Zierde, sondern die Zusicherung; ein freier Präfix hebt sie auf. |
| H16 `advanced.cookies[x].name` | Einzelne Cookie-Namen überschreiben (`cookies/index.ts:96-98`) | Weglassen | Wie H15. Ein umbenanntes Cookie ohne `__Host-`-Präfix verliert die Zusicherung genauso wie ein umbenannter Präfix. |
| H17 `advanced.cookies[x].attributes` | Attribute je Cookie überschreiben — gewinnt über alles, auch `httpOnly` (`cookies/index.ts:102-114`) | Weglassen | Niemand. Eine Option, mit der man `httpOnly` abschalten kann, ist eine Option, mit der man das Sitzungstoken an JavaScript ausliefert. |
| H18 `advanced.defaultCookieAttributes` | Globale Vorgabeattribute, z. B. `SameSite=None`, `Partitioned` (`cookies/index.ts:102-114`) | Weglassen | Wie H17. `SameSite=None` ist mit `__Host-` und der Origin-Prüfung nicht vorgesehen; bei Better Auth bleibt in dieser Konfiguration kein CSRF-Schutz übrig (Inventur N3-23). |
| H19 `useSecureCookies` + `__Secure-` | Vierstufige Auflösung, `__Secure-` bei `secure` (`cookies/index.ts:65-75`) | Übertreffen | `__Host-` erzwingt `Secure`, verbietet `Domain` und bindet an `Path=/` — damit ist Cookie-Tossing aus einer Subdomain strukturell ausgeschlossen. Better Auth definiert die Konstante, benutzt sie aber nie (`cookies/cookie-utils.ts:34-35`, Inventur N3-22). |
| H20 `crossSubDomainCookies` | `enabled`, `domain`, `additionalCookies` (`cookies/index.ts:76-90`) | Weglassen | Die Anwendung übernimmt, über eine gemeinsame Origin oder eine eigene Tokenübergabe. `__Host-` verbietet `Domain`; Subdomain-weite Sitzungscookies vertrauen jeder Subdomain, auch der vergessenen. |
| H21 Cookie-Signierung | HMAC-SHA256 über den Wert mit `ctx.secret` (`better-call dist/crypto.mjs:21-31`) | Anders lösen | Das Sitzungscookie trägt ein 256-bit-Zufallstoken, dessen Gültigkeit ausschließlich die Datenbank entscheidet — eine Signatur wäre wirkungslos und würde Integrität suggerieren, wo Existenz zählt. Signiert wird nur, wo ein Zeiger unversehrt bleiben muss, mit dem HKDF-abgeleiteten Schlüssel `cookie-sig`. |
| H22 `getSessionCookie`-Helfer | Liest das Session-Cookie außerhalb des Handlers (`cookies/index.ts:579-586`) | Übernehmen | Übernommen, mit dem ausdrücklichen Hinweis, dass die Anwesenheit eines Cookies keine Authentifizierung ist. |
| H23 `trustedOrigins` statisch | Liste erlaubter Origins (`auth/trusted-origins.ts`) | Übernehmen | Als `origins: [...]`; Pflichtangabe ohne Vorgabe. |
| H24 `trustedOrigins` dynamisch | Funktion pro Request (`init-options.ts:1383`) | Weglassen | Niemand. Eine Funktion pro Request macht die CSRF-Grenze von Anwendungscode abhängig, der im Fehlerfall alles erlaubt; Mandanten tragen ihre Origins in die Liste ein. |
| H25 `trustedOrigins` Wildcards | `*.example.com`, protokollspezifisch und -agnostisch (`trusted-origins.ts:125-138`) | Weglassen | Niemand. Nur exakte Origins. Präfix- und Wildcard-Vergleiche waren die produktivste Fehlerquelle des Projekts: GHSA-36rg-gfq2-3h56 (`startsWith`), GHSA-vp58-j275-797x (Token-Exfiltration), CVE-2025-27143 (`//evil.com`). |
| H26 Custom Schemes | `myapp://`, `chrome-extension://`, `exp://**` per String-Zerlegung statt `new URL()` (`trusted-origins.ts:32-73`) | Anders lösen | Nicht-HTTP-Schemata werden als vollständige, exakte Origin eingetragen und als solche verglichen; keine eigene String-Zerlegung und kein `**`. Ein selbstgebauter URL-Parser neben dem eingebauten ist ein Parser-Differential (vgl. GHSA-prpr-5gj3-qqhg). |
| H27 Redirect-URL-Validierung | Lehnt `//`, `\`, Steuerzeichen, `%2f` ab (`trusted-origins.ts:14-105`) | Anders lösen | Es werden gar keine vollständigen URLs entgegengenommen: `redirect_path` ist ein Pfad, serverseitig gehalten (Abschnitt 3.10). Was man nicht annimmt, muss man nicht validieren — fünf Advisories dieser Klasse (Nr. 1, 3, 4, 5, 25 im Sicherheitsbericht) hätten so nicht entstehen können. |
| H28 `originCheckMiddleware` | Origin/Referer-Prüfung auf allen nicht-GET-Routen mit Cookie (`origin-check.ts:67-151`) | Übernehmen | Übernommen und verschärft: sie läuft auch bei direkten Serveraufrufen und ist nicht abschaltbar. |
| H29 `Origin: null`-Sonderfall | Rekonstruiert die Origin bei `Sec-Fetch-Site: same-origin` (`origin-check.ts:253-269`) | Übernehmen | Unverändert; notwendig für Redirect-Ketten und Sandbox-Frames. |
| H30 Callback-URL-Validierung | `callbackURL`, `redirectTo`, `errorCallbackURL`, `newUserCallbackURL` gegen `trustedOrigins` (`origin-check.ts:83-150`) | Anders lösen | Vier Parameter mit URL-Semantik werden zu einem Pfadparameter (H27). Jeder zusätzliche URL-Parameter ist eine weitere Stelle, an der die Validierung vergessen werden kann — CVE-2024-56734 war genau das. |
| H31 `advanced.disableCSRFCheck` | Schaltet die CSRF-Prüfung ab (`create-context.ts:397`) | Weglassen | Niemand. Die Prüfung ist Teil der festen Kette vor jeder Route (Abschnitt 3.11) und kennt keinen Schalter. Wer sie abschalten will, hat in der Praxis einen fehlenden Origin in der Liste — das wird dort behoben, nicht an der Prüfung; und ein Schalter, der in der Entwicklung umgelegt wird, bleibt in der Produktion umgelegt. |
| H32 `advanced.disableOriginCheck` | Schaltet die URL-Validierung ab, und aus Kompatibilität auch CSRF (`create-context.ts:398-403`) | Weglassen | Niemand. Eine Option, die zwei Prüfungen zugleich abschaltet, obwohl ihr Name nur eine nennt, ist der Grund, warum es sie nicht geben darf. |
| H33 `advanced.trustedProxyHeaders` | Vertraut `X-Forwarded-Host`/`-Proto` bei der baseURL-Ermittlung (`init-options.ts:500`) | Weglassen | Niemand. Die Basis-URL ist Konfiguration. Das Vertrauen in `X-Forwarded-Host` beim ersten Request war CVE-2025-71401: ein externer Request vergiftete den Basispfad dauerhaft. |
| H34 `advanced.skipTrailingSlashes` | Toleriert abweichende Trailing Slashes (`init-options.ts:534`) | Anders lösen | Pfade werden vor der Auflösung normalisiert, und der Schlüssel für Ratenbegrenzung und Regeln ist der aufgelöste Routenname — nicht der rohe Pfad. Toleranz als Option ist die Ursache von GHSA-x732-6j76-qmhm. |
| H35 `secret` | Ein Secret für Cookie-Signaturen, E-Mail-JWTs und Cookie-Cache (`init-options.ts:603`) | Anders lösen | Ein Wurzelschlüssel, daraus per HKDF-SHA256 sechs zweckgetrennte Schlüssel: `cookie-sig`, `token-pepper`, `totp-enc`, `oauth-token-enc`, `pkce-enc`, `password-enc` (Abschnitt 3.8, L-2). Better Auth hat keine Domain-Separation; HKDF nur im JWE-Pfad (Inventur N3-27). |
| H36 `secrets` (versioniert) | Rotation über `[{version, value}]`, aber nur für Verschlüsselung (`init-options.ts:616`, N3-26) | Übertreffen | Jeder erzeugte Wert trägt seine Schlüsselversion, ein Ring akzeptierter Versionen erlaubt Rotation ohne Ausfall — für **alle** Zwecke, nicht nur für Verschlüsselung. Und weil Sitzungen undurchsichtige Datenbankzeilen sind, überlebt jede Rotation sämtliche Sitzungen. |
| H37 Envelope-Format `$ba$<v>$<hex>` | Verschlüsselte Werte tragen ihre Schlüsselversion (`crypto/index.ts:16-98`) | Übernehmen | Gleiches Prinzip; die Version steht zusätzlich als eigene Spalte (`key_version`, `token_key_version`), damit sie ohne Parsen auswertbar ist. |
| H38 Lazy Re-Encryption | Alte Envelopes werden beim nächsten Schreiben gehoben (`context/secret-utils.ts:75-167`) | Übernehmen | Unverändert; dasselbe Muster wie beim stillen Rehash. |
| H39 Secret-Entropieprüfung | Warnt bei schwachem Secret, wirft bei Vorgabe-Secret in Produktion (`create-context.ts:46-72`) | Übernehmen | Übernommen als Startfehler bei zu kurzem Wurzelschlüssel — es gibt keinen Vorgabe-Wurzelschlüssel, der gewarnt werden müsste. |
| H40 `logger` | Eigener Logger mit Level-Steuerung (`init-options.ts:1399`) | Übernehmen | Unverändert. Serverseitig wird der wahre Grund jeder unsichtbaren Ablehnung protokolliert (Abschnitt 3.13). |
| H41 `onAPIError` | Zentraler Fehler-Callback mit `throw`, `onError`, `errorURL` (`init-options.ts:1698`) | Anders lösen | Ein Fehler-Callback ohne `errorURL`-Variante, weil es keine von der Bibliothek gerenderte Fehlerseite und keinen Fehler-Redirect gibt (A52). |
| H42 `disabledPaths` | Einzelne Endpunkte HTTP-seitig abschalten (`api/index.ts:296-301`) | Weglassen | Niemand. Welche Routen es gibt, ergibt sich aus der Konfiguration — Identitätskonfiguration, aktivierte Faktoren, Anbieterliste. Eine nachträgliche Abschaltliste ist eine zweite Wahrheit über die Oberfläche, und sie war an GHSA-x732-6j76-qmhm beteiligt. |
| H43 `basePath` | Montagepunkt der API, Vorgabe `/api/auth` (`init-options.ts:579`) | Übernehmen | Unverändert. |
| H44 `baseURL` statisch | Feste öffentliche URL (`init-options.ts:571`) | Übernehmen | Pflichtangabe statt Option mit Ableitung. |
| H45 `baseURL` dynamisch | Funktion pro Request, Kontext wird pro Request geklont (`auth/base.ts:64-73`) | Weglassen | Niemand. Eine Basis-URL je Instanz; ein pro Request geklonter Kontext macht jede Aussage über „den" Kontext ungültig. |
| H46 `appName` | Anzeigename für TOTP-Issuer und OpenAPI (`init-options.ts:547`) | Übernehmen | Unverändert, zusätzlich als WebAuthn-`rpName`. |
| H47 `backgroundTasks.handler` | Hintergrundarbeit an `waitUntil` o. ä. übergeben (`create-context.ts:409-427`) | Übernehmen | Notwendig: der stille Rehash läuft nach dem Senden der Antwort in einer begrenzten Hintergrundaufgabe (Abschnitt 3.3, Schritt 6), ebenso der E-Mail-Versand. |
| H48 Telemetrie | Anonyme Init- und Event-Telemetrie, opt-in (`packages/telemetry/src/index.ts:67-90`) | Weglassen | Niemand. Die Bibliothek meldet nichts nach außen. Eine Authentifizierungsbibliothek, die im Startpfad einen fremden Endpunkt kennt, ist erklärungsbedürftig — auch wenn sie ihn nicht ruft. |
| H49 Telemetrie-Detektoren | Runtime, Datenbank, Framework, System, Paketmanager (`packages/telemetry/src/detectors/`) | Weglassen | Entfällt mit H48. Die Erkennung von Laufzeit, Datenbank und Framework ist ein Fingerabdruck; auch anonymisiert gehört er nicht in eine Bibliothek, die nichts sendet. |
| H50 OpenTelemetry-Instrumentierung | Endpoint- und Datenbank-Spans (`docs/…/instrumentation.mdx`) | Anders lösen | Keine OTel-Abhängigkeit im Paket; Einhängepunkte sind der `logger` und der Alarm-Callback der globalen Ratenbegrenzung, aus denen die Anwendung Spans erzeugt. Eine Bibliothek mit sechs Kernabhängigkeiten nimmt kein Observability-SDK auf. |
| H51 OpenAPI-Schema erzeugen | `GET /open-api/generate-schema` per Plugin (`plugins/open-api/`) | Übernehmen | Als Kernbestandteil: die Routendeklaration ist bereits die vollständige Quelle (Pfad, Methode, Eingabe, Ausgabe, Fehlercodes), das Dokument wird daraus erzeugt statt aus laufenden Endpunkten abgeleitet. |
| H52 API-Referenzseite | `GET /reference` rendert Scalar von externem CDN (`plugins/open-api/index.ts:65-99`) | Weglassen | Die Anwendung übernimmt. Die Bibliothek rendert kein HTML und lädt kein fremdes Skript in den eigenen Origin. Nebenbei überspringt diese Route bei Better Auth alle `after`-Hooks (`dispatch.ts:418-421`). |
| H53 Fehlermeldungen übersetzen | `after`-Hook mit `matcher:()=>true` ersetzt `APIError`-Messages (`packages/i18n/src/index.ts:155-183`) | Anders lösen | Die Bibliothek liefert stabile Codes; die Anwendung übersetzt sie. Damit entfällt der Hook, der jede Antwort abfangen und ersetzen darf (G15). |
| H54 22 mitgelieferte Sprachen | ar, bn, de, en, es, fa, fr, hi, id, it, ja, ko, nl, pl, pt, ru, sv, th, tr, uk, vi, zh (`packages/i18n/src/locales/`) | Weglassen | Die Anwendung übernimmt. Übersetzungen, die eine Bibliothek mitliefert, altern mit ihrer Version, nicht mit dem Produkt. |
| H55 Locale-Erkennung | `header`, `cookie`, `session`, `callback` (`packages/i18n/src/index.ts:118-148`) | Weglassen | Die Anwendung übernimmt; sie kennt ihre Sprachwahl ohnehin. |
| H56 Test-Helfer im Kontext | Login-, Cookie- und Factory-Helfer als Plugin (`plugins/test-utils/`) | Anders lösen | `@velve/auth/testing` als eigener Subpfad-Export mit Uhrkontrolle und deterministischem Zufall, kein Plugin, das sich in den Produktionskontext hängen kann. |
| H57 CLI-Befehle (11) | `init`, `generate`, `migrate`, `secret`, `create-admin`, `info`, `upgrade`, `ai`, `login`, `logout`, `mcp` (`packages/cli/src/index.ts:24-36`) | Anders lösen | Kein CLI. Was gebraucht wird, sind Programmierschnittstellen: `@velve/auth/schema` (Migrationsläufer, Statusabfrage) und `@velve/auth/import`. Von den elf Befehlen entfallen `create-admin` mangels Rollenmodell, `login`/`logout`/`mcp`/`ai` binden an den kostenpflichtigen Dienst, `generate`/`migrate` werden zur Bibliotheksfunktion, `secret` ist ein Einzeiler mit `crypto.getRandomValues`. |

**H: Übernehmen 17 · Anders lösen 15 · Weglassen 20 · Übertreffen 5**

---

### I. Autorisierung und Organisationen (71)

Der gesamte Abschnitt entfällt. Velve Auth beantwortet genau eine Frage — wer ist angemeldet.
Rollen, Berechtigungen, Organisationen, Teams, Einladungen, SCIM und SSO sind ausdrücklich nicht
Aufgabe der Bibliothek (Abschnitt 3.14). Wer sie braucht, baut sie in der Anwendung auf
`user_id` und den Sitzungsdaten auf oder setzt ein dediziertes Produkt ein. Die Begründung je
Zeile nennt, warum die Fähigkeit dort besser aufgehoben ist.

#### I.1 Access-Control-Bibliothek (5)

| Funktion | Better Auth | Velve Auth | Begründung |
|---|---|---|---|
| I1 `createAccessControl(statements)` | Definiert das Statement-Vokabular (`plugins/access/access.ts:157-169`) | Weglassen | Die Anwendung übernimmt. Das Vokabular beschreibt die Domäne der Anwendung; eine Auth-Bibliothek, die es vorgibt, bestimmt deren Modellierung mit. |
| I2 `newRole(statements)` | Erzeugt eine Rolle als Teilmenge (`access.ts:157-169`) | Weglassen | Die Anwendung übernimmt; Rollen sind Anwendungsdaten. |
| I3 `role.authorize(request, connector)` | Prüft eine Berechtigungsanfrage in-memory (`access.ts:106-155`) | Weglassen | Die Anwendung übernimmt. Eine In-Memory-Prüfung ohne Bezug zur Datenbank kann keine Aussage über den aktuellen Zustand machen. |
| I4 Connector `AND` / `OR` | `AND` Vorgabe, `OR` optional (`access.ts:87-104`) | Weglassen | Die Anwendung übernimmt; Verknüpfungssemantik gehört zur Regel, nicht zur Bibliothek. |
| I5 Vorgabe-Statements Organization | `organization[…]`, `member[…]`, `invitation[…]`, `team[…]` (`organization/access/statement.ts:3-41`) | Weglassen | Die Anwendung übernimmt. Ein mitgeliefertes Vokabular für Organisationen setzt voraus, dass es Organisationen gibt — die gibt es hier nicht. |

#### I.2 Organization-Plugin (54)

| Funktion | Better Auth | Velve Auth | Begründung |
|---|---|---|---|
| I6 Organisation anlegen | `POST /organization/create` | Weglassen | Die Anwendung übernimmt. Eine Organisation ist ein Objekt ihrer Domäne: welche Felder sie hat, wer sie anlegen darf und was ihre Löschung mit den Daten der Anwendung tut, weiß nur die Anwendung. Velve Auth liefert dafür `user_id` und `session.factors`, sonst nichts (Abschnitt 3.14). Alle Zeilen, die auf I6 verweisen, sind Lese- oder Schreibzugriffe auf dieses Objekt. |
| I7 Organisation aktualisieren | `POST /organization/update` | Weglassen | Wie I6; welche Felder änderbar sind, ist eine Frage des Datenmodells der Anwendung. |
| I8 Organisation löschen | `POST /organization/delete` | Weglassen | Wie I6; die Löschsemantik hängt an den Daten der Anwendung, nicht an der Identität. |
| I9 Organisationen auflisten | `GET /organization/list` | Weglassen | Wie I6; eine Liste ist eine Abfrage über eine Tabelle, die der Anwendung gehört. |
| I10 Einzelne Organisation lesen | `GET /organization/get-organization` | Weglassen | Wie I6; ein Lesezugriff auf eine Anwendungstabelle braucht keine Route in der Anmeldebibliothek. |
| I11 Vollbild einer Organisation | `GET /organization/get-full-organization` | Weglassen | Wie I6; ein Aggregat über sechs Tabellen ist eine Abfrage der Anwendung. |
| I12 Aktive Organisation setzen | `POST /organization/set-active` schreibt `session.activeOrganizationId` | Weglassen | Die Anwendung übernimmt. Ein Anwendungszustand in der Sitzungszeile ist genau die Fremdspalte an einer Kerntabelle, die es nicht geben soll (E6). |
| I13 Slug-Verfügbarkeit prüfen | `POST /organization/check-slug` | Weglassen | Wie I6. Slugs sind Anwendungsbezeichner, und ihre Verfügbarkeitsprüfung ist so aufzählbar wie E21 — nur begrenzt die Anwendung sie hier selbst. |
| I14 Mitglied einladen | `POST /organization/invite-member` | Weglassen | Die Anwendung übernimmt, über den eigenen E-Mail-Versand. Eine Einladung verbindet eine Adresse mit einer Mitgliedschaft, nicht mit einer Identität — und genau die Verwechslung war CVE-2026-53514 (I15). Alle Zeilen, die auf I14 verweisen, sind Zustandsübergänge dieses Anwendungsobjekts. |
| I15 Einladung annehmen | `POST /organization/accept-invitation` | Weglassen | Die Anwendung übernimmt. Better Auths Umsetzung akzeptierte E-Mail-Gleichheit als Eigentumsnachweis (CVE-2026-53514) — der Fehler entsteht dort, wo Identität und Mitgliedschaft vermischt werden. |
| I16 Einladung ablehnen | `POST /organization/reject-invitation` | Weglassen | Wie I14; Ablehnen ist ein Zustandswechsel an einem Objekt der Anwendung. |
| I17 Einladung stornieren | `POST /organization/cancel-invitation` | Weglassen | Wie I14; dasselbe Objekt, dieselbe Zuständigkeit — nur von der einladenden Seite. |
| I18 Einladung lesen | `GET /organization/get-invitation` | Weglassen | Wie I14. Wer eine Einladung lesen darf, entscheidet, wer den Link kennt — eine Berechtigungsfrage. |
| I19 Einladungen einer Org auflisten | `GET /organization/list-invitations` | Weglassen | Wie I14; Listen über Einladungen sind Abfragen der Anwendung. |
| I20 Eigene Einladungen auflisten | `GET /organization/list-user-invitations` | Weglassen | Wie I14; die Sicht des eingeladenen Nutzers ist eine Anwendungsansicht über `user_id`. |
| I21 `invitationExpiresIn` | Gültigkeitsdauer der Einladung (`types.ts:184`) | Weglassen | Wie I14; eine Frist für ein Objekt, das es nicht gibt. |
| I22 `invitationLimit` | Deckelt offene Einladungen (`types.ts:190`) | Weglassen | Wie I14; eine Obergrenze ist eine Geschäftsregel (I33). |
| I23 `cancelPendingInvitationsOnReInvite` | Storniert alte Einladungen (`types.ts:206`) | Weglassen | Wie I14; ob eine erneute Einladung die alte ersetzt, ist Ablaufsemantik der Anwendung. |
| I24 `requireEmailVerificationOnInvitation` | Verlangt verifizierte E-Mail zum Annehmen (`types.ts:229`) | Weglassen | Wie I14. Dass diese Prüfung optional war, ist der Kern von CVE-2026-53514. |
| I25 Mitglieder auflisten | `GET /organization/list-members` | Weglassen | Wie I6; die Mitgliederliste ist ein Join der Anwendung auf `velve.user`. |
| I26 Mitglied entfernen | `POST /organization/remove-member` | Weglassen | Wie I6. Wer entfernt werden darf, ist eine Berechtigungsfrage; die Sitzungen des Entfernten bleiben davon unberührt, denn Mitgliedschaft ist keine Identität. |
| I27 Mitgliedsrolle ändern | `POST /organization/update-member-role` | Weglassen | Die Anwendung übernimmt; Rollen sind Anwendungsdaten. |
| I28 Aktives Mitglied lesen | `GET /organization/get-active-member` | Weglassen | Wie I12; ohne aktive Organisation in der Sitzung gibt es kein „aktives Mitglied", nur einen Nutzer und die Mitgliedschaften der Anwendung. |
| I29 Rolle des aktiven Mitglieds lesen | `GET /organization/get-active-member-role` | Weglassen | Wie I12; die Rolle liest die Anwendung aus ihrer eigenen Tabelle. |
| I30 Organisation verlassen | `POST /organization/leave` | Weglassen | Wie I6; das Verlassen ist eine Zeile weniger in einer Anwendungstabelle. |
| I31 Mehrfachrollen je Mitglied | `member.role` als komma-separierter String (`api/middlewares/authorization.ts:100-105`) | Weglassen | Die Anwendung übernimmt — und modelliert Mehrfachrollen als Zeilen, nicht als kommaseparierten String in einer Textspalte. |
| I32 `creatorRole` | Rolle des Erstellers, Vorgabe `owner` (`types.ts:59`) | Weglassen | Wie I27; welche Rolle der Ersteller bekommt, ist eine Regel der Anwendung. |
| I33 `membershipLimit` | Maximale Mitgliederzahl (`types.ts:67`) | Weglassen | Wie I6; eine Geschäftsregel. |
| I34 `organizationLimit` | Maximale Organisationen je Nutzer (`types.ts:50`) | Weglassen | Wie I33; die Grenze zählt Objekte, die die Bibliothek nicht kennt. |
| I35 `allowUserToCreateOrganization` | Wer Organisationen anlegen darf (`types.ts:32`) | Weglassen | Wie I33; eine Berechtigungsentscheidung. |
| I36 Teams aktivieren | `teams.enabled` erzeugt `team`/`teamMember` (`types.ts:108-112`) | Weglassen | Wie I6. Teams sind Organisationen zweiter Stufe — dieselben Tabellen, eine Ebene tiefer — und teilen deren Begründung; die Zeilen I37–I44 und I46 sind ihre Lese- und Schreibzugriffe. |
| I37 Team anlegen | `POST /organization/create-team` | Weglassen | Wie I36; ein Einfügen in eine Anwendungstabelle. |
| I38 Team aktualisieren | `POST /organization/update-team` | Weglassen | Wie I36; siehe I7 für die Felder. |
| I39 Team löschen | `POST /organization/remove-team` | Weglassen | Wie I36; siehe I8 für die Löschsemantik. |
| I40 Teams auflisten | `GET /organization/list-teams` | Weglassen | Wie I36; eine Abfrage der Anwendung. |
| I41 Team-Mitglied hinzufügen | `POST /organization/add-team-member` | Weglassen | Wie I36. Wer hinzufügen darf, ist eine Berechtigungsfrage (I26). |
| I42 Team-Mitglied entfernen | `POST /organization/remove-team-member` | Weglassen | Wie I36; der Gegenzug zu I41, dieselbe Berechtigungsfrage. |
| I43 Team-Mitglieder auflisten | `GET /organization/list-team-members` | Weglassen | Wie I36; ein Join der Anwendung auf `velve.user` (I25). |
| I44 Eigene Teams auflisten | `GET /organization/list-user-teams` | Weglassen | Wie I36; die Sicht des Nutzers auf seine Mitgliedschaften, über `user_id`. |
| I45 Aktives Team setzen | `POST /organization/set-active-team` schreibt `session.activeTeamId` | Weglassen | Wie I12; `activeTeamId` wäre die zweite Anwendungsspalte an der Sitzungszeile. |
| I46 `teams.defaultTeam` | Legt automatisch ein Standardteam an (`types.ts:116`) | Weglassen | Wie I36; ein automatisch angelegtes Standardteam ist eine Vorgabe über Anwendungsdaten. |
| I47 `teams.maximumTeams` / `maximumMembersPerTeam` | Deckelungen (`types.ts:142,162`) | Weglassen | Wie I33; Deckelungen über Objekte, die die Bibliothek nicht kennt. |
| I48 Dynamic Access Control | `dynamicAccessControl.enabled` erzeugt `organizationRole` (`types.ts:87`) | Weglassen | Die Anwendung übernimmt. Zur Laufzeit veränderbare Rollen sind ein Berechtigungssystem mit eigenem Lebenszyklus — das ist ein eigenes Produkt. |
| I49 Rolle zur Laufzeit anlegen | `POST /organization/create-role` | Weglassen | Wie I48; eine Rolle anzulegen heißt, das Berechtigungsvokabular zur Laufzeit zu erweitern. |
| I50 Rolle aktualisieren | `POST /organization/update-role` | Weglassen | Wie I48; eine Rollenänderung wirkt auf jede laufende Berechtigungsprüfung, deren Semantik nur die Anwendung kennt. |
| I51 Rolle löschen | `POST /organization/delete-role` | Weglassen | Wie I48; das Löschen einer Rolle muss entscheiden, was mit ihren Trägern geschieht — eine Anwendungsregel. |
| I52 Rollen auflisten | `GET /organization/list-roles` | Weglassen | Wie I48; Listen sind Abfragen der Anwendung. |
| I53 Rolle lesen | `GET /organization/get-role` | Weglassen | Wie I48; Einzelzugriff, dieselbe Abfrage. |
| I54 Berechtigung prüfen | `POST /organization/has-permission` | Weglassen | Die Anwendung übernimmt. Eine Berechtigungsprüfung über HTTP ist zudem ein Round-Trip an der Stelle, an der die Anwendung ohnehin schon in ihrer Datenbank steht. |
| I55 `organizationHooks` | Before/After-Hooks für alle Organisationsvorgänge (`types.ts:363`) | Weglassen | Wie I6 — und der Ort, an dem `@better-auth/stripe` in fremde Plugin-Optionen schreibt (`stripe/index.ts:256`). |
| I56 `organization.additionalFields` / `schema` | Eigene Felder und Namensmapping für sechs Tabellen (`types.ts:293`) | Weglassen | Wie I6; die Tabellen gehören der Anwendung, samt ihrer Felder. |
| I57 Session-Erweiterung | `session.activeOrganizationId`, `session.activeTeamId` (`organization.ts:1257-1296`) | Weglassen | Wie I12. Die Sitzungszeile trägt nur, was zur Antwort „wer ist angemeldet, und wie sicher" gehört (Abschnitt 3.5). |
| I58 `requireOrgRole`-Middleware | Kern-Middleware, die die `member`-Tabelle liest (`api/middlewares/authorization.ts:91-155`) | Weglassen | Niemand — ausdrücklich. Das ist die einzige echte Kern-Kopplung des Organization-Plugins bei Better Auth: der Kern kennt eine Tabelle, die nur mit Plugin existiert. |
| I59 `ac` / `roles` | Eigenes Access-Control-Objekt und eigene Rollen einhängen (`types.ts:75,79`) | Weglassen | Wie I1; ein eigenes Access-Control-Objekt einzuhängen setzt das mitgelieferte voraus, das es nicht gibt. |

#### I.3 Admin-Plugin (10)

| Funktion | Better Auth | Velve Auth | Begründung |
|---|---|---|---|
| I60 Nutzer anlegen | `POST /admin/create-user` | Weglassen | Die Anwendung übernimmt, über die Servermethode `auth.signUp()` — die es ohne HTTP-Route gibt (A36/G5). Was fehlt, ist nur die Berechtigungsprüfung, und die gehört zur Anwendung. |
| I61 Nutzer auflisten / lesen / ändern / löschen | `/admin/list-users`, `/get-user`, `/update-user`, `/remove-user` | Weglassen | Die Anwendung übernimmt; sie hat direkten Zugriff auf `velve.user` und ihre eigenen Profiltabellen. |
| I62 Rolle setzen | `POST /admin/set-role` (`user.role`) | Weglassen | Die Anwendung übernimmt; es gibt kein `user.role`. |
| I63 Passwort setzen | `POST /admin/set-user-password` | Weglassen | Die Anwendung übernimmt, über die Servermethode aus A36. |
| I64 Bannen / entbannen | `/admin/ban-user`, `/admin/unban-user` mit Grund und Ablauf | Weglassen | Die Anwendung übernimmt. Velve Auth bietet `disabled_at` — die Sitzungsauflösung prüft es in derselben Abfrage — sowie den Widerruf aller Sitzungen; Grund und Ablaufdatum sind Anwendungsdaten. |
| I65 Ban-Durchsetzung | DB-Hook `session.create.before`, abgelaufene Bans lazy aufgehoben (`admin/admin.ts:88-121`) | Weglassen | Niemand. `disabled_at` wird bei jeder Sitzungsauflösung gelesen (Abschnitt 3.5) — eine Sperre wirkt sofort auf bestehende Sitzungen, nicht erst bei der nächsten Erzeugung. |
| I66 Sessions eines Nutzers verwalten | `/admin/list-user-sessions`, `/admin/revoke-user-session(s)` | Weglassen | Die Anwendung übernimmt, über die Servermethoden zu B17–B20 mit einer `user_id`. |
| I67 Impersonation-Sessions ausblenden | `after`-Hook filtert sie aus `/list-sessions` (`admin/admin.ts:128-144`) | Weglassen | Entfällt mit B41; es gibt keine Sitzungen, die vor dem Nutzer verborgen werden müssten. |
| I68 Berechtigung prüfen | `POST /admin/has-permission` | Weglassen | Wie I54; dieselbe Prüfung unter anderem Namensraum. |
| I69 Admin-Statements | Eigenes Statement-Set inkl. `impersonate-admins` (`admin/access/statement.ts`) | Weglassen | Wie I1. Dass `impersonate-admins` ein Statement ist, zeigt: Impersonation (B41) ist ein Berechtigungsproblem, kein Sitzungsproblem. |

#### I.4 SSO und SCIM (2)

| Funktion | Better Auth | Velve Auth | Begründung |
|---|---|---|---|
| I70 SSO je Domain/Organisation | OIDC- und SAML2-Provider je Domain oder Organisation, 14 Endpunkte, Domain-Verifikation, Provisioning (`packages/sso/src/`) | Weglassen | Die Anwendung oder ein dediziertes Produkt übernimmt. Kein SAML, kein SSO (Abschnitt 3.14). Auf dieses Paket entfallen GHSA-5rr4-8452-hf4v (CVSS 9.6, SSRF), GHSA-gv74-j8m3-fg5f, GHSA-prpr-5gj3-qqhg und GHSA-8c5h-wx78-2cfg — eine Fähigkeit, deren Umsetzung eine eigene Sicherheitsdisziplin ist. |
| I71 SCIM 2.0 Provisioning | Users und Groups per SCIM, Gruppen→Rollen-Mapping, 7–9 Tabellen (`packages/scim/src/`) | Weglassen | Wie I70. Kein SCIM (Abschnitt 3.14). Betroffen von GHSA-rjg6-39jm-rgg4 (CVSS 9.9, ATO über Provider-ID-Kollision) und GHSA-j8v8-g9cx-5qf4. |

**I: Übernehmen 0 · Anders lösen 0 · Weglassen 71 · Übertreffen 0**

---

### J. Als Identitätsanbieter auftreten (62)

Auch dieser Abschnitt entfällt vollständig. Velve Auth ist Relying Party, nicht Autorisierungsserver:
kein eigener OAuth-Server, kein SAML, kein Abo-Modul (Abschnitt 3.14). Die Rolle des Ausstellers hat eine
andere Bedrohungslage als die Rolle des Prüfers, und sie in dieselbe Bibliothek zu legen bedeutet,
beide Angriffsflächen an jeden Nutzer auszuliefern.

#### J.1 OAuth-2.1-/OIDC-Provider (37)

| Funktion | Better Auth | Velve Auth | Begründung |
|---|---|---|---|
| J1 Authorization-Endpunkt | `GET/POST /oauth2/authorize` (`packages/oauth-provider/src/authorize.ts`) | Weglassen | Niemand. Wer ein Identitätsanbieter sein will, betreibt einen — Velve Auth ist die Anmeldung einer Anwendung, nicht die Ausgabestelle für fremde. Die Rolle des Ausstellers bringt Client-Verwaltung, Token-Lebenszyklen, Zustimmung, Claims und Metadaten mit; keine dieser Fähigkeiten ist ohne die anderen brauchbar, und fast jede hat in der Advisory-Historie einen Eintrag (J2, J6, J12, J13, J23, J35). Deshalb entfällt der Block als Ganzes, und die Zeilen, die auf J1 verweisen, sind seine Bestandteile. |
| J2 Token-Endpunkt | `POST /oauth2/token` (`token.ts`) | Weglassen | Wie J1. Genau hier lagen CVE-2026-53518 (gleichzeitige Code-Einlösung) und CVE-2026-53517 (Refresh-Rotation forkt die Token-Familie); der Refresh-Replay ohne Client-Authentifizierung, CVE-2026-53512, traf das Vorgängerplugin `oidcProvider`. |
| J3 Introspection | `POST /oauth2/introspect` (RFC 7662) | Weglassen | Wie J1; Introspection beantwortet Fragen nach ausgestellten Tokens, die es nicht gibt. |
| J4 Revocation | `POST /oauth2/revoke` (RFC 7009) | Weglassen | Wie J1; widerrufen wird bei Velve Auth eine Sitzung (B18–B20), kein ausgestelltes Token. |
| J5 UserInfo | `GET/POST /oauth2/userinfo` | Weglassen | Wie J1; die Claims-Ausgabe an fremde Clients setzt ein Claims-Modell voraus (J28). |
| J6 Dynamic Client Registration | `POST /oauth2/register` (RFC 7591) | Weglassen | Wie J1. Eine unauthentifizierte Registrierung fremder Clients war der Weg zu GHSA-86j7-9j95-vpqj (`javascript:` als `redirect_uri`). |
| J7 Consent verarbeiten | `POST /oauth2/consent` | Weglassen | Wie J1; eine Zustimmungsoberfläche ist Produkt, nicht Bibliothek. |
| J8 Flow fortsetzen | `POST /oauth2/continue` | Weglassen | Wie J1; ein wiederaufnehmbarer Flow ist Zustand des Autorisierungsservers. |
| J9 RP-initiated Logout | `/oauth2/end-session(/confirm)` (`logout.ts`) | Weglassen | Wie J1; die Gegenrichtung — Abmeldung beim fremden Anbieter — ist A20. |
| J10 Back-Channel Logout | Logout-Tokens an registrierte URIs (`logout.ts:259-310`) | Weglassen | Wie J1; Back-Channel-Logout sendet Tokens an registrierte URIs und ist damit eine SSRF-Fläche (vgl. J62). |
| J11 AS-Metadata | `/.well-known/oauth-authorization-server` (RFC 8414) | Weglassen | Wie J1; Metadaten beschreiben einen Server, den es nicht gibt. |
| J12 OIDC-Discovery | `/.well-known/openid-configuration` | Weglassen | Wie J1. Better Auths Dokument bewarb zeitweise `alg=none` (GHSA-9h47-pqcx-hjr4). |
| J13 Client anlegen | `/oauth2/create-client`, `/admin/oauth2/create-client` | Weglassen | Wie J1; CVE-2026-41427 betraf genau diesen Pfad. |
| J14 Client lesen | `/oauth2/get-client(s)` | Weglassen | Wie J1; Client-Datensätze existieren nicht (J13). |
| J15 Client aktualisieren | `/oauth2/update-client` | Weglassen | Wie J1; siehe J14. |
| J16 Client löschen | `/oauth2/delete-client` | Weglassen | Wie J1; siehe J14. |
| J17 Client-Secret rotieren | `POST /oauth2/client/rotate-secret` | Weglassen | Wie J1. Client-Geheimnisse sind eine Ausstellerpflicht; auf der Prüferseite verwaltet Velve Auth nur die eigenen Zweckschlüssel (Abschnitt 3.8). |
| J18 Öffentliche Client-Info | `/oauth2/public-client(-prelogin)` | Weglassen | Wie J1; eine Anzeigeauskunft über Clients, die es nicht gibt. |
| J19 Consents lesen | `/oauth2/get-consent(s)` | Weglassen | Wie J1; Zustimmungen sind Zustand des Ausstellers (J7). |
| J20 Consent aktualisieren/löschen | `/oauth2/update-consent`, `/delete-consent` | Weglassen | Wie J1; siehe J19. |
| J21 Protected Resources verwalten | `/admin/oauth2/resources` CRUD | Weglassen | Wie J1; geschützte Ressourcen sind Objekte eines Autorisierungsservers. |
| J22 Client↔Resource verknüpfen | `/admin/oauth2/resources/:id/clients/:client_id` | Weglassen | Wie J1; siehe J21. |
| J23 Resource Indicators (RFC 8707) | Tokens an eine Zielressource gebunden (`resources.ts`) | Weglassen | Wie J1; GHSA-p2fr-6hmx-4528 zeigt, wie schwer diese Bindung vollständig zu ziehen ist. |
| J24 DPoP | Sender-constrained Access Tokens (RFC 9449) (`dpop.ts`) | Weglassen | Wie J1. DPoP bindet ausgestellte Tokens an einen Schlüssel; Velve Auths Sitzungstoken ist an nichts gebunden als an das `__Host-`-Cookie und die Datenbankzeile, und das mit Absicht (Abschnitt 3.5). |
| J25 PKCE-Konfiguration | Erzwingen oder optional machen (`authorize.ts`) | Weglassen | Wie J1. Auf der Client-Seite ist PKCE bei Velve Auth nicht konfigurierbar, sondern verpflichtend (C51). |
| J26 Client-Authentifizierung per JWKS | `private_key_jwt` / Client-Assertions (`client-jwks.ts`) | Weglassen | Wie J1; Client-Authentifizierung setzt Clients voraus (J13). |
| J27 Pairwise Subject Identifiers | `subjectType` je Client (`schema.ts:34-37`) | Weglassen | Wie J1; pairwise Subjects sind eine Ausstellereigenschaft — auf der Prüferseite ist `subject` stets der Wert des Anbieters (C62). |
| J28 Claims-Authority | Steuert, welche Claims wohin gelangen (`claims.ts`) | Weglassen | Wie J1. Ein Claims-Modell beschreibt, was ein Aussteller herausgibt; Velve Auth gibt nichts heraus und speichert die Claims der Anbieter roh (C63). |
| J29 Standard-Claims | OIDC-Standardclaim-Mapping (`standard-claims.ts`) | Weglassen | Wie J1; siehe J28. |
| J30 Claims-Request-Parameter | `claims`-Parameter wird ausgewertet (`claims-request.ts`) | Weglassen | Wie J1; siehe J28. |
| J31 Authentication Context (`acr`/`amr`) | Wird ausgegeben, unterstützt aber nur `acr = "0"` (`authentication-context.ts:10`) | Weglassen | Niemand als Protokollmerkmal. Die inhaltliche Aussage — womit wurde authentifiziert — steht in Velve Auth als `session.factors` zur Verfügung (Abschnitt 3.5) und ist damit für die Anwendung nutzbar, ohne ein Protokoll zu bedienen, das Better Auth ohnehin nur mit `acr = "0"` beantwortet. |
| J32 Signed Query | Signierte Authorize-Query zur Wiederaufnahme (`signed-query.ts`) | Weglassen | Wie J1; Wiederaufnahme-Zustand kennt Velve Auth nur als `velve.oauth_flow`-Zeile für die eigene Anbieteranmeldung (C52). |
| J33 Provider-Extensions | Eigene Erweiterungen in den Flow einhängen (`extensions.ts`) | Weglassen | Wie J1; Erweiterungen eines Flows, den es nicht gibt. |
| J34 Organisationsbindung | Clients an Organisationen binden | Weglassen | Wie J1; setzt zusätzlich Organisationen voraus (I6). |
| J35 Refresh-Token-Anpassung | Rotation/Lebensdauer konfigurierbar (`token.ts`) | Weglassen | Wie J1; CVE-2026-53517 (Token-Familien-Fork) betraf genau diese Rotation. |
| J36 Eigene Storage- und Rate-Limit-Konfiguration | Speicher und Limits separat einstellbar | Weglassen | Wie J1; die Ratenbegrenzung des Kerns gilt für alle Routen gleich (Abschnitt 3.9), und ein zweiter Speicher wäre B32. |
| J37 Sieben eigene Tabellen | `oauthClient`, `oauthResource`, `oauthClientResource`, `oauthRefreshToken`, `oauthAccessToken`, `oauthConsent`, `oauthClientAssertion` (`schema.ts`) | Weglassen | Wie J1. Sieben Tabellen für eine Rolle, die die Bibliothek nicht spielt; das Schema von Velve Auth hat sechzehn, alle für die Frage „wer ist angemeldet" (Abschnitt 3.17). |

#### J.2 Device Authorization (7)

| Funktion | Better Auth | Velve Auth | Begründung |
|---|---|---|---|
| J38 Device-Code anfordern | `POST /device/code` (RFC 8628) | Weglassen | Niemand im Kern; ein Plugin kann es unter `/x/…` bauen. Der Flow setzt voraus, dass Velve Auth Tokens für fremde Geräte ausstellt (J1). |
| J39 Token pollen | `POST /device/token` mit `pollingInterval` | Weglassen | Wie J38; das Pollen ist die Client-Seite eines Grants, den es nicht gibt. |
| J40 Verifikationsseite | `GET /device` mit eigenem Rate-Limit (`device-authorization/index.ts:274-281`) | Weglassen | Wie J38; die Bibliothek rendert ohnehin kein HTML (A52). |
| J41 Genehmigen | `POST /device/approve` | Weglassen | Wie J38. CVE-2026-45337: jede authentifizierte Sitzung galt als Eigentümerin jedes offenen Device-Codes. |
| J42 Ablehnen | `POST /device/deny` | Weglassen | Wie J38; der Gegenzug zu J41, mit derselben Eigentümerfrage. |
| J43 `validateClient`-Callback | Eigene Client-Prüfung (`routes.ts:370-380`) | Weglassen | Wie J38; eine Client-Prüfung setzt Clients voraus (J13). |
| J44 Tabelle `deviceCode` | Zwei Unique-Indizes, konfigurierbare Code-Erzeugung (`schema.ts`) | Weglassen | Wie J38; baut ein Plugin den Flow, gehört die Tabelle ihm — mit Präfix nach Abschnitt 3.11. |

#### J.3 JWT und JWKS (8)

| Funktion | Better Auth | Velve Auth | Begründung |
|---|---|---|---|
| J45 JWKS-Endpunkt | `GET /jwks` (`plugins/jwt/index.ts:58-68`) | Weglassen | Die Anwendung übernimmt. Wer nachgelagerten Diensten Tokens ausstellt, betreibt damit einen Aussteller — mit Schlüsselverwaltung, Rotation und Grace Period als eigener Verantwortung. |
| J46 Token ausstellen | `GET /token` liefert ein JWT für die aktuelle Session (`jwt/index.ts:250`) | Weglassen | Die Anwendung übernimmt: sie hat die aufgelöste Sitzung und kann daraus signieren, was ihre Dienste erwarten. Ein JWT aus der Auth-Bibliothek ist ein zweiter Sitzungsbegriff, der nicht widerrufbar ist. |
| J47 `signJWT` / `verifyJWT` | serverOnly-Endpunkte für eigene JWTs (`jwt/index.ts:286`) | Weglassen | Die Anwendung übernimmt, mit `jose`. Eine allgemeine Signaturfunktion gehört nicht in eine Auth-Bibliothek. |
| J48 Schlüsselverwaltung | Tabelle `jwks` mit `publicKey`, `privateKey`, `alg` (`jwt/adapter.ts`) | Weglassen | Entfällt mit J45. Velve Auth verwaltet Schlüssel nur für eigene Zwecke, per HKDF aus einem Wurzelschlüssel (Abschnitt 3.8). |
| J49 Private-Key-Verschlüsselung | Private Keys symmetrisch verschlüsselt, abschaltbar (`jwt/utils.ts:80-90`) | Weglassen | Entfällt mit J48. Dass sie abschaltbar ist, ist ein eigener Grund. |
| J50 Algorithmuswahl | Vorgabe EdDSA, andere wählbar (`jwt/adapter.ts:89`) | Weglassen | Entfällt mit J48. Eine Algorithmuswahl ist eine Erlaubnisliste, die jemand pflegen muss; `alg=none` (GHSA-9h47-pqcx-hjr4) ist die Erinnerung daran. |
| J51 Key Rotation mit Grace Period | Warnt bei zu kurzer Überlappung (`jwt/index.ts:92-97`) | Weglassen | Entfällt mit J48. Die Rotation eigener Schlüssel löst Velve Auth über den Versionsring (H36). |
| J52 JWT-Cookie-Cache-Signer | Signiert den Session-Cookie-Cache mit JWKS-Schlüsseln (`jwt/index.ts:79-105`) | Weglassen | Entfällt mit B23; es gibt keinen Cookie-Cache. |

#### J.4 API-Keys (7)

| Funktion | Better Auth | Velve Auth | Begründung |
|---|---|---|---|
| J53 Key erstellen | `POST /api-key/create` (`packages/api-key/src/routes/create-api-key.ts:130`) | Weglassen | Die Anwendung übernimmt. Ein API-Key ist eine Maschinenidentität mit eigener Lebensdauer und eigenen Berechtigungen — nicht die Antwort auf „wer ist angemeldet". |
| J54 Key lesen / auflisten | `POST /api-key/get`, `/list` | Weglassen | Wie J53; Lesen und Auflisten von Objekten der Anwendung. |
| J55 Key aktualisieren / löschen | `POST /api-key/update`, `/delete` | Weglassen | Wie J53; Ablauf und Widerruf gehören zum Lebenszyklus der Maschinenidentität, den die Anwendung bestimmt. |
| J56 Key verifizieren | `verifyApiKey`, serverOnly ohne Pfad (`routes/verify-api-key.ts:514`) | Weglassen | Wie J53. Die Prüfung ist ein Hash-Nachschlagen in einer Anwendungstabelle; was fehlt, ist die Pseudo-Session (J58), und die soll fehlen. |
| J57 Abgelaufene Keys aufräumen | `deleteAllExpiredApiKeys` (`routes/delete-all-expired-api-keys.ts:12`) | Weglassen | Wie J53; das Aufräumen abgelaufener Schlüssel ist ein Wartungslauf der Anwendung, analog zu `auth.maintenance.sweep()` (L-11). |
| J58 Pseudo-Session aus API-Key | `before`-Hook fabriziert eine Session und setzt `ctx.context.session` (`api-key/src/index.ts:169-269`) | Weglassen | Niemand — ausdrücklich. Eine erfundene Sitzung, deren Token der Klartext-Key ist (`:245`), unterläuft jede Aussage des Sitzungsmodells. Ein Plugin darf die Sitzungsauflösung nicht ersetzen (Abschnitt 3.11). |
| J59 Key-Eigenschaften | Hashing (abschaltbar), Ablauf, Rate-Limit, Refill, Permissions, Metadaten (`api-key/src/schema.ts`) | Weglassen | Wie J53. Dass das Hashing abschaltbar ist (`disableKeyHashing`), ist zusätzlich unvereinbar mit der Speicherregel aus Abschnitt 3.2. |

#### J.5 MCP und CIMD (3)

| Funktion | Better Auth | Velve Auth | Begründung |
|---|---|---|---|
| J60 MCP-Resource-Server | Dekoriert `oauthProvider()`, ergänzt RFC 9728 und RFC 8707 (`packages/mcp/src/plugin.ts:170-224`) | Weglassen | Niemand; setzt den Autorisierungsserver voraus (J1) und ist ausdrücklich ausgeschlossen (Abschnitt 3.14). |
| J61 `requireMcpAuth` / `createMcpProtectedRequestHandler` | Schutzhelfer für MCP-Handler (`packages/mcp/src/`) | Weglassen | Die Anwendung übernimmt: `auth.session.resolve(token)` ist der Baustein, aus dem ein solcher Helfer besteht. |
| J62 Client-ID-Metadata-Document (CIMD) | Löst OAuth-Clients aus HTTPS-Metadaten auf (`packages/cimd/src/`) | Weglassen | Niemand; setzt J1 voraus. Ein Fetch-Governor für fremde Metadaten-URLs ist außerdem eine SSRF-Fläche im Auth-Pfad. |

**J: Übernehmen 0 · Anders lösen 0 · Weglassen 62 · Übertreffen 0**

---

### K. Framework-Integrationen (26)

Gleichförmiger Block, daher zusammengefasst — jede Gruppe als eigene Zeile mit ihren Einzelposten.

| Funktion | Better Auth | Velve Auth | Begründung |
|---|---|---|---|
| K1–K8, K10, K11, K13–K15, K17–K21 — 18 Server-Integrationen | Next.js (Handler + `nextCookies`), Node (`toNodeHandler`), SvelteKit, SolidStart, TanStack Start (React), TanStack Start (Solid), Astro, Convex, Elysia, Encore, Express, Fastify, Hono, NestJS, Nitro, Nuxt, React Router, Waku — teils eigene Module in `src/integrations/`, teils reine Dokumentationsseiten | Anders lösen | Ein einziger Ausgabepunkt: `toWebHandler(auth): (Request) => Promise<Response>` aus `@velve/auth/http` (Abschnitt 3.1). Jedes Framework, das die Fetch-API spricht, montiert ihn unverändert; für `node:http` schreibt die Anwendung den üblichen Request/Response-Adapter oder benutzt einen vorhandenen. Framework-eigene Module altern mit dem Framework, nicht mit der Bibliothek — und die `nextCookies`-Sonderbehandlung existiert nur, weil dort Cookies außerhalb der Antwort gesetzt werden. |
| K9 Electron | Eigenes Paket mit `/electron/token`, `/electron/init-oauth-proxy`, `/electron/transfer-user`, Preload-Bridge und verlängertem `transfer_token`-Cookie (`packages/electron/src/`) | Weglassen | Die Anwendung übernimmt: Anmeldung im System-Browser nach RFC 8252 mit eigenem Redirect-Handler, danach `auth.session.resolve(token)`. Ein Übergabemechanismus mit eigenem, bei jedem Request verlängertem Cookie ist ein zweiter Sitzungsbegriff neben dem Sitzungscookie. |
| K12 Expo / React Native | Eigenes Paket: `exp://`-Origins in `init`, **Origin-Header-Override**, Deep-Link-Transfer mit `set-cookie` als Query-Parameter (`packages/expo/src/index.ts:26-102`) | Weglassen | Die Anwendung übernimmt, ebenfalls über RFC 8252. Beide tragenden Mechanismen des Pakets sind mit dem Entwurf unvereinbar: ein Plugin darf weder `origins` erweitern (G28) noch die Origin-Prüfung aufheben (Abschnitt 3.11), und ein Sitzungstoken gehört nicht in einen Query-Parameter. |
| K16, K22–K26 — 6 Client-Pakete | Lynx-Entrypoint, `better-auth/react`, `/vue`, `/svelte`, `/solid` sowie der Vanilla-Client als Laufzeit-Proxy über Pfadsegmente (`client/vanilla.ts:79-110`) | Anders lösen | Ein Client aus `@velve/auth/client`, erzeugt aus derselben Routendeklaration wie Handler und Servermethode — framework-unabhängig, ohne Zustandsverwaltung und ohne Laufzeit-Proxy (G33/G36). Die fünf Framework-Clients bei Better Auth unterscheiden sich im Wesentlichen in ihrer Reaktivitätsschicht; diese Schicht hat die Anwendung bereits. |

**K: Übernehmen 0 · Anders lösen 24 · Weglassen 2 · Übertreffen 0**

---

### L. Kommerzielle Zusätze — „Better Auth Infrastructure" (21)

Alle über `@better-auth/infra`, nicht im Repo, ausdrücklich „a paid service"
(`docs/content/docs/infrastructure/introduction.mdx`). Velve Auth hat keine kommerzielle Ebene:
was es kann, kann es in der Bibliothek; was es nicht kann, sagt es.

| Funktion | Better Auth | Velve Auth | Begründung |
|---|---|---|---|
| L1 `dash()`-Plugin | Verbindet die Instanz mit dem gehosteten Dashboard | Weglassen | Niemand. Keine Admin-Oberfläche (Abschnitt 3.14), und schon gar keine, die die Instanz an einen fremden Dienst bindet. |
| L2 Nutzerverwaltung im Dashboard | Ansehen, suchen, bannen, löschen | Weglassen | Die Anwendung übernimmt; sie hat direkten Datenbankzugriff (I61). |
| L3 Session-Monitoring | Aktive Sessions sehen und widerrufen | Weglassen | Die Anwendung übernimmt, über B17–B20 als Servermethoden. |
| L4 Organisationsübersicht | Organisationen und Mitglieder verwalten | Weglassen | Entfällt mit I6; eine Oberfläche über Objekte, die es nicht gibt. |
| L5 Analytics | Sign-ups, Sign-ins, aktive Nutzer über die Zeit | Weglassen | Die Anwendung übernimmt. `velve.user.created_at` und `velve.session.created_at` sind gewöhnliche Spalten in ihrer Datenbank. |
| L6 Activity Tracking | Pflegt `user.lastActiveAt` mit konfigurierbarem Intervall | Weglassen | Anders gelagert vorhanden: `session.last_used_at` wird ohnehin geführt (höchstens stündlich geschrieben). Eine zweite Spalte an der Nutzerzeile braucht es nicht. |
| L7 Managed Directory Sync | Verwaltete SCIM-Anbindung über die Control Plane | Weglassen | Entfällt mit I71; ein verwalteter Dienst um eine Fähigkeit, die nicht existiert. |
| L8 Audit Logs | Ereignishistorie sammeln und abfragen | Weglassen | Die Anwendung übernimmt. Kein Audit-Log (Abschnitt 3.14): ein Protokoll, das die Bibliothek in dieselbe Datenbank schreibt, ist genau so vertrauenswürdig wie der Prozess, der es schreibt. Was die Bibliothek liefert, sind Ereignisse am `logger` und die aufgezählten `after`-Punkte. |
| L9 Audit-Events: User | 7 Events (`user_signed_up`, `user_banned`, …) | Weglassen | Wie L8; `afterUserCreate` deckt den Teil ab, den die Bibliothek überhaupt kennt. |
| L10 Audit-Events: Session | 7 Events (`user_signed_in`, `session_revoked`, …) | Weglassen | Wie L8; `afterSignIn`, `afterSessionCreate`, `beforeSessionRevoke` sind die Einhängepunkte. |
| L11 Audit-Events: Account | 3 Events (`account_linked`, `account_unlinked`, `password_changed`) | Weglassen | Wie L8. Für Verknüpfungen gibt es keinen Hook (F41); die Anwendung protokolliert um ihren Aufruf von `identity.link`/`identity.unlink` herum, mit dem Ergebnis, das sie ohnehin erhält. |
| L12 Audit-Events: Verification | 3 Events (`password_reset_requested/completed`, …) | Weglassen | Wie L8; Reset-Anforderung und -Abschluss sind Aufrufe der Anwendung, deren Ergebnis sie selbst protokollieren kann. |
| L13 Audit-Events: Organization | 14 Events | Weglassen | Entfällt mit I6; vierzehn Ereignisse über Objekte, die es nicht gibt. |
| L14 Audit-Events: Security | 11 Events aus Sentinel | Weglassen | Entfällt mit L15; die Ereignisse sind Ausgaben eines Detektors, der nicht vorhanden ist. Was die Bibliothek stattdessen meldet, ist der Alarm-Callback je Route aus Abschnitt 3.9. |
| L15 `sentinel()`-Plugin | Abwehrschicht mit `log`, `challenge`, `block` | Weglassen | Die Anwendung oder ein spezialisierter Dienst übernimmt. Eine Verhaltensabwehr braucht Daten über viele Mandanten hinweg; eine Bibliothek im Prozess des Nutzers hat sie nicht. Velve Auth liefert stattdessen die drei Zähler aus Abschnitt 3.9, darunter den Alarm-Callback je Route. |
| L16 Credential-Stuffing-Schutz | Schwellen für Challenge/Block, Zeitfenster, Cooldown | Weglassen | Wie L15; der Konto-Eimer aus Abschnitt 3.9 ist der Teil, den die Bibliothek ehrlich leisten kann — ohne Sperre und ohne Verzögerung (L-5). |
| L17 Impossible Travel, Geo-Blocking, Bot-Blocking, Suspicious IP | Vier unabhängige Detektoren | Weglassen | Wie L15; alle vier brauchen Datenquellen (Geo-Datenbank, Reputationslisten), die eine Bibliothek nicht mitbringen soll. |
| L18 Velocity-Limits und Free-Trial-Abuse | Ratenbasierte und missbrauchsbezogene Erkennung | Weglassen | Wie L15; Missbrauchserkennung über Testphasen setzt ein Abo-Modell voraus (M1). |
| L19 Compromised-Password- und Stale-Account-Erkennung | Kompromittierte Kennwörter, lange inaktive Konten | Weglassen | Die Anwendung übernimmt (A49); inaktive Konten erkennt sie an `session.last_used_at` und `user.created_at`. |
| L20 E-Mail-Validierung/-Normalisierung, Proof-of-Work, Unknown-Device-Notification | Weitere Sentinel-Bausteine | Weglassen | Teilweise ohnehin im Kern: die E-Mail-Normalisierung ist Kernbestandteil und per CHECK-Constraint abgesichert (E4). Der Rest gehört zur Anwendung. |
| L21 Managed E-Mail und SMS | Versanddienst mit 13 E-Mail- und 3 SMS-Vorlagen | Weglassen | Die Anwendung übernimmt. Kein eingebauter Versand, nur der `email.send`-Callback (Abschnitt 3.15, A.7) — und damit auch keine Vorlagen, die in der Sprache und dem Ton eines fremden Anbieters an die Nutzer der Anwendung gehen. |

**L: Übernehmen 0 · Anders lösen 0 · Weglassen 21 · Übertreffen 0**

---

### M. Bezahl-/Abo-Plugins (9)

| Funktion | Better Auth | Velve Auth | Begründung |
|---|---|---|---|
| M1 Stripe | Abos, Kunden, Seats, Webhooks; `/stripe/webhook`, `/subscription/*` (`packages/stripe/src/`) | Weglassen | Die Anwendung übernimmt. Kein Abo-/Bezahlmodul (Abschnitt 3.14). Abrechnung teilt mit Authentifizierung nur den Fremdschlüssel auf `user`. |
| M2 Stripe-Schema | Tabelle `subscription` + `user.stripeCustomerId` (`stripe/src/schema.ts`) | Weglassen | Wie M1; `user.stripeCustomerId` ist zusätzlich genau die Fremdspalte an einer Kerntabelle, die es nicht geben soll (E5). |
| M3 Stripe↔Organization-Kopplung | Überschreibt in `init` die `organizationHooks` eines anderen Plugins (`stripe/src/index.ts:186-256`) | Weglassen | Niemand — ausdrücklich. Ein Plugin darf Optionen anderer Plugins weder lesen noch schreiben (Abschnitt 3.11); diese Kopplung ist der Beleg dafür, wohin ein offenes `init` führt. |
| M4 Polar | Checkout, Portal, Usage, Webhooks (`@polar-sh/better-auth`) | Weglassen | Die Anwendung übernimmt; wie M1. |
| M5 Autumn | Pricing-Plans, Usage-Metering, Feature-Permissions (`autumn-js`) | Weglassen | Die Anwendung übernimmt; „Feature-Permissions" sind zudem ein Berechtigungsmodell (I1). |
| M6 Creem | Abos und Zahlungen (`@creem_io/better-auth`) | Weglassen | Wie M4; ein weiterer Zahlungsanbieter, dieselbe Trennlinie. |
| M7 Chargebee | Abos und Zahlungen (`@chargebee/better-auth`) | Weglassen | Wie M4; die Integration gehört dem Anbieter, der sie pflegt, nicht der Anmeldebibliothek. |
| M8 Dodo Payments | Abos und Zahlungen (`@dodopayments/better-auth`) | Weglassen | Wie M4. Die Fremdpakete hängen an Better Auths Plugin-Schnittstelle; für Velve Auth wären sie ohnehin neu zu schreiben, unter `/x/…` und mit eigenen Tabellen. |
| M9 Commet | Abrechnung und Usage (`@commet/better-auth`) | Weglassen | Wie M4; Nutzungsabrechnung braucht Ereignisse der Anwendung, nicht der Anmeldung. |

**M: Übernehmen 0 · Anders lösen 0 · Weglassen 9 · Übertreffen 0**

---

### 1.N Was Velve Auth kann und Better Auth nicht

Fähigkeiten ohne Gegenstück in Better Auth v1.7.3. Jede Zeile nennt die Fundstelle, an der das
Fehlen belegt ist — Quelltext, Advisory oder Issue.

| Fähigkeit | Warum es sie bei Better Auth nicht gibt | Was Velve Auth tut |
|---|---|---|
| Multi-Algorithmus-Prüfpfad | Es gibt genau eine `hash`- und eine `verify`-Funktion; eine Verifier-Kette ist nicht vorgesehen; `grep -rn "hash.startsWith"` liefert über `packages/` einen einzigen Treffer, und der betrifft ein URL-Fragment (`electron/src/browser.ts:132`) (Inventur N1-2) | Weiche am PHC-Präfix über sechs Familien: `$argon2id$`, `$argon2i$/$argon2d$`, `$2a$/$2b$/$2y$/$2x$`, `$scrypt$`, `$pbkdf2-sha256$/-sha512$`, `$fbscrypt$`. Erzeugt wird nur Argon2id, geprüft wird alles (Abschnitt 3.3). |
| Stiller Rehash bei der Anmeldung | `grep -rn "rehash\|needsRehash\|upgradeHash" packages/` liefert null Treffer; `signInEmail` schreibt bei Erfolg nichts zurück (`api/routes/sign-in.ts:557-560`) | Nach erfolgreicher Prüfung wird `needsRehash` bestimmt und nach dem Senden der Antwort in einer begrenzten Hintergrundaufgabe per Vergleich-und-Tausch geschrieben (`WHERE user_id = $1 AND phc = $alt`). Schlägt es fehl, ist nichts kaputt. Ohne Benutzerinteraktion. |
| `verify` bekommt Kontext und einen Rückkanal | Signatur ist `verify({hash, password})` — kein Nutzer, kein `ctx`, kein „bitte neu hashen" (Inventur N1-5) | Der Prüfpfad liefert Ergebnis **und** Rehash-Bedarf; er ist Kernbestandteil und nicht ersetzbar, deshalb kann der Rückkanal existieren. |
| Kanonisches PHC-Speicherformat | Format ist `salt_hex:hash_hex` ohne Algorithmus-, Parameter- oder Versionskennung (`crypto/password.test.ts:11`); eine Parameteränderung entwertet alle Hashes | Ein PHC-String je Konto, verschlüsselt abgelegt (L-2), plus die Klartextspalte `scheme` für Auswertungen ohne Entschlüsseln. Ein eigener PHC-Parser von ~40 Zeilen, keine Abhängigkeit (Abschnitt 2.7). |
| Argon2id überhaupt | Nicht implementiert; Funktionswunsch #6608 „closed as not planned" | Argon2id als Standard mit m = 19456 KiB, t = 2, p = 1, 32 Byte Ausgabe, 16 Byte Salt (OWASP-Mindestempfehlung), nach oben konfigurierbar. |
| Semaphor über die gleichzeitigen KDF-Aufrufe | Kein Nebenläufigkeitsschutz im Kennwortpfad; scrypt mit N=16384, r=16 belegt ebenfalls Speicher | Der Kern hält einen Semaphor über die KDF-Aufrufe (Standard `min(4, cpus)`). Wartende laufen in eine Wartegrenze von 5 s und werden dann abgelehnt, statt in einen Speicherfehler zu laufen (Abschnitt 3.3, L-1). |
| Längenprüfung vor dem KDF | `/sign-in/email` reicht ein beliebig langes Kennwort direkt in scrypt (`api/routes/sign-in.ts:521-560`, Inventur N1-9) | Leer und über 4096 Byte werden abgelehnt, **bevor** ein KDF aufgerufen wird — auf allen vier Pfaden (Registrierung, Anmeldung, Reset, Änderung). |
| Drei Identitätskonfigurationen ohne E-Mail-Zwang | `user.email` ist `NOT NULL UNIQUE` (`core/src/db/get-tables.ts:208-216`); die Doku sagt es ausdrücklich (`docs/…/concepts/oauth.mdx:409`), Issue #9124 ist offen | `email`, `username`, `username_email` — gewählt bei der Initialisierung, als CHECK-Constraint in der Migration materialisiert. Keine erfundenen Adressen; `createPlaceholderEmail` hat kein Gegenstück (Abschnitt 3.4 und 3.10). |
| Startfehler statt stiller Aussperrung | Eine Konfiguration ohne E-Mail gibt es nicht (E2), also auch keinen Fall, in dem das Fehlen eines Rückwegs erzwungen werden müsste; das Username-Plugin hängt eine Spalte an ein Modell, das die E-Mail voraussetzt (`plugins/username/schema.ts:6-58`) | `identity: "username"` ohne `recoveryCodes` ist ein Startfehler — und über `RecoveryCodesRequirement` bereits ein Kompilierfehler (Abschnitt 3.15, A.3): ohne E-Mail gibt es kein Zurücksetzen, und das wird erzwungen statt dokumentiert. |
| Firebase-Migration | Im gesamten `docs/content/docs/guides/` gibt es keine Firebase-Anleitung; vorhanden sind nur Supabase, Clerk, Auth0, Auth.js/NextAuth, WorkOS (Inventur N4-35) | `$fbscrypt$`-Verifizierer (scrypt + AES-256-CTR) im selben Format, das GoTrue benutzt — damit lassen sich Firebase- **und** Supabase-Bestände unverändert übernehmen. `imported_from`/`imported_at` halten die Herkunft fest. |
| Import ohne fremdes Rohformat | Better Auth speichert sein eigenes Rohformat und kann fremde nur über einen ersetzten Verifier prüfen (A10) | Der Import normalisiert jedes Quellformat in einen PHC-String; z. B. wird Better Auths `salt_hex:hash_hex` zu `$scrypt$ln=14,r=16,p=1$<salt_b64>$<hash_b64>`. Es wird nie ein fremdes Rohformat gespeichert. |
| Session-Tokens nur gehasht gespeichert | Tokens liegen im Klartext in der Datenbank, ohne Hashing-Option (`db/internal-adapter.ts:513`, Inventur N3-19) | Gespeichert wird ausschließlich `sha256(token)` mit `UNIQUE`-Constraint; das Klartext-Token verlässt den Prozess nur im Cookie. |
| `__Host-`-Cookie-Präfix | Die Konstante existiert, wird aber nie gesetzt (`cookies/cookie-utils.ts:34-35`; `createCookieGetter` setzt nur `__Secure-`, Inventur N3-22) | `__Host-velve_session` und `__Host-velve_pending`: `Secure` erzwungen, `Domain` verboten, `Path=/`. Cookie-Tossing aus einer Subdomain ist strukturell ausgeschlossen. |
| Kennwort-Reset widerruft Sitzungen per Vorgabe | `revokeSessionsOnPasswordReset` ist per Vorgabe **aus** (`api/routes/password.ts:328-330`); dasselbe bei `/change-password` (Inventur N3-20) | Reset und Änderung widerrufen alle anderen Sitzungen. Kein Schalter (Abschnitt 3.5). |
| Zweite Frist (absolutes Ablaufdatum) | Es gibt genau eine `expiresAt`, die per Sliding Window unbegrenzt verlängert wird (`create-context.ts:313`, `session.ts:324-412`) | `idle_expires_at` (verlängerbar, höchstens stündlich geschrieben) und `absolute_expires_at` (nie verlängert). Beide stehen im Prädikat der Auflösung. |
| Zwischenzustand für 2FA als eigenes Artefakt | Der Zustand ist ein generischer Verification-Record plus signiertes Cookie im Plugin (`two-factor/index.ts:533-563`); der Cookie-Cache konnte ihn zur Sitzung machen (GHSA-xg6x-h9c9-2m83, CVSS 9.1) | `velve.pending_authentication` mit `factors_completed` und `attempts`, eigenes Cookie mit 5 Minuten Laufzeit, akzeptiert von genau vier Routen; jede andere ignoriert es vollständig (Abschnitt 3.6). |
| `factors` an der Sitzung | Es gibt kein Feld, das festhält, womit authentifiziert wurde; der eigene OIDC-Provider gibt nur `acr_values_supported: ["0"]` aus (`oauth-provider/src/metadata.ts:181`, Inventur N3-34) | `session.factors text[]` mit `password`, `totp`, `webauthn`, `recovery`, `oauth`. Keine Berechtigung, sondern Teil der Antwort auf „wer ist angemeldet, und wie sicher". |
| Passkey-Unterscheidung gerätegebunden / synchronisiert | `deviceType`/`backedUp` werden zwar gespeichert, aber `requireUserVerification: false` an beiden Verifikationsstellen macht Passkeys dort ohnehin nicht zum Faktor (`packages/passkey/src/routes.ts:658,909`, Inventur N3-33) | `backup_eligible` und `backup_state` werden getrennt aus den Authenticator-Daten gespeichert und bei jeder Anmeldung aktualisiert; `userVerification: "required"`. Die Anwendung kann darauf eine Richtlinie stützen, die Bibliothek erzwingt keine. |
| Passkey als eigener Anmeldeweg mit `factors` | Ein Passkey-Login umgeht erzwungene 2FA, weil der 2FA-`after`-Hook nur `/sign-in/email\|username\|phone-number` matched (`two-factor/index.ts:434-439`, Inventur N3-32) | Passkey-Anmeldung ergibt `factors = {webauthn}` ohne Kennwort; als zweiter Faktor ergibt sie `{password, webauthn}`. Beides im Kern, deshalb gibt es keinen Pfad, der an einem Hook vorbeiläuft. |
| Versionierte, transaktionale Migrationen | Kein Migrationsverlauf, keine `_migrations`-Tabelle, kein `down`; nicht transaktional; nur für Kysely (Inventur N4-37/39/40) | `velve.schema_migration` mit Version, Name, Zeitpunkt und Prüfsumme; jeder Schritt in einer eigenen Transaktion; Plugin-Migrationen im selben Läufer; Versionsabweichung beim Start ist ein Fehler. |
| `ON CONFLICT`-Ratenbegrenzung in einem Round-Trip | Kein Upsert in der Adapter-API; der Rate-Limiter emuliert ihn mit bis zu vier Round-Trips (`api/rate-limiter/index.ts:148-166`, Inventur N4-42) | Ein `INSERT … ON CONFLICT DO UPDATE SET tokens = LEAST(...) - 1 … RETURNING tokens`. Negativ heißt abgelehnt (Abschnitt 3.9). |
| IPv6-/64-Normalisierung | Der Schlüssel war die textuelle IP ohne Normalisierung; ein Client mit einem `/64` konnte 2^64 Buckets erzeugen (GHSA-p6v2-xcpg-h6xw / CVE-2026-45364) | Normalisierung auf `/32` (v4) bzw. `/64` (v6) vor der Schlüsselbildung; `X-Forwarded-For` nur bei konfigurierten `trustedProxies`. |
| Ratenbegrenzung pro Konto | Der Schlüssel ist `ip\|path`, es gibt keinen Zähler pro Konto; Lockouts existieren nur im 2FA-Plugin (`core/src/utils/ip.ts:395-399`, Inventur N3-28) | Drei Zähler gleichzeitig: IP-Präfix, Konto als Eimer mit langsam nachfüllender Rate (Überschreitung ist Ablehnung, keine Sperre und keine Verzögerung, L-5), und global je Route als Alarm-Callback. |
| Bucket-Schlüssel über den aufgelösten Routennamen | Der Router kollabiert leere Segmente, `//sign-in/email` läuft an Pfad-Limits vorbei (GHSA-x732-6j76-qmhm, CVSS 8.6) | Der Schlüssel enthält den aufgelösten Routennamen, nicht den rohen Pfad. |
| Eigenes Postgres-Schema | Alle Tabellen liegen im Suchpfad der Anwendung; deshalb gibt es `modelName`, `fields` und `usePlural`, um Kollisionen auszuweichen | Alles liegt in `velve` (konfigurierbar). Nichts kollidiert, `user` braucht keine Anführungszeichen-Disziplin, und die Namensoptionen entfallen ersatzlos (Abschnitt 3.2). |
| Echte PostgreSQL-Typen und -Constraints | Keine partiellen Indizes, keine Ausdrucksindizes, keine PG-Enums, kein `inet`, keine CHECK-Constraints, keine Trigger; `string[]` landet als JSON-String in `jsonb` (Inventur N4-45/46/47) | `uuid`, `timestamptz`, `bytea`, `inet`, `text[]`, `jsonb`, partielle Unique-Indizes, CHECK-Constraints für die Normalisierung und die Identitätsregel, ein Trigger gegen `UPDATE session SET user_id`. |
| Eindeutigkeit von `(provider, subject)` in der Datenbank | Kein Unique-Constraint auf `account(providerId, accountId)`; die Prüfung steht in JavaScript und ist anfällig für Wettläufe (`db/internal-adapter.ts:1192-1215`, Inventur N4-43) | `CONSTRAINT identity_provider_subject UNIQUE (provider, subject)`. Die E-Mail ist nie ein Verknüpfungsschlüssel. |
| Nicht abschaltbare Verknüpfungsbedingungen | Das Auto-Link-Gate las das lokale `emailVerified` nie (CVE-2026-53516, CVSS 8.3); die Magic-Link-/OTP-Variante ist GHSA-qq9h-g4jm-xgf3 | Automatisch verknüpft wird nur, wenn der Anbieter die E-Mail als verifiziert meldet **und** das lokale Konto verifiziert ist **und** der Anbieter in `trustedProviders` steht. Alle drei, ohne Ausnahme (Abschnitt 3.10). |
| Aufgezählte Plugin-Erweiterungspunkte mit Startfehler bei Kollision | Kollisionen von Endpunkten und Tabellen werden nur geloggt (`api/index.ts:153-170`); es gibt kein Sandboxing, keine deklarierten Abhängigkeiten und keine topologische Sortierung (Inventur N5-54/55/56) | Sieben aufgezählte Hook-Punkte, Namensraum `/x/<plugin-id>/…`, Tabellenpräfix `<plugin-id>_`, `dependsOn` mit topologischer Sortierung, eingefrorener Kontext — und ein Namenskonflikt ist ein Startfehler. |
| Zweckgetrennte Schlüssel mit Rotation | Dasselbe Secret signiert Cookies, signiert E-Mail-JWTs und HMACt den Cookie-Cache; HKDF nur im JWE-Pfad; für Signaturschlüssel gibt es keine Rotation (Inventur N3-26/27) | Ein Wurzelschlüssel, daraus per HKDF-SHA256 `cookie-sig`, `token-pepper`, `totp-enc`, `oauth-token-enc`, `pkce-enc`, `password-enc`; jeder Wert trägt seine Version, ein Ring erlaubt Rotation ohne Ausfall — und weil Sitzungen Datenbankzeilen sind, überlebt jede Rotation sämtliche Sitzungen (Abschnitt 3.8). |
| Wiederherstellungscodes als HMAC statt verschlüsselt | Backup-Codes werden per Vorgabe verschlüsselt gespeichert, damit `viewBackupCodes` sie anzeigen kann (`backup-codes/index.ts:44-55,552-590`) | `HMAC-SHA256(pepper, code)` mit `(user_id, code_hmac)` als Primärschlüssel: Nachschlagen ist ein Index-Treffer, Konsum ist `DELETE … RETURNING`, und Anzeigen ist unmöglich. |
| TOTP-Replay-Schutz über den Primärschlüssel | Kein Schutz gegen die Wiederverwendung desselben Zeitschritts im 2FA-Plugin dokumentiert | `velve.totp_used_step` mit Primärschlüssel `(user_id, time_step)`: ein `INSERT`, der bei Konflikt scheitert, **ist** die Prüfung. |
| Byteweise identische Antworten als Vorgabe | Der Enumerationsschutz ist nicht Vorgabe; im Standard-Setup antwortet `/sign-up/email` mit `422 USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL` (`api/routes/sign-up.ts:329-332`, Inventur N3-30) | Anmeldung, Registrierung, Kennwort-Reset und E-Mail-Wechsel liefern für existierende und nicht existierende Konten byteweise identische Antworten — gleicher Status, gleiche Kopfzeilen, gleicher Körper. Der Unterschied wandert in die E-Mail (Abschnitt 3.13). |
| Nachricht an die vorhandene Adresse bei Registrierungsversuch | Better Auth erfindet stattdessen ein synthetisches User-Objekt (`sign-up.ts:236-305`) | An die vorhandene Adresse geht „jemand hat versucht, sich mit deiner Adresse zu registrieren" mit einem Anmelde- statt Bestätigungslink. |
| Eine Routendeklaration statt Laufzeit-Proxy | Der Client ist ein Proxy, der jeden Pfad abschickt; ohne `pathMethods` gilt die Heuristik „Body vorhanden → POST" (`client/proxy.ts:12-34,36-125`, Inventur N7-77/78) | Pfad, Methode, Eingabe-Schema, Ausgabe-Typ und Fehlercodes werden **einmal** deklariert; daraus entstehen Serverhandler, Servermethode und Client. Ein Client-Aufruf, den es nicht gibt, kompiliert nicht (Abschnitt 3.12). |
| Sicherheitsmiddleware auch bei direkten Serveraufrufen | `onRequest`/`onResponse`/`middlewares` laufen nicht bei `auth.api.*`; captcha und die SCIM-Content-Type-Prüfung sind dort wirkungslos (`api/to-auth-endpoints.ts:88-116`, Inventur N3-31) | Origin-Prüfung und Ratenbegrenzung liegen immer vor der Routenlogik — auch bei direkten Serveraufrufen (Abschnitt 3.11). Es gibt genau ein Interception-Modell. |

Keine Fähigkeit, aber eine Haltung, die zu den 36 Zeilen gehört: Die Grenzen stehen im Entwurf und werden dokumentiert — kein Zurücksetzen per E-Mail in der Konfiguration `username`, aufzählbare Benutzernamen, Schlüsselverlust als Kennwortverlust (L-2), bcrypt-Bestände, die bis zum Rehash nur die ersten 72 Byte prüfen. Better Auth stellt Platzhalter-Adressen als Lösung dar und sichert in `SECURITY.md` nur die jeweils letzte Version zu.

---

### 2.N Die Zahlen

#### Je Abschnitt

| Abschnitt | Titel | Funktionen | Übernehmen | Anders lösen | Weglassen | Übertreffen |
|---|---|---:|---:|---:|---:|---:|
| A | Kern-Authentifizierung | 52 | 23 | 14 | 12 | 3 |
| B | Sitzungen | 46 | 8 | 5 | 32 | 1 |
| C | Soziale Anmeldung / OAuth | 96 | 23 | 56 | 13 | 4 |
| D | Zweiter Faktor und alternative Faktoren | 52 | 20 | 8 | 19 | 5 |
| E | Identität und Benutzermodell | 27 | 5 | 5 | 14 | 3 |
| F | Datenbank | 58 | 7 | 20 | 28 | 3 |
| G | Erweiterbarkeit | 41 | 8 | 10 | 19 | 4 |
| H | Betrieb und Querschnitt | 57 | 17 | 15 | 20 | 5 |
| I | Autorisierung und Organisationen | 71 | 0 | 0 | 71 | 0 |
| J | Als Identitätsanbieter auftreten | 62 | 0 | 0 | 62 | 0 |
| K | Framework-Integrationen | 26 | 0 | 24 | 2 | 0 |
| L | Kommerzielle Zusätze | 21 | 0 | 0 | 21 | 0 |
| M | Bezahl-/Abo-Plugins | 9 | 0 | 0 | 9 | 0 |
| | **Summe** | **618** | **111** | **157** | **322** | **28** |

Anteile: Übernehmen 18,0 % · Anders lösen 25,4 % · Weglassen 52,1 % · Übertreffen 4,5 %.

**Getrennte Zählung — Plugin-Entscheidungen (G.2):** 38 Pakete (26 im Hauptpaket, 12 extern) —
Übernehmen 2, Anders lösen 7, Weglassen 29. Diese Zeilen sind Entscheidungen über Pakete; die
Funktionen der Plugins selbst stecken bereits in den 618.

**Gegenrichtung:** Abschnitt 1.N zählt 36 Fähigkeiten, die Better Auth nicht hat. Sie decken
44 der 78 in der Inventur belegten Lücken ab; die übrigen 34 betreffen Bereiche, die Velve Auth
gar nicht erst betritt (SAML-IdP, LDAP, PAR/CIBA, mTLS, SCIM-Client, Multi-Column-Sort, Savepoints).

#### Was die Verteilung über das Produkt sagt

Etwas mehr als die Hälfte der Funktionen entfällt, und der Löwenanteil davon liegt in drei Blöcken: Autorisierung und Organisationen (71),
Identitätsanbieter-Rolle (62) und kommerzielle Zusätze plus Bezahlung (30). Das sind 163 der 322 weggelassenen Funktionen — mehr als die Hälfte — und
sie fallen nicht aus Zeitgründen weg, sondern weil sie andere Fragen beantworten als „wer ist angemeldet". Zieht man sie ab, bleiben 159 Weglassungen
über die eigentlichen Authentifizierungsabschnitte hinweg, und die verteilen sich fast vollständig auf drei Muster: abschaltbare Sicherheitsprüfungen
(`disableCSRFCheck`, `skipStateCookieCheck`, `disableKeyHashing`), zweite Wahrheiten über den Zustand (Cookie-Cache, Secondary Storage, stateless
Sessions) und Konfigurationsflächen, die nur existieren, weil eine Entwurfsentscheidung offengelassen wurde (Namensmapping, vier ID-Strategien, drei
Speicherstrategien je Token, elf Adapter).

Der zweitgrößte Block ist „Anders lösen" mit 157 Funktionen — die Fähigkeit kommt, der Mechanismus nicht. Der Wert konzentriert sich in C (56, im
Wesentlichen die Anbieterliste) und F (20, die Datenbankschicht). Dass „Anders lösen" fast doppelt so häufig ist wie „Übernehmen", ist die eigentliche
Aussage dieser Auswertung: Velve Auth streitet Better Auth kaum eine Fähigkeit ab, sondern fast immer nur den Weg dorthin. In der Regel besteht die
Änderung darin, eine Option durch ein Verhalten zu ersetzen — `revokeSessionsOnPasswordReset` wird zur Regel, `requireLocalEmailVerified` zur
Bedingung, `pathMethods` zur Deklaration, `encryptOAuthTokens` zur Voreinstellung „gar nicht speichern".

Die 111 übernommenen Funktionen sind der Beleg dafür, dass Better Auth den Zuschnitt der Kernoperationen weitgehend richtig getroffen hat:
Registrierung, Anmeldung, Verifikation, Reset, E-Mail-Wechsel, Kontolöschung, Sitzungsverwaltung, OAuth-Mechanik und die atomaren Konsum-Primitive
werden unverändert übernommen. Die 28 Übertreffungen sind dagegen auffällig ungleich verteilt: sie liegen fast alle dort, wo Better Auth ein Advisory
hatte — Kennwortpfad (A7, A9, A34), Sitzungsspeicherung (B2), Verknüpfungsregel (C86), Zweitfaktor-Zwischenzustand (D16, D33), Cookie-Präfix (H19),
Ratenbegrenzung (H4, H9) und Schlüsselrotation (H36).

Bewusst genannt sei auch, was diese Verteilung kostet. Wer heute Better Auth mit `organization`, `admin`, `sso`, `oauth-provider` oder `stripe`
betreibt, findet in Velve Auth kein Gegenstück und muss diese Fähigkeiten in der Anwendung oder mit einem anderen Produkt aufbauen. Wer MySQL, SQLite,
Prisma, Drizzle oder MongoDB einsetzt, kann nicht wechseln. Wer den Cookie-Cache aus Latenzgründen braucht, verliert ihn. Das ist der Preis dafür,
dass jede verbleibende Zusicherung ohne Vorbehalt gilt.

---

## 2. Sprache und Laufzeit

### 2.1 Die Empfehlung

**Reines TypeScript. Kein eigenes Rust/WASM-Modul. Ausgeliefert als vorkompiliertes ESM mit Typdeklarationen.**

`hash-wasm` wird als **optionale** Peer-Abhängigkeit unterstützt. Ist sie installiert, übernimmt sie Argon2id; ist sie es nicht, rechnet `@noble/hashes`. Die Hashes sind bytegleich, ein Wechsel in beide Richtungen erfordert keine Datenmigration.

### 2.2 Die drei bewerteten Entwürfe

| | A — reines TypeScript | B — TS + eigenes Rust/WASM | C — TS + fremdes WASM im Pflichtpfad |
|---|---|---|---|
| Argon2id (19 MiB, t=2, p=1) | 263 ms | 47 ms (Rust→WASI) / 76 ms (C→WASM) | 76 ms |
| Läuft in Cloudflare Workers | ja | nein | nein |
| Läuft auf Caprock | SCHÄTZUNG: ja, ohne über Web-Standards hinausgehende Annahmen (2.6) | unerprobt | unerprobt |
| Bauwerkzeuge | eine (tsc/tsdown) | zwei (+ Rust, wasm-pack, CI-Ziel) | eine |
| Prüfbarkeit des Auslieferungsstands | Quelltext lesbar | `.wasm`-Blob im npm-Paket | `.wasm`-Blob des Dritten |
| Audit-Lage der Basis | Cure53 für `@noble/hashes` (2022, Argon2 ausgenommen) und `@noble/ciphers` (2024, voll) | eigener Code, nie auditiert | nicht auditiert, letzter Release 11/2024 |
| Bundler-Verhalten (Next, Vite) | unauffällig | Sonderbehandlung nötig | Sonderbehandlung nötig |
| Speicher nach Nutzung | fällt zurück | wächst und schrumpft nie | wächst und schrumpft nie |

Alle Messwerte: 2 vCPU Xeon @ 2,80 GHz, Node 22.22.2, Median aus sieben Läufen (drei bei den teuersten). Cloud-Container liefern Größenordnungen, keine Absolutwerte; auf typischer Serverhardware ist der Faktor gleich, das Niveau um Faktor 2–4 niedriger. Vollständige Rohdaten in `findings/06-krypto-bibliotheken.md`, Abschnitt 3.6.

Zum Audit-Vorbehalt: Der Cure53-Bericht zu `@noble/hashes` (Version 1.0.0, Januar 2022) schließt Argon2 ausdrücklich aus. Der Nachweis für nobles Argon2id ist deshalb nicht das Audit, sondern die Messung: `@noble/hashes`, `hash-wasm` (C→WASM) und `@node-rs/argon2-wasm32-wasi` (Rust→WASM) erzeugen bei gleichen Parametern bytegleiche Hashes und verifizieren sich gegenseitig (`findings/06-krypto-bibliotheken.md`, dort Abschnitt 1.5). Drei unabhängige Codebasen machen nicht denselben Fehler.

### 2.3 Warum A und nicht B

Der Geschwindigkeitsvorteil ist real, aber er wird an der falschen Stelle bezahlt.

**Der Vorteil eines eigenen Rust-Moduls gegenüber einem fertigen WASM-Paket beträgt Faktor 1,6** (47 ms gegen 76 ms) — und ausgerechnet der schnelle Weg dorthin führt über `node:wasi`, `node:worker_threads` und `node:fs`. Das sind genau die Module, die auf einer schmalen Linux-Kompatibilitätsschicht nicht zugesichert sind. Der Entwurf würde also zwei Werkzeugketten und einen unprüfbaren Binärblob einführen, um in der Zielumgebung womöglich gar nicht zu starten.

**WASM kostet die Portabilität, wegen der die Bibliothek existiert.** `hash-wasm` scheitert in Cloudflare Workers mit `Wasm code generation disallowed by embedder`; das ist keine Konfigurationsfrage, sondern eine Eigenschaft der Plattform, die nur vorkompilierte Module lädt. Ein selbstgebautes Modul träfe dasselbe, denn die Ursache ist „WASM zur Laufzeit aus Bytes kompilieren", nicht `hash-wasm`. Wer eine Anmeldebibliothek baut, deren erklärtes Ziel Ortsunabhängigkeit ist, darf ihren Kern nicht an eine Ausführungsart binden, die verbreitete Laufzeiten verbieten.

**Das Zeroize-Argument spricht gegen WASM, nicht dafür.** `@noble/hashes` wischt seine Zwischenpuffer bereits (`clean()` wird in `argon2.js` achtmal aufgerufen). Das eigentliche Problem sind unveränderliche JavaScript-Strings, in denen das Kennwort ankommt — die hat WASM genauso, denn der String existiert vor dem Übergang. Dafür wächst `WebAssembly.Memory` monoton: nach einem 256-MiB-Hash blieben 259,5 MB extern belegt, auch nach ausdrücklicher Speicherbereinigung. Reines JavaScript fiel auf 65,5 MB zurück.

**Für ein sehr kleines Team zählt die Zahl der Werkzeugketten mehr als knapp 200 ms.** Eine Rust-Toolchain im CI, ein zweiter Auslieferungspfad, reproduzierbare Binärbuilds und ein Blob, den niemand im Paket nachlesen kann — das ist dauerhafte Last für einen Gewinn, den ein Semaphor und eine passende Instanzgröße auch erbringen.

**Reines JavaScript kann etwas, das WASM nicht kann.** `argon2idAsync({ asyncTick: 10 })` gibt während der Berechnung an die Ereignisschleife ab: die größte Blockade sinkt von 317 ms auf 12 ms, bei unveränderter Gesamtdauer (317 gegen 316 ms). Die `async`-Schnittstelle von `hash-wasm` ist dagegen nur ein Promise um einen synchronen Aufruf und blockiert die vollen 62 ms. Für einen Server mit einem Thread ist das betrieblich mehr wert als der Rohdurchsatz.

**Und der Wechsel bleibt offen.** Weil die drei Implementierungen bytegleiche Ausgaben erzeugen (2.2), ist die Rechenmaschine eine austauschbare Komponente hinter einer Schnittstelle. Wenn sich in einem Jahr zeigt, dass 263 ms zu viel sind, wird das Paket getauscht — nicht die Datenbank.

### 2.4 Wo Nicht-JavaScript trotzdem gewinnt

Dort, wo es ohne native Bindungen zu haben ist, weil es in der Laufzeit schon steckt: **`crypto.subtle`**.

- PBKDF2 mit 600.000 Iterationen: 269 ms über `crypto.subtle`, 926 ms in JavaScript — und 2161 ms über `hash-wasm`, das hier **langsamer ist als reines JavaScript**, weil es je Iteration die Grenze zwischen JavaScript und WASM überquert.
- SHA-2 auf großen Blöcken: 3,1 ms gegen 8,5 ms je MiB. Bei 32-Byte-Eingaben kehrt sich das um, dort dominiert der `await`.
- AES-256-GCM: hardwarebeschleunigt, in jeder Web-Crypto-Laufzeit vorhanden.

Das ist der Grund, warum die Verschlüsselung gespeicherter Geheimnisse auf `crypto.subtle` liegt und nicht auf `@noble/ciphers` — letzteres bleibt als Rückfallebene für Laufzeiten ohne vollständige Web-Crypto-Implementierung erhalten (E-03). Der Chiffretext trägt dafür ein Algorithmus-Präfix, damit ein späterer Wechsel bestehende Daten nicht entwertet.

### 2.5 Was „ohne Bauschritt beim Nutzer" konkret heißt

- Das npm-Paket enthält `dist/*.mjs` und `dist/*.d.mts`. Kein `postinstall`, kein `node-gyp`, keine `.node`-Datei, kein Downloader.
- Nur ESM. CommonJS wird nicht ausgeliefert; wer es braucht, nutzt dynamisches `import()`.
- `exports` mit Subpfaden, `types` je Subpfad, geprüft mit `publint` und `attw` im Auslieferungstor.
- Abhängigkeiten des Kerns: `@noble/hashes`, `@noble/ciphers`, `bcryptjs`, `otpauth`, `@simplewebauthn/server`, `jose`. Sechs. `bcryptjs` gehört zum Kern, weil die bcrypt-Prüfung Teil des Prüfpfads ist (Abschnitt 3.3) und nicht nur des Imports: Ein importierter bcrypt-Hash wird bei jeder Anmeldung geprüft, bis der Rehash ihn ersetzt hat. Alle sechs sind ohne native Bindungen und ohne `node:`-Import im Pflichtpfad (`findings/06`, Abschnitt 1.1: null `.node`-Dateien, null Install-Skripte im gesamten Baum).
- Node ab 20.19 (Vorgabe von `@noble/hashes` 2.x; globale `crypto`, `crypto.subtle`, `getRandomValues`, `AbortSignal.timeout`). `@simplewebauthn/server` sichert offiziell nur Node 22 zu; sein Code enthält keine Node-Builtins. SCHÄTZUNG: läuft auf Node 20, ungeprüft.

### 2.6 Portierbarkeit auf Caprock

Die Bibliothek trifft folgende Annahmen — und keine weiteren:

| Annahme | Warum sie hält |
|---|---|
| `globalThis.crypto` mit `subtle` und `getRandomValues` | Web-Standard, kein Node-Modul |
| `fetch` für OAuth-Anbieter | Web-Standard |
| ein PostgreSQL-Treiber, den der Aufrufer stellt | der Treiber ist ein Parameter, kein Import |
| kein `node:fs`, `node:wasi`, `node:worker_threads`, `node:child_process` | im Pflichtpfad nicht verwendet |
| Schlüssel kommen aus einer Schnittstelle, nicht aus `process.env` | `KeyProvider`, Abschnitt 3.8 |

Der letzte Punkt ist der eigentlich wichtige. SCHÄTZUNG: Auf Caprock werden Geheimnisse als Capability übergeben, nicht als Umgebungsvariable. Weil der Kern Schlüssel ausschließlich über `KeyProvider` bezieht, ist das ein Austausch der Implementierung — am Aufrufer ändert sich nichts, und keine Zeile im Kern kennt den Unterschied.

Zwei Bedingungen an die Paketwahl folgen daraus: `otpauth` wird über den `default`- oder `./slim`-Exportzweig geladen, nicht über den `node`-Zweig (nur dieser importiert `node:crypto`); und fehlt Web Crypto auf der Kompatibilitätsschicht, übernimmt `@noble/ciphers` die Verschlüsselung (2.4).

**SCHÄTZUNG:** Der Portierungsaufwand nach Caprock beträgt eine neue `KeyProvider`-Implementierung und eine Treiberprüfung, in der Größenordnung von ein bis zwei Personentagen — vorausgesetzt, Node startet dort und der gewählte PostgreSQL-Treiber kommt mit der verfügbaren Netzwerkabstraktion zurecht. Diese Voraussetzung ist nicht geprüft und der einzige ernsthafte Unsicherheitsfaktor.

### 2.7 Die kryptografischen Primitive im Überblick

Die Tabelle ordnet jedem Zweck aus Abschnitt 3 sein Paket zu: den sechs Präfixfamilien des Prüfpfads (3.3), den sechs Schlüsselzwecken (3.8) und den übrigen Bausteinen.

| Zweck | Paket / API |
|---|---|
| Argon2id erzeugen + prüfen (`$argon2id$`, `$argon2i$`, `$argon2d$`) | `@noble/hashes/argon2` (`argon2idAsync`, `asyncTick: 10`) |
| bcrypt prüfen (`$2a$`, `$2b$`, `$2y$`, `$2x$`) | `bcryptjs` (Kern; `truncates()` für die 72-Byte-Prüfung auf Byte-Länge) |
| scrypt prüfen (`$scrypt$`) | `@noble/hashes/scrypt` |
| PBKDF2 prüfen (`$pbkdf2-sha256$`, `$pbkdf2-sha512$`) | `crypto.subtle.deriveBits`, Rückfall `@noble/hashes/pbkdf2` |
| Firebase-scrypt prüfen (`$fbscrypt$`) | `@noble/hashes/scrypt` + `crypto.subtle` AES-256-CTR |
| PHC parsen / serialisieren | eigener Parser, ~40 Zeilen, keine Abhängigkeit; nicht `@phc/format` (CJS, ohne Typen, `Buffer`) |
| CSPRNG (Sitzungstoken, Einmal-Artefakte, Salz, Nonces) | `crypto.getRandomValues` |
| HKDF-SHA256 — Ableitung der sechs Zweckschlüssel `cookie-sig`, `token-pepper`, `totp-enc`, `oauth-token-enc`, `pkce-enc`, `password-enc` | `crypto.subtle.deriveBits` (HKDF) |
| SHA-256 (`token_sha256`, `state_sha256`), HMAC-SHA256 (`cookie-sig`, `token-pepper`: Wiederherstellungscodes, Kontozähler) | `crypto.subtle` für große Blöcke; `@noble/hashes/sha2`, `/hmac` synchron für kurze Eingaben |
| AES-256-GCM (`totp-enc`, `oauth-token-enc`, `pkce-enc`, `password-enc`) | `crypto.subtle`, Rückfall `@noble/ciphers` |
| Zeitkonstanter Vergleich | eigene XOR-Schleife über `Uint8Array` gleicher Länge; `crypto.timingSafeEqual` ist Node-spezifisch |
| TOTP (RFC 6238) | `otpauth` (Subpfad `otpauth/slim`) |
| WebAuthn | `@simplewebauthn/server` (CBOR über das mitgelieferte `@levischuck/tiny-cbor`, rein JavaScript) |
| ID-Token-Signaturen der OAuth-Anbieter (JWS gegen JWKS) | `jose` |

`hash-wasm` ist eine **optionale** Peer-Abhängigkeit als Beschleuniger. Wird sie gefunden, erzeugt und prüft sie Argon2id; die Ausgabe ist bytegleich mit `@noble/hashes`, ein Wechsel erfordert keine Migration. Für bcrypt (10 % Gewinn), PBKDF2 (2,3-mal langsamer) und SHA-2 bringt WASM nichts und wird nicht eingesetzt.

---
## 3. Zielarchitektur

Velve Auth beantwortet genau eine Frage: **wer ist angemeldet**. Keine Rollen, keine Berechtigungen, keine Organisationen, keine Teams, keine Profildaten. Die Bibliothek läuft im Prozess der Anwendung, die Daten liegen in deren Datenbank.

### 3.1 Paketstruktur und Modulschnitt

Ein npm-Paket `@velve/auth` mit Subpfad-Exports. Kein Monorepo, keine
Cross-Paket-Versionsdrift.

```
@velve/auth              Kern: createVelveAuth(), alle Kernoperationen
@velve/auth/http         toWebHandler(): (Request) => Promise<Response>
@velve/auth/client       typisierter Client, aus derselben Routendeklaration abgeleitet
@velve/auth/pg           Treiber für node-postgres
@velve/auth/postgres-js  Treiber für postgres.js
@velve/auth/neon         Treiber für @neondatabase/serverless
@velve/auth/import       Migrationsmodul (schwere Abhängigkeiten nur hier)
@velve/auth/schema       generiertes SQL, Migrationsläufer
@velve/auth/testing      Prüf-Helfer (Uhr-Kontrolle, deterministischer Zufall)
```

Interner Modulschnitt:

```
core/
  identity/     Identitätskonfiguration, Normalisierung, Eindeutigkeit
  password/     Verfahrensweiche, PHC, Rehash-Politik
  session/      Erzeugung, Auflösung, Rotation, Widerruf
  token/        Einmal-Artefakte: Erzeugung, atomarer Konsum
  factor/       TOTP, WebAuthn, Wiederherstellungscodes, Zwischenzustand
  oauth/        Autorisierungscode-Fluss, PKCE, Identitätsverknüpfung
  limit/        Token-Bucket
  keys/         KeyProvider, HKDF-Zweckableitung, Schlüsselring
  db/           Treiberschnittstelle, Repositories, Migrationsläufer
  http/         Routendeklaration, Origin-Prüfung, Cookies, Fehlerabbildung
  plugin/       Registry, topologische Sortierung, Hook-Ausführung
```

### 3.2 Datenbank und Schema

Alles liegt in einem **eigenen Postgres-Schema**, standardmäßig `velve`
(konfigurierbar). Damit kollidiert nichts mit den Tabellen der Anwendung. `user`
ist in SQL ein reserviertes Wort; als schemaqualifizierter Name `velve.user` ist
es ohne Anführungszeichen gültig, weil PostgreSQL hinter dem Punkt jedes
Schlüsselwort zulässt. Nur ein unqualifiziertes `user` bräuchte Anführungszeichen,
und unqualifizierte Namen kommen nicht vor (E-07).

Keine Query-Abstraktion. Alles SQL ist von Hand für PostgreSQL geschrieben;
vorausgesetzt wird PostgreSQL ab Version 14 (`gen_random_uuid()` ist seit 13
ohne Erweiterung verfügbar). Die Treiberschnittstelle ist absichtlich klein:

```ts
interface Driver {
  query<T>(sql: string, params: unknown[]): Promise<T[]>
  transaction<T>(fn: (tx: Driver) => Promise<T>): Promise<T>
}
```

#### Das vollständige Schema

Das ist die Ausgangsform. Die Änderungen aus den Entscheidungen L-2 und L-3 und
die beiden Tabellen des Migrationsmoduls stehen in 3.17; zusammen ergeben beide
Blöcke das Schema mit sechzehn Tabellen.

```sql
CREATE SCHEMA IF NOT EXISTS velve;

-- Identität. Bewusst minimal: keine Profildaten.
CREATE TABLE velve.user (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email             text,
  email_verified_at timestamptz,
  username          text,            -- Anzeigeform, wie eingegeben (NFKC)
  username_key      text,            -- Vergleichsform: NFKC + casefold
  disabled_at       timestamptz,
  imported_from     text,            -- 'supabase' | 'clerk' | 'auth0' | 'firebase' | 'nextauth'
  imported_at       timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT user_email_normalized    CHECK (email IS NULL OR email = lower(email)),
  CONSTRAINT user_username_normalized CHECK (username_key IS NULL OR username_key = lower(username_key)),
  CONSTRAINT user_username_pairing    CHECK ((username IS NULL) = (username_key IS NULL))
);
CREATE UNIQUE INDEX user_email_key        ON velve.user (email)        WHERE email IS NOT NULL;
CREATE UNIQUE INDEX user_username_key_key ON velve.user (username_key) WHERE username_key IS NOT NULL;

-- Die Identitätskonfiguration wird als CHECK-Constraint materialisiert.
-- Genau eines der folgenden drei wird von der Migration angelegt:
--   email:          CHECK (email IS NOT NULL)
--   username:       CHECK (username IS NOT NULL)
--   username_email: CHECK (email IS NOT NULL AND username IS NOT NULL)

CREATE TABLE velve.password_credential (
  user_id     uuid PRIMARY KEY REFERENCES velve.user(id) ON DELETE CASCADE,
  phc         text NOT NULL,        -- kanonischer PHC-String (3.3); Endform bytea als Chiffretext (L-2, 3.17)
  scheme      text NOT NULL,        -- redundant zu phc, für Auswertung ohne Parsen
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE velve.identity (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            uuid NOT NULL REFERENCES velve.user(id) ON DELETE CASCADE,
  provider           text NOT NULL,
  subject            text NOT NULL,   -- die stabile ID beim Anbieter, nie die E-Mail
  provider_email     text,
  provider_email_verified boolean NOT NULL DEFAULT false,
  profile            jsonb,           -- rohe Claims; die Anwendung liest sie, die Bibliothek nicht
  access_token_enc   bytea,
  refresh_token_enc  bytea,
  id_token_enc       bytea,
  token_key_version  integer,
  scopes             text[],
  token_expires_at   timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT identity_provider_subject UNIQUE (provider, subject)
);
CREATE INDEX identity_user_id_idx ON velve.identity (user_id);

CREATE TABLE velve.session (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            uuid NOT NULL REFERENCES velve.user(id) ON DELETE CASCADE,
  token_sha256       bytea NOT NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  last_used_at       timestamptz NOT NULL DEFAULT now(),
  idle_expires_at    timestamptz NOT NULL,
  absolute_expires_at timestamptz NOT NULL,
  factors            text[] NOT NULL DEFAULT '{}',  -- 'password','totp','webauthn','recovery','oauth'
  ip                 inet,
  user_agent         text,
  CONSTRAINT session_token_unique UNIQUE (token_sha256)
);
CREATE INDEX session_user_id_idx  ON velve.session (user_id);
CREATE INDEX session_sweep_idx    ON velve.session (absolute_expires_at);

CREATE TABLE velve.one_time_token (
  token_sha256 bytea PRIMARY KEY,
  purpose      text NOT NULL,   -- 'email_verify','password_reset','email_change','magic_link'
  user_id      uuid REFERENCES velve.user(id) ON DELETE CASCADE,
  payload      jsonb,
  created_at   timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL
);
CREATE INDEX one_time_token_user_purpose_idx ON velve.one_time_token (user_id, purpose);
CREATE INDEX one_time_token_sweep_idx        ON velve.one_time_token (expires_at);

CREATE TABLE velve.pending_authentication (
  token_sha256      bytea PRIMARY KEY,
  user_id           uuid NOT NULL REFERENCES velve.user(id) ON DELETE CASCADE,
  factors_completed text[] NOT NULL,
  attempts          integer NOT NULL DEFAULT 0,
  created_at        timestamptz NOT NULL DEFAULT now(),
  expires_at        timestamptz NOT NULL
);
CREATE INDEX pending_authentication_sweep_idx ON velve.pending_authentication (expires_at);

CREATE TABLE velve.totp_credential (
  user_id       uuid PRIMARY KEY REFERENCES velve.user(id) ON DELETE CASCADE,
  secret_enc    bytea NOT NULL,
  key_version   integer NOT NULL,
  confirmed_at  timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE velve.totp_used_step (
  user_id    uuid NOT NULL REFERENCES velve.user(id) ON DELETE CASCADE,
  time_step  bigint NOT NULL,
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (user_id, time_step)
);
CREATE INDEX totp_used_step_sweep_idx ON velve.totp_used_step (expires_at);

CREATE TABLE velve.recovery_code (
  user_id   uuid NOT NULL REFERENCES velve.user(id) ON DELETE CASCADE,
  code_hmac bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, code_hmac)
);

CREATE TABLE velve.webauthn_credential (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          uuid NOT NULL REFERENCES velve.user(id) ON DELETE CASCADE,
  credential_id    bytea NOT NULL,
  public_key       bytea NOT NULL,
  sign_count       bigint NOT NULL DEFAULT 0,
  transports       text[],
  aaguid           uuid,
  backup_eligible  boolean NOT NULL,   -- true  => synchronisierter Passkey
  backup_state     boolean NOT NULL,   -- true  => derzeit gesichert/synchronisiert
  user_verified_at_registration boolean NOT NULL,
  label            text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  last_used_at     timestamptz,
  CONSTRAINT webauthn_credential_id_unique UNIQUE (credential_id)
);
CREATE INDEX webauthn_credential_user_idx ON velve.webauthn_credential (user_id);

CREATE TABLE velve.webauthn_challenge (
  challenge_sha256 bytea PRIMARY KEY,
  purpose          text NOT NULL,   -- 'register' | 'authenticate'
  user_id          uuid REFERENCES velve.user(id) ON DELETE CASCADE,  -- NULL bei auffindbarer Anmeldung
  created_at       timestamptz NOT NULL DEFAULT now(),
  expires_at       timestamptz NOT NULL
);
CREATE INDEX webauthn_challenge_sweep_idx ON velve.webauthn_challenge (expires_at);

CREATE TABLE velve.oauth_flow (
  state_sha256    bytea PRIMARY KEY,
  provider        text NOT NULL,
  pkce_verifier_enc bytea NOT NULL,
  key_version     integer NOT NULL,
  nonce           text,
  redirect_path   text,            -- ein Pfad, niemals eine vollständige URL
  link_to_user_id uuid REFERENCES velve.user(id) ON DELETE CASCADE,
  created_at      timestamptz NOT NULL DEFAULT now(),
  expires_at      timestamptz NOT NULL
);
CREATE INDEX oauth_flow_sweep_idx ON velve.oauth_flow (expires_at);

CREATE TABLE velve.rate_bucket (
  bucket_key  text PRIMARY KEY,
  tokens      real NOT NULL,
  updated_at  timestamptz NOT NULL,
  expires_at  timestamptz NOT NULL
);
CREATE INDEX rate_bucket_sweep_idx ON velve.rate_bucket (expires_at);

CREATE TABLE velve.schema_migration (
  version     integer PRIMARY KEY,
  name        text NOT NULL,
  applied_at  timestamptz NOT NULL DEFAULT now(),
  checksum    text NOT NULL
);
```

**Speicherregel:** Was der Server nur vergleicht, wird gehasht (Session-Token,
Einmal-Token, Challenges, Wiederherstellungscodes). Was er im Klartext braucht,
wird verschlüsselt (TOTP-Secret, fremde OAuth-Tokens, PKCE-Verifier). Passwörter
werden per KDF abgeleitet. **Nichts Vertrauliches liegt im Klartext in der Datenbank.**

### 3.3 Der Passwort-Prüfpfad

Ein einziger kanonischer Speicherstring in der PHC-Familie. Die Weiche
entscheidet am Präfix:

| Präfix | Verfahren | Erzeugen | Prüfen |
|---|---|---|---|
| `$argon2id$` | Argon2id (Standard) | ja | ja |
| `$argon2i$`, `$argon2d$` | Argon2 andere Varianten | nein | ja |
| `$2a$`, `$2b$`, `$2y$`, `$2x$` | bcrypt | nein | ja |
| `$scrypt$` | scrypt (PHC) | nein | ja |
| `$pbkdf2-sha256$`, `$pbkdf2-sha512$` | PBKDF2 | nein | ja |
| `$fbscrypt$` | Firebase-scrypt | nein | ja |

**Normalisierung:** Jedes Kennwort wird vor jedem KDF-Aufruf NFKC-normalisiert (NIST SP 800-63B-4 §3.1.1.2). Better Auth tut dasselbe, seine importierten `$scrypt$`-Hashes verifizieren deshalb unverändert. bcrypt-Quellen (Supabase, Clerk, Auth0) und Firebase normalisieren nicht; ein importierter Hash eines Kennworts, dessen NFKC-Form von den eingegebenen Bytes abweicht, scheitert dort und führt in den Reset-Pfad aus Abschnitt 4.0. SCHÄTZUNG: Das betrifft nur Nicht-ASCII-Kennwörter in nicht-kanonischer Unicode-Form, einen sehr kleinen Bruchteil eines Bestands.

**Es wird nie ein fremdes Rohformat gespeichert.** Der Import normalisiert jedes
Quellformat in einen dieser Strings. Better Auths `salt_hex:hash_hex` wird zu
`$scrypt$ln=14,r=16,p=1$<salt_b64>$<hash_b64>`. Firebase wird zu
`$fbscrypt$v=1,n=<mem_cost>,r=<rounds>,p=1,ss=<b64>,sk=<b64>$<salt_b64>$<hash_b64>`
— dasselbe Format, das GoTrue bereits verwendet, damit Supabase-Bestände
unverändert übernommen werden können.

Standardparameter für Argon2id: **m = 19456 KiB, t = 2, p = 1, 32 Byte Ausgabe,
16 Byte Salt** (OWASP-Mindestempfehlung). Konfigurierbar nach oben.

Ablauf einer Kennwortprüfung:

1. Eingabelänge prüfen: unter 8 Zeichen ablehnen, über 4096 Byte ablehnen — **vor** jedem KDF-Aufruf (L-7).
2. Nutzer auflösen. Existiert keiner, wird gegen einen **Dummy-PHC mit den
   konfigurierten Standardparametern** geprüft. Der Codepfad ist derselbe.
3. Weiche nach Präfix, Verifier aufrufen, Ergebnis zeitkonstant vergleichen.
4. Bei Misserfolg: einheitliche Antwort, kein Hinweis auf die Ursache.
5. Bei Erfolg: `needsRehash` bestimmen — wahr, wenn Verfahren != Standard **oder**
   Parameter unter der aktuellen Politik liegen.
6. Ist `needsRehash` wahr, wird nach dem Senden der Antwort in einer begrenzten
   Hintergrundaufgabe neu gehasht und per Vergleich-und-Tausch geschrieben:
   `UPDATE velve.password_credential SET phc = $neu, scheme = $s, key_version = $v,
    updated_at = now() WHERE user_id = $1 AND phc = $alt`.
   Verglichen wird der gespeicherte Chiffretext (L-2); derselbe Weg trägt die
   Schlüsselrotation. Schlägt das fehl, ist nichts kaputt — der nächste Login
   versucht es erneut. **Still, ohne Benutzerinteraktion, Bestandteil des Kerns.**

Nebenläufigkeit: Argon2id belegt pro Aufruf 19 MiB. Der Kern hält einen
**Semaphor** über die gleichzeitigen KDF-Aufrufe (Standard: `min(4, cpus)`),
damit gleichzeitige Anmeldungen den Speicher nicht vervielfachen. Wartende
laufen in eine Wartegrenze von 5 Sekunden und werden dann mit `rate_limited`
abgelehnt, statt in einen Speicherfehler zu laufen (L-1).

Bekannte Einschränkung, die dokumentiert wird: **bcrypt schneidet bei 72 Byte ab.**
Importierte bcrypt-Hashes prüfen nur die ersten 72 Byte. Nach dem Rehash auf
Argon2id gilt die volle Länge.

### 3.4 Die drei Identitätskonfigurationen

Drei Konfigurationen, gewählt bei der Initialisierung über `identity.mode`
(3.15 A.3), materialisiert als CHECK-Constraint in der Migration:

| Konfiguration | Anmeldename | Eindeutig | Zurücksetzen/Bestätigen über | Aufzählungsschutz |
|---|---|---|---|---|
| `email` | E-Mail | `email` | E-Mail | vollständig |
| `username` | Benutzername | `username_key` | **nicht verfügbar** ohne Wiederherstellungscodes | für den Benutzernamen nicht möglich |
| `username_email` | Benutzername **oder** E-Mail | beide | E-Mail | für die E-Mail ja, für den Benutzernamen nein |

Konsequenz, die dokumentiert wird: **In `username` gibt es kein Zurücksetzen per
E-Mail.** Wer diese Konfiguration wählt, muss Wiederherstellungscodes bei der
Registrierung ausgeben, sonst ist ein vergessenes Kennwort endgültig; der Weg
zurück ist dann `password.redeemResetWithRecoveryCode` (3.15 B.4). Die
Bibliothek erzwingt das: `identity: { mode: "username" }` ohne `recoveryCodes`
ist ein Startfehler und in TypeScript bereits ein Kompilierfehler (3.15 A.3).

Zweite Konsequenz: **Benutzernamen sind per Definition aufzählbar.**
Wer eine Verfügbarkeitsprüfung anbietet, verrät die Existenz. Velve Auth bietet
sie an, begrenzt sie hart und sagt es in der Dokumentation, statt so zu tun, als
sei sie geschützt.

Normalisierung an genau einer Stelle:
- E-Mail: trimmen, NFKC, `lower()`. Datenbank prüft per CHECK nach.
- Benutzername: NFKC, `toLowerCase()` in `username_key`; Anzeigeform bleibt erhalten.
  Zusätzlich eine konfigurierbare Zeichenklassen-Erlaubnisliste (Standard:
  `[a-z0-9_-]`, 3–32 Zeichen) — das ist der wirksamste Schutz gegen Homoglyphen,
  weil es sie gar nicht erst zulässt.

### 3.5 Sitzungsmodell

- Token: 32 Byte aus `crypto.getRandomValues`, base64url — 256 bit.
- Gespeichert wird **nur `sha256(token)`**. Das Klartext-Token verlässt den
  Prozess nur im Cookie.
- Cookie: `__Host-velve_session`, `HttpOnly`, `Secure`, `SameSite=Lax`, `Path=/`.
  Das `__Host-`-Präfix erzwingt `Secure` und verbietet `Domain` — Cookie-Tossing
  aus einer Subdomain ist damit ausgeschlossen.
- Zwei Fristen: **Leerlauf** (Standard 7 Tage, verlängert bei Nutzung, höchstens
  einmal pro Stunde geschrieben) und **absolut** (Standard 30 Tage, nie verlängert).
- Auflösung: **eine** Abfrage mit Join auf `velve.user`, gefiltert nach
  `token_sha256 = $1 AND idle_expires_at > now() AND absolute_expires_at > now()`.
  `u.disabled_at` wird in derselben Abfrage gelesen: Ist es gesetzt, gilt die
  Sitzung nicht als angemeldet, und die Antwort ist `account_disabled` — die
  einzige Stelle, an der dieser Code erscheint (L-4). Eine Deaktivierung wirkt
  damit auf die nächste Anfrage jeder bestehenden Sitzung.
- **Frische:** Eine Sitzung gilt als frisch, solange seit `created_at` weniger
  als `freshnessWindow` (Vorgabe 15 Minuten) vergangen ist. Operationen an
  Anmeldedaten verlangen Frische (3.15 B.9); wiederhergestellt wird sie nur
  durch eine neue Anmeldung, weil eine Wiederauthentifizierung ohne Neuvergabe
  ein zweiter Vertrauensbegriff neben `factors` wäre.
- **Kein Cookie-Cache im Kern.** Autorisierungsentscheidungen werden nie aus
  einem Cache beantwortet; genau daran hing Better Auths schwerster Fehler im
  Kern-Anmeldepfad (GHSA-xg6x-h9c9-2m83, CVSS 9.1: 2FA-Bypass, weil der
  Cookie-Cache die Session vor der Zweitfaktor-Prüfung ablegte).
- **Metadaten gekürzt:** `ip` und `user_agent` werden standardmäßig verkürzt
  gespeichert — IPv4 auf `/24`, IPv6 auf `/64`, User-Agent auf Browser- und
  Systemfamilie (L-10, Option `sessionMetadata`).
- **Neuvergabe** bei jedem Ereignis, das die Vertrauensstufe ändert: Anmeldung,
  Abschluss des zweiten Faktors, Kennwortänderung, Verknüpfung einer neuen
  Identität. Immer als `INSERT` einer neuen Zeile plus `DELETE` der alten in
  **einer** Transaktion. Ein `UPDATE velve.session SET user_id` existiert nicht
  und wird per Lint-Regel und Datenbank-Trigger verhindert.
- **Widerruf:** einzeln, alle außer der aktuellen, alle. Kennwort-Reset und
  Kennwortänderung widerrufen **standardmäßig** alle anderen Sitzungen. Das ist
  kein Schalter.
- `factors` hält fest, womit authentifiziert wurde. Das ist keine Berechtigung,
  sondern Teil der Antwort auf „wer ist angemeldet, und wie sicher".

### 3.6 Zweiter Faktor und der Zwischenzustand

Der Moment zwischen korrektem Kennwort und zweitem Faktor ist **keine Sitzung**.
Er ist eine Zeile in `velve.pending_authentication`, das Token liegt in einem
eigenen kurzlebigen Cookie (`__Host-velve_pending`, 5 Minuten), und genau **vier**
Routen akzeptieren es: `POST /factor/totp/verify`, `/factor/webauthn/authenticate/start`,
`/factor/webauthn/authenticate/finish` und `POST /factor/recovery/verify`. Jede
andere Route ignoriert es vollständig. Ein Zwischenzustand erlaubt höchstens
fünf Versuche; danach wird die Zeile gelöscht, und der Vorgang beginnt beim
Kennwort von vorn (L-8).

- **TOTP:** RFC 6238, SHA-1, 6 Stellen, 30 s, Toleranz ±1 Schritt. Secret
  AES-256-GCM-verschlüsselt. Replay-Schutz über `velve.totp_used_step` mit
  Primärschlüssel `(user_id, time_step)` — ein `INSERT`, der bei Konflikt
  scheitert, ist die Prüfung.
- **WebAuthn:** vollwertiger eigener Anmeldeweg, nicht nur zweiter Faktor.
  - *Passkey-Anmeldung* (auffindbare Anmeldedaten, `userVerification: "required"`)
    ergibt eine Sitzung mit `factors = {webauthn}` — ohne Kennwort.
  - *Zweiter Faktor* nach Kennwort ergibt `factors = {password, webauthn}`.
  - **Gerätegebunden vs. synchronisiert** wird über die Flags `backup_eligible`
    (BE) und `backup_state` (BS) aus den Authenticator-Daten unterschieden und
    gespeichert. `BE = false` heißt gerätegebunden. Die Anwendung kann darauf
    eine Richtlinie stützen; die Bibliothek erzwingt keine.
  - Challenge einmalig, 5 Minuten, per `DELETE … RETURNING` konsumiert, an den
    Zweck (`register`/`authenticate`) gebunden.
  - `sign_count` wird geprüft: sinkt er, wird das der Anwendung als Feld
    `signCountRegressed` im Anmeldeergebnis gemeldet, nicht als Fehler (L-9).
- **Wiederherstellungscodes:** 10 Stück, je 160 bit, in Gruppen dargestellt.
  Gespeichert als `HMAC-SHA256(pepper, code)` — Nachschlagen ist ein
  Index-Treffer, kein Durchlaufen. Konsum per `DELETE … RETURNING`. Bei einem
  Wechsel des Verfahrens werden alle neu erzeugt und die alten in derselben
  Transaktion gelöscht.

### 3.7 Einmal-Artefakte

Jedes Einmal-Artefakt ist eine Zeile mit `sha256(token)` als Primärschlüssel,
einem `purpose` und einem `expires_at`. Konsum ist **immer**:

```sql
DELETE FROM velve.one_time_token
WHERE token_sha256 = $1 AND purpose = $2 AND expires_at > now()
RETURNING user_id, payload;
```

Ein Ergebnis heißt gültig, kein Ergebnis heißt ungültig — abgelaufen, verbraucht
und nie existiert sind nach außen ununterscheidbar. Das ist Absicht.

Fristen: E-Mail-Bestätigung 24 h, Kennwort-Reset 1 h, E-Mail-Wechsel 1 h,
Magic Link 10 min. Ein neu angeforderter Token gleichen Zwecks löscht die
vorherigen desselben Nutzers.

### 3.8 Schlüsselverwaltung

Ein Wurzelschlüssel, daraus per **HKDF-SHA256** zweckgetrennte Schlüssel:
`cookie-sig`, `token-pepper`, `totp-enc`, `oauth-token-enc`, `pkce-enc`, `password-enc`.
Jeder erzeugte Wert trägt seine Schlüsselversion im Envelope. Ein Ring
akzeptierter Versionen erlaubt Rotation ohne Ausfall.

```ts
interface KeyProvider {
  current(purpose: KeyPurpose): Promise<{ version: number; key: CryptoKey }>
  byVersion(purpose: KeyPurpose, version: number): Promise<CryptoKey | null>
}
```

Die Standardimplementierung `rootKeyProvider` (3.15 A.8) liest den
Wurzelschlüssel aus der Konfiguration. SCHÄTZUNG: Auf Caprock würde er als
Capability übergeben, ohne dass sich für den Aufrufer etwas ändert; das ist
ungeprüft. **Weil Sitzungen undurchsichtige Datenbankzeilen sind, überlebt jede
Schlüsselrotation sämtliche Sitzungen.**

### 3.9 Ratenbegrenzung

Token-Bucket in PostgreSQL, ein Round-Trip:

```sql
INSERT INTO velve.rate_bucket (bucket_key, tokens, updated_at, expires_at)
VALUES ($1, $2 - 1, now(), now() + $3)
ON CONFLICT (bucket_key) DO UPDATE
SET tokens = LEAST($2, velve.rate_bucket.tokens
      + EXTRACT(EPOCH FROM now() - velve.rate_bucket.updated_at) * $4) - 1,
    updated_at = now(),
    expires_at = now() + $3
RETURNING tokens;
```

Negativ heißt abgelehnt. Drei Zähler gleichzeitig:
- **IP:** normalisiert auf `/32` (v4) bzw. **`/64` (v6)** — das Präfix, nicht die
  Adresse, sonst rotiert ein Angreifer beliebig (CVE-2026-45364).
  `X-Forwarded-For` wird **nur** ausgewertet, wenn `trustedProxies` konfiguriert
  ist; ohne das zählt die Verbindungsadresse.
- **Konto:** ein Eimer mit langsam nachfüllender Rate statt einer Sperre, und Überschreitung führt zur **Ablehnung**, nicht zu einer Verzögerung (L-5). Eine Sperre ist eine
  Dienstverweigerung gegen einen bekannten Nutzer.
- **Global je Route:** kein Ablehnen, sondern ein Alarm-Callback.

Der Schlüssel enthält den **aufgelösten Routennamen**, nicht den rohen Pfad —
`//sign-in` und `/sign-in` sind derselbe Zähler (GHSA-x732-6j76-qmhm).

### 3.10 Drittanbieter-Anmeldung

Autorisierungscode-Fluss mit **PKCE S256 verpflichtend**, `state` serverseitig
in `velve.oauth_flow` (Cookie hält nur den Zeiger), `nonce` bei OIDC, Prüfung
von `iss` nach RFC 9207, ID-Token-Signatur gegen JWKS.

Anbieter zum Start: Google, GitHub, Apple, Microsoft/Entra, GitLab, Discord,
Facebook, LinkedIn, Twitch, Spotify, Slack, Notion, Zoom, Dropbox — plus
`genericOAuth` für alles Weitere. Kein Wettlauf um 36 Anbieter; die Schnittstelle
ist der Wert, nicht die Anzahl.

**Verknüpfungsregel, nicht verhandelbar:**
`(provider, subject)` ist der einzige Schlüssel. **Die E-Mail ist niemals ein
Verknüpfungsschlüssel.** Automatisch mit einem bestehenden Konto verknüpft wird
nur, wenn *alle* Bedingungen gelten:
1. Der Anbieter meldet die E-Mail als verifiziert.
2. Das lokale Konto hat `email_verified_at IS NOT NULL`.
3. Der Anbieter steht in `trustedProviders`.

Sonst: neues Konto oder ausdrückliche Verknüpfung in einer bestehenden Sitzung.
Better Auth las bis CVE-2026-53516 (CVSS 8,3) die zweite Bedingung nie — das
Auto-Link-Gate prüfte nur den `emailVerified`-Claim des Anbieters. Auch nach dem
Fix sind die Bedingungen dort nicht alle verpflichtend: Ein vertrauenswürdiger
Anbieter ersetzt die erste, und die zweite ist über
`accountLinking.requireLocalEmailVerified` abschaltbar
(`packages/better-auth/src/oauth2/link-account.ts:144-158`). GHSA-qq9h-g4jm-xgf3
ist dasselbe Muster auf dem Magic-Link-Weg; dort schließt L-12 die Lücke.

**Kein Konto ohne E-Mail-Zwang:** Meldet der Anbieter keine E-Mail, bleibt
`user.email` in den Konfigurationen `username`/`username_email` NULL. Es werden
**keine Platzhalter-Adressen erfunden** — Better Auth tut das mit
`createPlaceholderEmail` (`packages/core/src/utils/email.ts:24`) an neun
Stellen in acht Modulen des Produktionscodes und bricht damit jedes
E-Mail-Plugin.

Fremde Tokens werden verschlüsselt gespeichert oder, wenn die Anwendung sie
nicht braucht, gar nicht (`storeTokens: false` ist der Standard).

### 3.11 Plugin-Schnittstelle

**Was ein Plugin darf:**
- Routen unter seinem eigenen Namensraum `/x/<plugin-id>/…` beitragen.
- Eigene Tabellen im Schema `velve` mit Präfix `<plugin-id>_` anlegen; Migrationen
  laufen im selben versionierten Läufer.
- An deklarierten Punkten mithören: `beforeSignIn`, `afterSignIn`,
  `beforeSessionCreate`, `afterSessionCreate`, `beforeUserCreate`,
  `afterUserCreate`, `beforeSessionRevoke`. Ein Hook darf **ablehnen** (Fehler
  werfen) oder **beobachten**. Er darf die Antwort nicht ersetzen.
- Eigene Fehlercodes und Ratenbegrenzungsregeln beitragen.
- Abhängigkeiten deklarieren (`dependsOn`), die topologisch sortiert werden.

**Was ein Plugin nicht darf:**
- Kernrouten überschreiben. Ein Namenskonflikt ist ein **Startfehler**, keine Warnung.
- Den Kernkontext verändern. Der Kontext ist eingefroren (`Object.freeze`).
- Den Passwort-Verifier, die Session-Auflösung oder die Origin-Prüfung ersetzen.
- Kerntabellen direkt beschreiben. Nur Repository-Methoden, und jede verlangt
  einen `actor`.
- Optionen anderer Plugins lesen oder schreiben.
- Vor der Sicherheitsmiddleware laufen. Origin-Prüfung und Ratenbegrenzung
  liegen immer davor — auch bei direkten Serveraufrufen.

Kernentscheidung: Die Erweiterungspunkte sind **aufgezählt**, nicht offen.
Ein Plugin ist ein Zuhörer mit Vetorecht, kein Miteigentümer des Kerns.

### 3.12 Die Schnittstelle im Überblick

Jede Route wird **einmal** deklariert — Pfad, Methode, Eingabe-Schema,
Ausgabe-Typ, Fehlercodes. Aus dieser Deklaration werden erzeugt: der
Serverhandler, die direkt aufrufbare Servermethode und der Client (3.15 D und E).
So sieht der Einbau aus; 3.15 enthält jede Signatur:

```ts
const auth = createVelveAuth({
  database: pg(pool),
  identity: { mode: "email" },        // oder "username" | "username_email", dann mit username-Regeln
  keys: rootKeyProvider({ currentVersion: 1, keysByVersion: { 1: process.env.VELVE_ROOT_KEY! } }),
  password: { argon2id: { memoryKiB: 19456, iterations: 2, parallelism: 1 } },
  session: { idleTimeout: "7d", absoluteTimeout: "30d" },
  origins: ["https://app.example.com"],
  email: { send: async (message) => { … } },
})

await auth.signUp.withPassword({ … })
await auth.signIn.password({ … })
await auth.session.resolve(token)
export default toWebHandler(auth)   // (Request) => Promise<Response>
```

### 3.13 Fehlerbehandlung

Zwei Fehlerarten:

- **Sichtbar:** Eingabe ungültig, Rate-Limit erreicht, Token abgelaufen, zweiter
  Faktor erforderlich. Diese tragen einen stabilen Code. Konto deaktiviert gehört ausdrücklich **nicht** dazu, solange es um eine Anmeldung geht (L-4); der Code erscheint nur bei der Auflösung einer bestehenden Sitzung.
- **Absichtlich unsichtbar:** Alles, was Existenz verraten würde. Anmeldung,
  Registrierung, Kennwort-Reset und E-Mail-Wechsel liefern für existierende und
  nicht existierende Konten **byteweise identische** Antworten — gleicher Status,
  gleiche Kopfzeilen, gleicher Körper. Der Unterschied wandert ausschließlich in
  die versendete E-Mail.

Registrierung mit bereits vergebener E-Mail: gleiche Antwort wie bei Erfolg, und
an die vorhandene Adresse geht eine Nachricht „jemand hat versucht, sich mit
deiner Adresse zu registrieren" mit einem Anmelde- statt Bestätigungslink.

Serverseitig wird der wahre Grund immer protokolliert. Der Unterschied zwischen
innen und außen ist ausdrücklich und liegt an genau einer Stelle im Code.

### 3.14 Was ausdrücklich fehlt

Keine Rollen, keine Berechtigungen, keine Organisationen, keine Teams, keine
Einladungen, kein SCIM, kein SAML, kein eigener OAuth-Server, keine Profildaten,
keine Admin-Oberfläche, kein Audit-Log, kein E-Mail-Versand (nur ein Callback),
kein Abo-/Bezahlmodul.

### 3.15 Die öffentliche Schnittstelle im Detail

Dieser Abschnitt führt die Skizze aus 3.12 vollständig aus: Typen, Signaturen, Semantik,
keine Funktionskörper. Vier Entwurfsregeln tragen die Oberfläche; sie setzen die Vorgabe
des Bauauftrags um, dass der Code ohne Kommentare verständlich und die Schnittstelle ohne
Dokumentation benutzbar sein muss.

1. **Keine booleschen Parameter.** `revokeAllOther()` und `revokeAll()` statt
   `revoke({ includeCurrent })`.
2. **Ein Verbpaar je Ablaufart.** Zweischrittige Zeremonien mit Challenge heißen immer
   `start`/`finish`, per E-Mail zugestellte Einmal-Artefakte immer `request…`/`redeem…`.
3. **Kein Umgebungszustand.** Kein impliziter „aktueller Nutzer"; jede Methode nimmt ein
   benanntes `sessionToken`, `pendingToken` oder `userId`.
4. **Optionen beschreiben den Aufruf, nicht das Verhalten.** Kein Parameter hat mehr als fünf
   Felder, und keines ändert die Bedeutung der Methode.

---

#### A) Konfiguration

##### A.1 Der Identitätsmodus ist der Typparameter der Bibliothek

`createVelveAuth` ist generisch über den Modus, der Modus wird aus der Konfiguration
inferiert, und alles Nachgelagerte — Eingabefelder, ganze Namensräume — hängt daran.

```ts
type IdentityMode = "email" | "username" | "username_email"

interface IdentityFieldsByMode {
  email:          { email: string }
  username:       { username: string }
  username_email: { email: string; username: string }
}
interface SignInLookupByMode {
  email:          { email: string }
  username:       { username: string }
  username_email: { emailOrUsername: string }
}
type IdentityFields<M extends IdentityMode> = IdentityFieldsByMode[M]
type SignInLookup<M extends IdentityMode>  = SignInLookupByMode[M]

type ModeHasEmail<M extends IdentityMode>    = M extends "email"    | "username_email" ? true : false
type ModeHasUsername<M extends IdentityMode> = M extends "username" | "username_email" ? true : false
```

Nachschlagetabellen statt verteilter bedingter Typen: eine Zeile je Modus, lesbar ohne `infer`.
Im Modus `username_email` heißt das Anmeldefeld `emailOrUsername` und nicht zwei optionale
Felder — ein Aufruf mit beiden wäre sonst weder Typfehler noch definierte Semantik.

Wie verschwindet ein Namensraum, den der Modus nicht anbietet? *Entwurf A:* Der Schlüssel
bleibt, sein Typ wird `never`; der Fehler erscheint erst beim Methodenzugriff als „Property
'change' does not exist on type 'never'". *Entwurf B:* Der Schlüssel wird entfernt; der Fehler
lautet „Property 'username' does not exist on type `VelveAuth<"email">`". **Entscheidung: B** —
die Fehlermeldung ist das Einzige, was der Aufrufer ohne Dokumentation zu lesen bekommt, und
sie muss den Modus nennen.

```ts
type PresentKeys<S> = { [K in keyof S]-?: [S[K]] extends [never] ? never : K }[keyof S]
type Prune<S> = { [K in PresentKeys<S>]: S[K] }
type OnlyWhen<Condition extends boolean, S> = Condition extends true ? S : never
```

##### A.2 `VelveAuthConfig`

```ts
type Duration = `${number}${"s" | "m" | "h" | "d"}`
type VelveAuthConfig<M extends IdentityMode> = BaseConfig<M> & RecoveryCodesRequirement<M>
```

Felder mit Vorgabe sind in der Konfiguration optional; die Typen in A.4 bis A.8 zeigen die
aufgelöste Form. `Driver` (3.2) kommt aus einer der drei Treiberfabriken:

```ts
declare function pg(pool: import("pg").Pool): Driver                       // @velve/auth/pg
declare function postgresJs(sql: import("postgres").Sql): Driver           // @velve/auth/postgres-js
declare function neon(pool: import("@neondatabase/serverless").Pool): Driver  // @velve/auth/neon
```

| Feld von `BaseConfig<M>` | Typ | Vorgabe | Bedeutung |
|---|---|---|---|
| `database` | `Driver` | — | Treiber aus `@velve/auth/pg`, `/postgres-js`, `/neon`; einzige Stelle, an der eine Verbindung hereinkommt. |
| `identity` | `IdentityConfig<M>` | — | Welche Anmeldenamen es gibt; bestimmt CHECK-Constraint und Instanztyp. |
| `keys` | `KeyProvider` | — | Wurzelschlüssel und Ring; alle sechs Zweckschlüssel (3.8) entstehen daraus per HKDF-SHA256. |
| `origins` | `readonly string[]` | — | Erlaubte Ursprünge; eine leere Liste ist ein Startfehler, kein stiller Freibrief. |
| `password` | `PasswordConfig` | A.4 | Argon2id-Parameter, Altverfahren, Längengrenzen, Semaphor-Grenze, Einhängepunkt `validate`. |
| `session` | `SessionConfig` | A.5 | Fristen, Cookie-Name, Cookie-Optionen, Frischefenster. |
| `sessionMetadata` | `"truncated" \| "full" \| "none"` | `"truncated"` | Kürzung von `ip` und `user_agent` in `velve.session` (L-10). |
| `trustedProxies` | `readonly string[]` | `[]` | CIDR-Blöcke, deren `X-Forwarded-For` gilt; sonst zählt die Verbindungsadresse. |
| `rateLimit` | `RateLimitConfig` | A.6 | Eimergrößen, Alarm-Callback. |
| `email` | `EmailConfig` | keiner | Sende-Callback; sein Fehlen ist in `email` und `username_email` ein Startfehler. |
| `oauth` | `OAuthConfig` | keiner | Anbieter, vertrauenswürdige Anbieter, Token-Speicherung. |
| `webauthn` | `WebAuthnConfig` | keiner | Relying Party; sein Fehlen entfernt alle WebAuthn-Routen. |
| `totp` | `TotpConfig` | A.8 | Aussteller-Name und Toleranzfenster. |
| `recoveryCodes` | `RecoveryCodesConfig` | keiner; im Modus `username` **Pflicht** | Anzahl und Gruppierung der Wiederherstellungscodes. |
| `plugins` | `readonly VelvePlugin[]` | `[]` | Erweiterungen; ein Namenskonflikt ist ein Startfehler. |
| `schema` | `string` | `"velve"` | Postgres-Schemaname. |
| `clock` | `Clock` | Systemuhr | Zeitquelle; aus `@velve/auth/testing` ersetzbar. |

##### A.3 `identity` und die erzwungenen Wiederherstellungscodes

```ts
type IdentityConfig<M extends IdentityMode> =
  M extends "email"      ? { mode: "email" }
  : M extends "username" ? { mode: "username"; username: UsernameRules }
  : { mode: "username_email"; username: UsernameRules }

interface UsernameRules {
  allowedCharacters: RegExp          // Vorgabe /^[a-z0-9_-]+$/
  minimumLength: number              // Vorgabe 3
  maximumLength: number              // Vorgabe 32
  reservedNames: readonly string[]   // Vorgabe []
}

type RecoveryCodesRequirement<M extends IdentityMode> =
  M extends "username" ? { recoveryCodes: RecoveryCodesConfig }
                       : { recoveryCodes?: RecoveryCodesConfig }
```

`identity` ist ein Objekt und kein String-Literal, weil 3.4 eine konfigurierbare
Zeichen-Erlaubnisliste und Längengrenzen verlangt, die ein String nicht tragen kann; eine
String-Kurzform wird nicht zusätzlich akzeptiert, weil zwei Schreibweisen für dieselbe Sache
der dokumentationsfreien Benutzbarkeit widersprechen. Abschnitt 3.4 verlangt, dass der Modus
`username` ohne Wiederherstellungscodes ein **Startfehler** ist. Ein Startfehler ist die
zweitbeste Lösung: `RecoveryCodesRequirement` macht daraus einen Kompilierfehler. Die
Laufzeitprüfung bleibt für Aufrufer aus JavaScript.

##### A.4 `password`, A.5 `session`, A.6 `rateLimit`

```ts
interface PasswordConfig {
  argon2id: { memoryKiB: number; iterations: number; parallelism: number }  // 19456, 2, 1
  acceptLegacy: readonly LegacyScheme[]         // Vorgabe: alle sieben
  minimumLength: number                         // Vorgabe 8
  maximumLengthInBytes: number                  // Vorgabe 4096, nach oben nicht konfigurierbar
  concurrentHashLimit: number                   // Vorgabe min(4, cpus)
  validate?: (plaintext: string) => Promise<void>   // L-7: nur beim Setzen und Ändern
}
type LegacyScheme = "argon2i" | "argon2d" | "bcrypt" | "scrypt"
  | "pbkdf2-sha256" | "pbkdf2-sha512" | "fbscrypt"

interface SessionConfig {
  idleTimeout: Duration          // Vorgabe "7d"
  absoluteTimeout: Duration      // Vorgabe "30d"
  idleWriteInterval: Duration    // Vorgabe "1h"
  freshnessWindow: Duration      // Vorgabe "15m"
  cookieName: `__Host-${string}` // Vorgabe "__Host-velve_session"
  cookie: { sameSite: "lax" | "strict" }                      // Vorgabe "lax"
}

interface BucketRule { capacity: number; refillPerSecond: number }
interface RateLimitConfig {
  perIpAddress: BucketRule       // Vorgabe { capacity: 10, refillPerSecond: 0.1 }
  perAccount: BucketRule         // Vorgabe { capacity: 5, refillPerSecond: 0.01 }
  globalPerRoute: { alertThresholdPerMinute: number; onAlert: (alert: RateAlert) => void }
}
interface RateAlert { routeName: string; requestsInLastMinute: number; observedAt: Date }
```

`memoryKiB` unter 19456 ist ein Startfehler — eine Untergrenze, die man unterschreiten darf,
ist keine. Beide Längen werden **vor** jedem KDF-Aufruf geprüft; erzeugt wird ausschließlich
Argon2id, `acceptLegacy` regelt nur das Prüfen importierter Bestände. `validate` ist der
einzige Einhängepunkt für eine Kennwortrichtlinie der Anwendung, etwa einen Abgleich gegen
Leak-Korpora; er läuft beim Setzen und Ändern und nie bei der Anmeldung, damit das
Klartextkennwort auf dem heißen Pfad keinen fremden Code erreicht (L-7).

`httpOnly`, `secure`, `domain` und `path` sind keine Optionen: Das `__Host-`-Präfix erzwingt
`Secure` und `Path=/` und verbietet `Domain`; ein konfigurierbares `domain` öffnete
Cookie-Tossing aus einer Subdomain wieder, und `sameSite: "none"` fehlt aus demselben Grund.
Ein `cookieName` ohne `__Host-` ist ein Typfehler und ein Startfehler. `freshnessWindow` misst
gegen `created_at`, nicht gegen `last_used_at` — Frische ist die Zeit seit der Anmeldung (3.5);
sie betrifft 17 Methoden (B.9). Die IP-Normalisierung auf `/32` (v4) beziehungsweise `/64`
(v6) ist nicht konfigurierbar. `perIpAddress` und `perAccount` gelten für die Routen, die
Kennwörter, Codes oder Token entgegennehmen; die übrigen Routen tragen weitere, feste Eimer
in ihrer Deklaration (D.2). Der Kontozähler wird auf dem HMAC des eingegebenen Bezeichners
gebildet und lehnt bei Überschreitung ab, statt zu verzögern oder zu sperren (L-5); der
globale Zähler lehnt nie ab, sondern ruft `onAlert`.

##### A.7 `email` — der Sende-Callback und der vollständige Nachrichtentyp

```ts
interface EmailConfig { send: (message: EmailMessage) => Promise<void> }

type EmailMessage =
  | { kind: "email_verification"; to: string; userId: string; token: string; expiresAt: Date }
  | { kind: "password_reset";     to: string; userId: string; token: string; expiresAt: Date }
  | { kind: "email_change";       to: string; userId: string; token: string; expiresAt: Date
      previousEmail: string }
  | { kind: "magic_link";         to: string; userId: string; token: string; expiresAt: Date }
  | { kind: "sign_up_attempt_on_existing_account"; to: string; userId: string }
  | { kind: "request_for_unknown_address"; to: string; requested: "password_reset" | "magic_link" }
```

Vier Arten entsprechen den vier `purpose`-Werten aus `velve.one_time_token`. Die fünfte ist die
Gegenseite des Aufzählungsschutzes: Eine Registrierung auf eine vergebene Adresse liefert
dieselbe Antwort wie ein Erfolg, und der Unterschied wandert vollständig in diese Nachricht.
Sie trägt absichtlich **kein** Token — sie führt zur Anmeldung, nicht zu einer Bestätigung, die
niemand angefordert hat. Die sechste folgt aus L-1: Ein Reset oder Magic Link für eine
unbekannte Adresse ruft `send` genauso auf wie für eine bekannte, damit beide Zweige dieselbe
Arbeit verrichten; ob daraus eine „hier existiert kein Konto"-Nachricht wird oder nichts,
entscheidet die Anwendung im Callback.

Die Bibliothek baut keine URLs; ein `redirectTo`, das aus einem Request stammt und gegen eine
Erlaubnisliste geprüft werden müsste, existiert deshalb gar nicht. Wirft `send`, schlägt die
auslösende Operation fehl und das Einmal-Token wird zurückgerollt: Ein Reset-Token, dessen Mail
nie ankam, nützt nur einem Angreifer.

##### A.8 `oauth`, `webauthn`, `totp`, `recoveryCodes`, `keys`, `clock`

```ts
interface OAuthConfig {
  providers: Partial<Record<KnownProvider, ProviderCredentials>>
           & { [customId: string]: GenericProviderConfig }
  trustedProviders: readonly string[]
  storeTokens: boolean                          // Vorgabe false
}
type KnownProvider = "google" | "github" | "apple" | "microsoft" | "gitlab" | "discord"
  | "facebook" | "linkedin" | "twitch" | "spotify" | "slack" | "notion" | "zoom" | "dropbox"
interface ProviderCredentials { clientId: string; clientSecret: string; scopes?: readonly string[] }
interface GenericProviderConfig extends ProviderCredentials {
  authorizationEndpoint: string; tokenEndpoint: string; userInfoEndpoint?: string
  issuer?: string; jwksUri?: string
  subjectClaim: string                          // ohne Vorgabe, mit Absicht
}

interface WebAuthnConfig {
  relyingPartyId: string                        // die eTLD+1, z.B. "example.com"
  relyingPartyName: string; origins: readonly string[]
  userVerification: "required" | "preferred"
}
interface TotpConfig          { issuer: string; stepToleranceInSteps: 0 | 1 }  // Vorgabe 1
interface RecoveryCodesConfig { count: number; groupSize: number }             // Vorgaben 10, 5

type KeyPurpose = "cookie-sig" | "token-pepper" | "totp-enc" | "oauth-token-enc" | "pkce-enc" | "password-enc"
interface KeyProvider {
  current(purpose: KeyPurpose): Promise<{ version: number; key: CryptoKey }>
  byVersion(purpose: KeyPurpose, version: number): Promise<CryptoKey | null>
}
declare function rootKeyProvider(input: { currentVersion: number
  keysByVersion: Readonly<Record<number, string>> }): KeyProvider   // base64url, je 32 Byte
interface Clock { now(): Date }
```

`subjectClaim` hat bewusst keine Vorgabe: Die stabile Anbieter-ID ist der einzige
Verknüpfungsschlüssel, und `"sub"` wäre bequem und in dem einen Fall, in dem es falsch ist, ein
Kontoübernahmefehler. `trustedProviders` ist die dritte der drei Bedingungen für automatische
Verknüpfung; wer nicht darin steht, führt nie zu einer. `webauthn.origins` ist ein Array, weil
eine Relying Party mit Web- und nativer App legitim mehrere Ursprünge hat; ein einzelner
String zwänge zu einer zweiten Instanz mit demselben `relyingPartyId`.
`userVerification: "discouraged"` fehlt, weil ein zweiter Faktor ohne Nutzerverifikation
keiner ist, und für die auffindbare Passkey-Anmeldung gilt immer `"required"`.

---

#### B) Die Instanz

```ts
declare function createVelveAuth<M extends IdentityMode>(config: VelveAuthConfig<M>): VelveAuth<M>

type VelveAuth<M extends IdentityMode> = Prune<AuthSurface<M>> & AuthInternals

interface AuthSurface<M extends IdentityMode> {
  signUp:   SignUpNamespace<M>
  signIn:   SignInNamespace<M>
  signOut:  (input: { sessionToken: SessionToken }) => Promise<void>
  session:  SessionNamespace
  user:     UserNamespace<M>
  password: PasswordNamespace<M>
  factor:   { totp: TotpNamespace; webauthn: WebAuthnNamespace; recovery: RecoveryNamespace }
  identity: IdentityNamespace
  pending:  PendingNamespace
  email:    OnlyWhen<ModeHasEmail<M>,    EmailNamespace>
  username: OnlyWhen<ModeHasUsername<M>, UsernameNamespace>
}

interface AuthInternals {
  readonly routes: readonly AnyRoute[]
  readonly identityMode: IdentityMode
  readonly errorCodes: readonly VelveErrorCode[]
  readonly maintenance: { sweep(): Promise<SweepReport> }        // L-11, ohne HTTP-Route
  migrate(): Promise<MigrationReport>
  close(): Promise<void>
}
interface MigrationReport { appliedVersions: readonly number[]; currentVersion: number }
interface SweepReport     { deletedRowsByTable: Readonly<Record<string, number>> }
```

`routes` ist kein Implementierungsdetail, sondern die Datenstruktur, aus der Teil D den
HTTP-Handler und Teil E den Client baut. Sie liegt zur Laufzeit vor, weil der Client sonst
raten müsste. `AuthSurface` hat 54 Methoden im Modus `username_email`, 51 in `email`, 45 in
`username`. `maintenance.sweep` löscht abgelaufene Zeilen aus den sieben Tabellen mit
`*_sweep_idx` (L-11); `@velve/auth/schema` liefert dasselbe als SQL für `pg_cron`.

##### B.1 `signUp` (2), `signIn` (7), `signOut` (1)

```ts
interface SignUpNamespace<M extends IdentityMode> {
  withPassword(input: IdentityFields<M> & { password: string }): Promise<SignUpResult>
  withoutPassword(input: IdentityFields<M>): Promise<SignUpResult>
}
type SignUpResult = { user: User; sessionToken: SessionToken; session: Session }

interface SignInNamespace<M extends IdentityMode> {
  password(input: SignInLookup<M> & { password: string }): Promise<SignInResult>
  passkey: {
    start(): Promise<PasskeyAuthenticationChallenge>
    finish(input: { challengeToken: string; response: AuthenticatorAssertion }): Promise<SignInResult>
  }
  oauth: {
    start(input: { provider: string; redirectPath?: string }): Promise<OAuthRedirect>
    finish(input: { provider: string; code: string; state: string; issuer?: string })
      : Promise<OAuthCallbackResult>
  }
  magicLink: OnlyWhen<ModeHasEmail<M>, {
    request(input: { email: string }): Promise<void>
    redeem(input: { token: string }): Promise<SignInResult>
  }>
}
```

`signUp` ist ein Namensraum mit zwei Methoden statt einer Funktion mit optionalem `password`,
weil beide Wege unterschiedliche `factors` erzeugen (Regel 1): `withPassword` legt Nutzer und
`password_credential` in einer Transaktion an, `factors = ["password"]`; `withoutPassword` legt
nur den Nutzer an, für Anwendungen, die mit Passkey oder Magic Link beginnen.

`signIn.password` löst im Modus `username_email` am Format auf: mit `@` gegen `email`, sonst
gegen `username_key`; beide Zweige laufen durch denselben Dummy-PHC-Pfad, wenn nichts gefunden
wird. `magicLink.request` gibt `void` zurück, nicht `{ sent: boolean }` — ein boolescher
Rückgabewert wäre genau die Aufzählungsauskunft, die 3.13 verbietet. `signIn.passkey.*` ist
die auffindbare Anmeldung ohne Kennwort (`factors = ["webauthn"]`) und nicht dasselbe wie
`factor.webauthn.authenticate.*`, die einen Zwischenzustand voraussetzt: Vorbedingung (kein
Token gegen `pendingToken`), Nutzerverifikation (immer `required` gegen konfigurierbar) und
Ergebnis (`["webauthn"]` gegen `["password", "webauthn"]`) unterscheiden sich, und ein
gemeinsamer Namensraum mit Modus-Parameter wäre der boolesche Parameter, den Regel 1
ausschließt. `signOut` löscht genau eine Sitzungszeile; ein unbekanntes Token ist kein Fehler.

##### B.2 `session` (7)

```ts
interface SessionNamespace {
  resolve(token: SessionToken): Promise<ResolvedSession | null>
  resolveFromHeaders(headers: Headers): Promise<ResolvedSession | null>
  list(input: { sessionToken: SessionToken }): Promise<Session[]>
  revoke(input: { sessionToken: SessionToken; targetSessionId: string }): Promise<void>
  revokeAllOther(input: { sessionToken: SessionToken }): Promise<{ revokedCount: number }>
  revokeAll(input: { sessionToken: SessionToken }): Promise<{ revokedCount: number }>
  refresh(input: { sessionToken: SessionToken }): Promise<ResolvedSession | null>
}
interface ResolvedSession { session: Session; user: User }
```

`resolve` ist die einzige Autorisierungsentscheidung der Bibliothek und beantwortet sie
**immer** aus einer Abfrage gegen die Datenbank: kein Cookie-Cache, keine Kurzschlussvariante,
kein Parameter, der einen einführen könnte — genau daran hing der schwerste bekannte Fehler im
Anmeldepfad des Vergleichssystems (3.5). Ein unbekanntes oder abgelaufenes Token ergibt `null`;
ein gültiges Token auf einem deaktivierten Konto wirft `account_disabled` (L-4). Als
Nebeneffekt verlängert `resolve` die Leerlauffrist, höchstens einmal je `idleWriteInterval`;
`refresh` erzwingt genau diesen Schreibvorgang und sonst nichts — nie die absolute Frist, nie
ein neues Token, denn eine Methode, die die absolute Frist verlängern könnte, wäre das Ende der
absoluten Frist. `revoke` nimmt eine `targetSessionId`, nicht ein zweites Token — das Token
einer fremden Sitzung liegt dem Aufrufer nicht vor und soll ihm nicht vorliegen; die Rückgabe
ist auch bei fehlender oder fremder Zeile `void`, sonst wäre die Methode eine Auskunft über
fremde Sitzungs-IDs.

##### B.3 `user` (6, ohne HTTP-Routen)

```ts
interface UserNamespace<M extends IdentityMode> {
  findById(input: { userId: string }): Promise<User | null>
  disable(input: { userId: string; reason: string }): Promise<void>
  enable(input: { userId: string }): Promise<void>
  delete(input: { userId: string }): Promise<void>
  findByEmail:    OnlyWhen<ModeHasEmail<M>,    (i: { email: string })    => Promise<User | null>>
  findByUsername: OnlyWhen<ModeHasUsername<M>, (i: { username: string }) => Promise<User | null>>
}
```

Dieser Namensraum ist die Fläche, die die Anwendung im eigenen Prozess aufruft, **nachdem** sie
ihre eigene Autorisierungsentscheidung getroffen hat. Velve Auth hat kein Berechtigungsmodell
und kann nicht entscheiden, wer `disable` aufrufen darf; das ungeprüft über HTTP
entgegenzunehmen wäre das Gegenteil einer Sicherung. `disable` setzt `disabled_at` und lässt
die Sitzungszeilen stehen: Jede weitere Anfrage mit einem ihrer Token endet bei der Auflösung
mit `account_disabled` (L-4, 3.5), bis `enable` das Konto freigibt oder die Fristen ablaufen.
`enable` existiert, weil eine Deaktivierung ohne Gegenstück nur per direktem SQL rückgängig zu
machen wäre. `reason` wird nicht gespeichert (3.14 schließt ein Audit-Log aus), sondern
protokolliert, und zwingt den Aufrufer, den Grund am Aufrufort zu formulieren.

**Kein `user.update`:** `velve.user` hat außer den Anmeldenamen keine veränderlichen Felder,
und beide haben eigene Namensräume mit Bestätigungsabläufen; ein `user.update` wäre entweder
leer oder eine zweite Tür an den Bestätigungen vorbei.

##### B.4 `password` (5)

```ts
interface PasswordNamespace<M extends IdentityMode> {
  set(input: { sessionToken: SessionToken; newPassword: string }): Promise<SetPasswordResult>
  change(input: { sessionToken: SessionToken; currentPassword: string; newPassword: string })
    : Promise<SetPasswordResult>
  redeemResetWithRecoveryCode(input: SignInLookup<M> & { recoveryCode: string; newPassword: string })
    : Promise<SetPasswordResult>
  requestReset: OnlyWhen<ModeHasEmail<M>, (i: { email: string }) => Promise<void>>
  redeemReset:  OnlyWhen<ModeHasEmail<M>, (i: { token: string; newPassword: string })
    => Promise<SetPasswordResult>>
}
interface SetPasswordResult {
  sessionToken: SessionToken            // neu; das alte ist ungültig
  session: Session
  revokedOtherSessionsCount: number
}
```

Alle vier schreibenden Methoden widerrufen **alle anderen** Sitzungen und geben ein neues Token
zurück. Das ist kein Schalter; ein Feld `revokeOtherSessions` existiert nicht. `set` ist für
Konten ohne Passwort-Credential und schlägt fehl, wenn bereits eines existiert — zwei Methoden
statt eines optionalen `currentPassword`, weil ein optionales aktuelles Kennwort genau die
Lücke ist, durch die man fremde Kennwörter überschreibt. `redeemResetWithRecoveryCode` ist der
Weg, den 3.4 im Modus `username` voraussetzt; er verbraucht den Code per `DELETE … RETURNING`
und erzeugt keine neuen. `validate` aus A.4 läuft bei allen vier Methoden vor dem Hashen.

##### B.5 `email` (4) und `username` (2)

```ts
interface EmailNamespace {
  requestVerification(input: { sessionToken: SessionToken }): Promise<void>
  redeemVerification(input: { token: string }): Promise<{ user: User }>
  requestChange(input: { sessionToken: SessionToken; newEmail: string }): Promise<void>
  redeemChange(input: { token: string }): Promise<{ user: User }>
}
interface UsernameNamespace {
  isAvailable(input: { username: string }): Promise<{ available: boolean; reason?: UnavailableReason }>
  change(input: { sessionToken: SessionToken; newUsername: string }): Promise<{ user: User }>
}
type UnavailableReason = "taken" | "reserved" | "invalid_characters" | "wrong_length"
```

`requestVerification` nimmt kein `email`-Feld: Die zu bestätigende Adresse ist die am Konto;
eine Adresse als Parameter wäre eine offene Aufzählungsschnittstelle. `requestChange` gibt auch
dann `void` zurück, wenn `newEmail` einem anderen Konto gehört (intern
`email_taken_on_change`); die Eindeutigkeitsprüfung wiederholt sich beim Einlösen, weil
dazwischen eine Stunde liegt. `redeemChange` setzt `email_verified_at` auf `now()` — der Nutzer
hat die Adresse durch das Einlösen bewiesen.

`username.isAvailable` ist der Ort, an dem der Aufzählungsschutz endet, und der Typ sagt das.
Die Alternative — weglassen und die Auskunft nur als Fehler bei `change` und `signUp` geben —
hätte die Aufzählung nicht verhindert, nur verlangsamt, und zugleich die Registrierungsmaske
verschlechtert. **Entscheidung: anbieten, hart begrenzen** (eigener Eimer: 10 Anfragen je
Minute je IP-Präfix) **und es benennen.**

##### B.6 `factor.totp` (4), `factor.webauthn` (7), `factor.recovery` (3)

```ts
interface TotpNamespace {
  enroll: {
    start(input: { sessionToken: SessionToken }): Promise<TotpEnrollment>
    finish(input: { sessionToken: SessionToken; code: string }): Promise<void>
  }
  verify(input: { pendingToken: PendingToken; code: string }): Promise<SignInResult>
  remove(input: { sessionToken: SessionToken; code: string }): Promise<void>
}
interface TotpEnrollment { secretBase32: string; otpauthUri: string }

interface WebAuthnNamespace {
  register: {
    start(input: { sessionToken: SessionToken }): Promise<WebAuthnRegistrationChallenge>
    finish(input: { sessionToken: SessionToken; challengeToken: string
                    response: AuthenticatorAttestation; label: string })
      : Promise<{ credential: WebAuthnCredential }>
  }
  authenticate: {
    start(input: { pendingToken: PendingToken }): Promise<WebAuthnAuthenticationChallenge>
    finish(input: { pendingToken: PendingToken; challengeToken: string
                    response: AuthenticatorAssertion }): Promise<SignInResult>
  }
  list(input: { sessionToken: SessionToken }): Promise<WebAuthnCredential[]>
  rename(input: { sessionToken: SessionToken; credentialId: string; label: string })
    : Promise<{ credential: WebAuthnCredential }>
  remove(input: { sessionToken: SessionToken; credentialId: string }): Promise<void>
}

interface RecoveryNamespace {
  generate(input: { sessionToken: SessionToken }): Promise<{ codes: readonly string[] }>
  verify(input: { pendingToken: PendingToken; code: string }): Promise<SignInResult>
  remaining(input: { sessionToken: SessionToken }): Promise<{ remainingCount: number }>
}
```

`totp.enroll.start` schreibt eine Zeile mit `confirmed_at = NULL`; solange sie NULL ist, gilt
der Faktor als nicht vorhanden — ein abgebrochener Einrichtungsversuch ist ein Datenrest, kein
ausgesperrter Nutzer. `totp.remove` verlangt einen gültigen Code: Wer den Faktor ohne Besitz
entfernen kann, hat keinen Faktor.

`webauthn.register.finish` verlangt ein `label` als Pflichtfeld — eine Liste mit drei Einträgen
namens „Sicherheitsschlüssel" ist keine Liste, aus der jemand einen entfernen kann, und die
AAGUID kennt nur das Modell, nicht das Gerät. `webauthn.remove` schlägt mit
`last_sign_in_method` fehl, wenn dies die letzte Anmeldemöglichkeit ist (B.7); ein rückläufiger
`sign_count` ist **kein** Fehler, sondern das Feld `signCountRegressed` (L-9).

`recovery.generate` erzeugt immer den vollständigen Satz und löscht alle vorherigen — ein
teilweise erneuerter Satz ist ein Satz, dessen Alter niemand kennt; die Klartextcodes verlassen
den Prozess genau hier, genau einmal. `remaining` gibt nur eine Zahl zurück, gespeichert ist
`HMAC-SHA256(pepper, code)`.

##### B.7 `identity` (3) und `pending` (3)

```ts
interface IdentityNamespace {
  list(input: { sessionToken: SessionToken }): Promise<Identity[]>
  linkOAuth: {
    start(input: { sessionToken: SessionToken; provider: string; redirectPath?: string })
      : Promise<OAuthRedirect>
  }
  unlink(input: { sessionToken: SessionToken; identityId: string }): Promise<void>
}
interface PendingNamespace {
  resolve(token: PendingToken): Promise<PendingAuthentication | null>
  resolveFromHeaders(headers: Headers): Promise<PendingAuthentication | null>
  cancel(input: { pendingToken: PendingToken }): Promise<void>
}
```

`linkOAuth.start` hat kein eigenes `finish`: Der Anbieter leitet auf genau eine Callback-Adresse
zurück, und `velve.oauth_flow` weiß über `link_to_user_id` bereits, ob verknüpft oder angemeldet
wird; ein zweites `finish` mit identischer Eingabe wäre eine Verzweigung, die der Client raten
müsste.

**Die Regel der letzten Anmeldemöglichkeit (L-13).** `unlink` schlägt mit
`last_sign_in_method` fehl, wenn danach keine Anmeldemöglichkeit übrig bliebe. Gezählt werden:
ein `password_credential`, jede WebAuthn-Anmeldedatei, jede weitere Identität. Eine bestätigte
E-Mail-Adresse zählt nicht, obwohl Magic Link damit funktioniert, und Wiederherstellungscodes
zählen nicht: Sie sind ein zweiter Faktor, kein Anmeldename. Dieselbe Zählung schützt
`webauthn.remove`. Dies ist neben `account_disabled` der einzige sichtbare Fehler, der über
einen Kontozustand Auskunft gibt; beide sind unbedenklich, weil sie nur in einer bestehenden
Sitzung und nur über das eigene Konto auftreten.

Der Zwischenzustand ist keine Sitzung und wird von `session.resolve` nie gefunden;
`pending.resolve` nennt nur die zur Wahl stehenden Faktoren, keine Nutzerdaten. `cancel` ist
der Abbrechen-Knopf; ohne ihn bliebe ein halbfertiger Versuch fünf Minuten gültig.

##### B.8 `auth.admin` existiert nicht

*Erstens:* Velve Auth hat kein Berechtigungsmodell (Abschnitt 3.14). Eine
Administrationsschnittstelle braucht zwingend eine Antwort auf „wer darf das", und die
Bibliothek kennt die Frage nicht; ein `auth.admin`, das jeden Aufrufer akzeptiert, ist eine
Hintertür mit gutem Namen. *Zweitens:* Die Fläche gibt es schon — sperren, entsperren, löschen,
nachschlagen ist `auth.user.*`; eine zweite Fassung mit aufgesetzter Prüfung wäre Doppelung mit
zwei Wahrheiten. *Drittens:* Zehn der 33 Advisories des Vergleichssystems sind eine fehlende
Eigentümerbindung (Abschnitt 5.10); ein Endpunkt, der jeden Aufrufer akzeptiert, ist diese
Klasse in Reinform.

##### B.9 Vorbedingungen je Methode

**Aufrufer:** `—` keine, `session` Sitzungstoken, `pending` Token des Zwischenzustands,
`server` nur im Prozess der Anwendung. **Frisch:** Sitzung muss innerhalb `freshnessWindow`
erzeugt sein. `invalid_input` und `rate_limited` sind überall möglich, `account_disabled` bei
jeder Methode mit Aufrufer `session` (L-4); alle drei sind in der Fehlerspalte weggelassen.

| Methode(n) | Aufrufer | Frisch | Limit | Fehler |
|---|---|---|---|---|
| `signUp.withPassword` | — | — | IP+Konto | `password_unacceptable`, `username_taken`, `username_invalid` |
| `signUp.withoutPassword` | — | — | IP+Konto | `username_taken`, `username_invalid` |
| `signIn.password` | — | — | IP+Konto | `invalid_credentials` (schließt Deaktivierung ein, L-4) |
| `signIn.passkey.start`, `signIn.oauth.start` | — | — | IP | `provider_not_configured` (nur oauth) |
| `signIn.passkey.finish` | — | — | IP | `webauthn_challenge_invalid`, `webauthn_credential_rejected` |
| `signIn.oauth.finish` | — | — | IP | `oauth_flow_invalid`, `oauth_provider_error`, `identity_already_linked` |
| `signIn.magicLink.request` | — | — | IP+Konto | — |
| `signIn.magicLink.redeem` | — | — | IP | `invalid_token` |
| `signOut`, `session.refresh`, `pending.cancel` | session/pending | — | IP | `session_required` (nur `refresh`) |
| `session.resolve`, `resolveFromHeaders`, `pending.resolve`, `pending.resolveFromHeaders` | — | — | **nein** | — (geben `null`; `session.*` wirft `account_disabled`, L-4) |
| `session.list`, `revoke`, `revokeAllOther`, `revokeAll` | session | **ja** | IP | `session_required`, `freshness_required` |
| `user.findById`, `findByEmail`, `findByUsername`, `disable`, `enable`, `delete`, `maintenance.sweep` | server | — | **nein** | — |
| `password.set` | session | **ja** | IP+Konto | `session_required`, `freshness_required`, `password_unacceptable`, `factor_already_enrolled` |
| `password.change` | session | **ja** | IP+Konto | `session_required`, `freshness_required`, `invalid_credentials`, `password_unacceptable` |
| `password.requestReset`, `email.requestVerification` | —/session | — | IP+Konto | `session_required` (nur `requestVerification`) |
| `password.redeemReset` | — | — | IP | `invalid_token`, `password_unacceptable` |
| `password.redeemResetWithRecoveryCode` | — | — | IP+Konto | `invalid_recovery_code`, `password_unacceptable` |
| `email.redeemVerification`, `email.redeemChange` | — | — | IP | `invalid_token` |
| `email.requestChange` | session | **ja** | IP+Konto | `session_required`, `freshness_required` |
| `username.isAvailable` | — | — | IP (eng) | — |
| `username.change` | session | **ja** | IP+Konto | `session_required`, `freshness_required`, `username_taken`, `username_invalid` |
| `factor.totp.enroll.start` | session | **ja** | IP | `session_required`, `freshness_required`, `factor_already_enrolled` |
| `factor.totp.enroll.finish`, `factor.totp.remove` | session | **ja** | IP+Konto | `session_required`, `freshness_required`, `invalid_factor_code`, `factor_not_enrolled` |
| `factor.totp.verify` | pending | — | IP+Konto | `invalid_pending_authentication`, `invalid_factor_code`, `too_many_factor_attempts` |
| `factor.webauthn.register.start` | session | **ja** | IP | `session_required`, `freshness_required` |
| `factor.webauthn.register.finish` | session | **ja** | IP | `session_required`, `freshness_required`, `webauthn_challenge_invalid`, `webauthn_credential_rejected` |
| `factor.webauthn.authenticate.start` | pending | — | IP | `invalid_pending_authentication`, `factor_not_enrolled` |
| `factor.webauthn.authenticate.finish` | pending | — | IP+Konto | `invalid_pending_authentication`, `webauthn_challenge_invalid`, `webauthn_credential_rejected`, `too_many_factor_attempts` |
| `factor.webauthn.list`, `rename`, `factor.recovery.remaining`, `identity.list` | session | — | IP | `session_required` |
| `factor.webauthn.remove`, `identity.unlink` | session | **ja** | IP | `session_required`, `freshness_required`, `last_sign_in_method` |
| `factor.recovery.generate` | session | **ja** | IP | `session_required`, `freshness_required` |
| `factor.recovery.verify` | pending | — | IP+Konto | `invalid_pending_authentication`, `invalid_recovery_code`, `too_many_factor_attempts` |
| `identity.linkOAuth.start` | session | **ja** | IP | `session_required`, `freshness_required`, `provider_not_configured` |

`session.resolve` und `pending.resolve` sind nicht ratenbegrenzt: Sie laufen bei jeder Anfrage
der Anwendung, ein Zähler darauf wäre eine Selbstblockade.

---

#### C) Rückgabetypen

```ts
type SessionToken = string & { readonly __brand: "SessionToken" }
type PendingToken = string & { readonly __brand: "PendingToken" }
type AuthenticationFactor = "password" | "totp" | "webauthn" | "recovery" | "oauth"

interface User {
  id: string; createdAt: Date; updatedAt: Date
  email: string | null; emailVerifiedAt: Date | null
  username: string | null                 // Anzeigeform, NFKC
  disabledAt: Date | null; hasPassword: boolean
  importedFrom: "supabase" | "clerk" | "auth0" | "firebase" | "nextauth" | null
}
interface Session {
  id: string; userId: string
  createdAt: Date; lastUsedAt: Date; idleExpiresAt: Date; absoluteExpiresAt: Date
  factors: readonly AuthenticationFactor[]
  ipAddress: string | null; userAgent: string | null
  isCurrent: boolean                      // nur in session.list gesetzt
}
interface Identity {
  id: string; provider: string; subject: string; createdAt: Date
  providerEmail: string | null; providerEmailVerified: boolean
  profile: unknown                        // rohe Claims; die Bibliothek liest sie nicht
  scopes: readonly string[]; tokenExpiresAt: Date | null
}
interface WebAuthnCredential {
  id: string; label: string; transports: readonly string[]; aaguid: string | null
  isBackupEligible: boolean               // true => synchronisierter Passkey
  isCurrentlyBackedUp: boolean; wasUserVerifiedAtRegistration: boolean
  createdAt: Date; lastUsedAt: Date | null
}
interface PendingAuthentication {
  factorsCompleted: readonly AuthenticationFactor[]
  availableFactors: readonly ("totp" | "webauthn" | "recovery")[]
  attemptsRemaining: number; expiresAt: Date
}
interface OAuthRedirect { authorizationUrl: string; stateCookie: CookieInstruction }
interface CookieInstruction { name: string; value: string; maximumAgeInSeconds: number
                              attributes: "HttpOnly; Secure; SameSite=Lax; Path=/" }
interface PasskeyAuthenticationChallenge  { publicKeyOptions: PublicKeyCredentialRequestOptionsJSON;  challengeToken: string }
interface WebAuthnAuthenticationChallenge { publicKeyOptions: PublicKeyCredentialRequestOptionsJSON;  challengeToken: string }
interface WebAuthnRegistrationChallenge   { publicKeyOptions: PublicKeyCredentialCreationOptionsJSON; challengeToken: string }

// JSON-Formen der WebAuthn-Spezifikation, wie @simplewebauthn/server sie definiert
type AuthenticatorAttestation = import("@simplewebauthn/server").RegistrationResponseJSON
type AuthenticatorAssertion   = import("@simplewebauthn/server").AuthenticationResponseJSON
type PublicKeyCredentialCreationOptionsJSON = import("@simplewebauthn/server").PublicKeyCredentialCreationOptionsJSON
type PublicKeyCredentialRequestOptionsJSON  = import("@simplewebauthn/server").PublicKeyCredentialRequestOptionsJSON
```

`username_key` erscheint nicht: Es ist die Vergleichsform. `hasPassword` leitet sich aus der
Existenz der Zeile in `password_credential` ab und ersetzt eine Methode `password.isSet`.
`Identity.profile` ist `unknown`, weil die Bibliothek diese Claims nicht liest und keine
Struktur versprechen darf, die der Anbieter morgen ändert. `isBackupEligible`/
`isCurrentlyBackedUp` heißen ausgeschrieben statt `be`/`bs` — sie sind die einzige Grundlage,
auf der eine Anwendung gerätegebundene von synchronisierten Passkeys unterscheidet.
`CookieInstruction` ist die einzige Stelle, an der Servermethoden Cookies erwähnen.

##### C.1 `SignInResult`

```ts
type SignInResult =
  | { status: "signed_in"
      sessionToken: SessionToken
      session: Session
      user: User
      signCountRegressed?: boolean }         // nur auf WebAuthn-Wegen
  | { status: "second_factor_required"
      pendingToken: PendingToken
      pending: PendingAuthentication }

type OAuthCallbackResult =
  | SignInResult
  | { status: "identity_linked"; identity: Identity; sessionToken: SessionToken; session: Session }
```

Im Zweig `second_factor_required` existiert **keine** `Session` und **kein** `sessionToken` —
nicht als `null`, nicht als optionales Feld, sondern als abwesende Eigenschaft. Wer
`result.sessionToken` ohne vorherige Prüfung von `result.status` liest, kompiliert nicht.

*Entwurf A* wäre ein flaches Objekt `{ session: Session | null; pending: … | null }` gewesen:
kürzer — und die Form, die das Vergleichssystem hat: Dort legt der Kennwort-Handler die
Sitzung an, der 2FA-Hook löscht sie danach wieder und setzt `newSession` auf `null`, mit dem
Hinweis, dass nachgelagerte Hooks das Feld prüfen müssen
(`packages/better-auth/src/plugins/two-factor/index.ts:525-535`). Ein `session`-Feld, das
manchmal gesetzt ist, wird irgendwann von irgendeinem Codepfad ungeprüft gelesen. *Entwurf B*
ist die diskriminierte Union. **Entscheidung: B.** Die Kosten sind ein `if` je Aufrufort; der
Nutzen ist, dass die gefährlichste Verwechslung der Bibliothek nicht kompiliert.
`signCountRegressed` ist optional, weil die Frage bei Kennwortanmeldung nicht gestellt wird —
`undefined` heißt „nicht zutreffend", nicht „nein". Im Verknüpfungsfall wird die Sitzung neu
vergeben, weil eine neue Identität die Vertrauensstufe ändert.

##### C.2 Was niemals nach außen geht

`token_sha256` (`session`, `one_time_token`, `pending_authentication`) — der Hash ist der
Verifier. `phc` und `scheme` (`password_credential`) — Offline-Angriff, und `scheme` verrät das
Herkunftssystem. `secret_enc`, `key_version` (`totp_credential`) — der Chiffretext ist im
Klartextfall der Faktor. `code_hmac` (`recovery_code`) — erlaubt Offline-Prüfung geratener
Codes gegen den Pepper. `challenge_sha256` (`webauthn_challenge`) — erlaubt Wiedereinspielung.
`pkce_verifier_enc`, `state_sha256`, `nonce` (`oauth_flow`) — der Verifier bricht PKCE.
`access_token_enc`, `refresh_token_enc`, `id_token_enc` (`identity`) — fremde Tokens, nur über
einen gesonderten Aufruf, nie als Feld von `Identity`. `credential_id`, `public_key`,
`sign_count` (`webauthn_credential`) — `credential_id` ist ein geräteübergreifender
Wiedererkennungswert, `sign_count` erscheint nur als `signCountRegressed`. `tokens`,
`bucket_key` (`rate_bucket`) — verrät Zählerstände fremder Konten.

Die Regel dahinter ist maschinell prüfbar: **Kein Typ der öffentlichen Oberfläche enthält ein
Feld vom Typ `Uint8Array` oder `Buffer`** — jede `bytea`-Spalte ist ein Verifier, ein
Chiffretext oder ein Schlüssel. Ein Typtest im Testlauf setzt das durch.

---

#### D) Die HTTP-Oberfläche

##### D.1 `defineRoute` — eine Deklaration, drei Erzeugnisse

```ts
type HttpMethod = "GET" | "POST"
type CallerRequirement    = "anonymous" | "session" | "pending" | "server_only"
type FreshnessRequirement = "not_required" | "required"
type OriginRequirement    = "checked" | "exempt"
interface RateLimitRule { perIpAddress: BucketRule | "none"; perAccount: BucketRule | "none" }
interface Validator<T>  { parse(raw: unknown): T }   // wirft VelveError("invalid_input")
interface RequestContext {
  readonly session: Session | null                   // gesetzt bei caller "session"
  readonly pending: PendingAuthentication | null     // gesetzt bei caller "pending"
  readonly ipAddress: string | null; readonly userAgent: string | null
  readonly plugin: FrozenContext                     // Teil G; für Kernrouten ohne ownTables
}
declare function toWebHandler(auth: VelveAuth<IdentityMode>): (request: Request) => Promise<Response>

interface RouteDefinition<Name extends string, Path extends string, Input, Output,
                          Code extends VelveErrorCode> {
  readonly name: Name                    // punktierter Pfad, z.B. "signIn.password"
  readonly method: HttpMethod; readonly path: Path
  readonly input: Validator<Input>; readonly errors: readonly Code[]
  readonly caller: CallerRequirement; readonly freshness: FreshnessRequirement
  readonly originCheck: OriginRequirement; readonly rateLimit: RateLimitRule
  readonly handler: (input: Input, context: RequestContext) => Promise<Output>
}
type AnyRoute = RouteDefinition<string, string, any, any, VelveErrorCode>

declare function defineRoute<Name extends string, Path extends string, Input, Output,
                             Code extends VelveErrorCode>(
  d: RouteDefinition<Name, Path, Input, Output, Code>
): RouteDefinition<Name, Path, Input, Output, Code>

type ServerMethodOf<R> = R extends RouteDefinition<any, any, infer I, infer O, any>
  ? (input: I) => Promise<O> : never
type ClientMethodOf<R> = R extends RouteDefinition<any, any, infer I, infer O, infer C>
  ? (input: I) => Promise<VelveResult<O, C>> : never

type Nest<Name extends string, Fn> =
  Name extends `${infer Head}.${infer Rest}` ? { [K in Head]: Nest<Rest, Fn> } : { [K in Name]: Fn }
type UnionToIntersection<U> =
  (U extends unknown ? (arg: U) => void : never) extends (arg: infer I) => void ? I : never

type ServerSurface<T extends readonly AnyRoute[]> =
  UnionToIntersection<{ [I in keyof T]: Nest<T[I]["name"], ServerMethodOf<T[I]>> }[number]>
type ClientSurface<T extends readonly AnyRoute[]> =
  UnionToIntersection<{ [I in keyof T]: Nest<T[I]["name"], ClientMethodOf<T[I]>> }[number]>
```

`errors` ist Pflicht. Der Handler darf ausschließlich die genannten Codes werfen; ein Testlauf
prüft das gegen den tatsächlichen Wurfkatalog. Damit ist die Fehlerliste einer Route ein
Vertrag statt eines Kommentars — und der Client kann sie exhaustiv behandeln. `object`,
`string` und die übrigen Konstruktoren für `Validator<T>` liegen in `core/http/`; sie sind
keine öffentliche Schnittstelle, weil Eingabeschemata nur in Routendeklarationen vorkommen.

##### D.2 Zwei Beispiele

```ts
const signInPasswordRoute = defineRoute({
  name: "signIn.password",
  method: "POST",
  path: "/sign-in/password",
  input: object({ emailOrUsername: string(), password: string() }),
  errors: ["invalid_credentials", "invalid_input", "rate_limited"] as const,
  caller: "anonymous",
  freshness: "not_required",
  originCheck: "checked",
  rateLimit: { perIpAddress: { capacity: 10, refillPerSecond: 0.1 }, perAccount: { capacity: 5, refillPerSecond: 0.01 } },
  handler: async (input, context): Promise<SignInResult> => { /* … */ },
})

const webauthnRegisterStartRoute = defineRoute({
  name: "factor.webauthn.register.start",
  method: "POST",
  path: "/factor/webauthn/register/start",
  input: object({}),
  errors: ["session_required", "freshness_required"] as const,
  caller: "session",
  freshness: "required",
  originCheck: "checked",
  rateLimit: { perIpAddress: { capacity: 20, refillPerSecond: 0.5 }, perAccount: "none" },
  handler: async (_input, context): Promise<WebAuthnRegistrationChallenge> => { /* … */ },
})
```

Aus der ersten Deklaration entsteht (a) der **Handler** für `POST /sign-in/password` mit fester
Reihenfolge davor — Origin-Prüfung, Ratenbegrenzung (der Schlüssel enthält `"signIn.password"`,
nicht den rohen Pfad: `//sign-in/password` und `/sign-in/password` sind derselbe Zähler),
`input.parse`, Aufrufer-Auflösung, Handler; (b) die **Servermethode**
`auth.signIn.password(input)` mit Rückgabe `Promise<SignInResult>`, deren Objektpfad `Nest` aus
dem punktierten `name` erzeugt; (c) der **Clienttyp** `client.signIn.password(input)` mit
Rückgabe `Promise<VelveResult<SignInResult, "invalid_credentials" | "invalid_input" |
"rate_limited">>` — auf drei Codes verengt, nicht auf die ganze Union. `account_disabled`
fehlt mit Absicht: Bei der Anmeldung ist ein deaktiviertes Konto von einem falschen Kennwort
nicht zu unterscheiden (L-4).

Die zweite Deklaration zeigt zwei Besonderheiten: Der vierstufige `name` erzeugt vier Ebenen,
und das Eingabeschema ist leer, weil der Aufrufer über das Cookie identifiziert wird. Die
Servermethode bekommt trotzdem ein `sessionToken`-Feld, das die HTTP-Schicht aus dem Cookie
einsetzt; `caller: "session"` erzeugt genau diese eine Differenz zwischen den Signaturen.

##### D.3 Die Routentabelle

| Methode | Pfad | Eingabe | Ausgabe | Status | Limit | Origin |
|---|---|---|---|---|---|---|
| POST | `/sign-up` | `IdentityFields & { password }` | `SignUpResult` | 200, 400, 409 | IP+Konto | ja |
| POST | `/sign-up/passwordless` | `IdentityFields` | `SignUpResult` | 200, 400, 409 | IP+Konto | ja |
| POST | `/sign-in/password` | `SignInLookup & { password }` | `SignInResult` | 200, 400, 401 | IP+Konto | ja |
| POST | `/sign-in/passkey/start` | — | `PasskeyAuthenticationChallenge` | 200 | IP | ja |
| POST | `/sign-in/passkey/finish` | `{ challengeToken, response }` | `SignInResult` | 200, 400, 401 | IP | ja |
| POST | `/sign-in/oauth/start` | `{ provider, redirectPath? }` | `OAuthRedirect` | 200, 400 | IP | ja |
| GET | `/sign-in/oauth/callback/:provider` | Query `{ code, state, iss? }` | 302 | 302, 400, 409, 502 | IP | **nein** |
| POST | `/sign-in/magic-link/request` | `{ email }` | — | 204, 400 | IP+Konto | ja |
| POST | `/sign-in/magic-link/redeem` | `{ token }` | `SignInResult` | 200, 400 | IP | ja |
| POST | `/sign-out` | — | — | 204 | IP | ja |
| GET | `/session` | — | `ResolvedSession \| null` | 200, 403 | nein | ja |
| GET | `/session/list` | — | `Session[]` | 200, 401, 403 | IP | ja |
| POST | `/session/revoke` | `{ targetSessionId }` | — | 204, 400, 401, 403 | IP | ja |
| POST | `/session/revoke-others` | — | `{ revokedCount }` | 200, 401, 403 | IP | ja |
| POST | `/session/revoke-all` | — | `{ revokedCount }` | 200, 401, 403 | IP | ja |
| POST | `/session/refresh` | — | `ResolvedSession \| null` | 200, 401 | IP | ja |
| POST | `/password/set` | `{ newPassword }` | `SetPasswordResult` | 200, 400, 401, 403, 409 | IP+Konto | ja |
| POST | `/password/change` | `{ currentPassword, newPassword }` | `SetPasswordResult` | 200, 400, 401, 403 | IP+Konto | ja |
| POST | `/password/request-reset` | `{ email }` | — | 204, 400 | IP+Konto | ja |
| POST | `/password/redeem-reset` | `{ token, newPassword }` | `SetPasswordResult` | 200, 400 | IP | ja |
| POST | `/password/redeem-reset-with-recovery-code` | `SignInLookup & { recoveryCode, newPassword }` | `SetPasswordResult` | 200, 400, 401 | IP+Konto | ja |
| POST | `/email/request-verification` | — | — | 204, 401 | IP+Konto | ja |
| POST | `/email/redeem-verification` | `{ token }` | `{ user }` | 200, 400 | IP | ja |
| POST | `/email/request-change` | `{ newEmail }` | — | 204, 400, 401, 403 | IP+Konto | ja |
| POST | `/email/redeem-change` | `{ token }` | `{ user }` | 200, 400 | IP | ja |
| GET | `/username/available` | Query `{ username }` | `{ available, reason? }` | 200, 400 | IP (eng) | ja |
| POST | `/username/change` | `{ newUsername }` | `{ user }` | 200, 400, 401, 403, 409 | IP+Konto | ja |
| POST | `/factor/totp/enroll/start` | — | `TotpEnrollment` | 200, 401, 403, 409 | IP | ja |
| POST | `/factor/totp/enroll/finish` | `{ code }` | — | 204, 401, 403, 409 | IP+Konto | ja |
| POST | `/factor/totp/verify` | `{ code }` | `SignInResult` | 200, 401, 429 | IP+Konto | ja |
| POST | `/factor/totp/remove` | `{ code }` | — | 204, 401, 403, 409 | IP+Konto | ja |
| POST | `/factor/webauthn/register/start` | — | `WebAuthnRegistrationChallenge` | 200, 401, 403 | IP | ja |
| POST | `/factor/webauthn/register/finish` | `{ challengeToken, response, label }` | `{ credential }` | 200, 400, 401, 403 | IP | ja |
| POST | `/factor/webauthn/authenticate/start` | — | `WebAuthnAuthenticationChallenge` | 200, 401, 409 | IP | ja |
| POST | `/factor/webauthn/authenticate/finish` | `{ challengeToken, response }` | `SignInResult` | 200, 400, 401, 429 | IP+Konto | ja |
| GET | `/factor/webauthn/list` | — | `WebAuthnCredential[]` | 200, 401 | IP | ja |
| POST | `/factor/webauthn/rename` | `{ credentialId, label }` | `{ credential }` | 200, 400, 401 | IP | ja |
| POST | `/factor/webauthn/remove` | `{ credentialId }` | — | 204, 401, 403, 409 | IP | ja |
| POST | `/factor/recovery/generate` | — | `{ codes }` | 200, 401, 403 | IP | ja |
| POST | `/factor/recovery/verify` | `{ code }` | `SignInResult` | 200, 401, 429 | IP+Konto | ja |
| GET | `/factor/recovery/remaining` | — | `{ remainingCount }` | 200, 401 | IP | ja |
| GET | `/identity/list` | — | `Identity[]` | 200, 401 | IP | ja |
| POST | `/identity/link/start` | `{ provider, redirectPath? }` | `OAuthRedirect` | 200, 400, 401, 403 | IP | ja |
| POST | `/identity/unlink` | `{ identityId }` | — | 204, 400, 401, 403, 409 | IP | ja |
| GET | `/pending` | — | `PendingAuthentication \| null` | 200 | nein | ja |
| POST | `/pending/cancel` | — | — | 204 | IP | ja |

Nicht aufgeführt, weil überall möglich: `429 rate_limited` bei jeder Route mit Limit (die
drei ausgewiesenen 429 sind `too_many_factor_attempts`), `403 origin_not_allowed` bei jeder
Route mit Origin-Prüfung, `403 account_disabled` bei jeder Route mit Aufrufer `session`
(L-4) und `500 internal_error`.

46 Routen im Modus `username_email`, 44 in `email` (ohne `/username/*`), 38 in `username`
(zusätzlich ohne Magic Link, Passwort-Reset per E-Mail und `/email/*`); die Zahlen gelten mit
konfiguriertem `webauthn`, ohne es fehlen die neun `webauthn`- und `passkey`-Routen. Die
Tabelle wird beim Erzeugen der Instanz nach Modus und Konfiguration gefiltert; eine Route, die es im gewählten Modus nicht
gibt, antwortet nicht mit 403, sondern existiert nicht und ergibt 404. `auth.user.*` und
`auth.maintenance.*` haben keine Routen (B.3). Jede Antwort trägt `Cache-Control: no-store`
und `Vary: Cookie`, gesetzt vom Handler (L-6).

Der OAuth-Callback ist die einzige Route ohne Origin-Prüfung: Er ist eine Rückleitung des
Anbieters per GET und hat systembedingt keinen `Origin`-Kopf; seine Absicherung ist der
serverseitige `state` in `velve.oauth_flow`, dessen Zeiger im Cookie liegt. Die vier Routen mit
`caller: "pending"` sind die aus 3.6; nur sie lesen `__Host-velve_pending`, jede andere Route
ignoriert es vollständig, und die Anzahl ist am Deklarationstyp ablesbar.

---

#### E) Der Client

```ts
declare function createVelveClient<Auth extends { routes: readonly AnyRoute[] }>(
  options: { baseURL: string; fetch?: typeof fetch }
): ClientSurface<Auth["routes"]>
```

```
defineRoute(…)                        eine Deklaration, Wert und Typ zugleich
   └─ const routes = [ … ] as const   Wert:  die Routentabelle
          └─ typeof routes            Typ:   readonly [Route1, Route2, …]
                 ├─ ServerSurface<typeof routes>   auth.signIn.password(…)
                 └─ ClientSurface<typeof routes>   client.signIn.password(…)
```

`typeof auth` trägt `routes` als erhaltenen Tupeltyp, weil die Tabelle `as const` deklariert
ist. `ClientSurface` läuft mit `Nest` über die `name`-Felder und setzt an jedes Blatt die
Signatur aus `Input`, `Output` und `Code` derselben Deklaration.

**Ohne Laufzeit-Proxy:** Die Routentabelle ist zur Laufzeit ein echtes Array.
`createVelveClient` iteriert es **einmal** beim Erzeugen und baut ein gewöhnliches
verschachteltes Objekt — es zerlegt `name` an den Punkten und setzt an jedes Blatt eine
Funktion, die `method` und `path` aus **derselben Zeile** liest. Kein `Proxy`, keine
Pfadzusammensetzung aus Eigenschaftsnamen, keine Kebab-Case-Umformung, keine Heuristik „Body
vorhanden, also POST". Ein Aufruf, der nicht in der Tabelle steht, existiert im Objekt nicht:
zur Kompilierzeit ein Typfehler, zur Laufzeit ein `TypeError`. Der Preis ist, dass der Client
die Tabelle als Wert importiert; `@velve/auth/client` liefert sie ohne Handler-Verweise, sodass
kein Serverkern im Browser landet.

```ts
type VelveResult<Value, Code extends VelveErrorCode> =
  | { ok: true;  value: Value }
  | { ok: false; error: { code: Code; message: string; retryAfterSeconds?: number } }

declare function unwrap<V, C extends VelveErrorCode>(result: VelveResult<V, C>): V
class VelveTransportError extends Error { readonly cause: unknown }
```

*Entwurf A:* Der Client wirft, wie der Server — symmetrisch. Aber ein geworfener Fehler kann
vergessen werden, und im Browser ist jeder Aufruf ein Vorgang, dessen Meldung der Nutzer sehen
muss; ein vergessenes `catch` ist eine Oberfläche, die nichts sagt. *Entwurf B:* ein
Ergebnisobjekt — der Compiler erzwingt die Prüfung von `ok`, bevor `value` lesbar ist, und
`error.code` ist auf die Codes **dieser** Route verengt, sodass ein `switch` exhaustiv geprüft
wird. **Entscheidung: B für den Client, Werfen für den Server; die Asymmetrie ist gewollt** —
serverseitig sitzt der Aufruf in einem Request-Handler mit zentraler Fehlerabbildung, wo ein
`throw` die Abbruchstelle direkt zur Antwort trägt, clientseitig ist jeder Aufrufort eine
Maske, die den Fehler selbst darstellen muss. Wer die Symmetrie will, ruft `unwrap(…)`.

Der Client **wirft** nur in zwei Fällen, die keinen Code haben können: Netzwerkfehler und
Antworten, die keine Velve-Fehlerhülle sind. Beide sind `VelveTransportError`, nicht
`VelveError` — „Der Server hat nein gesagt" gegen „Der Server hat nicht geantwortet".
`retryAfterSeconds` steht nur bei `rate_limited`.

---

#### F) Fehlertypen

```ts
type VelveErrorCode =
  | "invalid_input" | "origin_not_allowed" | "rate_limited"
  | "invalid_credentials" | "account_disabled"
  | "session_required" | "freshness_required"
  | "invalid_token" | "invalid_factor_code" | "invalid_recovery_code"
  | "invalid_pending_authentication" | "too_many_factor_attempts"
  | "password_unacceptable" | "username_taken" | "username_invalid"
  | "factor_not_enrolled" | "factor_already_enrolled" | "last_sign_in_method"
  | "identity_already_linked" | "provider_not_configured"
  | "oauth_flow_invalid" | "oauth_provider_error"
  | "webauthn_challenge_invalid" | "webauthn_credential_rejected"
  | "internal_error"

class VelveError extends Error {
  readonly code: VelveErrorCode
  readonly httpStatus: number
  readonly retryAfterSeconds?: number
}
```

25 Codes, stabil: Ein Code verschwindet nur im Hauptversionssprung, ein neuer kommt nur mit
einer neuen Route.

| Code | Wann | Status | Sichtbar |
|---|---|---|---|
| `invalid_input` | Eingabeschema abgelehnt, Feld fehlt, Format falsch | 400 | ja |
| `origin_not_allowed` | `Origin` fehlt oder steht nicht in `origins` | 403 | ja |
| `rate_limited` | Ein Eimer ist leer | 429 | ja |
| `invalid_credentials` | Kennwortprüfung fehlgeschlagen | 401 | ja, **verschmolzen** |
| `account_disabled` | `user.disabled_at` gesetzt, nur bei der Auflösung einer bestehenden Sitzung (L-4) | 403 | ja |
| `session_required` | Kein oder ungültiges Sitzungscookie | 401 | ja, **verschmolzen** |
| `freshness_required` | Sitzung älter als `freshnessWindow` | 403 | ja |
| `invalid_token` | Einmal-Artefakt nicht einlösbar | 400 | ja, **verschmolzen** |
| `invalid_factor_code` | TOTP-Code falsch oder wiederverwendet | 401 | ja, **verschmolzen** |
| `invalid_recovery_code` | Wiederherstellungscode nicht gefunden | 401 | ja, **verschmolzen** |
| `invalid_pending_authentication` | Zwischenzustand fehlt, abgelaufen, verbraucht | 401 | ja, **verschmolzen** |
| `too_many_factor_attempts` | `pending_authentication.attempts` überschritten | 429 | ja |
| `password_unacceptable` | Unter `minimumLength` oder über `maximumLengthInBytes` | 400 | ja |
| `username_taken` | `username_key` bereits vergeben | 409 | ja, **notwendig** |
| `username_invalid` | Zeichen, Länge oder Reservierung verletzt | 400 | ja |
| `factor_not_enrolled` | Faktor für diese Operation nicht eingerichtet | 409 | ja |
| `factor_already_enrolled` | Faktor bereits vorhanden | 409 | ja |
| `last_sign_in_method` | Trennen entfernte die letzte Anmeldemöglichkeit | 409 | ja |
| `identity_already_linked` | `(provider, subject)` gehört einem anderen Konto | 409 | ja |
| `provider_not_configured` | Anbieter steht nicht in `oauth.providers` | 400 | ja |
| `oauth_flow_invalid` | `state`, PKCE, `nonce` oder `iss` passen nicht | 400 | ja, **verschmolzen** |
| `oauth_provider_error` | Anbieter antwortet fehlerhaft oder gar nicht | 502 | ja |
| `webauthn_challenge_invalid` | Challenge unbekannt, abgelaufen, zweckfremd | 400 | ja, **verschmolzen** |
| `webauthn_credential_rejected` | Signatur, RP-ID, Ursprung oder Verifikation falsch | 401 | ja, **verschmolzen** |
| `internal_error` | Alles Übrige | 500 | ja, ohne Details |

##### F.1 Die absichtlich nicht unterscheidbaren Fälle

„Verschmolzen" heißt: mehrere innere Ursachen, ein äußerer Code, dieselbe Nachricht, derselbe
Status, derselbe Körper. Die Zuordnung liegt an genau einer Stelle, `core/http/error-map.ts`;
die inneren Codes werden ausschließlich protokolliert.

| Äußerer Code | Innere Ursachen |
|---|---|
| `invalid_credentials` | `user_not_found`, `password_mismatch`, `no_password_credential`, `legacy_scheme_rejected`, `user_disabled` |
| `session_required` | `cookie_absent`, `session_not_found`, `session_idle_expired`, `session_absolute_expired` |
| `invalid_token` | `token_not_found`, `token_expired`, `token_consumed`, `token_purpose_mismatch`, `email_taken_on_change`, `user_disabled` |
| `invalid_factor_code` | `totp_code_wrong`, `totp_step_replayed`, `totp_not_confirmed` |
| `invalid_recovery_code` | `recovery_code_not_found`, `recovery_codes_exhausted`, `recovery_codes_never_generated` |
| `invalid_pending_authentication` | `pending_not_found`, `pending_expired`, `pending_consumed`, `pending_cookie_absent` |
| `oauth_flow_invalid` | `state_not_found`, `state_expired`, `pkce_mismatch`, `nonce_mismatch`, `issuer_mismatch`, `id_token_signature_invalid`, `user_disabled` |
| `webauthn_challenge_invalid` | `challenge_not_found`, `challenge_expired`, `challenge_purpose_mismatch` |
| `webauthn_credential_rejected` | `credential_unknown`, `signature_invalid`, `rp_id_mismatch`, `origin_mismatch`, `user_not_verified`, `user_disabled` |

Sechs Operationen erzeugen **gar keinen** Fehler, obwohl innen etwas fehlschlug, weil ein
Fehler die Existenz verriete: `signUp.*` bei vergebener E-Mail (200 wie bei Erfolg, plus Mail
`sign_up_attempt_on_existing_account`), `password.requestReset` und `signIn.magicLink.request`
ohne passendes Konto (204; der Sende-Callback wird mit `request_for_unknown_address`
aufgerufen, L-1), `email.requestChange` bei fremder Zieladresse (204),
`session.revoke` bei fehlender oder fremder Zielsitzung (204) und `signOut` bei unbekanntem
Token (204). Die einzige Operation, die absichtlich Existenz preisgibt, ist
`username.isAvailable` — kein Fehler, sondern ein Rückgabewert (B.5).

---

#### G) Plugin-Typen

```ts
interface VelvePlugin<Id extends string = string> {
  readonly id: Id; readonly dependsOn?: readonly string[]
  readonly migrations?: readonly PluginMigration<Id>[]
  readonly routes?: readonly PluginRoute<Id>[]
  readonly hooks?: PluginHooks
  readonly errorCodes?: readonly `${Id}.${string}`[]
  readonly rateLimitRules?: Readonly<Record<`${Id}.${string}`, RateLimitRule>>
}
interface PluginMigration<Id extends string> {
  readonly version: number; readonly name: string; readonly sql: string
  readonly createsTables: readonly `${Id}_${string}`[]
}
type PluginRoute<Id extends string> =
  RouteDefinition<`${Id}.${string}`, `/x/${Id}/${string}`, any, any, VelveErrorCode>

interface PluginHooks {
  beforeSignIn?:        (event: SignInEvent,          context: FrozenContext) => Promise<void>
  afterSignIn?:         (event: SignInCompletedEvent, context: FrozenContext) => Promise<void>
  beforeSessionCreate?: (event: SessionCreateEvent,   context: FrozenContext) => Promise<void>
  afterSessionCreate?:  (event: SessionCreatedEvent,  context: FrozenContext) => Promise<void>
  beforeUserCreate?:    (event: UserCreateEvent,      context: FrozenContext) => Promise<void>
  afterUserCreate?:     (event: UserCreatedEvent,     context: FrozenContext) => Promise<void>
  beforeSessionRevoke?: (event: SessionRevokeEvent,   context: FrozenContext) => Promise<void>
}

interface SignInEvent {
  readonly method: "password" | "passkey" | "oauth" | "magic_link"
  readonly userId: string | null           // null, solange nicht aufgelöst
  readonly ipAddress: string | null; readonly userAgent: string | null
}
interface SignInCompletedEvent extends SignInEvent {
  readonly userId: string; readonly sessionId: string
  readonly factors: readonly AuthenticationFactor[]
  readonly signCountRegressed?: boolean
}
interface SessionCreateEvent  { readonly userId: string
                                readonly factors: readonly AuthenticationFactor[] }
interface SessionCreatedEvent extends SessionCreateEvent { readonly sessionId: string }
interface UserCreateEvent     { readonly email: string | null; readonly username: string | null }
interface UserCreatedEvent    extends UserCreateEvent { readonly userId: string }
interface SessionRevokeEvent  { readonly sessionId: string; readonly userId: string
                                readonly reason: RevokeReason }
type RevokeReason = "sign_out" | "revoked_by_user" | "password_changed"
  | "password_reset" | "identity_linked"

interface FrozenContext {
  readonly clock: Clock; readonly identityMode: IdentityMode; readonly schema: string
  readonly repositories: FrozenRepositories
  readonly ownTables: { query<Row>(sql: string, params: readonly unknown[]): Promise<Row[]> }
  log(level: "info" | "warn" | "error", message: string,
      fields?: Readonly<Record<string, unknown>>): void
}
interface FrozenRepositories {
  findUserById(input: { userId: string; actor: PluginActor }): Promise<User | null>
  listSessionsForUser(input: { userId: string; actor: PluginActor }): Promise<Session[]>
  revokeSession(input: { sessionId: string; reason: RevokeReason; actor: PluginActor }): Promise<void>
}
interface PluginActor { readonly pluginId: string; readonly reason: string }
```

Der Namensraum-Zwang ist ein Typ, keine Laufzeitprüfung: `name` beginnt mit `${Id}.`, `path`
mit `/x/${Id}/`, jede erzeugte Tabelle mit `${Id}_`, jeder Fehlercode mit `${Id}.`. Ein Plugin,
das eine Kernroute überschreiben will, kann den Deklarationstyp nicht erfüllen; die
Laufzeitprüfung beim Start bleibt für Plugins aus JavaScript, und ein Namenskonflikt ist dort
ein Startfehler, keine Warnung. `dependsOn` wird topologisch sortiert, ein Zyklus ist ein
Startfehler.

Sieben Hook-Punkte, genau die aus 3.11. Die Rückgabe ist überall
`Promise<void>` — das ist der Typ, der „Zuhörer mit Vetorecht" ausdrückt: Ein Hook kann
**ablehnen**, indem er wirft, und **beobachten**, indem er nichts tut; ersetzen kann er die
Antwort nicht, weil er keine zurückgeben kann. Ein Rückgabetyp `Promise<Event | void>` hätte
genau die Tür geöffnet, die 3.11 schließt. Alle Ereignisfelder sind `readonly`, und
kein Ereignis enthält ein Sitzungstoken, ein Klartextkennwort oder einen Hash.

`Object.freeze` friert den Kontext zur Laufzeit ein, `readonly` macht den Versuch zum Typfehler
— beides, weil das eine für TypeScript-Aufrufer und das andere für alle übrigen gilt.
`FrozenRepositories` enthält bewusst **keine** schreibenden Methoden auf `velve.user`,
`password_credential`, `totp_credential` oder `recovery_code`: Ein Plugin, das Kennwörter oder
Faktoren schreiben kann, ist Miteigentümer des Kerns. Jede Methode verlangt einen `actor` mit
`pluginId` und `reason`, beides Pflicht, beides protokolliert; `ownTables.query` ist auf
Tabellen mit dem Präfix `<pluginId>_` beschränkt. Vom Kontext führt kein Weg zum
Passwort-Verifier, zur Sitzungsauflösung oder zur Origin-Prüfung — sie sind nicht Teil des
Typs. Hooks laufen ausnahmslos **nach** Origin-Prüfung und Ratenbegrenzung, auch bei direkten
Servermethodenaufrufen.

##### G.1 Beispiel: Anmeldungen protokollieren

```ts
export function signInLogPlugin(): VelvePlugin<"sign_in_log"> {
  return {
    id: "sign_in_log",
    dependsOn: [],
    migrations: [{
      version: 1,
      name: "create_sign_in_log",
      createsTables: ["sign_in_log_entry"],
      sql: `CREATE TABLE sign_in_log_entry (
              id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
              user_id uuid NOT NULL REFERENCES velve.user(id) ON DELETE CASCADE,
              method text NOT NULL, factors text[] NOT NULL,
              ip_address inet, user_agent text,
              occurred_at timestamptz NOT NULL DEFAULT now());
            CREATE INDEX sign_in_log_entry_user_idx
              ON sign_in_log_entry (user_id, occurred_at DESC);`,
    }],
    hooks: {
      afterSignIn: async (event, context) => {
        await context.ownTables.query(
          `INSERT INTO sign_in_log_entry (user_id, method, factors, ip_address, user_agent)
           VALUES ($1, $2, $3, $4, $5)`,
          [event.userId, event.method, event.factors, event.ipAddress, event.userAgent],
        )
      },
    },
    routes: [
      defineRoute({
        name: "sign_in_log.listOwn",
        path: "/x/sign_in_log/list-own",
        method: "GET",
        input: object({}),
        errors: ["session_required"] as const,
        caller: "session",
        freshness: "not_required",
        originCheck: "checked",
        rateLimit: { perIpAddress: { capacity: 30, refillPerSecond: 1 }, perAccount: "none" },
        handler: async (_input, requestContext) =>
          requestContext.plugin.ownTables.query<SignInLogEntry>(
            `SELECT id, method, factors, ip_address, user_agent, occurred_at
               FROM sign_in_log_entry WHERE user_id = $1
               ORDER BY occurred_at DESC LIMIT 50`,
            [requestContext.session.userId],
          ),
      }),
    ],
  }
}
```

Die Route erbt die gesamte Ableitungskette: `auth.sign_in_log.listOwn()` als Servermethode,
`client.sign_in_log.listOwn()` als typisierter Clientaufruf, `GET /x/sign_in_log/list-own` als
HTTP-Route mit Origin-Prüfung und Ratenzähler davor. Ein Tabellenname ohne Präfix wäre ein
Typfehler in `createsTables`, ein Pfad ohne `/x/sign_in_log/` einer in `path`. Das Plugin
schreibt nur in die eigene Tabelle und hat keinen Zugriff auf Sitzungstoken oder Kennwörter.

### 3.16 Entschiedene Lücken

Die Ausarbeitung der Schnittstelle (3.15) und des Prüfplans (Abschnitt 6) hat dreizehn Stellen freigelegt, an denen die Abschnitte 3.1 bis 3.14 unvollständig waren. Sie werden hier entschieden; die Abschnitte davor sind daran angeglichen. Diese Entscheidungen sind Teil der Vorgabe, nicht Anhang.

**L-1 — Keine Antwort-Deadline, aber eine Wartegrenze.**
Erwogen war, jede Antwort im Anmeldepfad auf eine feste Mindestdauer zu strecken. Verworfen. Eine Deadline verdeckt genau den Fehler, den sie verhindern soll: Wird der Prüfpfad einmal ungleichförmig, fällt es nicht auf, solange beide Zweige unter der Schwelle bleiben — und über der Schwelle leckt sie wieder. Stattdessen gilt die härtere Regel: **jeder Endpunkt hat genau einen Codepfad, der unabhängig vom Ergebnis dieselbe Arbeit verrichtet.** Bei Kennwörtern heißt das ein KDF-Aufruf mit identischen Parametern, auch gegen einen Dummy. Bei Operationen ohne KDF — Reset anfordern, Bestätigung anfordern — heißt es dieselbe Folge von Abfragen und in jedem Fall ein Aufruf des Sende-Callbacks; ob eine Willkommens-, eine Reset- oder eine „hier existiert kein Konto"-Nachricht herausgeht, entscheidet sich innerhalb des Callbacks. Der Nachweis ist der statistische Test aus Abschnitt 6, nicht eine Zahl in der Konfiguration.

Davon zu trennen ist die **Wartegrenze** des Semaphors aus 3.3 (E-13): Wer nach **5 Sekunden** keinen Platz bekommen hat, wird mit `rate_limited` abgelehnt. Das ist eine Ressourcengrenze, keine Zeitangleichung — sie greift lastabhängig und für existierende wie nicht existierende Konten gleich.

**L-2 — Der PHC-String wird verschlüsselt gespeichert.**
Ein Pepper im klassischen Sinn ist nicht umsetzbar, ohne importierte Hashes zu brechen: Er müsste in die Ableitung eingehen, und fremde Hashes wurden ohne ihn erzeugt. Die Wirkung, um die es geht — ein gestohlener Datenbankauszug allein nützt nichts — wird stattdessen durch **Umschlagverschlüsselung der gesamten Spalte** erreicht.

```sql
ALTER TABLE velve.password_credential
  ADD COLUMN phc_enc     bytea,
  ADD COLUMN key_version integer NOT NULL DEFAULT 1;
-- Der Migrationsläufer verschlüsselt jede Zeile in die neue Spalte, bevor die alte
-- fällt. Ein reines Umtypisieren würde Klartext-Bytes schreiben.
ALTER TABLE velve.password_credential
  DROP COLUMN phc,
  ALTER COLUMN phc_enc SET NOT NULL;
ALTER TABLE velve.password_credential RENAME COLUMN phc_enc TO phc;
```

`phc` hält AES-256-GCM über den kanonischen PHC-String, Schlüsselzweck `password-enc` (der sechste Zweck in 3.8). `scheme` bleibt Klartext, damit sich der Bestand ohne Entschlüsselung auswerten lässt. Das wirkt für erzeugte **und** importierte Hashes gleichermaßen, ist rotierbar, und die Rotation läuft auf demselben Weg wie der Rehash (3.3, Schritt 6): nach erfolgreicher Anmeldung, per Vergleich-und-Tausch, still.

Der Preis wird benannt: **Verlust des Schlüssels bedeutet Verlust aller Kennwörter.** Das ist dieselbe Risikoklasse wie ein Pepper und gehört an die erste Stelle der Betriebsdokumentation.

**L-3 — Wiederherstellungscodes tragen eine Schlüsselversion.**
`velve.recovery_code` bekommt `key_version integer NOT NULL`. Ohne sie hätte eine Rotation von `token-pepper` sämtliche Wiederherstellungscodes entwertet — in der Konfiguration `username` also den einzigen verbleibenden Weg zurück ins Konto.

**L-4 — „Konto deaktiviert" ist bei der Anmeldung unsichtbar.**
Eine Anmeldung mit korrektem Kennwort auf einem deaktivierten Konto liefert dieselbe Antwort wie eine mit falschem Kennwort. Sonst ist die Deaktivierung ein Aufzählungsorakel, und zwar ein besonders wertvolles. `account_disabled` erscheint ausschließlich bei der Auflösung einer bestehenden Sitzung — dort hat der Aufrufer bereits bewiesen, dass ihm das Konto gehört.

**L-5 — Der kontobezogene Zähler wird auf dem Bezeichner gebildet, nicht auf der Konto-ID.**
Schlüssel ist `HMAC(token-pepper, normalisierter_bezeichner)`. Damit greift die Begrenzung **vor** der Auflösung des Nutzers, existierende und nicht existierende Konten laufen durch dieselbe Zeile, und der Bezeichner steht nicht im Klartext in der Tabelle. Überschreitung führt zu einer **Ablehnung**, nicht zu einer Verzögerung: Eine Verzögerung wäre ein Zeitkanal und stünde im Widerspruch zur Gleichförmigkeitsregel aus L-1.

**L-6 — Jede Antwort trägt `Cache-Control: no-store` und `Vary: Cookie`.**
Gesetzt vom Handler, nicht von der Anwendung. Ein vorgelagertes CDN, von dem die Bibliothek nichts weiß, ist der Normalfall und nicht die Ausnahme.

**L-7 — Kennwortpolitik: Mindestlänge 8, Höchstlänge 4096 Byte, keine Zusammensetzungsregeln.**
Das folgt NIST SP 800-63B. Keine erzwungene Rotation, keine Zeichenklassen, keine Kennworthistorie im Kern.
Ein Abgleich gegen Leak-Korpora gehört **nicht** in den Kern: er braucht einen Netzzugriff (SCHÄTZUNG: den Caprock möglicherweise nicht gewährt), und er ist eine Richtlinienentscheidung. Stattdessen gibt es genau einen Einhängepunkt in `PasswordConfig` (3.15 A.4):

```ts
password.validate?: (plaintext: string) => Promise<void>
```

Er wird beim Setzen und Ändern aufgerufen, **niemals bei der Anmeldung**. Damit erreicht das Klartextkennwort keinen fremden Code auf dem heißen Pfad, und wer eine Kompromissprüfung will, hängt sie dort ein.

**L-8 — Höchstens fünf Versuche je Zwischenzustand.**
`pending_authentication.attempts` läuft gegen 5. Danach wird die Zeile gelöscht und der Vorgang beginnt beim Kennwort von vorn. Kein Kontosperren.

**L-9 — Ein rückläufiger `sign_count` wird gemeldet, nicht abgelehnt.**
Das ist eine bewusste Abweichung von WebAuthn Level 3 §7.2 und wird dokumentiert. Synchronisierte Passkeys führen den Zähler nicht verlässlich; eine Ablehnung würde legitime Nutzer aussperren. Der Befund erreicht die Anwendung als Feld `signCountRegressed` im Anmeldeergebnis, die dort entscheidet.

**L-10 — Sitzungsmetadaten werden standardmäßig gekürzt.**
`sessionMetadata: "truncated" | "full" | "none"`, Vorgabe `truncated`: IPv4 auf `/24`, IPv6 auf `/64` — bei IPv6 dieselbe Präfixlänge wie in der Ratenbegrenzung nach 3.9 —, User-Agent auf Browser- und Systemfamilie. Das ist Datenminimierung nach Art. 5 Abs. 1 lit. c DSGVO als Vorgabewert statt als Konfigurationsaufgabe. Wer den vollen Wert braucht, schaltet ihn ausdrücklich ein.

**L-11 — Aufräumen ist eine benannte Operation, kein Hintergrund-Zeitgeber.**
`auth.maintenance.sweep()` (3.15 B) löscht abgelaufene Zeilen aus `session`, `one_time_token`, `pending_authentication`, `webauthn_challenge`, `oauth_flow`, `totp_used_step` und `rate_bucket`. Zusätzlich wird das äquivalente SQL über `@velve/auth/schema` ausgeliefert, damit es aus `pg_cron` oder einem eigenen Zeitplan laufen kann. Kein `setInterval` im Kern — der überlebt keine serverlose Ausführung und täuscht Betrieb vor, wo keiner stattfindet. Aufbewahrung: `totp_used_step` zwei Minuten über das Fenster hinaus, `rate_bucket` eine Stunde über den Ablauf hinaus, alles andere sofort.

**L-12 — Ein Vorabkonto verliert sein Kennwort, wenn jemand anders die Adresse bestätigt.**
Das ist die Lücke mit unmittelbarer Angriffsfolge, und sie ist dieselbe, an der Better Auth zweimal gescheitert ist (CVE-2026-53516; GHSA-qq9h-g4jm-xgf3, offen von 1.1.3 bis 1.6.21).

Der Angriff: Ein Angreifer registriert `opfer@example.com` mit einem Kennwort, das er kennt. Bestätigen kann er die Adresse nicht. Später meldet sich das Opfer über einen Magic Link an — es beweist damit Kontrolle über das Postfach, und das Konto gilt als bestätigt. Das vom Angreifer gesetzte Kennwort bleibt jedoch gültig.

Die Regel: **Wird eine E-Mail-Adresse erstmals bestätigt, und wurde das vorhandene Kennwort in einer anderen Sitzung gesetzt als der, die jetzt bestätigt, dann wird die Kennwortanmeldung gelöscht und jede bestehende Sitzung widerrufen.** Der rechtmäßige Inhaber setzt danach ein Kennwort. Es geht nichts verloren außer einem Zugang, den nie jemand nachgewiesen hat.

**L-13 — Der letzte Anmeldeweg darf nicht entfernt werden.**
Ein Nutzer behält immer mindestens eines aus {Kennwort, WebAuthn-Anmeldedaten, verknüpfte Identität}. Der Versuch, das letzte zu entfernen, wird mit `last_sign_in_method` abgelehnt. Für zweite Faktoren gilt dasselbe nur dann, wenn die Konfiguration einen zweiten Faktor verlangt.

### 3.17 Die daraus folgenden Schemaänderungen

Zusammengeführt mit den Ergänzungen aus dem Migrationsmodul (Abschnitt 4) ergibt sich gegenüber dem Schema in 3.2 die folgende Differenz. Die ausgelieferte Migration Nr. 1 legt alle Tabellen unmittelbar in der Endform an; die `ALTER`-Anweisungen zeigen die Differenz und sind der Weg für eine Datenbank, die bereits in der Form aus 3.2 befüllt wurde.

```sql
-- L-2: die vier Anweisungen aus 3.16 (neue Spalte, umschlüsseln, alte Spalte fallen lassen,
-- umbenennen). Ergebnis in velve.password_credential:
--   phc          bytea   NOT NULL             -- AES-256-GCM über den kanonischen PHC-String
--   key_version  integer NOT NULL DEFAULT 1

-- L-3
ALTER TABLE velve.recovery_code
  ADD COLUMN key_version integer NOT NULL DEFAULT 1;

-- aus Abschnitt 4.0.3: Idempotenz des Imports
CREATE TABLE velve.import_mapping (
  source      text NOT NULL,   -- 'supabase'|'clerk'|'auth0'|'firebase'|'nextauth'
  source_id   text NOT NULL,   -- Quell-Primärschlüssel, unverändert
  user_id     uuid NOT NULL REFERENCES velve.user(id) ON DELETE CASCADE,
  run_id      uuid NOT NULL,   -- welcher Lauf hat die Zeile angelegt
  imported_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (source, source_id)
);
CREATE INDEX import_mapping_user_idx ON velve.import_mapping (user_id);
CREATE INDEX import_mapping_run_idx  ON velve.import_mapping (run_id);

-- aus Abschnitt 4.0.5: nicht verifizierbare Alt-Hashes
CREATE TABLE velve.password_reset_required (
  user_id    uuid PRIMARY KEY REFERENCES velve.user(id) ON DELETE CASCADE,
  reason     text NOT NULL,   -- 'unsupported_scheme'|'hash_not_exported'
                              -- |'missing_parameters'|'malformed'|'no_password_in_source'
  source     text NOT NULL,
  detail     text,            -- z. B. 'clerk:phpass', 'auth0:md5'
  created_at timestamptz NOT NULL DEFAULT now()
);
```

Damit umfasst das Schema **sechzehn Tabellen**. Zum Vergleich: Better Auth kommt im Kern mit vier aus — `user`, `session`, `account`, `verification`, dazu `rateLimit` nur bei Datenbank-Ratenbegrenzung (`packages/core/src/db/get-tables.ts:59-61`) — und verteilt den Rest auf Plugins. Der Unterschied ist keine Aufblähung, sondern Explizitheit — Zwischenzustände, Einmal-Artefakte und Herausforderungen, die dort in Cookies, JWTs oder der generischen `verification`-Tabelle stecken, haben hier eine eigene Zeile mit eigener Frist und eigenem Konsum.

---

## 4. Migrationsmodul

Das Migrationsmodul liegt im Subpfad `@velve/auth/import` (Abschnitt 3.1). Nur dort dürfen schwere Abhängigkeiten stehen — CSV-Parser, PGP-Entschlüsselung, Quelltreiber. Der Kern kennt das Modul nicht; er kennt nur das Ergebnis: Zeilen im Schema `velve` und kanonische PHC-Strings nach Abschnitt 3.3. Der Importer erzeugt den PHC-String, schreibt ihn aber nie selbst in `velve.password_credential.phc`: Die Spalte hält nach L-2 (Abschnitt 3.16) den AES-256-GCM-verschlüsselten String unter dem Schlüsselzweck `password-enc`, und der Importer benutzt dafür denselben Verschlüsselungspfad wie der Kern beim Registrieren; `key_version` ist die aktuelle Version dieses Schlüssels. Dasselbe gilt für `velve.recovery_code.key_version` (L-3), sollte ein projektspezifischer Hook Wiederherstellungscodes liefern — keine der fünf Quellen tut das.

Grundhaltung: Eine Migration ist kein Skript, sondern ein Verfahren mit Vorprüfung, Trockenlauf, Wiederholbarkeit und einem Verlustbericht. Alles, was nicht mitkommt, wird benannt.

Für alle fünf Quellen gleich, deshalb in den Einzelabschnitten nur als Tabellenzeile geführt und nicht erneut begründet: E-Mail-Adressen werden getrimmt, NFKC-normalisiert und kleingeschrieben, Benutzernamen in Anzeige- und Vergleichsform getrennt (Abschnitt 3.4); `imported_from` und `imported_at` werden gesetzt; aktive Sitzungen, Sitzungs-Token und Einmal-Artefakte der Quelle werden verworfen, weil Abschnitte 3.5 und 3.7 eigene vergeben — jede Migration erzwingt eine Neuanmeldung aller Nutzer.

---

### 4.0 Entwurf des Migrationsmoduls

#### 4.0.1 Die Schnittstelle

Ein Importer ist vier Dinge: eine Vorprüfung, ein Leser, eine reine Abbildung, ein Beweis. Die Abbildung ist bewusst **rein** — kein I/O, kein Zufall. Nur so führt der Trockenlauf denselben Code aus wie der Schreiblauf.

```ts
type SourceName = 'supabase' | 'clerk' | 'auth0' | 'firebase' | 'nextauth'
type Scheme = 'argon2id' | 'argon2i' | 'argon2d' | 'bcrypt' | 'scrypt'
            | 'pbkdf2-sha256' | 'pbkdf2-sha512' | 'fbscrypt'

type PasswordOutcome =
  | { readonly kind: 'none' }                                    // Quelle hat keins
  | { readonly kind: 'phc'; readonly phc: string; readonly scheme: Scheme }
  | { readonly kind: 'unusable'; readonly sourceScheme: string
      readonly reason: 'unsupported_scheme' | 'hash_not_exported'
                     | 'missing_parameters' | 'malformed' | 'no_password_in_source' }

/** Der einzige Datentyp, den der Schreiber kennt. Quellneutral. */
interface VelveRecord {
  readonly sourceId: string                    // Schlüssel für Idempotenz (Abschnitt 4.0.3)
  readonly user: {
    readonly id?: string                       // nur, wenn die Quell-ID eine UUID ist (Abschnitt 4.0.7)
    readonly email: string | null              // bereits trim + NFKC + lower
    readonly emailVerifiedAt: Date | null
    readonly username: string | null           // Anzeigeform (NFKC)
    readonly usernameKey: string | null        // NFKC + casefold
    readonly disabledAt: Date | null
    readonly createdAt: Date | null; readonly updatedAt: Date | null
  }
  readonly password: PasswordOutcome
  readonly identities: ReadonlyArray<{
    readonly provider: string                  // Velve-Anbietername, nicht der Quellname
    readonly subject: string                   // stabile Anbieter-ID, nie die E-Mail
    readonly providerEmail: string | null
    readonly providerEmailVerified: boolean
    readonly profile: unknown | null           // rohe Claims
    readonly scopes: readonly string[] | null
    readonly tokens: { access?: string; refresh?: string; id?: string; expiresAt?: Date } | null
  }>
  readonly totp: { secret: string; confirmedAt: Date | null } | null   // Base32-Klartext
  readonly recoveryCodes: readonly string[] | null                     // Klartext
  readonly webauthn: ReadonlyArray<{
    readonly credentialId: Uint8Array; readonly publicKey: Uint8Array
    readonly signCount: bigint; readonly transports: readonly string[] | null
    readonly aaguid: string | null
    readonly backupEligible: boolean; readonly backupState: boolean
    readonly userVerifiedAtRegistration: boolean; readonly label: string | null
  }>
  readonly warnings: readonly Warning[]
}

interface Importer<Config, Raw> {
  readonly source: SourceName
  /** Verbindung/Datei prüfen, Schema-Drift und fehlende Pflichtparameter melden. Schreibt nie. */
  probe(config: Config): Promise<{ reachable: boolean; estimatedRecords: number | null
                                   missingRequiredConfig: readonly string[]
                                   schemaWarnings: readonly string[] }>
  /** Streamt die Quelle; abbrechbar und ab einem Cursor fortsetzbar. */
  read(config: Config, from?: Cursor): AsyncIterable<Raw>
  /** Rein. Kein I/O. Deterministisch. */
  map(record: Raw): VelveRecord | MappingError
  /** Der Beweis: ein Datensatz mit bekanntem Kennwort wird gegen den erzeugten
   *  PHC-String geprüft. Ohne bestandenes verify() kein Schreiblauf. */
  verify(config: Config, sample: { sourceId: string; plaintextPassword: string }):
    Promise<{ ok: true; scheme: Scheme } | { ok: false; reason: string }>
}
```

`read` steht zusätzlich zur Vorgabe in der Schnittstelle: Ohne streamenden Leser lässt sich kein Millionenbestand verarbeiten, und die Trennung „Leser liefert `Raw`, Mapper ist rein" ist die Voraussetzung für einen aussagekräftigen Trockenlauf. `verify()` ist die Antwort auf einen belegten Fehlermodus: Bei Firebase sind `rounds` und `mem_cost` leicht zu vertauschen, und ein vertauschtes Paar erzeugt **keinen Fehler**, sondern nur Hashes, die nie passen (Befundbericht `findings/05-migrationsquellen.md`, Abschnitte 4.3 und 8). Der Fehler wird sonst erst nach der Umstellung sichtbar. Der PHC-String aus `map()` ist Klartext im Speicher des Importers; die Verschlüsselung nach L-2 geschieht erst im Schreiber, an derselben Stelle wie im Kern.

#### 4.0.2 Trockenlauf, verpflichtend

`plan()` läuft ohne Schreibzugriff; der Treiber wird in einen Wrapper gehüllt, der alles außer `SELECT` ablehnt. Ergebnis ist ein Bericht:

```ts
interface DryRunReport {
  source: SourceName; readAt: Date
  records:   { total: number; mapped: number; rejected: number }
  passwords: { byScheme: Record<Scheme, number>          // was verifizierbar landet
               unusableByReason: Record<string, number>  // Reset-Pfad, Abschnitt 4.0.5
               none: number }                            // OAuth-only, Phone-only, anonym
  collisions: { emailWithinSource:        Array<{ email: string; sourceIds: string[] }>
                emailAgainstExisting:     Array<{ email: string; sourceId: string; userId: string }>
                usernameKeyWithinSource:  Array<{ usernameKey: string; sourceIds: string[] }>
                usernameKeyAgainstExisting: Array<{ usernameKey: string; sourceId: string }>
                subjectAlreadyLinked:     Array<{ provider: string; subject: string }> }
  identityConstraint: { configured: 'email'|'username'|'username_email'; violating: number }
  usernamePolicy: { rejectedByAllowlist: number }
  factors:    { totp: number; totpDropped: number; recoveryCodes: number
                webauthn: number; webauthnDroppedNoFlags: number }
  identities: { total: number; byProvider: Record<string, number>; withTokens: number }
  unrecoverable: number    // kein Kennwort, keine E-Mail, keine Wiederherstellungscodes
}
```

Drei Zahlen verweigern den Schreiblauf, solange sie nicht ausdrücklich quittiert sind: `collisions.emailWithinSource` (Abschnitt 4.0.6), `identityConstraint.violating` (die gewählte Konfiguration aus Abschnitt 3.4 passt nicht zum Bestand — etwa `identity: "email"` bei anonymen Supabase-Nutzern ohne E-Mail) und `unrecoverable` (Nutzer ohne jeden Weg zurück ins Konto). Der Bericht wird als JSON und als Klartexttabelle geschrieben; er ist die Grundlage der Nutzerkommunikation vor der Umstellung, nicht nur ein Protokoll.

#### 4.0.3 Idempotenz

**Entscheidung: eine Zuordnungstabelle `velve.import_mapping` **plus** `ON CONFLICT DO NOTHING` auf jeder Zieltabelle. Beides, nicht eines von beiden.**

`imported_from` allein reicht nicht: Die Spalte hält nur einen Quellennamen (Abschnitt 3.2), keine Quell-ID; ein zweiter Lauf könnte nicht entscheiden, ob *dieser* Datensatz schon da ist. Die Quell-ID kann auch nicht einfach `velve.user.id` werden, denn bei drei von fünf Quellen ist sie keine UUID — Clerk `user_2abc…`, Auth0 `auth0|abc123`, Firebase `OzDdXA7LwoR7lX2MH7AXaEmmn5u2`. Und `ON CONFLICT DO NOTHING` allein reicht ebenfalls nicht: Der natürliche Konflikt wäre die E-Mail, die in Abschnitt 3.2 aber nullable und nur per partiellem Unique-Index eindeutig ist — für Nutzer ohne E-Mail gibt es gar keinen Konflikt, und ein zweiter Lauf dupliziert sie.

Die Tabelle — Primärschlüssel `(source, source_id)`, `user_id` mit `ON DELETE CASCADE`, `run_id` je Lauf, Indizes auf `user_id` und `run_id` — steht als DDL in Abschnitt 3.17.

Warum ins Kernschema und nicht in eine Plugin-Tabelle: Sie wird vom Kern-Schemaläufer versioniert (`velve.schema_migration`), sie referenziert `velve.user(id)` mit `ON DELETE CASCADE`, und sie überlebt den Import — sie ist der einzige Ort, an dem später noch beantwortbar ist, welcher Velve-Nutzer welcher Quell-ID entspricht (Nachzüglerläufe, Support-Rückfragen, Umhängen von Anwendungs-Fremdschlüsseln). Ein Plugin-Präfix `<plugin-id>_` (Abschnitt 3.11) wäre falsch, weil kein Plugin beteiligt ist.

| Tabelle | Konfliktziel | Verhalten | Warum |
|---|---|---|---|
| `velve.import_mapping` | `(source, source_id)` PK | `DO NOTHING` | Wiedereintritt nach Abbruch |
| `velve.password_credential` | `(user_id)` PK | `DO NOTHING` | Ein Kennwort, das der Nutzer geändert oder das der Rehash (Abschnitt 3.3, Schritt 6) ersetzt hat, darf ein zweiter Lauf **nie** überschreiben. Geschrieben werden `phc` verschlüsselt unter `password-enc` und `key_version` (L-2) |
| `velve.identity` | `(provider, subject)` | `DO NOTHING` | Verknüpfungsregel Abschnitt 3.10 |
| `velve.totp_credential` | `(user_id)` PK | `DO NOTHING` | ein neu eingerichteter Faktor gewinnt gegen den importierten |
| `velve.recovery_code` | `(user_id, code_hmac)` PK | `DO NOTHING` | von sich aus idempotent; `key_version` = aktuelle Version von `token-pepper` (L-3) |
| `velve.webauthn_credential` | `(credential_id)` | `DO NOTHING` | Credential-ID ist global eindeutig |

`DO NOTHING` statt `DO UPDATE` ist überall die Entscheidung: Ein Import ist eine **Erstbefüllung**, keine Synchronisation. Die Quelle darf nach der Umstellung nichts überschreiben, was in Velve Auth passiert ist.

#### 4.0.4 Transaktionsgrenzen und Stapelgröße

Zwei Durchgänge. **Durchgang 1** schreibt `velve.user` + `velve.import_mapping` — zwingend in *derselben* Transaktion, sonst gibt es nach einem Abbruch Nutzer ohne Zuordnung und der Wiederholungslauf dupliziert sie. **Durchgang 2** schreibt `password_credential`, `identity`, `totp_credential`, `recovery_code`, `webauthn_credential` und löst Quell-IDs über die Zuordnungstabelle auf; er ist für sich allein wiederholbar, was das Nachziehen einzelner Aspekte (nachgelieferte Auth0-Hashes) ohne Neuanlage der Nutzer erlaubt.

**Stapelgröße 1000 Datensätze pro Transaktion** (SCHÄTZUNG: Optimum je nach Netzlatenz 500–5000; konfigurierbar). Ein Stapel ist ein Mehrzeilen-`INSERT` über `unnest` — ein Round-Trip, ein Plan:

```sql
INSERT INTO velve.user (id, email, email_verified_at, username, username_key,
                        disabled_at, imported_from, imported_at, created_at)
SELECT * FROM unnest($1::uuid[], $2::text[], $3::timestamptz[], $4::text[], $5::text[],
                     $6::timestamptz[], $7::text[], $8::timestamptz[], $9::timestamptz[])
ON CONFLICT DO NOTHING RETURNING id;
```

Keine einzelne große Transaktion über Millionen Zeilen, aus vier Gründen: kein Fortsetzen nach Abbruch (ein Fehler bei Datensatz 900.000 wirft alles weg); der Snapshot blockiert `VACUUM` über die gesamte Laufzeit; WAL, Locks und Replikationsverzögerung wachsen unbegrenzt; `idle_in_transaction_session_timeout` und Verbindungspooler im Transaction-Mode (auf Supabase der Normalfall) beenden lange Transaktionen. Der Läufer merkt sich stattdessen den Cursor der Quellsortierung (`created_at, id`; bei Auth.js, dessen Referenzschemata kein `createdAt` führen, nur `id`) und setzt dort auf; die Zuordnungstabelle fängt die Überlappung ab.

Durchgang 2 schreibt `password_credential` nicht über `unnest` mit Klartext-PHC, sondern über dieselbe Repository-Methode, die auch die Registrierung benutzt: Sie verschlüsselt den PHC-String unter `password-enc` und setzt `key_version` (L-2). Der Importer hat keinen eigenen Schreibpfad in diese Spalte.

**Indizes bleiben stehen.** Das Fallenlassen und Neuanlegen der partiellen Unique-Indizes auf `email` und `username_key` wäre schneller, würde aber genau den Schutz abschalten, den der Import braucht: Kollisionen sollen *während* des Laufs auffallen. Und: Gibt ein Stapel weniger Zeilen zurück, als er eingefügt hat, hat `DO NOTHING` zugeschlagen — der Läufer fragt dann die Differenz gezielt ab und schreibt jede verlorene Quell-ID mit Grund in den Bericht. Ein `DO NOTHING`, das niemand zählt, ist ein Datenverlust ohne Zeugen.

SCHÄTZUNG: 1 Mio. Nutzer, 1000er-Stapel, 15–40 ms je Transaktion ergeben 15–40 s reine Schreibzeit für Durchgang 1. Der Engpass ist in allen fünf Fällen die Quellseite — Auth0s Ratenbegrenzung, Clerks Paginierung, Firebases Dateigröße —, nicht PostgreSQL.

#### 4.0.5 Umgang mit nicht verifizierbaren Hashes

Drei Sorten Nutzer haben keinen brauchbaren Hash: solche ohne Kennwort in der Quelle (OAuth-only, Phone-only, anonym, `is_sso_user`), solche, deren Hash nicht herausgegeben wird (Auth0 im Free-Tier), und solche mit einem Verfahren, das Velve Auth nicht in die Weiche aus Abschnitt 3.3 aufnimmt (md5, sha1, phpass …). Für alle drei gilt: **es wird keine Zeile in `velve.password_credential` geschrieben.** Ein Platzhalter-PHC wäre ein falscher Wert im kanonischen Feld und würde eine neue Präfixzeile in der Weiche erzwingen.

Stattdessen wird der Nutzer in `velve.password_reset_required` markiert — eine Zeile je Nutzer mit `reason` (`unsupported_scheme`, `hash_not_exported`, `missing_parameters`, `malformed`, `no_password_in_source`), `source` und `detail`; die DDL steht in Abschnitt 3.17.

Der Anmeldeweg, ohne neuen Aufzählungskanal: (1) Eingabelänge prüfen (Abschnitt 3.3, Schritt 1). (2) Nutzer auflösen; kein `password_credential` gefunden → **derselbe Codepfad wie bei einem unbekannten Nutzer**, also Prüfung gegen den Dummy-PHC mit den konfigurierten Standardparametern (Abschnitt 3.3, Schritt 2): gleiche Rechenzeit, gleicher Speicher, gleicher Semaphor. (3) Antwort ist die einheitliche Fehlantwort aus Abschnitt 3.13 — gleicher Status, gleiche Kopfzeilen, gleicher Körper; **kein Feld, kein Fehlercode und kein Zeitunterschied verrät die Markierung**. (4) *Nach* dem Senden der Antwort, in derselben begrenzten Hintergrundaufgabe, die auch den Rehash trägt (Abschnitt 3.3, Schritt 6): Existiert eine Zeile in `password_reset_required` und hat der Nutzer eine bestätigte E-Mail, wird ein `one_time_token` mit `purpose = 'password_reset'` erzeugt (1 h, Abschnitt 3.7) und die Reset-Mail versendet, mit einem Text, der die Migration erklärt. (5) Höchstens eine solche Mail pro Nutzer und Stunde, über denselben Token-Bucket wie der reguläre Reset (Abschnitt 3.9). (6) Setzt der Nutzer das Kennwort, löscht dieselbe Transaktion die Markierung und schreibt `password_credential`.

Das ist exakt das Muster aus Abschnitt 3.13: *„Der Unterschied wandert ausschließlich in die versendete E-Mail."* Der Angreifer sieht nichts; der Kontoinhaber bekommt den Weg zurück, ohne je einen Fehler zu sehen, den er nicht versteht. In der Konfiguration `username` (Abschnitt 3.4) gibt es keinen E-Mail-Pfad — dort ist der Wiederherstellungscode der einzige Weg, und fehlt auch der, ist das Konto verloren. Genau diese Fälle zählt der Trockenlauf als `unrecoverable`.

#### 4.0.6 Kollisionsauflösung

**Entscheidung: zwei Quellkonten mit derselben E-Mail werden niemals automatisch zusammengeführt; der Standard ist Abbruch vor dem Schreiblauf.** Vier Gründe, nach Gewicht:

1. **Die E-Mail ist kein Identitätsnachweis.** Abschnitt 3.10 macht das für die Anbieterverknüpfung unverhandelbar: `(provider, subject)` ist der einzige Schlüssel, die E-Mail nie. Im Import genau diese Regel zu brechen wäre widersinnig — und derselbe Fehler, der Better Auth CVE-2026-53516 (CVSS 8.3) eingebracht hat.
2. **Ein Zusammenführen verschenkt ein Kennwort.** `password_credential` hat `user_id` als Primärschlüssel: Von zwei Hashes überlebt einer. Der Besitzer des verworfenen Kennworts kommt nicht mehr hinein — der andere aber schon, in ein Konto, das nun die Identitäten und Faktoren beider trägt. Das ist eine Rechteausweitung durch Migration.
3. **Es ist belegt kein Randfall.** Auth0 erlaubt dieselbe E-Mail über Connections hinweg; bei 125.000 migrierten Auth0-Nutzern gab es „a few thousand cases of multiple user accounts with the same email address", von denen rund 100 nicht automatisch auflösbar waren (<https://kevcodez.medium.com/migrating-125-000-users-from-auth0-to-supabase-81c0568de307>), dazu „falsely matched user accounts" aus dem Auth0-Account-Linking (ebd.).
4. **Sonst entscheidet die Sortierung.** Der partielle Unique-Index `user_email_key` lässt die erste Zeile durch und wirft die zweite weg — die Reihenfolge der Quelldatei bestimmt den Gewinner.

| Politik | Verhalten |
|---|---|
| `abort` (Standard) | Trockenlauf listet alle Kollisionen, Schreiblauf verweigert |
| `manual` | Zuordnungsdatei `source_id,action` mit `action ∈ {import, skip, email:<neu>}`; nur vollständig aufgelöste Kollisionen werden geschrieben |
| `skip-duplicates` | Ältestes `created_at` gewinnt, alle weiteren werden namentlich berichtet und übersprungen. Nicht Standard, weil stiller Zugangsverlust |

Für Benutzernamen gilt dieselbe Regel mit einer Zusatzfalle: `username_key` ist NFKC + casefold (Abschnitt 3.4), also kollabieren in der Quelle verschiedene Namen (`Müller`/`MÜLLER`) zu einem Schlüssel — getrennt gezählt als `usernameKeyWithinSource`. Ebenso getrennt gezählt wird, wie viele Namen an der Standard-Erlaubnisliste `[a-z0-9_-]`, 3–32 Zeichen scheitern: Auth0 erlaubt bis 128 Zeichen, Clerk und Auth.js kennen Punkte und Umlaute. Die Erlaubnisliste ist konfigurierbar und muss **vor** dem Import auf eine Obermenge des Bestands gestellt werden. Kollisionen auf `(provider, subject)` sind der harmlose Fall: Der Constraint fängt sie, `DO NOTHING` lässt den bestehenden Eintrag stehen, der Bericht zählt ihn.

#### 4.0.7 UUID-Erhalt

**Regel `preserveIds: 'auto'`:** Die Quell-ID wird `velve.user.id`, wenn sie eine gültige UUID und noch frei ist; sonst wird eine neue erzeugt und die Quell-ID lebt in `velve.import_mapping` weiter.

| Quelle | ID-Form | Übernahme |
|---|---|---|
| Supabase | `uuid` | **zwingend** |
| Auth.js (Drizzle) | `text`, Default `crypto.randomUUID()` | ja, wenn alle Werte UUIDs sind |
| Auth.js (Prisma) | `cuid` (25 Zeichen) | nein |
| Clerk | `user_2abc…` | nein |
| Auth0 | `auth0\|abc123` | nein |
| Firebase | `OzDdXA7LwoR7lX2MH7AXaEmmn5u2` | nein |

Bei **Supabase ist der Erhalt nicht optional**: In fast jedem Projekt referenzieren Tabellen im Schema `public` per Fremdschlüssel `auth.users(id)`, und RLS-Policies vergleichen gegen `auth.uid()` — genau dieses Muster empfiehlt die Doku (<https://supabase.com/docs/guides/auth/managing-user-data>). Neue IDs bedeuten gebrochene Fremdschlüssel und Policies, die auf niemanden mehr passen; der Supabase-Importer verweigert deshalb `preserveIds: false`. Bei den übrigen vier bleibt die Quell-ID wertvoll für Anwendungsdaten, die noch auf sie zeigen — dafür ist `import_mapping` der richtige Ort und nicht eine `external_id`-Spalte auf `velve.user`: Abschnitt 3.14 sagt ausdrücklich, dass dort keine Profildaten liegen, und eine solche Spalte wäre der Anfang genau davon.

---

### 4.1 Supabase (GoTrue)

#### a) Beschaffung

Der einfachste Fall: Die Auth-Daten liegen im selben PostgreSQL, auf den der Kunde ohnehin Vollzugriff hat (<https://github.com/orgs/supabase/discussions/3897>).

1. Connection-String: Dashboard → *Project Settings → Database* — die **direkte** Verbindung, nicht der Pooler auf Port 6543 (Transaction-Mode verträgt keine langen Cursor).
2. Bestand prüfen: `psql "$SUPABASE_URL" -c "SELECT count(*) FROM auth.users WHERE deleted_at IS NULL;"`
3. Lesen — **spaltenweise explizit**, nie `SELECT *`. Die Doku warnt: „Columns, indices, constraints or other database objects managed by Supabase may change at any time." (<https://supabase.com/docs/guides/auth/managing-user-data>)
   ```
   psql "$SUPABASE_URL" -c "\copy (
     SELECT u.id, u.email, u.encrypted_password, u.email_confirmed_at, u.phone,
            u.raw_app_meta_data, u.raw_user_meta_data, u.banned_until, u.deleted_at,
            u.is_sso_user, u.is_anonymous, u.created_at, u.updated_at
     FROM auth.users u ORDER BY u.created_at, u.id) TO 'users.csv' WITH (FORMAT csv, HEADER)"
   ```
   analog für `auth.identities` und `auth.mfa_factors`. Der Standardweg des Importers ist ein zweiter `pg`-Pool ohne Zwischendatei.
4. `pg_dump --schema=auth --data-only` geht auch, kann aber an der Ownership Supabase-interner Objekte scheitern (Discussion #3897, Issue #1856).

**Nicht gangbar:** `GET /admin/users` liefert `encrypted_password` nicht — das Feld ist im Go-Struct mit `json:"-"` markiert (<https://raw.githubusercontent.com/supabase/auth/master/internal/models/user.go>); das `auth`-Schema ist auch nicht über die generierte REST-API exponiert. **Dauer:** SCHÄTZUNG: Minuten bis Stunden, rein bestandsabhängig. Kein Ticket, keine Genehmigung.

#### b) Quellschema

`auth.users` (<https://raw.githubusercontent.com/supabase/auth/master/internal/models/user.go>), `auth.identities` (<https://raw.githubusercontent.com/supabase/auth/master/internal/models/identity.go>), `auth.mfa_factors` (<https://raw.githubusercontent.com/supabase/auth/master/internal/models/factor.go>). PG-Typen `SCHÄTZUNG:` wo aus dem Go-Typ abgeleitet.

| Feld | Typ | Bedeutung |
|---|---|---|
| `users.id` | `uuid` PK | Nutzer-ID; von Fremdschlüsseln und RLS referenziert |
| `users.email` | `varchar` | E-Mail, kann NULL sein |
| `users.encrypted_password` | `varchar` | Der Passwort-**Hash** (Name irreführend) |
| `users.email_confirmed_at` | `timestamptz` | Bestätigungszeitpunkt |
| `users.phone` / `phone_confirmed_at` | `text`/`timestamptz` | Telefonfaktor |
| `users.raw_app_meta_data` | `jsonb` | enthält `provider`, `providers[]` |
| `users.raw_user_meta_data` | `jsonb` | Profildaten (`full_name`, `avatar_url`) |
| `users.banned_until` | `timestamptz` | Sperre |
| `users.deleted_at` | `timestamptz` | Soft-Delete |
| `users.is_sso_user` / `is_anonymous` / `is_super_admin` | `boolean` | SAML-Nutzer (nie ein Kennwort) / anonym / Admin |
| `users.created_at` / `updated_at` | `timestamptz` | |
| `users.confirmed_at` | `timestamptz` | **generierte Spalte** (`rw:"r"`), nicht schreibbar |
| `users.confirmation_token`, `recovery_token`, `email_change*`, `reauthentication_token` | `text`/`timestamptz` | Einmal-Token und Schwebezustände |
| `identities.id` | `uuid` | PK der Identität |
| `identities.provider_id` | `text` | **Subject beim Anbieter** (JSON-Name schlicht `id`) |
| `identities.user_id` | `uuid` | FK → `auth.users.id` |
| `identities.provider` | `text` | `email`, `google`, `github`, `apple`, … |
| `identities.identity_data` | `jsonb` | Roh-Claims (`sub`, `email`, `email_verified`, `name`) |
| `identities.email` | `text` | **generierte Spalte** aus `identity_data->>'email'` |
| `mfa_factors.user_id` / `status` | `uuid`/`text` | `unverified` / `verified` |
| `mfa_factors.secret` | `text` | **TOTP-Secret** — ggf. verschlüsselt |
| `mfa_factors.factor_type` | `text` | `totp` / `phone` / `webauthn` |
| `mfa_factors.friendly_name` | `text` | Anzeigename |
| `mfa_factors.web_authn_credential` / `web_authn_aaguid` | `jsonb`/`uuid` | Passkey-Credential / Authenticator-Modell |

Das Identity-Struct hat **keine** Tokenspalten: GoTrue persistiert Anbieter-Tokens nicht (ebd.).

#### c) Zuordnung zum Velve-Auth-Schema

| Quellfeld | Ziel | Transformation |
|---|---|---|
| `users.id` | `velve.user.id` | unverändert — **zwingend** (Abschnitt 4.0.7) |
| `users.id` | `velve.import_mapping.source_id` | als Text |
| `users.email` | `velve.user.email` | trim, NFKC, `lower()` |
| `users.email_confirmed_at` | `velve.user.email_verified_at` | unverändert |
| `raw_user_meta_data->><konfig. Pfad>` | `velve.user.username` / `.username_key` | NFKC bzw. NFKC + casefold; GoTrue hat kein Benutzernamenfeld, nur in `username`/`username_email` relevant |
| `users.banned_until` | `velve.user.disabled_at` | `> now() ? banned_until : NULL` — abgelaufene Sperren nicht übernehmen |
| — | `velve.user.imported_from` / `.imported_at` | `'supabase'` / `now()` |
| `users.created_at` / `updated_at` | gleichnamig | unverändert |
| `users.encrypted_password` | `velve.password_credential.phc` | PHC-String nach d), AES-256-GCM unter `KeyProvider('password-enc')` (L-2) |
| abgeleitet | `velve.password_credential.scheme` | `bcrypt`\|`argon2i`\|`argon2id`\|`fbscrypt`, Klartext |
| — | `velve.password_credential.key_version` | aktuelle Version des Schlüssels `password-enc` (L-2) |
| `identities.provider` | `velve.identity.provider` | Abbildung; `email` erzeugt **keine** Identität (das ist der Kennwortzugang) |
| `identities.provider_id` | `velve.identity.subject` | unverändert |
| `identities.user_id` | `velve.identity.user_id` | über `import_mapping` |
| `identity_data->>'email'` | `velve.identity.provider_email` | `lower()` |
| `identity_data->>'email_verified'` | `velve.identity.provider_email_verified` | Bool-Cast, Default `false` |
| `identity_data` | `velve.identity.profile` | unverändert als `jsonb` |
| — | `velve.identity.access_token_enc`/`refresh_token_enc`/`id_token_enc`/`token_key_version`/`scopes`/`token_expires_at` | **NULL** — GoTrue speichert keine Anbieter-Tokens |
| `mfa_factors.secret` (`totp`, `verified`) | `velve.totp_credential.secret_enc` | ggf. GoTrue-Entschlüsselung, dann AES-256-GCM unter `KeyProvider('totp-enc')` |
| — | `velve.totp_credential.key_version` | aktuelle Schlüsselversion |
| `mfa_factors.updated_at` / `created_at` | `.confirmed_at` / `.created_at` | unverändert |
| — | `velve.recovery_code` | **keine Zeilen** — GoTrue kennt keine |
| `web_authn_credential->>'credential_id'`/`'public_key'`/`'sign_count'` | `velve.webauthn_credential.credential_id`/`.public_key`/`.sign_count` | base64url → `bytea`, Zahl; nur bei Opt-in (f) |
| `web_authn_aaguid` / `friendly_name` | `.aaguid` / `.label` | unverändert |
| konservativ | `.backup_eligible`/`.backup_state`/`.user_verified_at_registration` | `false` (f) |
| `users.deleted_at IS NOT NULL` | — | Datensatz **überspringen** |
| `users.is_sso_user` | — | kein Kennwort → `no_password_in_source` |
| Einmal-Token-Spalten, `auth.sessions`, `auth.refresh_tokens` | — | **verwerfen** (Abschnitt 3.7) |

#### d) Hash-Übernahme

`encrypted_password` kann **drei** Familien enthalten (<https://raw.githubusercontent.com/supabase/auth/master/internal/crypto/password.go>): GoTrue *erzeugt* nur bcrypt (Go-`DefaultCost` = 10), *verifiziert* aber auch argon2i/argon2id und `$fbscrypt$`. Alle drei sind bereits kanonisch im Sinne von Abschnitt 3.3:

```
bcrypt:   "$2a$10$<22><31>"                                  → unverändert übernehmen, scheme = "bcrypt"
argon2:   "$argon2id$v=19$m=…,t=…,p=…$<salt_b64>$<hash_b64>" → unverändert, scheme = "argon2id"|"argon2i"
          (ablehnen, wenn v != 19 oder Variante argon2d — GoTrue akzeptiert nur i/id)
fbscrypt: "$fbscrypt$v=1,n=<n>,r=<r>,p=<p>,ss=<b64>,sk=<b64>$<salt>$<hash>" → unverändert, scheme = "fbscrypt"

scheme(h) = h.startsWith("$2") ? "bcrypt" : h.startsWith("$argon2id$") ? "argon2id"
          : h.startsWith("$argon2i$") ? "argon2i" : h.startsWith("$fbscrypt$") ? "fbscrypt"
          : UNUSABLE("malformed");     phc = h    // in allen Fällen unverändert
```

Der `$fbscrypt$`-Fall ist der Grund, warum Abschnitt 3.3 genau dieses Format gewählt hat: Supabase hat es nach Issue #1750/PR #1768 nachgerüstet (<https://github.com/supabase/auth/issues/1750>), Velve Auth übernimmt es 1:1 (`FirebaseScryptKeyLen = 32` beidseitig). Damit ist die Supabase-Übernahme für alle drei Familien reines Kopieren des Strings; verschlüsselt wird er erst beim Schreiben (L-2). Nach dem ersten Login ist `needsRehash` in allen drei Fällen wahr und der Hash wandert still auf Argon2id (Abschnitt 3.3, Schritt 6, und Abschnitt 4.6).

#### e) Was mitkommt

Nutzer-ID unverändert · E-Mail und Bestätigungszeitpunkt · Zeitstempel · Passwort-Hashes aller drei Familien ohne Umrechnung · Sperren (`banned_until` in der Zukunft) · Anbieterverknüpfungen mit Roh-Claims · TOTP-Secrets, sofern unverschlüsselt oder der GoTrue-Schlüssel vorliegt · WebAuthn-Credentials bei gleicher RP-ID und Opt-in.

#### f) Was nicht mitkommt

* **Aktive Sessions und Refresh-Tokens** — nicht sinnvoll: Velve-Sessions sind undurchsichtige Zeilen mit `sha256(token)` (Abschnitt 3.5), ein fremdes Token hat kein Gegenstück.
* **Anbieter-Access-/Refresh-Tokens** — nicht vorhanden; GoTrue persistiert sie nicht. Verlustumfang null.
* **Einmal-Token und schwebender E-Mail-Wechsel** — nicht sinnvoll: Abschnitt 3.7 vergibt neue; fremde Geheimnisse werden nie importiert.
* **TOTP-Secrets bei verschlüsselter Ablage auf Supabase Cloud** — technisch unmöglich ohne `GOTRUE_DB_ENCRYPTION_KEY`, der dort nicht herausgegeben wird (SCHÄTZUNG; Befundbericht `findings/05-migrationsquellen.md`, Abschnitt 1.2).
* **Passkeys bei Domainwechsel** — technisch unmöglich, RP-ID-Bindung.
* **`backup_eligible`/`backup_state`/User-Verification-Flag** — nicht exportierbar; GoTrue speichert sie nicht getrennt, in Abschnitt 3.2 sind sie `NOT NULL`. Standard ist deshalb **kein** Passkey-Import; das Opt-in `webauthn: 'conservative'` setzt beide Flags auf `false` und markiert damit synchronisierte Passkeys fälschlich als gerätegebunden — was eine Anwendungsrichtlinie in die Irre führt.
* **RLS-Policies, `public`-Objekte, `is_super_admin`, `role`, Audit-Log** — außerhalb des Geltungsbereichs (Abschnitt 3.14).
* **Soft-gelöschte Nutzer** — nicht sinnvoll; gelöschte Konten werden nicht übernommen.

#### g) Was der Nutzer danach tun muss

1. Vor dem Import prüfen, ob `mfa_factors.secret` verschlüsselt ist (am Format erkennbar); wenn ja und der Schlüssel fehlt: TOTP-Neueinrichtung einplanen.
2. Identitätskonfiguration festlegen (Abschnitt 3.4) — bei anonymen Nutzern ohne E-Mail ist `email` nicht wählbar.
3. Trockenlauf, Bericht lesen, Kollisionen auflösen.
4. Schreiblauf mit `preserveIds: true` (erzwungen).
5. **RLS-Policies umschreiben:** jedes `auth.uid()` durch die eigene Session-Auflösung ersetzen. Die IDs bleiben gleich, die Quelle der Wahrheit nicht — die aufwendigste Einzelaufgabe.
6. Fremdschlüssel von `public.*` auf `velve.user(id)` umhängen.
7. Anwendung auf `@velve/auth` umstellen, Origins konfigurieren.
8. Nutzer informieren: Neuanmeldung nötig, bei fehlendem TOTP-Secret zusätzlich Neueinrichtung des zweiten Faktors.
9. `auth`-Schema erst nach einer Karenzzeit löschen, nicht am Umstellungstag.

#### h) Fallstricke

1. **User-IDs müssen erhalten bleiben** — Fremdschlüssel und RLS gegen `auth.uid()`.
2. **Kein `SELECT *`** — Supabase behält sich Schemaänderungen jederzeit vor.
3. **Generierte Spalten** `users.confirmed_at` und `identities.email` sind `rw:"r"`.
4. **`pg_dump --schema=auth` kann an Ownership scheitern** (Discussion #3897, Issue #1856).
5. **Drei Hash-Familien in einer Spalte** — wer nur bcrypt erwartet, verliert argon2- und `$fbscrypt$`-Nutzer stillschweigend.
6. **`provider = 'email'` ist keine OAuth-Verknüpfung**, sondern der Kennwortzugang. Wer ihn als Identität importiert, erzeugt einen Anbieter „email" mit der E-Mail als Subject — genau das, was Abschnitt 3.10 verbietet.
7. Der Pooler auf Port 6543 verträgt keine langen Cursor.

---

### 4.2 Clerk

#### a) Beschaffung

Zwei Quellen, die zwingend zusammengeführt werden müssen.

1. **CSV aus dem Dashboard**, seit 23.10.2024 self-service: Button *„Export All Users"*, Download-Link bleibt im Dashboard, bis die Datei abläuft; Zugriff nur für Admins bzw. im persönlichen Workspace (<https://clerk.com/changelog/2024-10-23-export-users>). Die CSV „includes their hashed passwords" (<https://clerk.com/docs/guides/development/migrating/overview>).
2. **Backend-API für alles Übrige** — Bilder, Metadaten, `external_accounts`, `created_at`:
   ```
   curl -sS -H "Authorization: Bearer $CLERK_SECRET_KEY" \
     "https://api.clerk.com/v1/users?limit=500&offset=0"
   ```
   seitenweise bis leer; Ratenbegrenzung beachten (die Doku warnt beim `CreateUser`-Endpoint ausdrücklich).
3. Join über `id`.

Ein Support-Ticket ist **nicht** mehr nötig; ältere Anleitungen von WorkOS (<https://github.com/workos/migrate-clerk-users>) und PropelAuth (<https://docs.propelauth.com/migrations/clerk>) sind hier veraltet. **Dauer:** SCHÄTZUNG: CSV in Minuten; API bei 100.000 Nutzern = 200 Seiten, mit Ratenbegrenzung realistisch unter einer Stunde. Der Aufwand liegt in der Vorbereitung, nicht im Abruf.

#### b) Quellschema

CSV-Spalten `UNBELEGT:` — Clerk dokumentiert sie nicht; Liste aus dem Better-Auth-Skript (`docs/content/docs/guides/clerk-migration-guide.mdx:195–207`), `password_digest`/`password_hasher` bestätigt durch <https://github.com/workos/migrate-clerk-users>. API-Objekt: <https://clerk.com/docs/reference/backend/types/backend-user>.

| Feld | Typ | Bedeutung |
|---|---|---|
| CSV `id` | string | Clerk-User-ID (`user_…`), Join-Schlüssel |
| CSV `username`, `first_name`, `last_name` | string | Benutzername, Profil |
| CSV `primary_email_address` / `primary_phone_number` | string | Haupt-Adresse / -Nummer |
| CSV `verified_email_addresses` / `unverified_email_addresses` | Liste | bestätigt / unbestätigt |
| CSV `verified_phone_numbers` / `unverified_phone_numbers` | Liste | dito |
| CSV `totp_secret` | string | **TOTP-Secret im Klartext** |
| CSV `password_digest` | string | Passwort-Hash |
| CSV `password_hasher` | string | Verfahrensname, 19 mögliche Werte |
| API `externalId` | string \| null | kundeneigene ID |
| API `emailAddresses[]` / `phoneNumbers[]` | Objekt[] | inkl. Verifikationsstatus |
| API `externalAccounts[]` | Objekt[] | `id`, `provider`, `identification_id`, `provider_user_id`, `approved_scopes`, `email_address`, `created_at`, `updated_at` |
| API `enterpriseAccounts[]` / `web3Wallets[]` | Objekt[] | SSO / Wallets |
| API `passwordEnabled`, `totpEnabled`, `twoFactorEnabled`, `backupCodeEnabled` | boolean | **nur Flags, keine Geheimnisse** |
| API `banned`, `locked` | boolean | Sperrzustand |
| API `createdAt`, `updatedAt` | number | Unix-**Millisekunden** |
| API `publicMetadata`/`privateMetadata`/`unsafeMetadata`, `imageUrl`, `locale` | Objekt/string | Profil |

#### c) Zuordnung zum Velve-Auth-Schema

| Quellfeld | Ziel | Transformation |
|---|---|---|
| `id` | `velve.import_mapping.source_id` | unverändert; **nicht** als `user.id` (kein UUID) |
| — | `velve.user.id` | neu erzeugt |
| `primary_email_address` | `velve.user.email` | trim, NFKC, `lower()` |
| in `verified_email_addresses` enthalten | `velve.user.email_verified_at` | `true` → `createdAt` (SCHÄTZUNG: Clerk exportiert keinen Bestätigungszeitpunkt), sonst NULL |
| `username` | `velve.user.username` / `.username_key` | NFKC bzw. NFKC + casefold |
| `banned \|\| locked` | `velve.user.disabled_at` | `true` → `now()`; Clerk liefert keinen Sperrzeitpunkt |
| — | `velve.user.imported_from` / `.imported_at` | `'clerk'` / `now()` |
| `createdAt`, `updatedAt` (ms) | `velve.user.created_at` / `.updated_at` | `new Date(ms)`, Plausibilität Jahr 2000–2100 |
| `password_digest` + `password_hasher` | `velve.password_credential.phc` / `.scheme` | PHC-String nach d), verschlüsselt unter `password-enc` (L-2) / Klartext |
| — | `velve.password_credential.key_version` | aktuelle Version des Schlüssels `password-enc` (L-2) |
| `external_accounts[].provider` | `velve.identity.provider` | Präfix `oauth_` abschneiden (`oauth_google`→`google`); Unbekanntes bleibt als generischer Anbietername |
| `external_accounts[].provider_user_id` | `velve.identity.subject` | unverändert |
| `external_accounts[].email_address` | `velve.identity.provider_email` | `lower()` |
| — | `velve.identity.provider_email_verified` | **`false`** — kein Verifikationsstatus je External Account; konservativ, verhindert automatische Verknüpfung nach Abschnitt 3.10 |
| ganzes `external_accounts[i]` | `velve.identity.profile` | als `jsonb` |
| `approved_scopes` | `velve.identity.scopes` | Split auf Leerzeichen |
| — | `velve.identity.access_token_enc` u. a. | **NULL** — Tokens nicht im User-Objekt |
| CSV `totp_secret` | `velve.totp_credential.secret_enc` | Base32-Klartext → AES-256-GCM unter `KeyProvider('totp-enc')` |
| — | `velve.totp_credential.key_version` / `.confirmed_at` | aktuelle Schlüsselversion / `now()` (SCHÄTZUNG: kein Zeitpunkt im Export) |
| — | `velve.recovery_code` | **keine Zeilen** — nur `backupCodeEnabled: boolean` verfügbar |
| — | `velve.webauthn_credential` | **keine Zeilen** — `UNBELEGT:` kein Exportweg bekannt |
| `primary_phone_number`, Metadaten, `imageUrl`, Namen | — | kein Zielfeld bzw. außerhalb des Geltungsbereichs (Abschnitt 3.14) |

#### d) Hash-Übernahme

`password_hasher` **muss** ausgewertet werden: Clerk akzeptiert beim Import 19 Verfahren und behält sie bei (<https://clerk.com/docs/reference/backend/user/create-user>; die Zahl folgt der Aufzählung im Beschreibungstext — die SDK-Typsignatur auf derselben Seite nennt eine abweichende Menge mit `ldap_ssha` und `md5_phpass`, weshalb der Importer jeden unbekannten Wert als `unusable` mit `detail = 'clerk:<hasher>'` behandelt). Ein Tenant, der selbst einmal migriert ist, enthält potenziell alles.

| `password_hasher` | Velve? | Umwandlung / Grund |
|---|---|---|
| `bcrypt` | **ja** | `"$2a$10$<22><31>"` → unverändert, `scheme = "bcrypt"` |
| `argon2i` / `argon2id` | **ja** | PHC-String → unverändert, `scheme = "argon2i"`/`"argon2id"` |
| `pbkdf2_sha256`, `pbkdf2_sha256_django` | **ja** | `"pbkdf2_sha256$<i>$<salt>$<hash_b64>"` → `"$pbkdf2-sha256$i=<i>$<b64(salt)>$<hash_b64>"` |
| `pbkdf2_sha512` | **ja** | analog → `"$pbkdf2-sha512$i=<i>$<b64(salt)>$<hash_b64>"` |
| `pbkdf2_sha512_hex` | **ja** | wie oben, aber `hex→b64` für den Hash |
| `scrypt_werkzeug` | **ja** | `"scrypt:<N>:<r>:<p>$<salt>$<hash_hex>"` → `"$scrypt$ln=log2(N),r=<r>,p=<p>$<b64(salt_ascii)>$<b64(hexToBytes(hash))>"` |
| `scrypt_firebase` | **praktisch nein** | Algorithmus verifizierbar (Abschnitt 4.4), aber `signer_key` und `salt_separator` des ursprünglichen Firebase-Projekts stehen **nicht** im Clerk-Export. Nur migrierbar, wenn der Kunde das alte Projekt noch besitzt und die vier Parameter beibringt |
| `bcrypt_peppered` | **nein** | Der Pepper ist ein Clerk-Geheimnis, nicht Teil des Exports — Hash nicht reproduzierbar |
| `bcrypt_sha256_django` | **nein** | Django hasht erst zu SHA-256-Hex und übergibt *das* an bcrypt: ein anderes Verfahren als `$2a$`, bräuchte eine eigene Zeile in der Weiche |
| `awscognito` | **nein** | SRP-basiert, kein übernehmbarer Hash |
| `phpass` | **nein** | MD5-basierte Iteration, nicht in der Weiche |
| `md5`, `md5_salted` | **nein** | kryptografisch tot, siehe Abschnitt 4.3 d) |
| `sha256`, `sha256_salted`, `sha512_symfony` | **nein** | Ein-Runden- bzw. schwach iterierte Digests, nicht speicherhart |
| `pbkdf2_sha1` | **nein** | Abschnitt 3.3 führt nur `$pbkdf2-sha256$` und `$pbkdf2-sha512$`; SHA-1 wird nicht aufgenommen |

**Bilanz: 8 von 19 sicher verifizierbar, ein neunter (`scrypt_firebase`) nur mit Fremdparametern, 10 nicht.** Für die 10 gilt Abschnitt 4.0.5: keine Zeile in `password_credential`, Markierung mit `detail = 'clerk:<hasher>'`. `UNBELEGT:` Clerk dokumentiert die exakte Zeichenkettenform je Hasher nicht; die Umwandlungen oben setzen die üblichen Formate (Django, Werkzeug) voraus. Der Importer prüft jede Umwandlung über `verify()` gegen einen Testdatensatz und stuft ein Verfahren ohne bestandenen Testvektor auf `unusable` herunter, statt blind zu schreiben. `SCHÄTZUNG:` Kostenfaktor 10 für bcrypt; Clerk dokumentiert ihn nicht.

#### e) Was mitkommt

E-Mail und Verifikationsstatus · Benutzername · Sperrzustand · Zeitstempel · Passwort-Hashes der acht verifizierbaren Verfahren · **TOTP-Secrets** — der seltene Fall, in dem der zweite Faktor vollständig übernommen wird, gegengeprüft daran, dass Clerks eigener `createUser` ein `totpSecret` „without the need to reset it" annimmt · Anbieterverknüpfungen mit Scopes.

#### f) Was nicht mitkommt

* **Hashes der 10 nicht unterstützten Verfahren** — nicht sinnvoll: Aufnahme in die Weiche bände Velve Auth dauerhaft an tote Kryptografie.
* **Backup-Codes** — nicht exportierbar; nur `backupCodeEnabled: boolean` (SCHÄTZUNG: gehasht gespeichert).
* **Passkeys** — `UNBELEGT:` kein dokumentierter Exportweg.
* **OAuth-Anbieter-Tokens** — nicht exportierbar; nur über einen separaten, kurzlebigen Endpoint abrufbar.
* **Verifikationsstatus je External Account** — nicht exportierbar, konservativ `false`.
* **Organisationen** — außerhalb des Geltungsbereichs (Abschnitt 3.14), separat über die Backend-API zu ziehen (<https://workos.com/docs/migrate/clerk>).
* **Telefonnummern, Profildaten, Metadaten, Bilder** — kein Zielfeld (Abschnitt 3.14), gehören in die Anwendungstabellen.

#### g) Was der Nutzer danach tun muss

1. Vor dem Export feststellen, ob der Tenant je aus einem Fremdsystem importiert hat — sonst überrascht die `password_hasher`-Verteilung im Trockenlauf.
2. CSV **und** API-Lauf möglichst zeitnah ziehen (Snapshot-Drift).
3. Trockenlauf; `passwords.byScheme` und `unusableByReason` sind die Grundlage der Nutzerkommunikation.
4. Je Verfahren ein Testkonto mit bekanntem Kennwort für `verify()` beibringen.
5. Schreiblauf, danach **Nachzügler abgleichen**: erneuter API-Lauf, Diff gegen `velve.import_mapping`, zweiter Durchgang.
6. Profildaten in die eigenen Anwendungstabellen übernehmen; Organisationen separat nachbauen.
7. Nutzer mit `unusable`-Markierung informieren, dass beim nächsten Login eine Reset-Mail kommt.
8. Nutzern mit Backup-Codes mitteilen, dass die alten ungültig sind, und in Velve Auth neue ausgeben.

#### h) Fallstricke

1. **CSV nie mit `split(',')` parsen.** Genau das tut das offizielle Better-Auth-Skript (`clerk-migration-guide.mdx:183–192`, `split(',')` in den Zeilen 185 und 187) und zerlegt Zeilen mit Komma im Namen oder mehreren Adressen in einer Zelle falsch. Velve Auth verlangt einen RFC-4180-Parser.
2. **Zwei Datenquellen zwingend** — das API-Objekt enthält weder Hash noch TOTP-Secret, nur `passwordEnabled`/`totpEnabled`. Wer nur die API benutzt, verliert beides.
3. **Snapshot-Drift** — während der Migration angelegte Nutzer fehlen (<https://clerk.com/docs/guides/development/migrating/overview>).
4. **Dev- und Prod-Instanz sind getrennt** — „You cannot migrate users from your Development instance to your Production instance." (ebd.)
5. **Kein Primary-Flag bei Mehrfach-E-Mails** im Exportformat (<https://workos.com/docs/migrate/clerk>) — die Auswahl der Hauptadresse ist eine Annahme.
6. **`createdAt` ist Unix-ms**, kein ISO-8601.

---

### 4.3 Auth0

#### a) Beschaffung

Der komplizierteste Fall: Profildaten und Hashes gehen völlig getrennte Wege.

**(a1) Profildaten — Management-API-Job, selbstbedienbar** (<https://auth0.com/docs/manage-users/user-migration/bulk-user-exports>):

```
curl -X POST "https://$TENANT.auth0.com/api/v2/jobs/users-exports" \
  -H "Authorization: Bearer $MGMT_TOKEN" -H 'content-type: application/json' \
  -d '{"connection_id":"con_…","format":"json",
       "fields":[{"name":"user_id"},{"name":"email"},{"name":"email_verified"},
                 {"name":"username"},{"name":"blocked"},{"name":"created_at"},
                 {"name":"updated_at"},{"name":"identities"},{"name":"multifactor"}]}'
curl "https://$TENANT.auth0.com/api/v2/jobs/$JOB_ID" -H "Authorization: Bearer $MGMT_TOKEN"
curl -L -o users.ndjson "$LOCATION"     # sofort — der Link lebt 60 Sekunden
```

`format: "json"` liefert **NDJSON**; CSV kann höchstens 30 Felder und keine Metadaten-Objekte. Job-Daten werden nach 24 h gelöscht, der Download-Link lebt 60 s — Poll und Fetch müssen in einem Rutsch laufen.

**(a2) Passwort-Hashes und MFA-Secrets — nur per Support-Ticket** (<https://auth0.com/docs/troubleshoot/customer-support/manage-subscriptions/export-data>, <https://auth0.com/docs/manage-users/user-migration/export-password-hashes-and-mfa-secrets>): (1) PGP-Schlüsselpaar erzeugen, mindestens RSA 4096, Public Key ASCII-armored, höchstens 35.000 Zeichen. (2) Support-Case mit Tenant-Name und Public Key eröffnen. (3) Eligibility-Review durch Auth0 — „Not all requests qualify for export". (4) Schriftliche Autorisierung, Bestätigung durch einen **zweiten Admin**, **unterschriebenes Acknowledgment-Formular mit CISO-/CSO-/Executive-Unterschrift**. (5) Download-Link, **3 Tage** gültig, nur für den Case-Ersteller mit aktiver Tenant-Admin-Rolle. (6) Lokal entschlüsseln (`gpg --decrypt hashes.pgp`); „Never share your private key or passphrase with anyone, including Auth0 or Okta support staff".

Zwei harte Grenzen: **„This operation is not available for our Free subscription tier."** und „unable to accept or guarantee requests for exports at a specific time and date." **Dauer:** SCHÄTZUNG: Profildaten in Minuten; Hash-Export 2–6 Wochen — belegt ist „about a week in total" über mehrere Support-Level, plus Review und Unterschriftenrunde (<https://kevcodez.medium.com/migrating-125-000-users-from-auth0-to-supabase-81c0568de307>). Ohne bezahlten Tarif: gar nicht.

#### b) Quellschema

Normalisiertes Profil (<https://auth0.com/docs/manage-users/user-accounts/user-profiles/user-profile-structure>); Hash-Felder nach dem Import-Schema, das der Support-Export in der Praxis spiegelt (<https://auth0.com/docs/manage-users/user-migration/bulk-user-import-database-schema-and-examples>).

| Feld | Typ | Bedeutung |
|---|---|---|
| `user_id` | string | mit Connection-Präfix, z. B. `auth0\|abc123`, `google-oauth2\|1179…` |
| `email` / `email_verified` | string / boolean | Local-Part ≤ 64, gesamt ≤ 254 |
| `username` | string | Vorgabe 1–15 Zeichen, bis 128 konfigurierbar; lowercased |
| `name`, `given_name`, `family_name`, `nickname`, `picture` | string | Profil |
| `phone_number` / `phone_verified` | string / boolean | nur SMS-Connections |
| `blocked` | boolean | Sperre |
| `created_at`, `updated_at`, `last_login` | datetime | |
| `last_ip`, `logins_count` | string / integer | Audit |
| `last_password_reset` | datetime | nur DB-Connections |
| `multifactor` | string[] | eingeschriebene MFA-Anbieter |
| `guardian_authenticators[]` | Objekt[] | Faktoren **ohne** Secret |
| `blocked_for[]` | Objekt[] | Bruteforce-Sperren |
| `app_metadata` / `user_metadata` | Objekt | Rollen/Rechte bzw. Präferenzen |
| `identities[]` | Objekt[] | `connection`, `provider`, `user_id`, `isSocial`, `profileData`, `access_token`, `refresh_token` |
| `password_hash` | string | bcrypt `$2a$`/`$2b$`, 10 saltRounds |
| `custom_password_hash` | Objekt | `algorithm`, `hash{value,encoding,digest,key}`, `salt{value,encoding,position}`, `password.encoding`, scrypt-`keylen`/`cost`/`blockSize`/`parallelization` |
| `mfa_factors[]` | Objekt[] | `{"totp":{"secret":"<base32>"}}`, `{"phone":…}`, `{"email":…}` |

`SCHÄTZUNG:` Für Standard-DB-Connections enthält der Export schlicht bcrypt-Strings; `custom_password_hash` taucht nur bei Tenants auf, die selbst mit Fremd-Hashes importiert haben. Die Feldstruktur des PGP-**Exports** ist nicht dokumentiert → `UNBELEGT:`.

#### c) Zuordnung zum Velve-Auth-Schema

| Quellfeld | Ziel | Transformation |
|---|---|---|
| `user_id` | `velve.import_mapping.source_id` | vollständig, **mit** Präfix |
| — | `velve.user.id` | neu erzeugt |
| `email` | `velve.user.email` | trim, NFKC, `lower()` |
| `email_verified` | `velve.user.email_verified_at` | `true` → `created_at`, sonst NULL (kein Zeitpunkt im Export) |
| `username` | `velve.user.username` / `.username_key` | NFKC bzw. NFKC + casefold; Länge gegen die Erlaubnisliste prüfen (Abschnitt 3.4) |
| `blocked` | `velve.user.disabled_at` | `true` → `now()` |
| — | `velve.user.imported_from` / `.imported_at` | `'auth0'` / `now()` |
| `created_at`, `updated_at` | gleichnamig | ISO-8601 → `timestamptz` |
| `password_hash` / `custom_password_hash` | `velve.password_credential.phc` / `.scheme` | PHC-String nach d), verschlüsselt unter `password-enc` (L-2) / Klartext |
| — | `velve.password_credential.key_version` | aktuelle Version des Schlüssels `password-enc` (L-2) |
| `identities[].provider` | `velve.identity.provider` | **Nachschlagetabelle**, nicht `split("-")[0]`: `google-oauth2`→`google`, `windowslive`→`microsoft`, `github`/`apple`/`facebook`/`linkedin`/`twitter` unverändert, `oidc`→Connection-Name als generischer Anbieter, `auth0`/`sms`/`email`→**keine Identität** |
| `identities[].user_id` | `velve.identity.subject` | im Identity-Objekt bereits präfixfrei |
| `identities[].profileData.email` / `.email_verified` | `velve.identity.provider_email` / `.provider_email_verified` | `lower()` / Bool-Cast, Default `false` |
| `identities[].profileData` | `velve.identity.profile` | als `jsonb` |
| `identities[].access_token` / `refresh_token` | `velve.identity.access_token_enc` / `.refresh_token_enc` / `.token_key_version` | **standardmäßig verworfen** (f); bei `storeTokens: true` AES-256-GCM unter `KeyProvider('oauth-token-enc')` |
| `mfa_factors[].totp.secret` | `velve.totp_credential.secret_enc` / `.key_version` | Base32 → AES-256-GCM unter `KeyProvider('totp-enc')` |
| `multifactor` nicht leer | `velve.totp_credential.confirmed_at` | `now()` — kein Einschreibungszeitpunkt im Export |
| — | `velve.recovery_code` | **keine Zeilen** — `UNBELEGT:`, als verloren einplanen |
| — | `velve.webauthn_credential` | **keine Zeilen** — `UNBELEGT:` kein Exportweg |
| `app_metadata`, `blocked_for[]`, `logins_count`, `last_ip`, Profilfelder | — | Rollen/Rechte (Abschnitt 3.14), Ratenbegrenzungszustand, Audit, Profil — nichts davon hat ein Zielfeld |

#### d) Hash-Übernahme

**Standardfall.** Auth0 definiert `password_hash` ausdrücklich als bcrypt `$2a$`/`$2b$` mit 10 saltRounds:

```
Auth0 password_hash: "$2b$10$<22><31>" → unverändert übernehmen, scheme = "bcrypt"
```

**Sonderfall `custom_password_hash`** — elf Algorithmen, drei Ergebnisse:

| `algorithm` | Velve? | Umwandlung / Grund |
|---|---|---|
| `bcrypt` | **ja** | `hash.value` ist bereits MCF → unverändert, `scheme = "bcrypt"` |
| `argon2` | **ja** | `hash.value` ist bereits PHC (`$argon2id$v=19$m=…,t=…,p=…$…$…`) → unverändert; Variante bestimmt `scheme` |
| `scrypt` | **ja** | `"$scrypt$ln=" + log2(cost) + ",r=" + blockSize + ",p=" + parallelization + "$" + b64(decode(salt.value, salt.encoding)) + "$" + b64(decode(hash.value, hash.encoding))`; Bedingung: `cost` Zweierpotenz (von Auth0 gefordert), `keylen` = Länge des dekodierten Hashes |
| `pbkdf2` | **bedingt** | Nur, wenn `hash.value` ein selbstbeschreibender Passlib-String mit Digest, Iterationszahl, Salt und Hash ist → `"$pbkdf2-sha256$…"`/`"$pbkdf2-sha512$…"`. `UNBELEGT:` Die Feldtabelle nennt für pbkdf2 keinen Iterationsparameter; ohne ihn ist der Hash nicht reproduzierbar → `unusable`. Passlibs abgewandelte Base64-Variante (`.` statt `+`) muss vorher normalisiert werden; ohne bestandenen `verify()`-Testvektor wird nicht geschrieben |
| `hmac` | **nein** | Ein-Runden-MAC, weder iteriert noch speicherhart; Abschnitt 3.3 führt kein `$hmac$`, und der Schlüssel müsste dauerhaft in der Datenbank liegen |
| `ldap` | **nein** | `hash.value` ist ein LDAP-Schemastring (`{SSHA}`, `{CRYPT}`) — ein Format im Format, das eine eigene Weiche bräuchte |
| `md4`, `md5`, `sha1` | **nein** | kryptografisch tot, siehe unten |
| `sha256`, `sha512` | **nein** | Ein-Runden-Digests, nicht iteriert, nicht speicherhart |

**Was tut man mit md4, md5, sha1? Nichts.** Sie werden nicht in die Weiche aus Abschnitt 3.3 aufgenommen; die betroffenen Nutzer bekommen keinen Kennwortdatensatz, sondern eine Zeile in `velve.password_reset_required` mit `detail = 'auth0:md5'` und den Reset-Pfad aus Abschnitt 4.0.5. Drei Gründe: **Erstens ist ein ungesalzenes MD5/SHA-1 faktisch Klartext** — ein einzelner Grafikprozessor rechnet Milliarden Kandidaten pro Sekunde, und jedes dieser Kennwörter steht mit hoher Wahrscheinlichkeit bereits in einem Breach-Korpus; es zu importieren heißt, eine bekannte Kompromittierung in eine frische Datenbank zu übernehmen. **Zweitens wäre es dauerhafte Last, kein einmaliger Aufwand** — jede Zeile in der Weiche ist Code, der ewig gepflegt, geprüft und dokumentiert werden muss, und ein Verfahren, das nur wegen einer Migration existiert, überlebt sie um Jahre. **Drittens ist der Nutzen gering** — der einzige Gewinn wäre, dass der Nutzer sein altes Kennwort behalten darf, also genau das, was man bei einem toten Verfahren nicht will; der Rehash (Abschnitt 3.3, Schritt 6) würde es beim ersten Login ohnehin ersetzen, und der Reset erreicht dasselbe, ohne dass je ein toter Hash in der Datenbank lag. Dieselbe Linie gilt für `sha256`/`sha512`/`hmac`: **Velve Auth verifiziert kein Verfahren, das weder iteriert noch speicherhart ist.** Das ist eine Regel, kein Einzelfallurteil.

**Free-Tier-Fall:** Ohne Hash-Export bekommt *jeder* Nutzer `reason = 'hash_not_exported'`. Die einzige Alternative zur Reset-Kampagne ist ein Lazy-Migration-Proxy (Anmeldung gegen Auth0 durchreichen, Klartext abfangen, sofort mit Argon2id hashen) — eine Produktentscheidung mit erheblichen Folgen: Der Proxy sieht Klartextkennwörter, und Auth0 bleibt für die Übergangszeit im kritischen Pfad. Velve Auth liefert dafür bewusst kein fertiges Bauteil.

#### e) Was mitkommt

E-Mail und Verifikationsstatus · Benutzername · Sperrzustand · Zeitstempel · bcrypt-, argon2- und scrypt-Hashes (bei bezahltem Tarif und erfolgreichem Support-Export) · Anbieterverknüpfungen mit `profileData` · TOTP-Secrets, sofern im PGP-Export enthalten (`UNBELEGT:` Struktur).

#### f) Was nicht mitkommt

* **Alle Hashes im Free-Tier** — nicht exportierbar: „not available for our Free subscription tier".
* **md4/md5/sha1/sha256/sha512/hmac/ldap-Hashes** — nicht sinnvoll, siehe d).
* **`pbkdf2` ohne Iterationsparameter** — technisch unmöglich, nicht reproduzierbar.
* **Refresh-Tokens der Anbieter** — praktisch wertlos: an die **Auth0-Client-Registrierung** beim Anbieter gebunden; nach dem Wechsel auf eigene Client-IDs nicht mehr einlösbar.
* **Access-Tokens** — praktisch wertlos, zum Migrationszeitpunkt abgelaufen.
* **Wiederherstellungscodes und Passkeys** — `UNBELEGT:`, als verloren einplanen.
* **Guardian-Push-/SMS-Faktoren** — kein Zielmodell; Abschnitt 3.6 kennt TOTP, WebAuthn, Wiederherstellungscodes.
* **`app_metadata`, Organisationen, Roles-API** — außerhalb des Geltungsbereichs (Abschnitt 3.14).
* **`blocked_for[]`** — nicht sinnvoll: Abschnitt 3.9 baut den Zustand selbst neu auf.

#### g) Was der Nutzer danach tun muss

1. **Zuerst den Tarif prüfen.** Ohne bezahlten Tarif gibt es keine Hashes — diese Frage entscheidet die gesamte Strategie und muss vor allem anderen beantwortet sein.
2. PGP-Schlüsselpaar erzeugen, Support-Case eröffnen, Unterschriftenrunde starten — **das ist der lange Pfad und gehört zuerst angestoßen**.
3. Parallel den Profil-Export-Job laufen lassen (Poll und Fetch in einem Rutsch).
4. Trockenlauf auf den Profildaten allein — Kollisionen, Benutzernamenlängen, Identitätskonfiguration klären, solange die Hashes unterwegs sind.
5. Bei Eintreffen des PGP-Exports **sofort** entschlüsseln und Durchgang 2 fahren; der Link lebt 3 Tage und der Zeitpunkt ist nicht planbar (belegt: 2 Uhr nachts am Ostersamstag).
6. Fehlende Nutzer gegen `velve.import_mapping` diffen und je Fehltreffer eine Zeile in `password_reset_required` schreiben (belegter Umfang: ~1.600 von 125.000).
7. Mehrfach-Identitäten aus dem Auth0-Account-Linking prüfen — sie haben in der Praxis zu falsch zusammengeführten Konten geführt.
8. Eigene OAuth-Client-IDs bei allen Anbietern registrieren; die Auth0-Clients sind nach der Umstellung wertlos.
9. Nutzer informieren: Neuanmeldung, teils Kennwort-Reset, MFA je nach Exportlage neu einrichten.

#### h) Fallstricke

1. **Support-Export dauert rund eine Woche** und durchläuft mehrere Support-Level.
2. **Kein Scheduling** — belegter Extremfall: Lieferung nachts an einem Feiertag.
3. **Nutzer fehlen im finalen Export** — ~1.600 von 125.000 brauchten Reset-Mails statt Migration.
4. **Globale Ratenbegrenzung der Management-API:** „we quickly ran into a global rate limit that would not even let our own users log out of our system." Das Limit ist tenant-global und trifft die Produktion — gedrosselt und außerhalb der Spitzenzeit exportieren.
5. **Doppelte E-Mails über Connections hinweg** — siehe Abschnitt 4.0.6.
6. **`identity.provider.split("-")[0]`** ergibt für `google-oauth2` zufällig „google", für `windowslive` oder `oidc`-Connections Unsinn. Better Auth macht genau das (`auth0-migration-guide.mdx:208–212`); Velve Auth benutzt eine Nachschlagetabelle mit harter Ablehnung für Unbekanntes.
7. **Job-Daten verfallen nach 24 h, der Download-Link nach 60 s.**
8. Better Auth behauptet, der Hash-Export sei „only available for Auth0 Enterprise users" (`auth0-migration-guide.mdx:175–176`) — belegt ist nur das Fehlen im Free-Tier. Für die Tarifentscheidung ist der Unterschied erheblich.

---

### 4.4 Firebase Authentication

#### a) Beschaffung

Zwei Teile, die beide gebraucht werden: die Exportdatei **und** vier Parameter, die nicht in ihr stehen.

```
npm i -g firebase-tools && firebase login
firebase auth:export users.json --format=json --project <project-id>
```

**JSON, nicht CSV.** Das CSV-Format (`transUserToArray`, Positionen 0–27, <https://raw.githubusercontent.com/firebase/firebase-tools/master/src/accountExporter.ts>) verliert `mfaInfo` vollständig und kappt bei vier Anbietern pro Nutzer. Die vier Hash-Parameter kommen **von Hand** aus der Console: *Authentication → Users → ⋮ → Password hash parameters* — „All the parameters below can be obtained from the Firebase Console's users section." (<https://firebase.google.com/docs/auth/admin/import-users>)

| Parameter | Bedeutung | typisch |
|---|---|---|
| `base64_signer_key` | projektweiter Signer-Key, wird *verschlüsselt*, nicht als Salt benutzt | 32 Byte |
| `base64_salt_separator` | wird an jedes Account-Salt angehängt | oft `Bw==` |
| `rounds` | scrypts **`r`** (Blockgröße!) | oft `8` |
| `mem_cost` | Exponent für **`N = 2^mem_cost`** | oft `14` |

Ohne diese vier Werte ist der Export wertlos; `probe()` meldet sie in `missingRequiredConfig`, und vor dem Schreiblauf ist ein bestandener `verify()`-Durchlauf gegen einen Testnutzer Pflicht. **Dauer:** SCHÄTZUNG: Export Minuten bis eine Stunde je nach Bestand, Console-Schritt Minuten; der Zeitfresser ist die Parametervalidierung — die aber unbedingt vor die Umstellung gehört.

#### b) Quellschema

`firebase auth:export --format=json`, ein Objekt je Nutzer (Beispiel: <https://fusionauth.io/docs/lifecycle/migrate-users/bulk/firebase>).

| Feld | Typ | Bedeutung |
|---|---|---|
| `localId` | string | Firebase-UID, 28 Zeichen |
| `email` / `emailVerified` | string / boolean | Bestätigungs**status**, kein Zeitpunkt |
| `passwordHash` | string | **Standard-Base64**, 64 Byte roh (88 Zeichen) |
| `salt` | string | **Standard-Base64**, je Konto |
| `displayName`, `photoUrl` | string | Profil |
| `createdAt`, `lastSignedInAt` | string | **Unix-Millisekunden als Zeichenkette**; `lastSignedInAt` heißt in der Quelle `lastLoginAt` |
| `phoneNumber` | string | Telefonnummer |
| `disabled` | boolean | Sperre |
| `customAttributes` | string (JSON) | Custom Claims |
| `providerUserInfo[]` | Objekt[] | `providerId`, `rawId`, `email`, `displayName`, `photoUrl` |
| `mfaInfo[]` | Array | SMS-Faktoren; `SCHÄTZUNG:` `phoneInfo` + `mfaEnrollmentId`, **keine Secrets** |

Die CLI konvertiert `passwordHash` und `salt` von URL-safe in normales Base64 und filtert `providerUserInfo` auf bekannte `providerId`-Werte.

#### c) Zuordnung zum Velve-Auth-Schema

| Quellfeld | Ziel | Transformation |
|---|---|---|
| `localId` | `velve.import_mapping.source_id` | unverändert; **nicht** als `user.id` (kein UUID) |
| — | `velve.user.id` | neu erzeugt |
| `email` | `velve.user.email` | trim, NFKC, `lower()` |
| `emailVerified` | `velve.user.email_verified_at` | `true` → `createdAt`, sonst NULL |
| — | `velve.user.username` / `.username_key` | **NULL** — Firebase kennt keinen Benutzernamen; die Konfigurationen `username`/`username_email` (Abschnitt 3.4) brauchen eine zusätzliche Quelle |
| `disabled` | `velve.user.disabled_at` | `true` → `now()` |
| — | `velve.user.imported_from` / `.imported_at` | `'firebase'` / `now()` |
| `createdAt` | `velve.user.created_at` | `new Date(parseInt(s, 10))`, Plausibilität 2000–2100 |
| `passwordHash` + `salt` + `hash_config` | `velve.password_credential.phc` | `$fbscrypt$`-String nach d), verschlüsselt unter `password-enc` (L-2) |
| — | `velve.password_credential.scheme` | `'fbscrypt'`, Klartext |
| — | `velve.password_credential.key_version` | aktuelle Version des Schlüssels `password-enc` (L-2) |
| `providerUserInfo[].providerId` | `velve.identity.provider` | `.com`-Suffix abschneiden (`google.com`→`google`, `apple.com`→`apple`, …); `password` und `phone` erzeugen **keine** Identität |
| `providerUserInfo[].rawId` | `velve.identity.subject` | unverändert |
| `providerUserInfo[].email` | `velve.identity.provider_email` | `lower()` |
| — | `velve.identity.provider_email_verified` | **`false`** — kein Status je Anbieter im Export; konservativ (Abschnitt 3.10) |
| ganzes `providerUserInfo[i]` | `velve.identity.profile` | als `jsonb` |
| — | `velve.identity.access_token_enc` u. a. | **NULL** — keine Tokens im Export |
| — | `velve.totp_credential`, `velve.recovery_code`, `velve.webauthn_credential` | **keine Zeilen** — siehe f) |
| `mfaInfo[]`, `customAttributes`, `phoneNumber`, `displayName`, `photoUrl`, `lastSignedInAt` | — | kein Zielmodell bzw. außerhalb des Geltungsbereichs |

#### d) Hash-Übernahme

Firebase benutzt „an internally modified version of scrypt" (<https://github.com/firebase/scrypt>). Die Ableitung, belegt über die Referenzimplementierung (<https://raw.githubusercontent.com/nhairs/firebase-scrypt/main/src/firebase_scrypt/firebasescrypt.py>, bestätigt durch <https://gist.github.com/Meldiron/eecf84a0225eccb5a378d45bb27462cc> und die Go-Portierung <https://pkg.go.dev/github.com/Aoang/firebase-scrypt>):

1. `salt_bytes = base64decode(user.salt)`, `sep_bytes = base64decode(base64_salt_separator)`
2. `dk = scrypt(utf8(password), salt_bytes || sep_bytes, N = 2^mem_cost, r = rounds, p = 1, dkLen = 64)`
3. `aesKey = dk[0..32]` — „only use first 32 bytes … to match expected key length"
4. `out = AES-256-CTR(key = aesKey, IV = 16 Nullbytes).encrypt(base64decode(base64_signer_key))`
5. `base64(out)` **zeitkonstant** mit `user.passwordHash` vergleichen

Der Signer-Key wird also *verschlüsselt*, nicht gehasht; das scrypt-Ergebnis ist der AES-Schlüssel. Konstanten: `p = 1`, `KeyLen = 32` („required for AES-256", <https://raw.githubusercontent.com/supabase/auth/master/internal/crypto/password.go>). Die Umwandlung nach Abschnitt 3.3:

```
Firebase: passwordHash(b64) + salt(b64) + hash_config
  → "$fbscrypt$v=1,n=<mem_cost>,r=<rounds>,p=1,ss=<salt_separator>,sk=<signer_key>$<salt_b64>$<hash_b64>"
    scheme = "fbscrypt"

phc = `$fbscrypt$v=1,n=${cfg.mem_cost},r=${cfg.rounds},p=1,` +
      `ss=${cfg.base64_salt_separator},sk=${cfg.base64_signer_key}$` +
      `${toStandardB64(u.salt)}$${toStandardB64(u.passwordHash)}`
```

Das ist bitgleich das Format, das GoTrue verwendet (Regex: `^\$fbscrypt\$v=(?P<v>[0-9]+),n=(?P<n>[0-9]+),r=(?P<r>[0-9]+),p=(?P<p>[0-9]+)(?:,ss=…)?(?:,sk=…)?\$(?P<salt>[^$]+)\$(?P<hash>.+)$`). Der Verifier liest `n` als **Exponent** und rechnet `N = 2^n` — konsistent mit `ln=` im PHC-scrypt-Format.

**Fallstrick 1 — die Parameterverwechslung.** `rounds` ist **nicht** die Iterationszahl, sondern scrypts `r` (Blockgröße); `mem_cost` ist **nicht** der Speicher in Megabyte, sondern der Exponent für `N`. Wer beides vertauscht, bekommt einen Hash, der niemals passt — **ohne Fehlermeldung**. Genau deshalb ist `verify()` mit Testvektor Pflicht.

**Fallstrick 2 — Nodes `maxmem`.** Der Speicherbedarf ist `128 · N · r`; bei `mem_cost = 14`, `rounds = 8` sind das `128 · 16384 · 8 ≈ 16 MiB` — Nodes eingebautes `crypto.scrypt` begrenzt per Default auf `maxmem = 32 MB`, das passt gerade. Bei `mem_cost = 15` sind es 32 MiB und der Aufruf scheitert mit `ERR_CRYPTO_INVALID_SCRYPT_PARAMS`, solange `maxmem` nicht angehoben wird (`{ maxmem: 256*1024*1024 }`). Abschnitt 2.7 schreibt ohnehin `@noble/hashes/scrypt` vor, das diese Grenze nicht kennt — aber der Speicher wird trotzdem belegt, und der KDF-Semaphor aus Abschnitt 3.3 muss `fbscrypt`-Prüfungen mitzählen (16 MiB je Aufruf gegen 19 MiB bei Argon2id).

**Fallstrick 3 — Base64-Variante.** Die CLI liefert Standard-Base64; wer die `identitytoolkit`-REST-API direkt anzapft, bekommt URL-safe Base64 und muss konvertieren. Der PHC-String verlangt Standard-Base64. Nach dem ersten Login ist `needsRehash` wahr und der Hash wandert still auf Argon2id (Abschnitt 3.3, Schritt 6) — der Signer-Key ist danach nur noch für die Reste relevant.

#### e) Was mitkommt

E-Mail und Verifikationsstatus · Sperrzustand · Anlagezeitpunkt · **alle Passwort-Hashes verlustfrei** als `$fbscrypt$` · Anbieterverknüpfungen (`providerId` + `rawId` + E-Mail/Name/Bild).

#### f) Was nicht mitkommt

* **TOTP-Faktoren** — nicht exportierbar: TOTP gibt es nur in Google Cloud Identity Platform, und `UNBELEGT:` es ist kein Beleg gefunden, dass `auth:export` die Shared Secrets ausgibt. Als **nicht migrierbar** einplanen.
* **SMS-Faktoren (`mfaInfo`)** — kein Zielmodell (Abschnitt 3.6).
* **Wiederherstellungscodes und Passkeys** — existieren in Firebase Auth nicht.
* **OAuth-Anbieter-Tokens** — nicht vorhanden im Export.
* **Benutzernamen** — existieren nicht; `username`/`username_email` brauchen eine zusätzliche Datenquelle.
* **Bestätigungs*zeitpunkt* der E-Mail** — nicht exportierbar, nur der Boolean.
* **Custom Claims, Firestore-Rules** — außerhalb des Geltungsbereichs (Abschnitt 3.14); Rules müssen neu geschrieben werden.

#### g) Was der Nutzer danach tun muss

1. Die vier Hash-Parameter aus der Console holen und wie einen Master-Key behandeln — mit dem Signer-Key sind alle Hashes offline angreifbar (in der Praxis schützt scrypt davor, für die Compliance ist es trotzdem ein Geheimnis ersten Ranges).
2. **Vor dem Export** einen Testnutzer mit bekanntem Kennwort anlegen und `verify()` gegen ihn laufen lassen. Ohne bestandenen Testvektor kein Schreiblauf.
3. Trockenlauf; besonders auf `passwords.none` achten — OAuth-only-, Phone- und anonyme Nutzer haben keinen Hash, und das ist der **Normalfall**, kein Fehler.
4. Identitätskonfiguration auf `email` festlegen, sofern keine Benutzernamenquelle existiert.
5. Schreiblauf; danach Anbieter-Client-IDs neu registrieren, die Firebase-OAuth-Clients entfallen.
6. Nutzer mit TOTP informieren: zweiter Faktor muss neu eingerichtet werden.
7. Apple-Nutzer gesondert behandeln: Apple liefert den vollständigen Namen nur beim allerersten Login, für migrierte Nutzer nie wieder (<https://fusionauth.io/docs/lifecycle/migrate-users/bulk/firebase>) — wer Namen braucht, muss sie jetzt aus `displayName` sichern.
8. Signer-Key nach dem vollständigen Rehash aller Nutzer aus der Konfiguration entfernen.

#### h) Fallstricke

1. **`rounds` ↔ `mem_cost` vertauscht** — schlägt lautlos fehl.
2. **Nodes `maxmem`-Grenze** ab `mem_cost >= 15`.
3. **Nutzer ohne `passwordHash` sind normal** (OAuth, Phone, anonym) — kein Fehlerfall.
4. **`createdAt` ist eine Zeichenkette mit Unix-Millisekunden**, nicht ISO-8601.
5. **CSV verliert Daten** — `mfaInfo` fällt weg, Anbieter werden bei vier gekappt. Immer JSON.
6. **Base64-Variante** unterscheidet sich je nach Bezugsweg.
7. **Der Signer-Key ist ein Projektgeheimnis** und landet zwangsläufig in der Migrationskonfiguration.
8. **Kein Better-Auth-Guide als Vergleich** — für die einzige Quelle mit einem wirklich schwierigen Verfahren existiert keine fremde Anleitung, an der man sich prüfen könnte.

---

### 4.5 Auth.js / NextAuth.js

#### a) Beschaffung

Kein Export nötig: Auth.js ist eine Bibliothek, die Daten liegen in der Datenbank des Kunden (<https://authjs.dev/getting-started/adapters/prisma>).

1. Tatsächliches Schema feststellen — es variiert je Adapter: `npx prisma db pull` bzw. `psql "$DB_URL" -c "\d+ users"`.
2. Klären, **wo das Kennwort liegt.** Auth.js hat dafür kein Feld; jedes Projekt hat es selbst gebaut. Der Importer nimmt das als Konfiguration entgegen:
   ```ts
   passwordSource: {
     table: 'users', userIdColumn: 'id', hashColumn: 'passwordHash',
     format: 'phc' | 'bcrypt-mcf' | 'better-auth-scrypt' | 'custom',
     custom?: (raw: string) => PasswordOutcome
   }
   ```
3. Lesen: `psql "$DB_URL" -c "\copy (SELECT id, name, email, \"emailVerified\", image FROM users ORDER BY id) TO 'users.csv' CSV HEADER"`, analog für `accounts` und `authenticators`.

**Dauer:** SCHÄTZUNG: Minuten für den Abzug; der Aufwand liegt vollständig in Schritt 2.

#### b) Quellschema

Drizzle/Postgres-Referenz (<https://raw.githubusercontent.com/nextauthjs/next-auth/main/packages/adapter-drizzle/src/lib/pg.ts>).

| Feld | Typ | Bedeutung |
|---|---|---|
| `users.id` | `text` PK | Default `crypto.randomUUID()` (Drizzle) bzw. `cuid` (Prisma) |
| `users.name` / `users.image` | `text` | Anzeigename / Bild |
| `users.email` | `text` UNIQUE | **optional** |
| `users.emailVerified` | `timestamp` | **Zeitstempel**, kein Boolean |
| `accounts.userId` | `text` → `users.id` | FK, `ON DELETE CASCADE` |
| `accounts.type` | `text` | `oauth` / `oidc` / `email` / `credentials` |
| `accounts.provider` / `.providerAccountId` | `text` | Anbietername / **Subject beim Anbieter** |
| `accounts.refresh_token` / `.access_token` / `.id_token` | `text` | Anbieter-Tokens |
| `accounts.expires_at` | `integer` | Unix-**Sekunden** |
| `accounts.token_type` / `.scope` / `.session_state` | `text` | |
| `sessions.sessionToken` / `.userId` / `.expires` | `text`/`text`/`timestamp` | nur bei `strategy: "database"` |
| `verificationTokens.identifier` / `.token` / `.expires` | `text`/`text`/`timestamp` | Einmal-Token |
| `authenticators.credentialID` | `text` UNIQUE | Passkey-ID |
| `authenticators.userId` / `.providerAccountId` | `text` | FK / Anbieterkonto |
| `authenticators.credentialPublicKey` | `text` | Public Key |
| `authenticators.counter` | `integer` | Signaturzähler |
| `authenticators.credentialDeviceType` | `text` | `singleDevice` / `multiDevice` |
| `authenticators.credentialBackedUp` | `boolean` | Sicherungszustand |
| `authenticators.transports` | `text` | kommaseparierte Liste |
| *(projektspezifisch)* | | Kennwort-Hash-Spalte, siehe a) |

Prisma nutzt `id` als PK für `Account`, Drizzle einen zusammengesetzten PK `(provider, providerAccountId)` und hat gar kein `Account.id` — der Reader muss beide Layouts vertragen.

#### c) Zuordnung zum Velve-Auth-Schema

| Quellfeld | Ziel | Transformation |
|---|---|---|
| `users.id` | `velve.import_mapping.source_id` | unverändert |
| `users.id` | `velve.user.id` | **übernehmen, wenn UUID** (Drizzle-Default); bei `cuid` neu erzeugen (Abschnitt 4.0.7) |
| `users.email` | `velve.user.email` | trim, NFKC, `lower()`; kann NULL sein |
| `users.emailVerified` | `velve.user.email_verified_at` | **direkt übernehmen** — hier ist ausnahmsweise ein echter Zeitstempel vorhanden |
| *(projektspezifisch)* | `velve.user.username` / `.username_key` | nur, wenn das Projekt eine Benutzernamenspalte hat |
| — | `velve.user.disabled_at` | **NULL** — Auth.js kennt keinen Sperrzustand |
| — | `velve.user.imported_from` / `.imported_at` | `'nextauth'` / `now()` |
| — | `velve.user.created_at` / `.updated_at` | `now()` — weder das Drizzle- noch das Prisma-Referenzschema führt `createdAt`; eine projektspezifische Spalte wird wie die Hash-Spalte konfiguriert |
| Hash-Spalte | `velve.password_credential.phc` / `.scheme` | PHC-String nach d), verschlüsselt unter `password-enc` (L-2) / Klartext |
| — | `velve.password_credential.key_version` | aktuelle Version des Schlüssels `password-enc` (L-2) |
| `accounts.provider` (bei `type ∈ {oauth,oidc}`) | `velve.identity.provider` | unverändert; `type = 'credentials'` erzeugt **keine** Identität |
| `accounts.providerAccountId` | `velve.identity.subject` | unverändert |
| — | `velve.identity.provider_email` / `.provider_email_verified` | NULL / `false` — Auth.js speichert sie nicht je Account |
| `accounts` (ganze Zeile) | `velve.identity.profile` | als `jsonb` |
| `accounts.scope` | `velve.identity.scopes` | Split auf Leerzeichen |
| `accounts.refresh_token` | `velve.identity.refresh_token_enc` | **übernehmen**, AES-256-GCM unter `KeyProvider('oauth-token-enc')` |
| `accounts.access_token` | `velve.identity.access_token_enc` | dito, nur wenn `expires_at` in der Zukunft |
| `accounts.id_token` | `velve.identity.id_token_enc` | nur bei `storeTokens: true`; Momentaufnahme, meist wertlos |
| — | `velve.identity.token_key_version` | aktuelle Schlüsselversion |
| `accounts.expires_at` | `velve.identity.token_expires_at` | `new Date(sec * 1000)` |
| `authenticators.credentialID` / `.credentialPublicKey` | `velve.webauthn_credential.credential_id` / `.public_key` | base64url → `bytea` |
| `authenticators.counter` | `.sign_count` | Zahl → `bigint` |
| `authenticators.transports` | `.transports` | `split(',')` → `text[]` |
| `authenticators.credentialDeviceType` | `.backup_eligible` | `=== 'multiDevice'` |
| `authenticators.credentialBackedUp` | `.backup_state` | unverändert |
| — | `.user_verified_at_registration` / `.aaguid` | **`false`** / **NULL** — Auth.js speichert beides nicht; verlustbehaftet (f) |
| `authenticators.userId` | `.user_id` | über `import_mapping` |
| — | `velve.totp_credential`, `velve.recovery_code` | **keine Zeilen** — Auth.js-Core hat kein TOTP; ein selbstgebauter Faktor ist ein Sonderfall für einen projektspezifischen Hook |
| `sessions.*`, `verificationTokens.*`, `users.name`, `users.image` | — | verwerfen (f) bzw. außerhalb des Geltungsbereichs |

#### d) Hash-Übernahme

**Auth.js hasht keine Kennwörter.** Wörtlich: „By default, the Credentials provider does not persist data in the database. However, you can still create and save any data in your database, you just have to provide the necessary logic, eg. to encrypt passwords …" (<https://authjs.dev/getting-started/authentication/credentials>). Es gibt folglich kein Auth.js-Passwortformat, das ein Importer fest verdrahten könnte — nur einen konfigurierbaren Ablesepfad und eine Formatangabe. Vier Formate beherrscht der Importer ohne Zusatzcode:

```
bcryptjs/bcrypt:  "$2a$10$<22><31>" bzw. "$2b$…"            → unverändert, scheme = "bcrypt"
argon2/@node-rs:  "$argon2id$v=19$m=…,t=…,p=…$<s_b64>$<h_b64>" → unverändert, scheme = "argon2id"
PHC-scrypt:       "$scrypt$ln=…,r=…,p=…$<s_b64>$<h_b64>"     → unverändert, scheme = "scrypt"
Better-Auth-Stil "salt_hex:hash_hex":
  → "$scrypt$ln=14,r=16,p=1$" + b64(ascii(salt_hex)) + "$" + b64(hexToBytes(hash_hex))
    scheme = "scrypt"          (N = 16384 = 2^14, r = 16, p = 1, dkLen = 64; Abschnitt 3.3)
```

Zwei Eigenheiten des Better-Auth-Formats, belegt in `@better-auth/utils` (Befundbericht `findings/06-krypto-bibliotheken.md`, „Die präfixlosen Formate"): Das Salt geht als **ASCII-Hex-String von 32 Byte** in scrypt ein, nicht als die 16 dekodierten Bytes — deshalb `ascii(salt_hex)` und nicht `hexToBytes(salt_hex)`. Und das Kennwort wird vor dem Aufruf **NFKC-normalisiert** (`password.normalize("NFKC")`, `packages/better-auth/src/crypto/password.test.ts:75–76`). `Abschnitt 3.3 legt NFKC vor jedem KDF-Aufruf fest; umgewandelte Better-Auth-Hashes verifizieren damit auch für Kennwörter außerhalb von ASCII. Der `verify()`-Testvektor für dieses Format muss deshalb ein Nicht-ASCII-Kennwort enthalten.

Alles andere geht über `passwordSource.custom`, eine reine Funktion `(raw: string) => PasswordOutcome`. Sie darf nur in einen der PHC-Strings aus Abschnitt 3.3 münden oder `unusable` zurückgeben — sie darf **kein** neues Format erfinden. `SCHÄTZUNG:` bcrypt über `bcryptjs` ist in Auth.js-Projekten am verbreitetsten; belegt ist das nicht. `verify()` ist auch hier Pflicht: Ein selbstgebautes Kennwortfeld ist die fehleranfälligste aller fünf Quellen, weil niemand außer dem Projekt weiß, was drin steht.

#### e) Was mitkommt

Nutzer-IDs (bei UUID-Adaptern unverändert) · E-Mail und **echter Bestätigungszeitpunkt** · Kennwort-Hashes bei unterstütztem Format · Anbieterverknüpfungen mit Scopes · **Refresh-Tokens** — der einzige Fall unter den fünf Quellen, in dem Anbieter-Tokens ihren Wert behalten, weil die OAuth-Client-ID beim Bibliothekswechsel dieselbe bleiben kann (anders als bei Auth0 oder Clerk, wo sie auf den Anbieter registriert ist) · **Passkeys vollständig** (`credentialID`, `credentialPublicKey`, `counter`, `credentialDeviceType`, `credentialBackedUp`, `transports`); der `counter` muss zwingend mitwandern, sonst schlägt die Replay-Prüfung fehl.

#### f) Was nicht mitkommt

* **Passkeys bei Domainwechsel** — technisch unmöglich, RP-ID-Bindung.
* **`user_verified_at_registration` und `aaguid`** — nicht exportierbar; Auth.js speichert beides nicht, in Abschnitt 3.2 ist Ersteres `NOT NULL` → konservativ `false`. Eine Anwendung, die darauf eine Richtlinie stützt, muss importierte Credentials gesondert behandeln.
* **Aktive Sessions** — nicht sinnvoll: Bei `strategy: "jwt"` (Default in v5) gibt es gar keine Zeilen; bei Datenbank-Sessions ist das Tokenformat ein anderes. „Due to different session management methods, existing users need to re-login after migration." (<https://dev.to/pipipi-dev/nextauthjs-to-better-auth-why-i-switched-auth-libraries-31h3>)
* **`verificationTokens`** — technisch übertragbar, aber nicht sinnvoll: Abschnitt 3.7 vergibt eigene Einmal-Artefakte.
* **`id_token`, abgelaufene `access_token`, `session_state`** — praktisch wertlos bzw. kein Zielfeld.
* **TOTP / zweiter Faktor** — nicht standardisiert; Auth.js-Core hat kein TOTP, das Format ist projektspezifisch (`UNBELEGT:`).
* **Sperrzustand** — existiert in Auth.js nicht.
* **`users.name`, `users.image`** — außerhalb des Geltungsbereichs (Abschnitt 3.14).

#### g) Was der Nutzer danach tun muss

1. Tatsächliches Schema feststellen — Feldnamen unterscheiden sich zwischen Adaptern (`sessionToken` vs. `token`, `expires` vs. `expiresAt`, `providerAccountId` vs. `accountId`).
2. Eigenes Kennwortformat dokumentieren und einen Testvektor bereitstellen.
3. Prüfen, ob `users.id` überall eine UUID ist. Wenn ja: `preserveIds: true`, alle Anwendungs-Fremdschlüssel bleiben gültig. Bei `cuid`: neue IDs, und die Fremdschlüssel müssen über `velve.import_mapping` umgeschrieben werden — der aufwendigste Teil.
4. Prüfen, ob die RP-ID unverändert bleibt; wenn nein, Passkeys nicht importieren und Nutzer zur Neuregistrierung auffordern.
5. Entscheiden, ob Anbieter-Tokens gebraucht werden — `storeTokens: false` ist der Standard (Abschnitt 3.10).
6. Trockenlauf; besonders auf Nutzer ohne E-Mail achten: `users.email` ist optional, die Konfiguration `email` (Abschnitt 3.4) verlangt sie.
7. Schreiblauf.
8. OAuth-Client-IDs **beibehalten**, sonst werden die migrierten Refresh-Tokens wertlos.
9. Nutzer informieren: Neuanmeldung nötig, Kennwörter und Passkeys bleiben gültig.

#### h) Fallstricke

1. **Zwei Adapter-Konventionen** — Prisma hat `Account.id`, Drizzle nicht; Tabellennamen schwanken zwischen `User` und `users`. Fest verdrahtete Namen scheitern an der Hälfte der Projekte.
2. **`emailVerified` ist `DateTime?`, kein Boolean** — wer es auf ein Boolean abbildet, verliert das Datum. Velve Auth übernimmt den Zeitstempel direkt; die einzige Quelle, bei der das geht.
3. **`users.email` ist optional** — Zielsysteme mit `NOT NULL` brechen; in Velve Auth entscheidet das die Identitätskonfiguration.
4. **JWT-Sessions hinterlassen keine Spur** — nach der Umstellung sind alle Cookies ungültig, ohne dass eine Tabelle das anzeigt.
5. **v4 vs. v5 ändert das Schema nicht** („v5 does not introduce any breaking changes to the database schema", <https://authjs.dev/getting-started/migrate-to-better-auth>) — die Konfiguration schon.
6. **`counter` nicht vergessen** — ein auf 0 zurückgesetzter Signaturzähler lässt Abschnitt 3.6 einen Klon-Verdacht melden.
7. **Better Auth liefert für Auth.js kein Datenmigrationsskript**, nur eine Schema-Gegenüberstellung (`next-auth-migration-guide.mdx`, 795 Zeilen) — es gibt hier keine fremde Vorlage zum Gegenprüfen.

---

### 4.6 Vergleich mit Better Auths Migrationsweg

Better Auth empfiehlt in **allen drei** Passwort-Guides, den globalen Hash-Hook auf bcrypt umzustellen — Supabase: `docs/content/docs/guides/supabase-migration-guide.mdx:969–971` („By default, Better Auth uses the `scrypt` algorithm to hash passwords. Since Supabase uses `bcrypt`, you'll need to configure Better Auth to use bcrypt for password verification.", gefolgt von einem `password.hash`/`password.verify`-Paar mit `bcrypt.hash(password, 10)`), wortgleich in `auth0-migration-guide.mdx:595` und `:608–617`, sinngleich in `clerk-migration-guide.mdx:47` und `:61–74`. Das ist aus vier Gründen falsch. **Erstens ist der Hook global und nicht pro Datensatz:** Er wird auch für Neuregistrierungen und jede Kennwortänderung verwendet, aus einer einmaligen Übernahmemaßnahme wird also ein dauerhafter Downgrade des Standardverfahrens — das Projekt hängt für immer und für alle Nutzer auf bcrypt(10), und die Guides erwähnen das nirgends. **Zweitens funktioniert es nur bei homogenen Beständen:** Ein Supabase-Tenant kann drei Hash-Familien enthalten (<https://github.com/supabase/auth/issues/1750>), ein Clerk-Tenant bis zu 19 (<https://clerk.com/docs/reference/backend/user/create-user>), ein Auth0-Tenant elf (<https://auth0.com/docs/manage-users/user-migration/bulk-user-import-database-schema-and-examples>); ein reiner bcrypt-Hook scheitert an jedem Datensatz, der nicht bcrypt ist — als Anmeldefehler ohne Erklärung. Der Auth0-Guide erkennt das halb und schiebt es dem Leser zu („For custom password hashing algorithms, you'll need to modify the `migratePassword` function", `auth0-migration-guide.mdx:588`, sinngleich nochmals `:713`). **Drittens fehlt der Rehash:** Weil der globale Hook das Verfahren zur neuen Konstante macht, gibt es keinen Weg zurück; die importierten Hashes werden nie besser, auch nicht nach Jahren. **Viertens zementiert es eine bekannte Schwäche:** bcrypt schneidet Eingaben bei 72 Byte ab, und wer global auf bcrypt bleibt, behält diese Kürzung dauerhaft, statt sie beim ersten Login loszuwerden. — **Velve Auth macht stattdessen dreierlei:** Das Verfahren steht *pro Datensatz* im kanonischen PHC-String, die Weiche entscheidet am Präfix (Abschnitt 3.3), und der Standard bleibt unverändert Argon2id — ein Import ändert die Kennwortpolitik der Anwendung nicht. Beim ersten erfolgreichen Login ist `needsRehash` für jeden Fremd-Hash wahr, und der Datensatz wird still, ohne Nutzerinteraktion, per Vergleich-und-Tausch auf Argon2id gehoben (Abschnitt 3.3, Schritt 6, und Abschnitt 4.6). Ein Bestand mit drei oder neunzehn Verfahren ist damit kein Problem, sondern eine Statistik, die der Trockenlauf ausweist und die in den Wochen nach der Umstellung gegen null geht. Ergänzend: Better Auth hat **für Firebase überhaupt keinen Guide** — es gibt Anleitungen für Supabase, Clerk, Auth0, Auth.js und WorkOS, aber ausgerechnet für die einzige Quelle mit einem nicht-trivialen Hash-Verfahren keine (Befundbericht `findings/05-migrationsquellen.md`, Abschnitt 6).

---

### 4.7 Zusammenfassung über alle fünf Quellen

| Quelle | Hashes exportierbar? | Hash-Verfahren | Von Velve verifizierbar? | 2FA übernehmbar? | OAuth-Verknüpfungen übernehmbar? | Aufwand (SCHÄTZUNG) |
|---|---|---|---|---|---|---|
| **Supabase** | **ja**, trivial (`SELECT` auf `auth.users`) | bcrypt(10); zusätzlich argon2i/argon2id und `$fbscrypt$` möglich | **ja, alle drei Familien, ohne Umrechnung** | TOTP nur bei unverschlüsseltem `mfa_factors.secret` oder vorliegendem GoTrue-Schlüssel — auf Managed-Supabase meist nicht; Passkeys technisch ja, aber ohne BE/BS-Flags; keine Wiederherstellungscodes | **ja** (`provider` + `provider_id`); Tokens existieren nicht | **1–3 Personentage** plus RLS-Umbau, der je nach Projekt ein Vielfaches sein kann |
| **Clerk** | **ja**, self-service seit 2024-10-23 (Dashboard-CSV) | bcrypt; beim Import bis zu 19 Verfahren zulässig | **8 von 19 sicher** (bcrypt, argon2i/id, pbkdf2\_sha256/\_django/\_sha512/\_sha512\_hex, scrypt\_werkzeug); `scrypt_firebase` nur mit Fremdparametern; 10 nicht | **TOTP ja** (`totp_secret` im Klartext in der CSV); Backup-Codes nein; Passkeys `UNBELEGT:` nein | **ja** (`external_accounts`); Tokens nein | **2–4 Personentage** (CSV + API joinen, RFC-4180-Parser, Nachzügler-Abgleich) |
| **Auth0** | **nein** über API; nur Support-Ticket mit PGP-Key, Zweit-Admin und CISO-Unterschrift, **nicht im Free-Tier** | bcrypt `$2a$`/`$2b$`, 10 Runden; `custom_password_hash` mit 11 Algorithmen | bcrypt, argon2, scrypt **ja**; pbkdf2 bedingt; hmac, ldap, md4, md5, sha1, sha256, sha512 **nein** | TOTP-Secrets im PGP-Export (`UNBELEGT:` Struktur); Wiederherstellungscodes nein; Passkeys `UNBELEGT:` nein | **ja** (`identities[]`); Tokens vorhanden, aber praktisch wertlos | **3–8 Personentage aktive Arbeit, 2–6 Wochen Kalenderzeit** wegen des Support-Prozesses; im Free-Tier: Reset-Kampagne für 100 % der Nutzer |
| **Firebase** | **ja**, im CLI-Export enthalten | modifiziertes scrypt (scrypt → AES-256-CTR über den Signer-Key) | **ja, vollständig**, als `$fbscrypt$` — dasselbe Format, das GoTrue verwendet | **nein**: TOTP nur in Cloud Identity Platform und `UNBELEGT:` nicht im Export; SMS-Faktoren ohne Zielmodell; keine Wiederherstellungscodes; keine Passkeys | **ja** (`providerUserInfo[]`); Tokens existieren nicht | **2–4 Personentage**, davon ein erheblicher Anteil auf die Validierung der vier Hash-Parameter |
| **Auth.js / NextAuth** | n/a — eigene Datenbank, voller Zugriff | **keins** (Auth.js hasht nicht); was da ist, hat das Projekt selbst gebaut | Projektabhängig: bcrypt, argon2, PHC-scrypt und Better-Auth-`salt:hash` **ja**, alles andere über einen eigenen Mapper oder gar nicht | Kein TOTP im Core (projektspezifisch, `UNBELEGT:`); **Passkeys vollständig übernehmbar** bei gleicher RP-ID | **ja** (`accounts`); **Refresh-Tokens behalten ihren Wert** — einzige Quelle, bei der das gilt | **1–3 Personentage**, sofern die IDs UUIDs sind; bei `cuid`-IDs plus Umschreiben aller Anwendungs-Fremdschlüssel |

**Quer über alle fünf gilt:** Aktive Sessions gehen immer verloren, jede Migration erzwingt eine Neuanmeldung aller Nutzer, und alle Einmal-Token werden verworfen. Das gehört in den Kommunikationsplan, nicht in eine Fußnote.

---

## 5. Sicherheitsanforderungen

Dieser Abschnitt übersetzt die Entscheidungen der Zielarchitektur (Abschnitt 3) in durchnummerierte, prüfbare Anforderungen. Jede Anforderung ist eine Behauptung über das fertige System im Indikativ und nennt in Klammern die Stelle in Abschnitt 3, aus der sie folgt. Abschnitt 6 ordnet jeder Anforderung mindestens einen Testfall zu.

Gliederung je Fehlerklasse: **(a)** was mechanisch schiefgeht, **(b)** der Präzedenzfall mit GHSA/CVE, **(c)** die Anforderungen `S-<Klasse>-<Nr>`. Grundlage der Präzedenzfälle ist der Recherchebericht `findings/07-sicherheit.md` (33 Better-Auth-Advisories, Referenz-Codebasis `better-auth` @ `e025ce6`, Paketversion 1.7.3); die CVSS-Werte und Fix-Versionen wurden gegen die GitHub-Advisory-Datenbank geprüft.

Der Entwurf wird hier **nicht** geändert. Wo die Ausarbeitung eine Lücke in der Zielarchitektur freigelegt hat, ist sie in Abschnitt 3.16 als L-1 bis L-13 entschieden; Abschnitt 5.20 ordnet diese Entscheidungen den betroffenen Anforderungen zu.

---

### 5.1 TIM — Zeitangriffe

**(a) Die Fehlerklasse.** Konstante Laufzeit ist keine Eigenschaft der Vergleichsfunktion, sondern des gesamten Request-Pfades. Ein früher `return`, bevor das KDF läuft, erzeugt ein Signal von 50–250 ms und ist über das Netz mit wenigen Dutzend Messungen sichtbar; ein Early-Exit-Stringvergleich auf einem Geheimnis erzeugt ein Sub-Nanosekunden-Signal, das nur ein In-Process-Angreifer verwertet. Dazwischen liegen datenabhängige Datenbankpfade (Index-Treffer vs. Fehltreffer, zusätzlicher Join) im Bereich 0,1–2 ms. Der Angreifer nutzt das Signal nicht, um ein Passwort zu raten, sondern um eine Liste von 10 Mio. Adressen auf die paar Tausend zu reduzieren, die bei diesem Dienst tatsächlich Konten haben.

**(b) Der Präzedenzfall.** Better Auth ruft bei fehlendem Benutzer bewusst `ctx.context.password.hash(password)` auf (`packages/better-auth/src/api/routes/sign-in.ts:537-546`, mit Kommentar „Hash password to prevent timing attacks"), verwendet dabei aber `hash()` statt `verify()` — unterschiedliche Kosten, weil `hash()` zusätzlich Salz erzeugt und `verify()` den PHC-String parst. Schwerwiegender: der Zweig `requireEmailVerification && !user.emailVerified` (`sign-in.ts:569-597`) läuft **nach** dem Passwort-Verify und kann einen E-Mail-Versand auslösen — ein Zeit- *und* Statuscode-Leck gleichzeitig. `constantTimeEqual` (`packages/better-auth/src/crypto/buffer.ts:4-24`) ist korrekt implementiert, wird im Kernpaket aber nur in den OTP-Modulen benutzt (`plugins/email-otp/otp-token.ts`, `plugins/two-factor/otp/index.ts:366`); der Session-Token-Vergleich läuft über einen Lookup auf einer Klartextspalte.

**(c) Die Anforderungen.**

- **S-TIM-1:** Jeder Kennwort-annehmende Endpunkt durchläuft für existierende und nicht existierende Kennungen dieselbe Folge von Datenbank- und KDF-Aufrufen in derselben Reihenfolge; nach der Längenprüfung (Schritt 1, die nur von der Eingabe abhängt) gibt es zwischen Schritt 2 und Schritt 4 der Prüfsequenz kein `return` und kein `throw`, der Fehlerzustand wird in einer lokalen Variablen akkumuliert. *(Abschnitt 3.3, Ablauf einer Kennwortprüfung, Schritte 1–4: „Der Codepfad ist derselbe.")*
- **S-TIM-2:** Existiert zur eingegebenen Kennung kein Nutzer, prüft der Kern gegen einen Dummy-PHC, dessen Verfahren und Parameter (`m = 19456`, `t = 2`, `p = 1`, 16 Byte Salz, 32 Byte Ausgabe) mit den konfigurierten Standardparametern identisch sind, und ruft dabei denselben Verifier auf, den der Echtpfad aufruft — nicht die Erzeugungsfunktion. *(Abschnitt 3.3 Schritt 2 und Standardparameter-Absatz)*
- **S-TIM-3:** Der Vergleich des KDF-Ergebnisses erfolgt zeitkonstant über gleich lange Puffer; die Bibliothek enthält keinen `===`-, `==`-, `startsWith`-, `includes`- oder `localeCompare`-Vergleich auf einem Wert vom Typ `Secret<…>`. *(Abschnitt 3.3 Schritt 3: „Ergebnis zeitkonstant vergleichen")*
- **S-TIM-4:** Die Auflösung einer Sitzung schlägt ausschließlich `sha256(token)` nach; der Klartext-Token wird nie als Datenbankprädikat verwendet, sodass die Lookup-Zeit nicht vom Klartext-Token abhängt. *(Abschnitt 3.5, „Gespeichert wird nur `sha256(token)`"; Schema `velve.session.token_sha256` mit `UNIQUE`)*
- **S-TIM-5:** Der Rehash nach erfolgreicher Anmeldung (`needsRehash`) läuft in einer Hintergrundaufgabe **nach** dem Senden der Antwort und verlängert die gemessene Antwortzeit des Anmeldevorgangs nicht. *(Abschnitt 3.3 Schritt 6: „nach dem Senden der Antwort in einer begrenzten Hintergrundaufgabe")*
- **S-TIM-6:** Jeder Endpunkt, dessen Antwort für existierende und nicht existierende Konten identisch sein muss, hat genau einen Codepfad, der unabhängig vom Ergebnis dieselbe Arbeit verrichtet: bei Kennwortendpunkten ein KDF-Aufruf mit identischen Parametern (S-TIM-2), bei Endpunkten ohne KDF — Reset anfordern, Magic Link anfordern; die Bestätigung wird nur aus einer Sitzung angefordert und hat keinen Nichtexistenz-Zweig (B.5) — dieselbe Folge von Datenbankabfragen und in jedem Fall genau ein Aufruf des Sende-Callbacks, in dem sich erst entscheidet, welche Nachricht herausgeht. Der kontobezogene Ratenzähler wird für beide Fälle auf derselben Zeile fortgeschrieben (S-RATE-7). Es existiert keine konfigurierbare Mindestantwortdauer. *(Abschnitt 3.16, L-1; Abschnitt 3.13: „Serverseitig wird der wahre Grund immer protokolliert")*
- **S-TIM-7:** Der Zustand `email_verified_at IS NULL` beeinflusst die Anmeldung nicht: Sie liefert dieselbe Sitzung wie bei bestätigter Adresse, und der Zustand ist ausschließlich als `User.emailVerifiedAt` im Ergebnis sichtbar. Eine Sperre unbestätigter Konten gibt es nicht (Abschnitt 1, A5). *(Abschnitt 3.15, B.1 und B.5)*

### 5.2 FIX — Sitzungsfixierung

**(a) Die Fehlerklasse.** Fixierung liegt vor, wenn ein Sitzungsbezeichner, den der Angreifer kennt, einen Wechsel der Vertrauensstufe überlebt. Bei undurchsichtigen Datenbank-Tokens fällt die klassische URL-Variante weg; es bleiben drei reale Wege: eine anonyme Zeile wird per `UPDATE session SET user_id` zur authentifizierten Zeile befördert; ein Privilegienwechsel (Abschluss des zweiten Faktors, Kennwortänderung) ändert nur ein Feld statt die Zeile zu ersetzen; oder das alte Cookie überlebt, weil das neue einen anderen `Path` oder `Domain` trägt und der Browser beide sendet.

**(b) Der Präzedenzfall.** Better Auth erzeugt beim Abschluss des zweiten Faktors korrekt eine neue Sitzung (`packages/better-auth/src/plugins/two-factor/verify-two-factor.ts:83`). Es setzt jedoch nirgends das `__Host-`-Präfix: `HOST_COOKIE_PREFIX` existiert in `packages/better-auth/src/cookies/cookie-utils.ts:35`, wird aber nur beim *Entfernen* von Präfixen gelesen, während `createCookieGetter` (`packages/better-auth/src/cookies/index.ts:75`) ausschließlich `__Secure-` setzt. Cookie-Tossing aus einer Subdomain ist damit nicht strukturell verhindert. Die verwandte Ausprägung ist GHSA-wmjr-v86c-m9jj (2.0 Low): der Multi-Session-Signout-Hook reichte rohe Cookie-Werte ungeprüft an `internalAdapter.deleteSessions` weiter.

**(c) Die Anforderungen.**

- **S-FIX-1:** Jede Anmeldung, jeder Abschluss des zweiten Faktors, jede Kennwortänderung und jede Verknüpfung einer neuen Identität erzeugt eine neue Zeile in `velve.session` mit einem neu erzeugten Token und löscht die vorherige Zeile in **derselben** Transaktion. *(Abschnitt 3.5, „Neuvergabe … Immer als `INSERT` einer neuen Zeile plus `DELETE` der alten in einer Transaktion")*
- **S-FIX-2:** Die Bibliothek enthält keine Anweisung, die `velve.session.user_id` aktualisiert; eine Lint-Regel weist einen solchen Aufruf im Quelltext zurück und ein Datenbank-Trigger weist ein `UPDATE` auf dieser Spalte zur Laufzeit mit einem Fehler ab. *(Abschnitt 3.5: „Ein `UPDATE velve.session SET user_id` existiert nicht und wird per Lint-Regel und Datenbank-Trigger verhindert")*
- **S-FIX-3:** Nach jedem der in S-FIX-1 genannten Ereignisse liefert eine Anfrage mit dem vorherigen Token dieselbe Antwort wie eine Anfrage ohne Cookie, und `SELECT count(*) FROM velve.session WHERE token_sha256 = sha256($alt)` ergibt 0. *(Abschnitt 3.5, Widerruf und Neuvergabe)*
- **S-FIX-4:** Der Zustand zwischen korrektem Kennwort und zweitem Faktor ist keine Zeile in `velve.session`, sondern eine Zeile in `velve.pending_authentication` mit eigenem Token in einem eigenen Cookie. *(Abschnitt 3.6, erster Absatz)*
- **S-FIX-5:** Der Sitzungscookie trägt in jeder Antwort den Namen `__Host-velve_session`, kein `Domain`-Attribut und `Path=/`; der Server setzt für den Sitzungscookie in einer Antwort niemals mehr als einen `Set-Cookie`-Kopfeintrag. *(Abschnitt 3.5, Cookie-Absatz)*
- **S-FIX-6:** Kennwort-Reset und Kennwortänderung widerrufen alle anderen Sitzungen des Nutzers; es existiert keine Konfigurationsoption, die dieses Verhalten abschaltet. *(Abschnitt 3.5: „Das ist kein Schalter.")*

---

### 5.3 ENUM — Benutzeraufzählung

**(a) Die Fehlerklasse.** Ein Aufzählungsorakel ist jede beobachtbare Größe, die zwischen „Konto existiert" und „Konto existiert nicht" unterscheidet: Statuscode, Fehlercode, `Content-Length`, ein `Set-Cookie` nur im einen Fall, ein `Retry-After` nur im einen Fall, die Antwortzeit, oder die Nebenwirkung „E-Mail geht nur bei existierendem Konto raus". Am häufigsten übersehen werden zwei: der kontobasierte Ratenzähler, der nur bei existierenden Konten anschlägt, und der E-Mail-Wechsel, der mit „Adresse bereits vergeben" antwortet.

**(b) Der Präzedenzfall.** Better Auths `/forget-password` ist vorbildlich uniform (`packages/better-auth/src/api/routes/password.ts:114-118` und `:331-333`). Im selben Projekt liefert `/sign-in/email` bei aktiviertem `requireEmailVerification` für existierende, unbestätigte Konten **403 `EMAIL_NOT_VERIFIED`** und sonst **401 `INVALID_EMAIL_OR_PASSWORD`** (`packages/better-auth/src/api/routes/sign-in.ts:569-597`) — ein voll funktionsfähiges Orakel, das zudem erst nach dem Kennwort-Verify greift. Ergänzend wirft `packages/better-auth/src/api/routes/sign-up.ts:331` weiterhin `USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL`, obwohl derselbe Endpunkt an anderer Stelle eine opake Erfolgsantwort dokumentiert (`sign-up.ts:249`).

**(c) Die Anforderungen.**

- **S-ENUM-1:** `POST /sign-in/password` liefert für eine existierende und eine nicht existierende Kennung bei falschem Kennwort identische HTTP-Status, identische Kopfzeilenmenge (nach Entfernen von `Date`) und byteweise identische Antwortkörper. *(Abschnitt 3.13: „byteweise identische Antworten — gleicher Status, gleiche Kopfzeilen, gleicher Körper")*
- **S-ENUM-2:** `POST /sign-in/password` liefert für die Kontozustände *nicht vorhanden*, *vorhanden und unbestätigt*, *vorhanden und bestätigt*, *vorhanden und deaktiviert*, *vorhanden ohne `password_credential`* bei falschem Kennwort dieselbe Antwort; ein deaktiviertes Konto liefert diese Antwort auch bei korrektem Kennwort, und der Code `account_disabled` erscheint bei keiner Anmeldung, sondern nur bei der Auflösung einer bestehenden Sitzung. *(Abschnitt 3.16, L-4; Abschnitt 3.13; Abschnitt 3.3 Schritt 4: „einheitliche Antwort, kein Hinweis auf die Ursache")*
- **S-ENUM-3:** `POST /sign-up` liefert für eine bereits vergebene und eine freie E-Mail identische HTTP-Status, identische Kopfzeilen und byteweise identische Antwortkörper. *(Abschnitt 3.13, Absatz „Registrierung mit bereits vergebener E-Mail")*
- **S-ENUM-4:** Bei `POST /sign-up` mit bereits vergebener E-Mail versendet der Kern genau eine Nachricht an die vorhandene Adresse, die einen Anmeldelink statt eines Bestätigungslinks enthält; die Anzahl versendeter Nachrichten ist in beiden Fällen gleich. *(Abschnitt 3.13: „an die vorhandene Adresse geht eine Nachricht … mit einem Anmelde- statt Bestätigungslink")*
- **S-ENUM-5:** `POST /password/request-reset` und `POST /email/request-change` liefern für existierende und nicht existierende Zieladressen byteweise identische Antworten; eine Kollision beim E-Mail-Wechsel wird erst beim Einlösen des Tokens erkannt und dort mit derselben Antwort wie ein ungültiger Token (`invalid_token`) verworfen. *(Abschnitt 3.13, Aufzählung der vier uniformen Flüsse; Abschnitt 3.15 F.1, innere Ursache `email_taken_on_change`)*
- **S-ENUM-6:** Der wahre Fehlergrund wird bei jedem abgewiesenen Anmeldeversuch serverseitig protokolliert, und der Unterschied zwischen protokolliertem und ausgeliefertem Grund entsteht an genau einer Stelle im Quelltext. *(Abschnitt 3.13, letzter Absatz)*
- **S-ENUM-7:** In der Konfiguration `identity: "email"` existiert kein Endpunkt, der die Existenz einer E-Mail-Adresse als boolesche Antwort zurückgibt. *(Abschnitt 3.4, Spalte „Aufzählungsschutz": „vollständig")*
- **S-ENUM-8:** In den Konfigurationen `username` und `username_email` gibt `GET /username/available` ausschließlich `available` und den Ablehnungsgrund zurück, unterliegt einem eigenen Eimer je IP-Präfix von 10 Anfragen je Minute und bietet keine Präfix- oder Ähnlichkeitssuche; die Dokumentation weist die Aufzählbarkeit von Benutzernamen ausdrücklich aus. *(Abschnitt 3.4: „Velve Auth bietet sie an, begrenzt sie hart und sagt es in der Dokumentation"; Abschnitt 3.15 B.5)*

---

### 5.4 REPLAY — Wiederholung

**(a) Die Fehlerklasse.** Ein Artefakt ist wiederholbar, wenn seine Gültigkeit allein aus seinem Inhalt folgt statt aus veränderlichem Serverzustand. Signierte Links (JWT mit `exp`) sind der Regelfall: sie landen in Mail-Archiven, Browser-Historien und werden von Unternehmens-Mailgateways präventiv aufgerufen. Bei TOTP verlangt RFC 6238 §5.2 ausdrücklich, dass ein erfolgreich verwendeter Code für den Rest seines Zeitschritts abgelehnt wird — sonst löst ein Phishing-Proxy denselben Code parallel ein zweites Mal ein.

**(b) Der Präzedenzfall.** GHSA-wxw3-q3m9-c3jr (5.3 Moderate, Fix 1.6.2): der Cookie-Zweig von `parseGenericState` verglich die gespeicherte Nonce nie mit dem eingehenden `state`-Parameter. GHSA-pw9m-5jxm-xr6h / CVE-2026-53512 (**CVSS 9.1 Critical**, Fix 1.6.11): `client_secret` wurde nur im Authorization-Code-Grant erzwungen, nicht im Refresh-Grant — Refresh-Token-Replay ohne Client-Authentifizierung.

**(c) Die Anforderungen.**

- **S-REPLAY-1:** Jedes Einmal-Artefakt der Bibliothek ist eine Datenbankzeile mit `sha256(token)` als Primärschlüssel, einem `purpose` und einem `expires_at`; kein Einmal-Artefakt ist ein selbsttragender signierter String. *(Abschnitt 3.7, erster Satz; Schema `velve.one_time_token`)*
- **S-REPLAY-2:** Das Einlösen eines Einmal-Tokens erfolgt ausschließlich über `DELETE FROM velve.one_time_token WHERE token_sha256 = $1 AND purpose = $2 AND expires_at > now() RETURNING user_id, payload`; eine leere Ergebnismenge ist das einzige Ungültigkeitssignal. *(Abschnitt 3.7, SQL-Block)*
- **S-REPLAY-3:** Die Antwort auf einen abgelaufenen, einen bereits verbrauchten und einen nie existierenden Token ist in allen drei Fällen byteweise identisch. *(Abschnitt 3.7: „abgelaufen, verbraucht und nie existiert sind nach außen ununterscheidbar")*
- **S-REPLAY-4:** Ein TOTP-Code wird pro Nutzer und Zeitschritt höchstens einmal akzeptiert; die Prüfung ist ein `INSERT INTO velve.totp_used_step (user_id, time_step, expires_at)`, dessen Scheitern an der Primärschlüsselbedingung die Ablehnung ist, und eingetragen wird der tatsächlich passende Zeitschritt, nicht der aktuelle. *(Abschnitt 3.6, TOTP-Absatz: „ein `INSERT`, der bei Konflikt scheitert, ist die Prüfung")*
- **S-REPLAY-5:** Eine WebAuthn-Challenge ist höchstens 5 Minuten gültig, wird per `DELETE … RETURNING` konsumiert und nur für den Zweck akzeptiert, unter dem sie erzeugt wurde (`register` oder `authenticate`). *(Abschnitt 3.6, WebAuthn-Absatz)*
- **S-REPLAY-6:** Ein OAuth-Callback wird nur angenommen, wenn die zugehörige Zeile in `velve.oauth_flow` beim Konsum noch existiert und nicht abgelaufen ist; PKCE mit `code_challenge_method = S256` ist Pflicht und durch keine Konfiguration abschaltbar, und bei OIDC wird zusätzlich der `nonce` und der `iss` nach RFC 9207 geprüft. *(Abschnitt 3.10, erster Absatz)*

---

### 5.5 RAND — Unsichere Zufälligkeit

**(a) Die Fehlerklasse.** Drei Muster: falsche Quelle (`Math.random` ist xorshift128+, aus fünf Ausgaben rekonstruierbar; UUIDv7 ist ein guter Datenbankschlüssel und ein verbotenes Geheimnis), zu wenig Entropie (nicht beim Sitzungstoken, sondern beim kurzen Nebenartefakt — Reset-Token, Wiederherstellungscode, `state`), und Entropieverlust bei der Kodierung durch Modulo-Bias, wenn die Alphabetlänge 256 nicht teilt.

**(b) Der Präzedenzfall.** Better Auth nutzt ein 64-Zeichen-Alphabet und ist damit bias-frei, wählt die Länge aber pro Aufrufstelle: Sitzungstoken `generateId(32)` = 192 bit (`packages/better-auth/src/db/internal-adapter.ts:513`), Reset-Token `generateId(24)` = 144 bit (`packages/better-auth/src/api/routes/password.ts:109,126`). `Math.random()` steht an drei Produktionsstellen (`packages/better-auth/src/client/session-refresh.ts:96`, `packages/core/src/db/adapter/factory.ts:61`, `packages/passkey/src/client.ts:107,237`) — keine davon ist ein Geheimnis, aber es gibt keine Regel, die die nächste Verwendung verhindert.

**(c) Die Anforderungen.**

- **S-RAND-1:** Jeder geheime Zufallswert der Bibliothek stammt aus `crypto.getRandomValues`; `Math.random`, `Date.now` und Zählerwerte werden nirgends zur Erzeugung eines Geheimnisses verwendet. *(Abschnitt 2.7, Zeile „CSPRNG")*
- **S-RAND-2:** Ein Sitzungstoken besteht aus 32 Byte aus `crypto.getRandomValues` und wird als base64url ohne Modulo-Abbildung kodiert. *(Abschnitt 3.5, erster Aufzählungspunkt)*
- **S-RAND-3:** Ein Wiederherstellungscode trägt 160 bit Entropie; die zehn Codes eines Nutzers sind paarweise verschieden. *(Abschnitt 3.6, Wiederherstellungscodes)*
- **S-RAND-4:** Einmal-Token, OAuth-`state`, PKCE-Verifier und WebAuthn-Challenges tragen jeweils mindestens 256 bit Entropie aus derselben Quelle wie das Sitzungstoken. *(Abschnitt 3.5, Tokenerzeugung; Abschnitt 3.10, PKCE-Pflicht)*
- **S-RAND-5:** Die Erzeugung von Geheimnissen ist in genau einem Modul gekapselt; kein anderes Modul ruft die CSPRNG-Schnittstelle direkt auf. *(Abschnitt 3.1, Modulschnitt `core/token/`)*
- **S-RAND-6:** Datenbankschlüssel (`uuid`-Spalten mit `gen_random_uuid()`) sind typsystematisch von Geheimnissen getrennt; ein Wert vom Typ `EntityId` ist nicht ohne ausdrückliche Konvertierung als Token verwendbar und wird nie in einem Cookie ausgeliefert. *(Abschnitt 3.2, Schema: `id uuid … DEFAULT gen_random_uuid()` gegenüber `token_sha256 bytea`)*

---

### 5.6 TOKEN — Token-Wiederverwendung und Einmaligkeit

**(a) Die Fehlerklasse.** Klasse REPLAY fragt „kann derselbe Token zweimal wirken?", diese Klasse fragt „ist der Token für genau eine Sache zuständig?". Drei Ausprägungen: Zweckverwechslung (ein E-Mail-Bestätigungstoken wird am Reset-Endpunkt akzeptiert, weil beide dieselbe Verifikationstabelle ohne Zweckprädikat abfragen), fehlende Subjektbindung (ein Token für Nutzer A wird in der Sitzung von Nutzer B eingelöst) und unvollständiger Widerruf („alles abmelden" vergisst eine Tabelle).

**(b) Der Präzedenzfall.** GHSA-2vg6-77g8-24mp (3.8 Low, CWE-613/672/459, Fix 1.6.11): vier Aufrufstellen löschten den Nutzer, ohne vorher `deleteSessions(userId)` im `secondaryStorage` auszuführen — Tokens blieben bis zu 7 Tage gültig. GHSA-392p-2q2v-4372 / CVE-2026-53517 (7.6 High): das `adapter.update`-Prädikat war nur auf `id` gekeyt, nicht zusätzlich auf `revoked IS NULL`, sodass die Refresh-Token-Familie forkte statt widerrufen zu werden.

**(c) Die Anforderungen.**

- **S-TOKEN-1:** Jede Abfrage auf `velve.one_time_token` enthält `purpose` im `WHERE`-Prädikat; die Repository-Signatur verlangt Token-Hash und Zweck gemeinsam, sodass eine Abfrage ohne Zweck nicht übersetzt. *(Abschnitt 3.7, SQL-Block; Abschnitt 3.1, Modul `core/token/`)*
- **S-TOKEN-2:** Ein Token mit dem Zweck *i* wird an einem Endpunkt, der den Zweck *j ≠ i* einlöst, mit derselben Antwort abgelehnt wie ein frei erfundener Token. *(Abschnitt 3.7, `purpose`-Spalte; Abschnitt 3.13, „Absichtlich unsichtbar")*
- **S-TOKEN-3:** Eine neu angeforderte Einmal-Marke desselben Zwecks löscht alle vorherigen Marken desselben Zwecks desselben Nutzers in derselben Transaktion. *(Abschnitt 3.7, letzter Satz)*
- **S-TOKEN-4:** Wird ein Einmal-Token auf ein Konto angewandt — E-Mail-Bestätigung, E-Mail-Wechsel, Kennwort-Reset —, ist das Zielkonto ausschließlich `one_time_token.user_id`; kein Eingabefeld und keine mitgesendete Sitzung bestimmt das Zielkonto. Bei der Verknüpfung einer Identität ist das Zielkonto ausschließlich `oauth_flow.link_to_user_id`, das beim Start aus der Sitzung gesetzt wurde. *(Abschnitt 3.7, Spalte `user_id`; Abschnitt 3.15 B.7: „`velve.oauth_flow` weiß über `link_to_user_id` bereits, ob verknüpft oder angemeldet wird")*
- **S-TOKEN-5:** Das Löschen eines Nutzers entfernt über `ON DELETE CASCADE` alle Zeilen in den dreizehn nutzergebundenen Tabellen `session`, `password_credential`, `identity`, `one_time_token`, `pending_authentication`, `totp_credential`, `totp_used_step`, `recovery_code`, `webauthn_credential`, `webauthn_challenge`, `oauth_flow` (`link_to_user_id`), `import_mapping` und `password_reset_required`; nach dem Löschen enthält keine dieser Tabellen eine Zeile mit der Nutzerkennung. *(Abschnitt 3.2 und 3.17, Schema: `REFERENCES velve.user(id) ON DELETE CASCADE` an jeder nutzergebundenen Tabelle)*
- **S-TOKEN-6:** Jede Tabelle im Schema `velve` mit einer Spalte, die auf `velve.user(id)` verweist — auch die von Plugins mit dem Präfix `<plugin-id>_` angelegten — trägt dort eine Fremdschlüsselbedingung mit `ON DELETE CASCADE`; der Migrationsläufer weist eine Migration ab, die eine solche Tabelle ohne diese Bedingung anlegt. *(Abschnitt 3.11, „Eigene Tabellen im Schema `velve` mit Präfix `<plugin-id>_`; Migrationen laufen im selben versionierten Läufer")*

---

### 5.7 RATE — Ratenbegrenzung

**(a) Die Fehlerklasse.** Ein Ratenbegrenzer besteht aus Schlüssel, Zähler, Fenster und Reaktion, und jeder Teil kann kaputt sein. Die Schlüsselfehler dominieren: die volle IPv6-Adresse statt des Präfixes gibt einem Angreifer mit einem `/64` zweiundsechzigstellige Zahlen an Eimern; die textuelle Repräsentation derselben Adresse ergibt mehrere Eimer; ein ungeprüfter `X-Forwarded-For` lässt den Client seinen Eimer selbst wählen; und ein roher Pfad als Schlüsselbestandteil trennt `//sign-in` von `/sign-in`. Eine harte Kontosperre ist kein Schutz, sondern eine Dienstverweigerung gegen einen bekannten Nutzer.

**(b) Der Präzedenzfall.** GHSA-p6v2-xcpg-h6xw / CVE-2026-45364 (7.3 High, CWE-307, Fix 1.4.17): der Schlüssel war die textuelle IP ohne Normalisierung, sodass ein Client mit einem `/64`-Präfix 2^64 Eimer erzeugen konnte. GHSA-x732-6j76-qmhm (8.6 High, Fix 1.4.5): der `rou3`-Router kollabiert leere Pfadsegmente, sodass `//sign-in/email` dieselbe Route trifft, aber an Pfad-Ratenlimits vorbeiläuft.

**(c) Die Anforderungen.**

- **S-RATE-1:** Der IP-Ratenschlüssel ist bei IPv6 das `/64`-Präfix und bei IPv4 die volle Adresse; verschiedene Schreibweisen derselben Adresse — komprimiert, expandiert, großgeschrieben, IPv4-in-IPv6-abgebildet — ergeben denselben Schlüssel. *(Abschnitt 3.9, erster Aufzählungspunkt)*
- **S-RATE-2:** 1000 Anfragen von 1000 verschiedenen Adressen desselben `/64` teilen sich einen Eimer. *(Abschnitt 3.9: „das Präfix, nicht die Adresse, sonst rotiert ein Angreifer beliebig (CVE-2026-45364)")*
- **S-RATE-3:** `X-Forwarded-For` wird nur ausgewertet, wenn `trustedProxies` konfiguriert ist; ist die Liste leer, zählt ausschließlich die Verbindungsadresse und jeder `X-Forwarded-*`-Kopfeintrag bleibt ohne Wirkung auf den Schlüssel. *(Abschnitt 3.9: „`X-Forwarded-For` wird nur ausgewertet, wenn `trustedProxies` konfiguriert ist")*
- **S-RATE-4:** Ist keine Client-Adresse ermittelbar, wird auf einen gemeinsamen Eimer je Route gezählt und das Limit durchgesetzt; die Prüfung wird nie übersprungen. *(Abschnitt 3.9, drei Zähler; Abschnitt 3.11, „Origin-Prüfung und Ratenbegrenzung liegen immer davor")*
- **S-RATE-5:** Der Ratenschlüssel enthält den aufgelösten Routennamen aus der Routendeklaration, nicht den rohen Pfad; `//sign-in/password`, `/sign-in/password/`, `/sign-in/password` und `/sign-in/passw%6Frd` zählen auf denselben Eimer. *(Abschnitt 3.9, letzter Absatz; Abschnitt 3.12, „Jede Route wird einmal deklariert")*
- **S-RATE-6:** Der Zähler wird in einer einzigen Datenbankanweisung (`INSERT … ON CONFLICT … DO UPDATE … RETURNING tokens`) fortgeschrieben; bei *n* zeitgleichen Anfragen gegen ein Limit *L* werden höchstens *L* angenommen. *(Abschnitt 3.9, SQL-Block: „ein Round-Trip")*
- **S-RATE-7:** Der Schlüssel des kontobezogenen Zählers ist `HMAC(token-pepper, normalisierter Bezeichner)`, nicht die Konto-ID; er wird vor der Auflösung des Nutzers gebildet, sodass existierende und nicht existierende Konten dieselbe Zeile fortschreiben und der Bezeichner nicht im Klartext in `velve.rate_bucket` steht. Ein leerer Eimer führt zur Ablehnung mit `rate_limited`, niemals zu einer künstlichen Verzögerung und niemals zu einer Sperre; der Eimer füllt sich mit der konfigurierten Rate nach, und ein Konto bleibt nach beliebig vielen Fehlversuchen Dritter für den rechtmäßigen Inhaber mit korrekten Zugangsdaten erreichbar. *(Abschnitt 3.16, L-5; Abschnitt 3.9: „ein Eimer mit langsam nachfüllender Rate statt einer Sperre … Eine Sperre ist eine Dienstverweigerung gegen einen bekannten Nutzer.")*
- **S-RATE-8:** Der Zähler je Route und Instanz löst bei Überschreitung ausschließlich den Alarm-Callback aus und lehnt keine Anfrage ab. *(Abschnitt 3.9, dritter Aufzählungspunkt)*

---

### 5.8 COOKIE — Cookie-Attribute

**(a) Die Fehlerklasse.** `Domain=.example.com` sendet den Sitzungstoken an *jede* Subdomain — auch an eine, deren DNS auf einen fremden Dienst zeigt — und zwar ohne XSS und trotz `HttpOnly`. Umgekehrt kann jede Subdomain ein Cookie gleichen Namens setzen (Cookie-Tossing); der Server sieht dann `name=A; name=B` ohne Unterscheidungsmerkmal und nimmt in der Regel das erste, dessen Reihenfolge der Angreifer über die Pfadlänge steuert. Das `__Host-`-Präfix ist die einzige Maßnahme, die beides strukturell ausschließt, weil der Browser sie durchsetzt und nicht der Anwendungscode.

**(b) Der Präzedenzfall.** Better Auth setzt `__Host-` nie (`packages/better-auth/src/cookies/index.ts:75` verwendet ausschließlich `__Secure-`), degradiert `secure` still auf `false`, wenn die Ableitung auf `isProduction` zurückfällt und `NODE_ENV` in einem Container nicht gesetzt ist (`:65-74`), und überschreibt die Vorgaben ungefiltert per Spread aus `defaultCookieAttributes` (`:109-111`) — `httpOnly: false` ist ohne Warnung konfigurierbar.

**(c) Die Anforderungen.**

- **S-COOKIE-1:** Der Sitzungscookie heißt `__Host-velve_session` und trägt `HttpOnly`, `Secure`, `SameSite=Lax` und `Path=/`. *(Abschnitt 3.5, Cookie-Absatz)*
- **S-COOKIE-2:** Es existiert keine Konfigurationsoption, die `HttpOnly` oder `Secure` am Sitzungscookie abschaltet oder ihm ein `Domain`-Attribut hinzufügt. *(Abschnitt 3.5: „Das `__Host-`-Präfix erzwingt `Secure` und verbietet `Domain`")*
- **S-COOKIE-3:** Der Zwischenzustandscookie heißt `__Host-velve_pending`, hat eine Lebensdauer von 5 Minuten und trägt dieselbe Attributmenge wie der Sitzungscookie. *(Abschnitt 3.6, erster Absatz)*
- **S-COOKIE-4:** Der Sitzungscookie enthält ausschließlich den Sitzungstoken; er trägt keine Nutzerdaten, keinen Sitzungszustand und kein zwischengespeichertes Prüfergebnis. *(Abschnitt 3.5: „Kein Cookie-Cache im Kern")*
- **S-COOKIE-5:** Trifft eine Anfrage mit zwei Cookies gleichen Namens ein, wird sie abgelehnt, statt eines der beiden auszuwählen. *(Abschnitt 3.5, „Cookie-Tossing aus einer Subdomain ist damit ausgeschlossen" — die Ablehnung deckt den Restfall ab, in dem ein Client die Browserregel verletzt)*
- **S-COOKIE-6:** Die Menge aller Cookies, die die Bibliothek jemals setzt, ist im Quelltext aufgezählt; eine Antwort, die einen nicht aufgezählten Cookie setzt, ist ein Fehler. *(Abschnitt 3.12, „Jede Route wird einmal deklariert"; Abschnitt 3.11, „Die Erweiterungspunkte sind aufgezählt, nicht offen")*

---

### 5.9 CSRF — Cross-Site Request Forgery

**(a) Die Fehlerklasse.** `SameSite=Lax` hat vier Löcher: zustandsändernde GETs bleiben erlaubt (das trifft den OAuth-Callback per Protokoll); ein Cookie ohne explizites `SameSite`-Attribut wird von Chrome bis zu zwei Minuten nach dem Setzen auch bei Top-Level-POST gesendet; „same-site" ist nicht „same-origin", sodass jede kontrollierte Subdomain `SameSite` vollständig umgeht; und gegen Login-CSRF hilft es gar nicht. Der `Origin`-Header ist die tragfähige Prüfung, weil der Browser ihn setzt und JavaScript ihn nicht fälschen kann.

**(b) Der Präzedenzfall.** GHSA-36rg-gfq2-3h56 / CVE-2025-53535 (2.1 Low): `matchesPattern` nutzte `url.startsWith(pattern)`, sodass `https://trusted.example.evil.com` als vertrauenswürdig galt. GHSA-vp58-j275-797x (7.1 High): fehlerhafte Origin-Logik bei absoluten URLs und Wildcard-Mustern erlaubte eine `callbackURL`, die den Reset-Token exfiltrierte. Beide sind Präfixvergleichsfehler auf Strings statt Gleichheitsvergleiche auf geparsten Origins.

**(c) Die Anforderungen.**

- **S-CSRF-1:** Jede Route außer `GET /sign-in/oauth/callback/:provider` trägt `originCheck: "checked"` und durchläuft die Origin-Prüfung, bevor der Handler läuft; das gilt auch für den direkten Serveraufruf über die aus der Routendeklaration erzeugte Servermethode. *(Abschnitt 3.15 D.3: „Der OAuth-Callback ist die einzige Route ohne Origin-Prüfung"; Abschnitt 3.11: „Origin-Prüfung und Ratenbegrenzung liegen immer davor — auch bei direkten Serveraufrufen.")*
- **S-CSRF-2:** Die Origin-Prüfung vergleicht `new URL(header).origin` per Zeichenkettengleichheit gegen einen Eintrag aus `origins`; die Bibliothek enthält keinen Präfix-, Teilstring- oder Musterabgleich auf Origins. *(Abschnitt 3.12, `origins: ["https://app.example.com"]`)*
- **S-CSRF-3:** Ein Origin, der sich vom erlaubten nur im Schema, im Port, in einem Präfix oder in einem Suffix unterscheidet, wird mit `origin_not_allowed` abgelehnt; die Ablehnung ist für alle Fehlvarianten byteweise identisch. *(Abschnitt 3.12, `origins`; Abschnitt 3.15 F, `origin_not_allowed`)*
- **S-CSRF-4:** Keine zustandsändernde Operation ist über `GET` erreichbar; die einzige Ausnahme ist der OAuth-Callback, der stattdessen durch `state`, PKCE und `iss` geschützt ist, und die übrigen `GET`-Routen (`/session`, `/session/list`, `/username/available`, `/factor/webauthn/list`, `/factor/recovery/remaining`, `/identity/list`, `/pending`) sind lesend. *(Abschnitt 3.10, erster Absatz; Abschnitt 3.15 D.3, Routentabelle)*
- **S-CSRF-5:** Der OAuth-`state` liegt serverseitig in `velve.oauth_flow`; das Cookie hält nur den Zeiger darauf, und ein Callback mit gültigem `state`, aber fehlendem oder fremdem Zeiger-Cookie wird abgelehnt. *(Abschnitt 3.10: „`state` serverseitig in `velve.oauth_flow` (Cookie hält nur den Zeiger)")*
- **S-CSRF-6:** Ein Plugin kann die Origin-Prüfung weder ersetzen noch umgehen noch vor ihr ausgeführt werden. *(Abschnitt 3.11, „Was ein Plugin nicht darf", Punkte 3 und 6)*

---

### 5.10 OWNER — Fehlende Eigentümerbindung / IDOR

**(a) Die Fehlerklasse.** Ein Endpunkt nimmt eine Objektkennung aus der Anfrage und operiert darauf, ohne zu prüfen, ob das Objekt dem Nutzer der Sitzung gehört. Bei Zugangsdatenverwaltung ist die Wirkung besonders schwer: fremde Faktoren zu löschen ist ein Aussperrangriff, fremde Faktoren anzulegen ist eine Kontoübernahme. Verschärfend wirken drei Details: unterschiedliche Antworten für „existiert nicht" und „gehört dir nicht" liefern ein zusätzliches Orakel; die Prüfung als `if` im Anwendungscode statt als Prädikat im `WHERE` lässt sich beim nächsten Refactoring verlieren; und ein Autorisierungsparameter, den die Middleware aus einer Quelle und der Handler aus einer anderen liest, ist ein Confused Deputy.

Diese Klasse ist mit **10 von 33 Advisories** die häufigste Ursache bei Better Auth. Sie ist keine Kryptoschwäche, sondern eine fehlende Zeile `AND user_id = $2`. Der Recherchebericht formuliert die Konsequenz so: die Eigentümerbindung muss architektonisch erzwungen werden, nicht per Review. Die Zielarchitektur setzt das an einer Stelle um — Abschnitt 3.11, „Was ein Plugin nicht darf": „Kerntabellen direkt beschreiben. Nur Repository-Methoden, und jede verlangt einen `actor`." Die folgenden Anforderungen ziehen daraus die Konsequenzen für den Kern selbst.

**(b) Die Präzedenzfälle.** Zehn Advisories, eine Ursache:

| GHSA | CVE | CVSS | Kern des Fehlers |
|---|---|---|---|
| GHSA-99h5-pjcv-gr6v | CVE-2025-61928 | 8.6 High | Ohne Sitzung befüllte der Endpunkt den Benutzerkontext aus dem Anfragekörper |
| GHSA-4vcf-q4xf-f48m | — | 7.1 High | `/passkey/delete-passkey` vertraute der Passkey-ID aus dem Körper ohne Eigentümerprüfung |
| GHSA-wmjr-v86c-m9jj | — | 2.0 Low | Multi-Session-Signout reichte rohe Cookie-Werte ungeprüft an `deleteSessions` |
| GHSA-xr8f-h2gw-9xh6 | CVE-2026-41427 | 8.4 High, CWE-863 | Autorisierungs-Hook lief bei Read/Update/Delete, nicht vor dem Anlegen |
| GHSA-cq3f-vc6p-68fh | CVE-2026-45337 | 7.6 High | Jede authentifizierte Sitzung galt als Eigentümerin jedes offenen Device-Codes |
| GHSA-gv74-j8m3-fg5f | CVE-2026-53515 | 7.1 High | Read/Update/Delete verlangten Adminrechte, die Registrierung nur Mitgliedschaft |
| GHSA-j8v8-g9cx-5qf4 | — | 8.3 High | `providerOwnership` per Vorgabe aus, `scimProvider.userId` blieb leer |
| GHSA-h3rm-78g3-j7cp | — | 7.1 High | Middleware prüfte die Org-ID aus Query-String oder Körper, der Handler las nur den Körper |
| GHSA-rjg6-39jm-rgg4 | — | **9.9 Critical** | Eine SCIM-Provider-ID durfte mit einer bestehenden Provider-ID kollidieren |
| GHSA-prpr-5gj3-qqhg | — | 8.1 High | Verwaiste Kontoverknüpfungen nach Löschung des Providers |

Der Recherchebericht hält fest: „**jede einzelne** wäre durch die Actor-Pflicht im Repository verhindert worden."

**(c) Die Anforderungen.**

- **S-OWNER-1:** Jede Repository-Methode, die auf eine Tabelle mit `user_id`-Spalte zugreift, nimmt einen `actor` entgegen; es existiert keine Methode auf diesen Tabellen ohne diesen Parameter. *(Abschnitt 3.11: „Nur Repository-Methoden, und jede verlangt einen `actor`.")*
- **S-OWNER-2:** Die Eigentümerbedingung steht im SQL-Prädikat, nicht in einer Verzweigung des TypeScript-Codes: Löschen und Ändern nutzergebundener Objekte erfolgt als `… WHERE id = $1 AND user_id = $2 RETURNING …`, und eine leere Ergebnismenge ist die Ablehnung. *(Abschnitt 3.2, „Keine Query-Abstraktion. Alles SQL ist von Hand für PostgreSQL geschrieben."; Abschnitt 3.11, Actor-Pflicht)*
- **S-OWNER-3:** `POST /factor/webauthn/remove` löscht einen Zugangsdatensatz nur, wenn `webauthn_credential.user_id` der `user_id` der aufrufenden Sitzung entspricht; für eine fremde und für eine erfundene `credentialId` ist die Antwort byteweise identisch. *(Abschnitt 3.2, `velve.webauthn_credential.user_id`; Abschnitt 3.15 B.6, `webauthn.remove`; Abschnitt 3.11, Actor-Pflicht)*
- **S-OWNER-4:** `POST /session/revoke` wirkt nur auf Zeilen mit der `user_id` der aufrufenden Sitzung; eine fremde oder erfundene `targetSessionId` ändert keine Zeile, und die Antwort ist in beiden Fällen 204. *(Abschnitt 3.5, „Widerruf: einzeln, alle außer der aktuellen, alle"; Abschnitt 3.15 B.2 und F.1)*
- **S-OWNER-5:** Das Lösen einer Identitätsverknüpfung wirkt nur auf Zeilen in `velve.identity` mit der `user_id` der aufrufenden Sitzung. *(Abschnitt 3.2, `identity_user_id_idx`; Abschnitt 3.10, ausdrückliche Verknüpfung in bestehender Sitzung)*
- **S-OWNER-6:** Jeder autorisierungsrelevante Parameter wird an genau einer Stelle aus der Anfrage gelesen; trägt eine Anfrage denselben Parameter mit widersprüchlichen Werten in Query und Körper, wird sie abgelehnt statt einen der Werte zu wählen. *(Abschnitt 3.12, „Jede Route wird einmal deklariert — Pfad, Methode, Eingabe-Schema")*
- **S-OWNER-7:** Die Identität des Aufrufers stammt ausschließlich aus der aufgelösten Sitzung; kein Handler liest eine Nutzerkennung aus dem Anfragekörper, aus einer Query oder aus einem Kopfeintrag, um daraus einen Aktor abzuleiten. *(Abschnitt 3.5, Auflösung per einer Abfrage auf `token_sha256`)*
- **S-OWNER-8:** „Existiert nicht" und „gehört einem anderen Nutzer" erzeugen dieselbe Antwort mit demselben Status, denselben Kopfzeilen und demselben Körper. *(Abschnitt 3.13, „Absichtlich unsichtbar: Alles, was Existenz verraten würde")*
- **S-OWNER-9:** Objektkennungen nutzergebundener Zeilen sind `uuid`-Werte aus `gen_random_uuid()`; es existiert keine fortlaufende ganzzahlige Kennung auf einer nutzergebundenen Tabelle. *(Abschnitt 3.2, Schema: `id uuid PRIMARY KEY DEFAULT gen_random_uuid()`)*
- **S-OWNER-10:** Ein Plugin erhält keinen Schreibzugriff auf Kerntabellen außer über die Repository-Methoden mit Actor-Pflicht, und der ihm übergebene Kernkontext ist eingefroren. *(Abschnitt 3.11, „Den Kernkontext verändern. Der Kontext ist eingefroren (`Object.freeze`).")*
- **S-OWNER-11:** Ein Plugin kann keine Kernroute überschreiben; ein Namenskonflikt zwischen einer Plugin-Route und einer Kernroute führt beim Start zu einem Fehler. *(Abschnitt 3.11: „Ein Namenskonflikt ist ein Startfehler, keine Warnung.")*
- **S-OWNER-12:** Ein Plugin-Hook kann eine Operation ablehnen oder beobachten, aber die Antwort des Kerns nicht ersetzen und die Session-Auflösung nicht austauschen. *(Abschnitt 3.11, „Ein Hook darf ablehnen … oder beobachten. Er darf die Antwort nicht ersetzen."; „Den Passwort-Verifier, die Session-Auflösung oder die Origin-Prüfung ersetzen." unter „Was ein Plugin nicht darf")*

---

### 5.11 LINK — Kontoübernahme über Identitätsverknüpfung

**(a) Die Fehlerklasse.** Die E-Mail-Adresse wird als Verbindungsschlüssel zwischen zwei Identitätsräumen benutzt (lokales Konto ↔ Anbieteridentität). Damit das trägt, müssten *beide* Seiten die Adresse verifiziert haben; geprüft wird typischerweise nur eine — oder keine. Der Angreifer registriert vorab ein Konto auf die Adresse des Opfers, lässt es unverifiziert liegen, und wenn das Opfer sich später per Anbieter anmeldet, wird das Vorabkonto samt hinterlegtem Kennwort des Angreifers verifiziert und übernommen.

**(b) Der Präzedenzfall.** GHSA-g38m-r43w-p2q7 / CVE-2026-53516 (**8.3 High**, CWE-287/345, Fix 1.6.11): „The auto-link gate validates only the OAuth provider's `userInfo.emailVerified` claim. The local row's `emailVerified` field is never read." GHSA-qq9h-g4jm-xgf3 (8.3 High, Fix 1.6.22): Magic-Link- und E-Mail-OTP-Login verifizierten das bestehende Konto, entfernten aber das Kennwort nicht, das der Angreifer vor der Verifikation gesetzt hatte. GHSA-fmh4-wcc4-5jm3 / CVE-2026-53514 (7.7 High) ist dieselbe Ursache bei Einladungen. Drei Advisories, eine Ursache.

**(c) Die Anforderungen.**

- **S-LINK-1:** Der einzige Verknüpfungsschlüssel zwischen einer Anbieteridentität und einem lokalen Konto ist das Paar `(provider, subject)`; die E-Mail-Adresse ist ein Attribut und wird in keiner Abfrage als Verknüpfungsschlüssel verwendet. *(Abschnitt 3.10: „`(provider, subject)` ist der einzige Schlüssel. Die E-Mail ist niemals ein Verknüpfungsschlüssel."; Schema-Bedingung `identity_provider_subject UNIQUE (provider, subject)`)*
- **S-LINK-2:** Eine automatische Verknüpfung mit einem bestehenden Konto findet nur statt, wenn der Anbieter die E-Mail als verifiziert meldet **und** das lokale Konto `email_verified_at IS NOT NULL` trägt **und** der Anbieter in `trustedProviders` steht; fehlt eine der drei Bedingungen, entsteht ein neues Konto oder es bleibt bei einer ausdrücklichen Verknüpfung in einer bestehenden Sitzung. *(Abschnitt 3.10, Verknüpfungsregel, Bedingungen 1–3)*
- **S-LINK-3:** `velve.identity.subject` enthält die stabile Anbieterkennung und niemals eine E-Mail-Adresse. *(Abschnitt 3.2, Schema: `subject text NOT NULL, -- die stabile ID beim Anbieter, nie die E-Mail`)*
- **S-LINK-4:** Wird eine E-Mail-Adresse erstmals bestätigt — per Magic Link oder Bestätigungslink — und wurde das vorhandene Kennwort in einer anderen Sitzung gesetzt als der bestätigenden, dann werden die Kennwortanmeldung gelöscht und alle bestehenden Sitzungen widerrufen; wurde das Kennwort in derselben Sitzung gesetzt, die jetzt bestätigt, bleibt es bestehen. Ein Magic Link verknüpft keine Anbieteridentität. *(Abschnitt 3.16, L-12; Abschnitt 3.10: „Die E-Mail ist niemals ein Verknüpfungsschlüssel")*
- **S-LINK-5:** Meldet ein Anbieter keine E-Mail-Adresse, bleibt `velve.user.email` in den Konfigurationen `username` und `username_email` NULL; die Bibliothek erzeugt keine Platzhalteradresse. *(Abschnitt 3.10, „Kein Konto ohne E-Mail-Zwang")*
- **S-LINK-6:** Der Zustand `provider_email_verified` wird pro Identität gespeichert und bei jeder Anmeldung aus den Anbieterclaims aktualisiert; der Wert einer Identität überträgt sich nicht auf eine andere Identität desselben Nutzers. *(Abschnitt 3.2, Schema: `provider_email_verified boolean NOT NULL DEFAULT false` auf `velve.identity`)*
- **S-LINK-7:** Die Verknüpfung einer weiteren Identität mit einem bestehenden Konto ist ein Wechsel der Vertrauensstufe und erzeugt daher eine neue Sitzungszeile mit neuem Token. *(Abschnitt 3.5: „Neuvergabe bei jedem Ereignis, das die Vertrauensstufe ändert: … Verknüpfung einer neuen Identität")*

---

### 5.12 CACHE — Autorisierungsentscheidung aus einem Cache

**(a) Die Fehlerklasse.** Ein Cache speichert das *Ergebnis* einer Prüfung. Wird der Eintrag geschrieben, bevor alle Bedingungen erfüllt sind, entscheidet der Cache-Treffer statt der Prüfung. Es gibt zwei Fenster: zu früh schreiben (die Sitzung wird nach dem Kennwortschritt, aber vor dem zweiten Faktor abgelegt) und zu spät invalidieren (eine Kontodeaktivierung wirkt erst nach Ablauf der Cache-Lebensdauer). Die HTTP-Variante ist Cache Deception: eine authentifizierte Antwort wird unter einem cachebar aussehenden Pfad ausgeliefert.

**(b) Der Präzedenzfall.** GHSA-xg6x-h9c9-2m83 (**CVSS 9.1 Critical**, CWE-288, Fix 1.4.9) — der schwerste veröffentlichte Fehler im Kern-Anmeldepfad, zwei Advisories in Randpaketen liegen mit 9,9 und 9,6 höher: „Sessions generated during initial sign-in are prematurely cached as valid before 2FA verification." Der Cookie-Cache (`sessionData`, Standardlaufzeit 300 s, `packages/better-auth/src/cookies/index.ts:125-127`) blieb als Funktion bestehen; der Fix schloss nur das Schreibfenster. GHSA-hq75-xg7r-rx6c (`better-call`, Moderate) ist die HTTP-Cache-Variante über einen Routing-Fehler.

**(c) Die Anforderungen.**

- **S-CACHE-1:** Der Kern beantwortet die Frage „wer ist angemeldet" bei jeder Anfrage mit einer Datenbankabfrage; es existiert kein Cookie-Cache, kein Prozess-Cache und kein externer Cache für Sitzungen oder Sitzungsdaten, und jede HTTP-Antwort trägt `Cache-Control: no-store` und `Vary: Cookie`, damit auch kein vorgelagerter HTTP-Cache eine Antwort wiederverwendet. *(Abschnitt 3.5: „Kein Cookie-Cache im Kern. Autorisierungsentscheidungen werden nie aus einem Cache beantwortet"; Abschnitt 3.16, L-6)*
- **S-CACHE-2:** Die Sitzungsauflösung ist genau eine Abfrage mit Join auf `velve.user`, gefiltert nach `token_sha256 = $1 AND idle_expires_at > now() AND absolute_expires_at > now()`, wobei `u.disabled_at` in derselben Abfrage gelesen wird und, wenn gesetzt, `account_disabled` statt einer Sitzung ergibt (L-4); jede dieser vier Bedingungen wirkt bei jeder Anfrage. *(Abschnitt 3.5, Auflösungsabsatz)*
- **S-CACHE-3:** Eine Kontodeaktivierung (`disabled_at`) wirkt auf die nächste Anfrage jeder bestehenden Sitzung, ohne dass eine Lebensdauer abgewartet werden muss. *(Abschnitt 3.5: „`u.disabled_at` wird in derselben Abfrage gelesen"; Abschnitt 3.16, L-4)*
- **S-CACHE-4:** Der Zwischenzustand aus `velve.pending_authentication` wird an keiner Stelle in eine Sitzungsdarstellung überführt, bevor der zweite Faktor geprüft ist; genau die vier Routen mit `caller: "pending"` — `POST /factor/totp/verify`, `POST /factor/webauthn/authenticate/start`, `POST /factor/webauthn/authenticate/finish`, `POST /factor/recovery/verify` — werten das Zwischenzustandscookie aus, jede andere Route ignoriert es vollständig. *(Abschnitt 3.6; Abschnitt 3.15 D.3: „nur sie lesen `__Host-velve_pending`, jede andere Route ignoriert es vollständig")*
- **S-CACHE-5:** Ein Plugin kann keine Zwischenschicht einziehen, die die Sitzungsauflösung ersetzt oder ihr Ergebnis zwischenspeichert. *(Abschnitt 3.11, „Was ein Plugin nicht darf": „Den Passwort-Verifier, die Session-Auflösung oder die Origin-Prüfung ersetzen.")*

---

### 5.13 REDIR — Open Redirect und URL-Validierung

**(a) Die Fehlerklasse.** Ein vom Client gelieferter URL-String wird nach Abschluss eines Flusses in einen `Location`-Kopfeintrag übernommen. Die Prüfung scheitert an Parser-Differentialen: `//evil.com` ist protokollrelativ, `/\evil.com` wird von Browsern als Slash gelesen, `https://trusted.de.evil.com` besteht einen Suffixtest, `https://trusted.de@evil.com` versteckt den echten Host hinter Userinfo, und `javascript:` ist gar keine Navigation, sondern Skriptausführung im eigenen Origin. Der Schaden ist selten der Redirect selbst, sondern der `Referer`, der den Token mitnimmt.

**(b) Der Präzedenzfall.** Fünf Advisories, die produktivste Fehlerquelle des Projekts: GHSA-8jhw-6pjj-8723 / CVE-2024-56734 (7.9 High, `callbackURL` ohne Domainvalidierung), GHSA-hjpm-7mrm-26w8 / CVE-2025-27143 (6.9 Moderate, `https://evil.com` blockiert, `//evil.com` nicht), GHSA-vp58-j275-797x (7.1 High, „craft a malicious link containing sensitive tokens (like password-reset tokens) to enable one-click account takeover"), GHSA-36rg-gfq2-3h56 / CVE-2025-53535 (2.1 Low, `startsWith`), GHSA-86j7-9j95-vpqj (7.7 High, CWE-79/601, `javascript:` als `redirect_uri`).

**(c) Die Anforderungen.**

- **S-REDIR-1:** Die öffentliche Schnittstelle nimmt als Weiterleitungsziel ausschließlich einen Pfad entgegen, niemals eine vollständige URL. *(Abschnitt 3.2, Schema: `redirect_path text, -- ein Pfad, niemals eine vollständige URL`)*
- **S-REDIR-2:** Ein Weiterleitungspfad, der mit `//` oder `/\` beginnt, ein Schema, eine Userinfo-Komponente oder eine Hostangabe enthält, wird abgelehnt; die Prüfung findet nach genau einer Prozent-Dekodierung statt und wird danach erneut angewandt. *(Abschnitt 3.2, `redirect_path`; Abschnitt 3.1, Modul `core/http/`)*
- **S-REDIR-3:** Der einzige `Location`-Kopfeintrag, den die Bibliothek erzeugt, ist die 302-Antwort des OAuth-Callbacks, und sein Wert ist der gespeicherte `redirect_path` — ein Pfad ohne Schema und ohne Host; ein `Location`-Wert mit Schema, insbesondere `javascript:`, `data:`, `vbscript:` oder `file:`, entsteht in keiner Konfiguration. Die Autorisierungs-URL des Anbieters wird als `OAuthRedirect.authorizationUrl` im Antwortkörper zurückgegeben, nicht als Weiterleitung, und stammt aus der Anbieterkonfiguration (S-REDIR-6). *(Abschnitt 3.2, `redirect_path`; Abschnitt 3.15 C und D.3: `OAuthRedirect`, Callback mit Status 302)*
- **S-REDIR-4:** Kein `Location`-Kopfeintrag und kein Query-String einer von der Bibliothek erzeugten Weiterleitung enthält jemals einen Einmal-Token, einen Sitzungstoken oder einen PKCE-Verifier. *(Abschnitt 3.5, „Das Klartext-Token verlässt den Prozess nur im Cookie")*
- **S-REDIR-5:** Wo ein Ursprung geprüft wird, ist die Prüfung ein Gleichheitsvergleich auf `new URL(x).origin` gegen die Liste `origins`; die Bibliothek enthält keinen Musterabgleich, keinen Platzhalter und keinen Präfixvergleich auf Ursprüngen. *(Abschnitt 3.12, `origins: ["https://app.example.com"]`)*
- **S-REDIR-6:** Anbieter-Endpunkt-URLs (Autorisierung, Token, JWKS, Userinfo) stammen ausschließlich aus der Konfiguration bei der Initialisierung; keine Route registriert oder ändert eine Endpunkt-URL, die der Server anschließend selbst aufruft. *(Abschnitt 3.10, feste Anbieterliste plus `genericOAuth`; Abschnitt 3.12, Initialisierung)*
- **S-REDIR-7:** Jede Antwort der Bibliothek mit Körper trägt den Inhaltstyp `application/json`; es gibt keine HTML-Antwort und keinen Antwortkörper, der einen Eingabewert des Anfragenden wiedergibt. *(Abschnitt 3.12, „Ausgabe-Typ, Fehlercodes" je Route; Abschnitt 3.15 D.3, Statuscodes je Route)*

---

### 5.14 REST — Geheimnisse at rest

**(a) Die Fehlerklasse.** Die Entscheidung folgt einer Frage: Muss der Server den Wert im Klartext zurückbekommen? Nein ⇒ hashen. Ja ⇒ verschlüsseln, mit einem Schlüssel, der nicht in der Datenbank liegt. Der häufigste Fehler ist, Sitzungstokens im Klartext zu speichern, „weil man sie ja nachschlagen muss" — man schlägt aber nicht den Token nach, sondern seinen Hash. Für Werte mit ≥ 128 bit Entropie genügt SHA-256 ohne Salz; für Werte niedriger Entropie (Kennwörter) ist ein schneller Hash falsch.

**(b) Der Präzedenzfall.** Better Auth speichert Sitzungstokens im Klartext: `packages/better-auth/src/db/internal-adapter.ts:513` erzeugt `token: generateId(32)` und legt ihn unverändert ab, der Lookup läuft auf der Klartextspalte. Wiederherstellungscodes liegen als JSON-Blob in *einer* Spalte (`packages/better-auth/src/plugins/two-factor/backup-codes/index.ts:78-99`), sodass „einen Code verbrauchen" ein Read-Modify-Write des ganzen Blobs ist; ohne gesetztes `storeBackupCodes` wird der Blob unverschlüsselt gespeichert (`:87`). TOTP-Secrets werden dagegen korrekt verschlüsselt (`packages/better-auth/src/plugins/two-factor/index.ts:244-273`).

**(c) Die Anforderungen.**

- **S-REST-1:** Ein `pg_dump` des Schemas `velve` enthält keinen Sitzungstoken, keinen Einmal-Token, keine WebAuthn-Challenge, keinen Wiederherstellungscode, kein TOTP-Geheimnis, keinen PKCE-Verifier, kein fremdes OAuth-Token und kein Kennwort im Klartext — weder als Zeichenkette noch in Base64- oder Hex-Kodierung. *(Abschnitt 3.2, Speicherregel: „Nichts Vertrauliches liegt im Klartext in der Datenbank.")*
- **S-REST-2:** Was der Server nur vergleicht, liegt gehasht vor: `session.token_sha256`, `one_time_token.token_sha256`, `pending_authentication.token_sha256`, `webauthn_challenge.challenge_sha256` und `oauth_flow.state_sha256` sind `bytea`-Spalten mit SHA-256-Werten. *(Abschnitt 3.2, Speicherregel und Schema)*
- **S-REST-3:** Ein Wiederherstellungscode wird als `HMAC-SHA256(pepper, code)` unter dem Zweckschlüssel `token-pepper` gespeichert, mit der Schlüsselversion in `recovery_code.key_version`; jeder Code ist eine eigene Zeile, und das Einlösen ist ein `DELETE … RETURNING` auf genau dieser Zeile. *(Abschnitt 3.6, Wiederherstellungscodes; Abschnitt 3.16, L-3)*
- **S-REST-4:** Was der Server im Klartext braucht, liegt AES-256-GCM-verschlüsselt vor: `totp_credential.secret_enc`, `oauth_flow.pkce_verifier_enc`, `identity.access_token_enc`, `identity.refresh_token_enc` und `identity.id_token_enc`. *(Abschnitt 3.2, Speicherregel; Abschnitt 2.7, Zeile „AES-256-GCM")*
- **S-REST-5:** Ein Kennwort liegt ausschließlich als kanonischer PHC-String vor, und dieser liegt in `password_credential.phc` (`bytea`) AES-256-GCM-verschlüsselt unter dem Zweck `password-enc`, mit der Schlüsselversion in `password_credential.key_version`; `scheme` bleibt Klartext. Die Bibliothek speichert kein fremdes Rohformat und keine umkehrbare Darstellung eines Kennworts. *(Abschnitt 3.3; Abschnitt 3.16, L-2; Abschnitt 3.17)*
- **S-REST-6:** Fremde OAuth-Tokens werden nur gespeichert, wenn die Anwendung das ausdrücklich verlangt; die Vorgabe ist `storeTokens: false`. *(Abschnitt 3.10, letzter Absatz)*
- **S-REST-7:** Erzeugt die Bibliothek einen Kennwort-Hash, entspricht der erzeugte PHC-String genau den konfigurierten Parametern (Standard `m = 19456`, `t = 2`, `p = 1`, 32 Byte Ausgabe, 16 Byte Salz); ein gespeicherter Hash mit schwächeren Parametern oder einem Nicht-Standardverfahren führt beim nächsten erfolgreichen Login zu einem Rehash. *(Abschnitt 3.3, Standardparameter und Schritte 5–6)*

---

### 5.15 KEY — Schlüsselverwaltung und Rotation

**(a) Die Fehlerklasse.** Ein Geheimnis für alles bedeutet: ein Leck kompromittiert alles gleichzeitig, Rotation macht alles gleichzeitig ungültig, und ohne Domänentrennung kann ein in einem Kontext erzeugter Wert in einem anderen als gültig durchgehen. Rotation ohne Übergangsfenster loggt alle Nutzer aus; Rotation ohne Neuverschlüsselung macht den alten Schlüssel für immer nötig. Und bei kompromittierten *Verschlüsselungs*-Schlüsseln reicht Rotation nicht — die geschützten Geheimnisse selbst müssen neu erzeugt werden.

**(b) Der Präzedenzfall.** Better Auth hat Rotation implementiert (Envelope `$ba$<version>$<ciphertext>`, `packages/better-auth/src/crypto/secret-rotation.test.ts`, `packages/better-auth/src/context/secret-utils.ts`), die Migration ist aber unvollständig: zahlreiche Aufrufstellen nutzen weiterhin den einzelnen `ctx.context.secret` statt `secretConfig` — unter anderem `packages/better-auth/src/api/routes/session.ts:91,126,225`, `email-verification.ts:60,188,307,341,444`, `sign-out.ts:80`, `cookies/index.ts:220,231,315,335,366,379,391`, `two-factor/index.ts:415,460,470,493,512,561`. Für alles, was über `ctx.context.secret` läuft, ist die Rotation ohne Wirkung; zudem dient dasselbe Wurzelgeheimnis direkt als HMAC-Schlüssel und als Verschlüsselungsschlüssel, ohne zweckgebundene Ableitung. Verwandt: GHSA-9h47-pqcx-hjr4 (8.7 High, CWE-327/757/1188) — das Discovery-Dokument bewarb `"none"` als Signaturalgorithmus.

**(c) Die Anforderungen.**

- **S-KEY-1:** Alle Arbeitsschlüssel werden per HKDF-SHA256 aus einem Wurzelschlüssel abgeleitet, mit genau einem Ableitungskontext je Zweck; die sechs Zwecke sind `cookie-sig`, `token-pepper`, `totp-enc`, `oauth-token-enc`, `pkce-enc` und `password-enc`. *(Abschnitt 3.8, erster Absatz; Abschnitt 3.15 A.8, `KeyPurpose`; Abschnitt 3.16, L-2)*
- **S-KEY-2:** Ein mit dem Schlüssel eines Zwecks erzeugter Wert ist mit dem Schlüssel eines anderen Zwecks nicht verifizierbar und nicht entschlüsselbar. *(Abschnitt 3.8, Zwecktrennung)*
- **S-KEY-3:** Jeder erzeugte, geschützte Wert trägt seine Schlüsselversion mit sich — entweder im Envelope oder in einer eigenen Spalte (`totp_credential.key_version`, `oauth_flow.key_version`, `identity.token_key_version`, `password_credential.key_version`, `recovery_code.key_version`). *(Abschnitt 3.8: „Jeder erzeugte Wert trägt seine Schlüsselversion im Envelope."; Abschnitt 3.2 und 3.17, Schema)*
- **S-KEY-4:** Der `KeyProvider` liefert über `current(purpose)` genau eine Version zum Erzeugen und über `byVersion(purpose, version)` jede Version des Rings zum Prüfen; eine nicht mehr im Ring enthaltene Version führt zu `null` und damit zu einem klar benannten Fehler statt zu einem generischen Absturz. *(Abschnitt 3.8, `KeyProvider`-Schnittstelle)*
- **S-KEY-5:** Eine Rotation des Wurzelschlüssels beendet keine bestehende Sitzung: nach dem Vorschalten einer neuen Version und nach dem Entfernen der alten Version aus dem Ring bleiben alle Zeilen in `velve.session` gültig. *(Abschnitt 3.8: „Weil Sitzungen undurchsichtige Datenbankzeilen sind, überlebt jede Schlüsselrotation sämtliche Sitzungen.")*
- **S-KEY-6:** Die Bibliothek startet nicht, wenn der Wurzelschlüssel fehlt oder kürzer als 32 Byte ist. *(Abschnitt 3.8, Standardimplementierung; Abschnitt 3.12, `keys: keyProvider` als Pflichtfeld)*
- **S-KEY-7:** Die Prüfung der Signatur eines ID-Tokens akzeptiert ausschließlich asymmetrische Algorithmen aus einer aufgezählten Liste gegen den JWKS des Anbieters; `none` und symmetrische Algorithmen werden abgelehnt. *(Abschnitt 3.10: „ID-Token-Signatur gegen JWKS"; Abschnitt 2.7, `jose`)*

---

### 5.16 RACE — Nebenläufigkeit beim Konsum von Einmal-Artefakten

**(a) Die Fehlerklasse.** `SELECT` → Prüfung → `DELETE` ist nicht atomar. Zwei parallele Anfragen passieren beide das `SELECT`, bevor die erste das `DELETE` abschließt, und beide gelten als gültig. Betroffen sind alle Einmal-Artefakte: Reset-Token, Magic Link, E-Mail-Wechsel, WebAuthn-Challenge, OAuth-`state`, Wiederherstellungscode, TOTP-Zeitschritt. Die einzige verlässliche Gegenmaßnahme ist, die Zustandsbedingung als Prädikat ins `WHERE` zu schreiben statt in ein `if` — plus Eindeutigkeitsbedingungen als letzte Verteidigung.

**(b) Der Präzedenzfall.** GHSA-7w99-5wm4-3g79 / CVE-2026-53518 (7.6 High, CWE-362/367/294): „the token endpoint used a non-atomic find-then-delete; two concurrent requests both passed the read." GHSA-392p-2q2v-4372 / CVE-2026-53517 (7.6 High): das `update`-Prädikat war nur auf `id` gekeyt, nicht zusätzlich auf `revoked IS NULL`. GHSA-8c5h-wx78-2cfg (8.1 High, CWE-287/345/367/862) ist die TOCTOU-Ausprägung. Drei Advisories, dieselbe Ursache, innerhalb weniger Monate.

**(c) Die Anforderungen.**

- **S-RACE-1:** Bei 50 zeitgleichen Einlöseversuchen desselben Einmal-Tokens ist genau einer erfolgreich. *(Abschnitt 3.7, `DELETE … RETURNING` als einziger Konsumweg)*
- **S-RACE-2:** Vor einem Konsum steht kein lesender Zugriff auf dieselbe Zeile; die Gültigkeitsbedingungen `purpose` und `expires_at > now()` stehen im `WHERE` derselben Anweisung, die die Zeile entfernt. *(Abschnitt 3.7, SQL-Block)*
- **S-RACE-3:** Bei 50 zeitgleichen Einreichungen desselben TOTP-Codes desselben Nutzers ist genau eine erfolgreich; die Serialisierung leistet der Primärschlüssel `(user_id, time_step)`. *(Abschnitt 3.6, TOTP-Absatz)*
- **S-RACE-4:** Bei 50 zeitgleichen Einreichungen desselben Wiederherstellungscodes ist genau eine erfolgreich; die Serialisierung leistet der Primärschlüssel `(user_id, code_hmac)` zusammen mit `DELETE … RETURNING`. *(Abschnitt 3.6, Wiederherstellungscodes; Abschnitt 3.2, Schema)*
- **S-RACE-5:** Sitzungsneuvergabe (`INSERT` neu, `DELETE` alt) und Kennwortänderung laufen in einer Transaktion; ein Fehler nach dem einen und vor dem anderen Schritt hinterlässt keinen der beiden Effekte. *(Abschnitt 3.5, „in einer Transaktion"; Abschnitt 3.2, `Driver.transaction`)*
- **S-RACE-6:** Der Rehash nach erfolgreicher Anmeldung schreibt per Vergleich-und-Tausch (`… WHERE user_id = $1 AND phc = $alt`); schlägt der Tausch fehl, bleibt der bestehende Hash unverändert und es entsteht kein Fehlerzustand. *(Abschnitt 3.3, Schritt 6: „Schlägt das fehl, ist nichts kaputt")*

---

### 5.17 DEFAULT — Unsichere Vorgabewerte

**(a) Die Fehlerklasse.** Fast jede „Critical"-Bewertung in der Advisory-Historie hängt an einer Vorgabe, nicht an einem Fehler im engeren Sinn: `alg=none` beworben, `providerOwnership` aus, `cookieCache` vor dem zweiten Faktor, `revokeSessionsOnPasswordReset` undefiniert. Der Mechanismus ist immer derselbe: eine Sicherheitsfunktion ist opt-in, also ist sie in der überwiegenden Zahl der Installationen aus, und der Autor der Bibliothek erfährt davon erst aus dem Advisory.

**(b) Der Präzedenzfall.** GHSA-9h47-pqcx-hjr4 (8.7 High): fehlendes `code_challenge_method` wurde still auf `plain` heruntergestuft. GHSA-j8v8-g9cx-5qf4 (8.3 High): `providerOwnership` war standardmäßig aus. GHSA-fmh4-wcc4-5jm3 / CVE-2026-53514 (7.7 High): E-Mail-Verifikation ist standardmäßig aus, und der Einladungsendpunkt behandelte String-Gleichheit trotzdem als Eigentumsnachweis. Und in `packages/better-auth/src/api/routes/password.ts:328` prüft der Reset-Pfad `options.emailAndPassword?.revokeSessionsOnPasswordReset`, das in `packages/core/src/types/init-options.ts:860` als optionales Feld deklariert ist und nirgends auf einen Wert gesetzt wird — also `undefined` und damit falsch.

**(c) Die Anforderungen.**

- **S-DEFAULT-1:** Jede sicherheitsrelevante Einstellung der Bibliothek ist in ihrer Vorgabestellung die sichere; eine Abschwächung erfordert eine ausdrückliche Angabe in der Konfiguration und wird beim Start protokolliert. *(Abschnitt 3.11, „Die Erweiterungspunkte sind aufgezählt, nicht offen"; Abschnitt 3.10, `storeTokens: false` als Vorgabe; Abschnitt 3.5, „Das ist kein Schalter.")*
- **S-DEFAULT-2:** Die Bibliothek enthält keine Option, die den Widerruf anderer Sitzungen bei Kennwortänderung oder Kennwort-Reset abschaltet. *(Abschnitt 3.5: „Kennwort-Reset und Kennwortänderung widerrufen standardmäßig alle anderen Sitzungen. Das ist kein Schalter.")*
- **S-DEFAULT-3:** Die Bibliothek enthält keine Option, die PKCE, die Zustandsprüfung, die Origin-Prüfung oder die Ratenbegrenzung deaktiviert. *(Abschnitt 3.10, „PKCE S256 verpflichtend"; Abschnitt 3.11, „Origin-Prüfung und Ratenbegrenzung liegen immer davor")*
- **S-DEFAULT-4:** Die Konfiguration `identity: "username"` ohne `recoveryCodes: true` führt zu einem Startfehler. *(Abschnitt 3.4: „Die Bibliothek erzwingt das: `identity: "username"` ohne `recoveryCodes: true` ist ein Startfehler.")*
- **S-DEFAULT-5:** Ein Namenskonflikt zwischen zwei Plugins oder zwischen einem Plugin und dem Kern — Route, Tabellenpräfix oder Fehlercode — führt zu einem Startfehler und nicht zu einer Warnung. *(Abschnitt 3.11: „Ein Namenskonflikt ist ein Startfehler, keine Warnung.")*
- **S-DEFAULT-6:** Die Standardparameter für Argon2id sind `m = 19456` KiB, `t = 2`, `p = 1` bei 32 Byte Ausgabe und 16 Byte Salz und lassen sich nur nach oben verändern; eine Konfiguration mit schwächeren Parametern führt zu einem Startfehler. *(Abschnitt 3.3: „Standardparameter für Argon2id … Konfigurierbar nach oben.")*
- **S-DEFAULT-7:** Wird die optionale Beschleunigerabhängigkeit `hash-wasm` gefunden, sind die von ihr erzeugten und geprüften Argon2id-Werte bitgleich mit denen von `@noble/hashes`; ihr Vorhandensein oder Fehlen ändert kein Sicherheitsverhalten. *(Abschnitt 2.1 und 2.7, `hash-wasm` als optionale Peer-Abhängigkeit)*

---

### 5.18 DOS — Ressourcenerschöpfung durch das KDF

**(a) Die Fehlerklasse.** Ein speicherhartes KDF ist eine Waffe, die in beide Richtungen zeigt. Argon2id mit `m = 19456` KiB belegt pro Aufruf 19 MiB. Ohne Begrenzung der Nebenläufigkeit multipliziert eine Anmeldeflut diesen Betrag mit der Zahl der gleichzeitigen Anfragen, und der Prozess stirbt am Speicher statt Anfragen abzulehnen. Der zweite Vektor ist die Eingabelänge: ein megabytegroßes „Kennwort" kostet vor dem KDF nichts und im KDF alles, wenn die Länge erst danach geprüft wird. Der dritte ist der Wartefall: ohne Wartegrenze stauen sich wartende Anfragen unbegrenzt auf.

**(b) Der Präzedenzfall.** Für die KDF-Erschöpfung selbst gibt es in der Better-Auth-Historie keinen eigenen Advisory. Die verwandte Ausprägung ist GHSA-569q-mpph-wgww / CVE-2025-71401 (2.9 Low, Fix 1.4.2): ohne gesetztes `baseURL` vertraute der Router beim ersten Request `X-Forwarded-Host`/`-Proto` und vergiftete dauerhaft den Basispfad — eine Dienstverweigerung, ausgelöst durch eine einzige externe Anfrage.

**(c) Die Anforderungen.**

- **S-DOS-1:** Die Eingabelänge wird vor jedem KDF-Aufruf geprüft: ein Kennwort unter 8 Zeichen und ein Kennwort über 4096 Byte werden abgelehnt, ohne dass ein KDF-Aufruf stattfindet. *(Abschnitt 3.3, Ablauf, Schritt 1: „vor jedem KDF-Aufruf"; Abschnitt 3.16, L-7)*
- **S-DOS-2:** Die Längenprüfung hängt ausschließlich von der Eingabe ab und läuft vor der Auflösung des Nutzers; eine Anmeldung mit zu langem oder zu kurzem Kennwort liefert daher für eine existierende und eine nicht existierende Kennung byteweise dieselbe Antwort in derselben Zeit und ist kein Aufzählungsorakel. *(Abschnitt 3.16, L-1: „genau ein Codepfad, der unabhängig vom Ergebnis dieselbe Arbeit verrichtet"; Abschnitt 3.3 Schritt 1)*
- **S-DOS-3:** Die Zahl gleichzeitig laufender KDF-Aufrufe im Prozess ist durch einen Semaphor auf `min(4, cpus)` begrenzt; der belegte Speicher überschreitet daher unabhängig von der Zahl gleichzeitiger Anfragen nicht das Produkt aus Semaphorgröße und KDF-Speicherparameter. *(Abschnitt 3.3, Nebenläufigkeitsabsatz)*
- **S-DOS-4:** Eine Anfrage, die nach 5 Sekunden keinen Semaphorplatz bekommen hat, wird mit `rate_limited` abgelehnt; die Wartegrenze gilt für existierende und nicht existierende Konten gleich, und wartende Anfragen erzeugen keinen Speicherfehler und keinen Absturz. *(Abschnitt 3.16, L-1, Wartegrenze; Abschnitt 3.3, Nebenläufigkeitsabsatz)*
- **S-DOS-5:** Die Ratenbegrenzung je IP-Präfix und Route läuft vor der Semaphor-Anforderung, sodass eine Flut abgelehnt wird, bevor sie Semaphorplätze belegt. *(Abschnitt 3.11: „Origin-Prüfung und Ratenbegrenzung liegen immer davor — auch bei direkten Serveraufrufen.")*
- **S-DOS-6:** Der Rehash im Hintergrund belegt denselben Semaphor wie der Prüfpfad; eine Anmeldewelle nach einer Parameteranhebung verdrängt keine laufenden Anmeldungen. *(Abschnitt 3.3, Schritt 6 „in einer begrenzten Hintergrundaufgabe" und Nebenläufigkeitsabsatz)*

---

### 5.19 Abdeckungstabelle: die 33 Better-Auth-Advisories

Jede Zeile nennt den Advisory, seine Fehlerklasse und die Velve-Auth-Anforderungen, die diese Klasse ausschließen — oder den Grund, warum die Klasse in Velve Auth nicht existieren kann. „Nicht anwendbar" bedeutet: die betroffene Funktion ist nach Abschnitt 3.14 ausdrücklich nicht Teil des Produkts. Wo die Funktion fehlt, aber die *Klasse* dennoch durch eine Anforderung strukturell verhindert wäre, ist diese Anforderung in Klammern genannt — sie schützt die Plugins, die diese Funktion nachrüsten könnten.

| # | GHSA | CVE / CVSS | Klasse | Velve-Auth-Anforderung |
|---|---|---|---|---|
| 1 | GHSA-8jhw-6pjj-8723 | CVE-2024-56734, 7.9 | Open Redirect (`callbackURL`) | S-REDIR-1, S-REDIR-2, S-REDIR-4 |
| 2 | GHSA-9x4v-xfq5-m8x5 | —, 5.1 | Reflected XSS auf `/api/auth/error` | S-REDIR-7 (nur JSON, keine Rückspiegelung von Eingaben) |
| 3 | GHSA-hjpm-7mrm-26w8 | CVE-2025-27143, 6.9 | Protokollrelative URL `//evil.com` | S-REDIR-2, S-REDIR-5 |
| 4 | GHSA-vp58-j275-797x | —, 7.1 | Origin-Bypass → Reset-Token-Leck | S-REDIR-4, S-REDIR-5, S-CSRF-2 |
| 5 | GHSA-36rg-gfq2-3h56 | CVE-2025-53535, 2.1 | `startsWith` beim Origin-Vergleich | S-CSRF-2, S-CSRF-3, S-REDIR-5 |
| 6 | GHSA-99h5-pjcv-gr6v | CVE-2025-61928, 8.6 | Unauthentifizierte API-Key-Erstellung | Nicht anwendbar, weil Velve Auth keine API-Keys hat (Abschnitt 3.14). Klasse strukturell verhindert durch S-OWNER-1, S-OWNER-7 |
| 7 | GHSA-4vcf-q4xf-f48m | —, 7.1 | Passkey-Löschung via IDOR | **S-OWNER-2, S-OWNER-3, S-OWNER-8** — direkt anwendbar, Velve Auth hat Passkeys |
| 8 | GHSA-wmjr-v86c-m9jj | —, 2.0 | Ungeprüfte Cookie-Werte beim Multi-Session-Signout | Nicht anwendbar, weil Velve Auth kein Multi-Session-Plugin hat. Klasse verhindert durch S-OWNER-4, S-COOKIE-4 |
| 9 | GHSA-569q-mpph-wgww | CVE-2025-71401, 2.9 | `X-Forwarded-Host` vergiftet den Basispfad | S-RATE-3, S-CSRF-2, S-DEFAULT-1 (Origins sind konfiguriert, nicht aus Kopfzeilen abgeleitet) |
| 10 | GHSA-x732-6j76-qmhm | —, 8.6 | Doppelslash umgeht Rate-Limit | S-RATE-5 (Schlüssel aus dem aufgelösten Routennamen) |
| 11 | GHSA-xg6x-h9c9-2m83 | —, **9.1** | 2FA-Bypass über Cookie-Cache | **S-CACHE-1, S-CACHE-2, S-CACHE-4, S-COOKIE-4, S-FIX-4** |
| 12 | GHSA-p6v2-xcpg-h6xw | CVE-2026-45364, 7.3 | IPv6-Einzeladresse als Ratenschlüssel | **S-RATE-1, S-RATE-2** |
| 13 | GHSA-wxw3-q3m9-c3jr | —, 5.3 | `state` im Cookie-Zweig nie verglichen | S-CSRF-5, S-REPLAY-6 |
| 14 | GHSA-xr8f-h2gw-9xh6 | CVE-2026-41427, 8.4 | OAuth-Provider: Hook bei Create übersprungen | Nicht anwendbar, weil Velve Auth kein eigener OAuth-Server ist (Abschnitt 3.14). Klasse verhindert durch S-OWNER-1 |
| 15 | GHSA-cq3f-vc6p-68fh | CVE-2026-45337, 7.6 | Device-Grant ohne Eigentümerbindung | Nicht anwendbar, weil Velve Auth keinen Device Authorization Grant hat. Klasse verhindert durch S-OWNER-2 |
| 16 | GHSA-g38m-r43w-p2q7 | CVE-2026-53516, 8.3 | Auto-Link liest lokales `emailVerified` nicht | **S-LINK-1, S-LINK-2, S-LINK-3** |
| 17 | GHSA-fmh4-wcc4-5jm3 | CVE-2026-53514, 7.7 | Einladungsannahme per E-Mail-Stringgleichheit | Nicht anwendbar, weil Velve Auth keine Organisationen und keine Einladungen hat (Abschnitt 3.14). Klasse verhindert durch S-LINK-1 |
| 18 | GHSA-5rr4-8452-hf4v | CVE-2026-53513, **9.6** | SSRF bei SSO-Provider-Registrierung | Nicht anwendbar, weil Velve Auth kein SSO/SAML und keine Provider-Registrierung zur Laufzeit hat (Abschnitt 3.14). Klasse verhindert durch S-REDIR-6 |
| 19 | GHSA-gv74-j8m3-fg5f | CVE-2026-53515, 7.1 | SSO-Registrierung ohne Rollenprüfung | Nicht anwendbar, weil Velve Auth kein SSO und keine Rollen hat (Abschnitt 3.14) |
| 20 | GHSA-pw9m-5jxm-xr6h | CVE-2026-53512, **9.1** | Refresh-Grant ohne Client-Authentifizierung | Nicht anwendbar, weil Velve Auth keine Tokens ausgibt, sondern nur fremde entgegennimmt (Abschnitt 3.14) |
| 21 | GHSA-9h47-pqcx-hjr4 | —, 8.7 | `alg=none`, stiller Downgrade auf `plain` PKCE | S-KEY-7 (Algorithmus-Erlaubnisliste), S-DEFAULT-3 (PKCE S256 nicht abschaltbar), S-REPLAY-6 |
| 22 | GHSA-7w99-5wm4-3g79 | CVE-2026-53518, 7.6 | Nebenläufige Einlösung von Autorisierungscodes | Nicht anwendbar als OAuth-Server; die Klasse trifft Velve Auths eigene Einmal-Artefakte und ist durch **S-RACE-1, S-RACE-2** ausgeschlossen |
| 23 | GHSA-392p-2q2v-4372 | CVE-2026-53517, 7.6 | Refresh-Familie forkt statt widerrufen zu werden | Nicht anwendbar, weil Velve Auth keine Refresh-Token-Familien ausgibt. Klasse verhindert durch S-RACE-2 (Zustandsbedingung im `WHERE`) |
| 24 | GHSA-2vg6-77g8-24mp | —, 3.8 | Sitzungen überleben die Löschung des Nutzers | **S-TOKEN-5, S-TOKEN-6** (`ON DELETE CASCADE` an jeder nutzergebundenen Tabelle, per Migrationsläufer erzwungen) |
| 25 | GHSA-86j7-9j95-vpqj | —, 7.7 | `javascript:` als `redirect_uri` | Nicht anwendbar, weil Velve Auth keine OAuth-Client-Registrierung hat. Klasse verhindert durch S-REDIR-1, S-REDIR-3 |
| 26 | GHSA-p2fr-6hmx-4528 | —, 6.4 | Access-Token-Audience nicht an den Grant gebunden | Nicht anwendbar, weil Velve Auth keine Access-Tokens ausgibt (Abschnitt 3.14) |
| 27 | GHSA-j8v8-g9cx-5qf4 | —, 8.3 | SCIM: `providerOwnership` per Vorgabe aus | Nicht anwendbar, weil Velve Auth kein SCIM hat (Abschnitt 3.14). Klasse verhindert durch S-OWNER-1, S-DEFAULT-1 |
| 28 | GHSA-h3rm-78g3-j7cp | —, 7.1 | Autorisierungsparameter aus zwei Quellen | Nicht anwendbar, weil Velve Auth kein Stripe-Modul und keine Organisationen hat (Abschnitt 3.14). Klasse verhindert durch **S-OWNER-6** |
| 29 | GHSA-prpr-5gj3-qqhg | —, 8.1 | SSO: Parser-Differential, verwaiste Verknüpfungen, fehlende SAML-Prüfungen, XSS | Nicht anwendbar, weil Velve Auth kein SSO/SAML hat (Abschnitt 3.14). Teilklasse „verwaiste Verknüpfungen" verhindert durch S-TOKEN-5; „Parser-Differential" durch S-REDIR-5, S-CSRF-2 |
| 30 | GHSA-rjg6-39jm-rgg4 | —, **9.9** | SCIM-Provider-ID kollidiert mit SSO-Provider-ID | Nicht anwendbar, weil Velve Auth kein SCIM hat (Abschnitt 3.14). Klasse „Namensraumkollision" verhindert durch **S-DEFAULT-5** und S-OWNER-11 |
| 31 | GHSA-qq9h-g4jm-xgf3 | —, 8.3 | Magic Link / E-Mail-OTP: Vorabkonto behält Kennwort | **S-LINK-4** — direkt anwendbar, Velve Auth hat Magic Links (Abschnitt 3.7); geschlossen durch L-12 |
| 32 | GHSA-8c5h-wx78-2cfg | —, 8.1 | SSO-Domain-Eigentum: TOCTOU und fehlende Verifikation | Nicht anwendbar, weil Velve Auth keine Domain-Verifikation hat (Abschnitt 3.14). TOCTOU-Klasse verhindert durch S-RACE-2 |
| 33 | GHSA-hq75-xg7r-rx6c | —, 4.9 | `better-call`-Routing → Cache Deception | Nicht anwendbar, weil Velve Auth keinen Fremdrouter nutzt: die Route wird einmal deklariert und daraus wird der Handler erzeugt (Abschnitt 3.12). Klasse verhindert durch S-RATE-5, S-CACHE-1 und `Cache-Control: no-store` auf jeder Antwort (L-6) |

**Auswertung.** Von 33 Advisories sind **15 unmittelbar auf Velve Auth übertragbar** (#1–#5,
#7, #9–#13, #16, #21, #24, #31 — davon #9 und #21 nur teilweise) und **18 nicht anwendbar,
weil die betroffene Funktion nach Abschnitt 3.14 nicht existiert**. Von den 18 nicht anwendbaren wären 15 zusätzlich durch eine strukturelle Anforderung ausgeschlossen, wenn ein Plugin die Funktion nachrüstete; die drei übrigen (#19, #20, #26) betreffen Rollen und Token-Ausgabe, für die es im Kern keine Entsprechung gibt. Die drei Anforderungen mit der größten Hebelwirkung sind S-OWNER-1 (Actor-Pflicht, verhindert die Klasse mit 10 Advisories), S-RACE-2 zusammen mit S-REPLAY-2 (atomarer Konsum als einziger Weg, verhindert Replay, Race und Zweckverwechslung) und S-LINK-1 (die E-Mail ist kein Schlüssel, verhindert die Klasse mit den höchsten CVSS-Werten).

---

### 5.20 Die vormals offenen Punkte

Bei der Ausarbeitung dieses Abschnitts und des Prüfplans wurden dreizehn Lücken in der Zielarchitektur sichtbar. Sie sind **entschieden und geschlossen** — die Entscheidungen stehen in Abschnitt 3.16 als L-1 bis L-13 und sind in die Anforderungen oben eingearbeitet.

| Lücke | Entschieden in |
|---|---|
| Wartegrenze statt Antwort-Deadline | L-1 (wirkt auf S-TIM-6, S-DOS-2, S-DOS-4) |
| Kein Pepper für Kennwörter | L-2 — stattdessen Umschlagverschlüsselung, Zweck `password-enc` (wirkt auf S-REST-5, S-KEY-1, S-KEY-3) |
| `recovery_code` ohne Schlüsselversion | L-3 (wirkt auf S-REST-3, S-KEY-3) |
| Deaktiviertes Konto als Aufzählungsorakel | L-4 (wirkt auf S-ENUM-2, S-CACHE-2, S-CACHE-3) |
| Schlüssel des kontobezogenen Zählers | L-5 (wirkt auf S-RATE-7) |
| Fehlende HTTP-Cache-Kopfzeilen | L-6 (wirkt auf S-CACHE-1) |
| Keine Kennwortuntergrenze, kein Leak-Abgleich | L-7 (wirkt auf S-DOS-1) |
| Versuchsgrenze im Zwischenzustand | L-8 |
| Rückläufiger `sign_count` | L-9, dokumentierte Abweichung von WebAuthn Level 3 §7.2 |
| Volle IP und User-Agent in `velve.session` | L-10 |
| Kein benannter Aufräumlauf (sieben `*_sweep_idx`) | L-11 |
| Unverifiziertes Vorabkonto (GHSA-qq9h-g4jm-xgf3) | L-12 (wirkt auf S-LINK-4) |
| Entfernen des letzten Anmeldewegs | L-13 |

---

## 6. Prüfplan

Zu jeder der 123 Anforderungen aus Abschnitt 5 gehört ein Testfall. Die Test-ID trägt dieselbe Klasse und dieselbe Nummer wie die Anforderung: `T-OWNER-3` prüft `S-OWNER-3`. Hinzu kommen vier ergänzende Testfälle, die keiner einzelnen Anforderung zugeordnet sind, sondern eine Klasse breiter absichern (`T-TIM-1b`, `T-RAND-Verteilung`, `T-RAND-Kollision`, `T-CSRF-Parser`) — zusammen **127 Testfälle**.

**Spalten.** *Art* ist eine von sechs: `Unit`, `Integration`, `Property` (fast-check), `Statistisch`, `Nebenläufigkeit`, `Statisch` (Lint-Regel, AST-Analyse, Typprüfung); Kombinationen sind mit `+` angegeben. *Schwelle* ist eine Zahl oder ein hartes Kriterium — kein Test in diesem Plan besteht mit „keine Fehler". *Läuft in* ist eine von drei Stufen: `CI bei jedem Commit` (109 Testfälle, dazu der statische Teil von T-RACE-2), `CI nächtlich` (15, dazu der Nebenläufigkeitsteil von T-RACE-2), `vor jedem Release` (2).

**Grundsatz der Stufenzuordnung.** Alles Deterministische blockiert jeden Commit. Alles Statistische und alles, was länger als 60 Sekunden läuft, läuft nächtlich auf einem dedizierten Läufer und meldet als Ticket, nicht als roter Build. Der Grund steht in Abschnitt 6.20.

---

### 6.1 TIM — Zeitangriffe

| Test-ID | prüft | Art | Vorgehen | Schwelle | läuft in |
|---|---|---|---|---|---|
| T-TIM-1 | S-TIM-1 | Statistisch | In-Process-Server, echtes Postgres, produktive KDF-Parameter. Gruppe X: 50 existierende Konten. Gruppe Y: 50 nicht existierende Adressen gleicher Länge und gleicher Domain. n = 1000 je Gruppe, verschränkt in zufälliger Reihenfolge, erste 100 Messungen verworfen. Messgröße `process.hrtime.bigint()` um den Handler plus TTFB über echten Socket. | Welch-t-Test auf 10-%-getrimmten Mitteln: **\|t\| < 4,5**; zusätzlich **Cliff's δ < 0,147** | CI nächtlich |
| T-TIM-1b | S-TIM-1 | Unit | Instrumentierter Treiber protokolliert jeden DB- und KDF-Aufruf. Vier Fälle: existierendes Konto + falsches Kennwort, nicht existierendes Konto, existierendes Konto ohne `password_credential`, syntaktisch ungültige E-Mail. | **4/4 Aufrufsequenzen byteweise identisch** | CI bei jedem Commit |
| T-TIM-2 | S-TIM-2 | Unit | Dummy-PHC beim Prozessstart erzeugen, PHC-Parameter parsen und gegen die Konfiguration vergleichen; per Spion prüfen, welche Verifier-Funktion im Dummy-Pfad aufgerufen wird. | `m/t/p/Salzlänge` exakt gleich; **die aufgerufene Funktion ist `verify`, nicht `hash`** | CI bei jedem Commit |
| T-TIM-3 | S-TIM-3 | Statisch | `ts-morph`-Regel: in `src/core/**` ist jeder Vergleichsoperator und jede Vergleichsmethode (`===`, `!==`, `==`, `startsWith`, `includes`, `localeCompare`, `indexOf`) auf einem Wert vom Branded Type `Secret<…>` verboten. | **0 Verstöße**, Laufzeit < 5 s | CI bei jedem Commit |
| T-TIM-4 | S-TIM-4 | Statisch + Integration | AST-Scan: kein SQL-Literal im Repository enthält `token =` ohne `_sha256`. Ergänzend Integrationstest, der eine Sitzung anlegt und `SELECT` auf jede Textspalte der Tabelle nach dem Klartext-Token durchsucht. | **0 SQL-Treffer; 0 Spaltentreffer** | CI bei jedem Commit |
| T-TIM-5 | S-TIM-5 | Integration | Konto mit veraltetem bcrypt-Hash anlegen, anmelden, TTFB messen; dasselbe mit einem Konto, dessen Hash bereits aktuell ist. 200 Messungen je Gruppe. | Differenz der Mediane **< 5 ms**; der Rehash ist danach in der Datenbank sichtbar | CI nächtlich |
| T-TIM-6 | S-TIM-6 | Integration + Statisch | Instrumentierter Treiber und Mailversand-Attrappe zählen Abfragen und Callback-Aufrufe für `POST /password/request-reset` und `POST /sign-in/magic-link/request`, je einmal mit existierendem und nicht existierendem Konto; dazu 200 Messungen je Fall. Typprüfung: der Optionstyp enthält keinen Schlüssel für eine Mindestantwortdauer. | **2/2 Endpunkte: identische Abfragefolge und genau 1 Callback-Aufruf in beiden Fällen**; Differenz der Mediane des ersten Antwortbytes **< 5 ms**; `rate_bucket` enthält nach beiden Fällen **genau 1 Zeile** für den Bezeichner; **0 Optionsschlüssel** | CI nächtlich |
| T-TIM-7 | S-TIM-7 | Unit | Instrumentierter Treiber, Fälle: bestätigtes und unbestätigtes Konto, jeweils mit falschem und mit korrektem Kennwort. Typprüfung: der Optionstyp enthält keinen Schlüssel `requireEmailVerification`. | Falsches Kennwort: **Aufrufsequenzen identisch**, Antwortkörper byteweise identisch. Korrektes Kennwort: **2/2 Sitzungen erzeugt**, die Antworten unterscheiden sich ausschließlich in `user.emailVerifiedAt`; **0 Optionsschlüssel** | CI bei jedem Commit |

---

### 6.2 FIX — Sitzungsfixierung

| Test-ID | prüft | Art | Vorgehen | Schwelle | läuft in |
|---|---|---|---|---|---|
| T-FIX-1 | S-FIX-1 | Integration, tabellengetrieben | Für jedes Ereignis der Konstante `TRUST_LEVEL_EVENTS` (Anmeldung Kennwort, Anmeldung Passkey, Abschluss TOTP, Abschluss WebAuthn-2F, Abschluss Wiederherstellungscode, Kennwortänderung, Kennwort-Reset, Identitätsverknüpfung): Token T1 merken, Ereignis auslösen, T2 lesen. | `T2 ≠ T1` in **8/8**; der Test schlägt fehl, wenn `TRUST_LEVEL_EVENTS.length ≠ Anzahl Testfälle` | CI bei jedem Commit |
| T-FIX-2 | S-FIX-2 | Statisch + Integration | AST-Scan über alle Repositories: kein `UPDATE`-Literal auf `velve.session` mit `user_id` im Set-Teil. Zusätzlich direktes `UPDATE velve.session SET user_id = …` über den Treiber gegen die Testdatenbank. | **0 AST-Treffer**; die Datenbank wirft eine Ausnahme, `SQLSTATE` ist nicht `00000` | CI bei jedem Commit |
| T-FIX-3 | S-FIX-3 | Integration | Nach jedem der 8 Ereignisse aus T-FIX-1 eine Anfrage mit T1 senden und die Zeilenzahl zählen. | `SELECT count(*) … token_sha256 = sha256(T1)` = **0**; Antwort mit T1 **byteweise identisch** zur Antwort ohne Cookie | CI bei jedem Commit |
| T-FIX-4 | S-FIX-4 | Integration | Anmeldung mit korrektem Kennwort bei aktivem zweitem Faktor; danach Tabellen zählen. | `velve.session` **+0 Zeilen**, `velve.pending_authentication` **+1 Zeile**; die Antwort setzt `__Host-velve_pending`, nicht `__Host-velve_session` | CI bei jedem Commit |
| T-FIX-5 | S-FIX-5 | Integration | `Set-Cookie`-Kopfzeilen jeder Antwort parsen, die eine Sitzung erzeugt. | Genau **1** Eintrag mit Sitzungsnamen; Attributmenge exakt `{HttpOnly, Secure, SameSite=Lax, Path=/}`; **kein** `Domain` | CI bei jedem Commit |
| T-FIX-6 | S-FIX-6 | Integration + Statisch | Drei Sitzungen A (aufrufend), B, C anlegen; Kennwort ändern und separat zurücksetzen. Zusätzlich Typprüfung: die Optionstypen enthalten keinen Schlüssel, der diesen Widerruf steuert. | B und C liefern die Antwort „nicht angemeldet", A bleibt gültig: **2/2 je Ereignis**; **0 Optionsschlüssel** | CI bei jedem Commit |

---

### 6.3 ENUM — Benutzeraufzählung

| Test-ID | prüft | Art | Vorgehen | Schwelle | läuft in |
|---|---|---|---|---|---|
| T-ENUM-1 | S-ENUM-1 | Integration | Zwei `POST /sign-in/password`-Anfragen mit gleich langen Kennungen, eine existierend, eine nicht. Antworten normalisieren (`Date` entfernen). | `status_a === status_b`, sortierte Kopfzeilennamen gleich, `Buffer.compare(body_a, body_b) === 0` — **0 abweichende Bytes** | CI bei jedem Commit |
| T-ENUM-2 | S-ENUM-2 | Integration, tabellengetrieben | Fünf Kontozustände herstellen, jeweils `POST /sign-in/password` mit falschem Kennwort; als sechsten Fall das deaktivierte Konto mit korrektem Kennwort. | **6/6 Antworten byteweise identisch**; `account_disabled` kommt in **0** der Antworten vor | CI bei jedem Commit |
| T-ENUM-3 | S-ENUM-3 | Integration | `POST /sign-up` mit vergebener und mit freier E-Mail gleicher Länge. | **0 abweichende Bytes** in Status, Kopfzeilenmenge und Körper | CI bei jedem Commit |
| T-ENUM-4 | S-ENUM-4 | Integration | Mailversand-Attrappe zählt Nachrichten und protokolliert die Vorlagenkennung. | Beide Fälle **genau 1 Nachricht**; Vorlagenkennungen **verschieden**; Empfängeradresse im Kollisionsfall die vorhandene | CI bei jedem Commit |
| T-ENUM-5 | S-ENUM-5 | Integration | `POST /password/request-reset` und `POST /email/request-change` je zweimal (existierend / nicht existierend). Beim E-Mail-Wechsel zusätzlich den Token auf eine kollidierende Adresse einlösen. | **0 abweichende Bytes** je Endpunkt; das Einlösen bei Kollision ändert **0 Zeilen** und liefert byteweise die Antwort auf einen erfundenen Token (`invalid_token`) | CI bei jedem Commit |
| T-ENUM-6 | S-ENUM-6 | Integration + Statisch | Protokoll-Senke prüfen: für jeden der 6 Fälle aus T-ENUM-2 muss der wahre Grund im Protokoll stehen. AST-Scan: die Abbildung von innerem Grund auf äußeren Code existiert an genau einer Stelle (`core/http/error-map.ts`). | **6/6 Gründe protokolliert**; **genau 1 Abbildungsstelle** | CI bei jedem Commit |
| T-ENUM-7 | S-ENUM-7 | Statisch | Routendeklaration bei `identity: "email"` auflisten und gegen eine Erlaubnisliste prüfen. | **0 Routen**, deren Antwort von der Existenz einer E-Mail abhängt | CI bei jedem Commit |
| T-ENUM-8 | S-ENUM-8 | Integration | `GET /username/available`: Antwortform prüfen; 11 Anfragen innerhalb einer Minute vom selben IP-Präfix; Anfrage mit Präfix-Platzhalter (`*`, `%`) senden. | Körper enthält **genau** die Felder `available` und optional `reason`; die **11. Anfrage** liefert `rate_limited`; Platzhalteranfrage liefert `available: false` mit `reason: "invalid_characters"` und keine Trefferliste | CI bei jedem Commit |

---

### 6.4 REPLAY — Wiederholung

| Test-ID | prüft | Art | Vorgehen | Schwelle | läuft in |
|---|---|---|---|---|---|
| T-REPLAY-1 | S-REPLAY-1 | Statisch | AST-Scan: keine Erzeugung eines Einmal-Artefakts über `jose`-Signatur; jede Erzeugung führt zu einem `INSERT` in eine Tabelle mit `token_sha256`/`challenge_sha256`/`state_sha256` als Primärschlüssel. | **0 signierte Einmal-Artefakte**; 4 Artefakttypen zugeordnet | CI bei jedem Commit |
| T-REPLAY-2 | S-REPLAY-2 | Integration | Für alle 4 Zwecke (`email_verify`, `password_reset`, `email_change`, `magic_link`): erzeugen, einlösen, erneut einlösen. | **4/4** erste Einlösung erfolgreich, zweite abgelehnt; nach der ersten Einlösung **0 Zeilen** in `one_time_token` | CI bei jedem Commit |
| T-REPLAY-3 | S-REPLAY-3 | Integration | Drei Anfragen je Zweck: abgelaufener Token (Uhr vorstellen), verbrauchter Token, erfundener Token. | **12/12 Antworten byteweise identisch** (4 Zwecke × 3 Fälle) | CI bei jedem Commit |
| T-REPLAY-4 | S-REPLAY-4 | Unit, kontrollierte Uhr | Uhr fixieren, Code berechnen, zweimal einreichen; Uhr um 30 s vorstellen, neuen Code einreichen; Code des vorherigen Schritts einreichen; Code des vorletzten Schritts einreichen. Zusätzlich prüfen, welcher `time_step` eingetragen wurde. | **5/5**: 200, 401, 200, 200, 401; der eingetragene `time_step` ist der des akzeptierten Codes | CI bei jedem Commit |
| T-REPLAY-5 | S-REPLAY-5 | Integration, kontrollierte Uhr | Challenge erzeugen, verwenden, erneut verwenden; Challenge erzeugen und nach 5 min + 1 s verwenden; `register`-Challenge an `authenticate` einreichen. | **3/3**: zweite Verwendung abgelehnt, abgelaufene abgelehnt, zweckfremde abgelehnt — alle mit derselben Antwort | CI bei jedem Commit |
| T-REPLAY-6 | S-REPLAY-6 | Integration + Statisch | Callback zweimal mit demselben `state` aufrufen; Callback mit erfundenem `state`; Konfiguration ohne PKCE zu setzen versuchen (Typprüfung); OIDC-Callback mit falschem `nonce` und mit falschem `iss`. | **5/5** abgelehnt; **0 Optionsschlüssel**, der PKCE abschaltet; `oauth_flow` nach dem ersten Callback **0 Zeilen** | CI bei jedem Commit |

---

### 6.5 RAND — Unsichere Zufälligkeit

| Test-ID | prüft | Art | Vorgehen | Schwelle | läuft in |
|---|---|---|---|---|---|
| T-RAND-1 | S-RAND-1 | Statisch | Lint-Regel über `src/`: `Math.random`, `Date.now` in Token-Kontext, UUID-Bibliotheken. Ausnahmen nur mit Kommentarmarke und Begründung. | **0 Treffer ohne Marke**; jede Marke hat einen Begründungstext | CI bei jedem Commit |
| T-RAND-2 | S-RAND-2 | Unit | 1000 Sitzungstokens erzeugen; Länge, Alphabet und Paarweise-Verschiedenheit prüfen; dekodierte Bytelänge messen. | Länge **43 Zeichen** base64url, dekodiert **32 Byte**, **0 Duplikate** bei 1000 | CI bei jedem Commit |
| T-RAND-3 | S-RAND-3 | Unit | 100 Sätze zu je 10 Wiederherstellungscodes erzeugen; dekodierte Bitlänge und Verschiedenheit prüfen. | **160 bit** je Code; **0 Duplikate** innerhalb eines Satzes; 0 Duplikate über alle 1000 | CI bei jedem Commit |
| T-RAND-4 | S-RAND-4 | Unit | Je 1000 Werte für Einmal-Token, `state`, PKCE-Verifier und WebAuthn-Challenge. | jeweils **≥ 256 bit** dekodiert; PKCE-Verifier zusätzlich 43–128 Zeichen (RFC 7636) | CI bei jedem Commit |
| T-RAND-5 | S-RAND-5 | Statisch | AST-Scan: Aufrufe von `crypto.getRandomValues` außerhalb des Zufallsmoduls. | **0 Treffer außerhalb** von `core/token/random.ts` | CI bei jedem Commit |
| T-RAND-6 | S-RAND-6 | Statisch + Integration | Typprüfung: eine Funktion, die `EntityId` erwartet, nimmt kein `Secret` an und umgekehrt (`expectTypeOf`). Integrationstest durchsucht alle `Set-Cookie`- und Körperwerte der gesamten Suite nach `uuid`-Werten aus `velve.session.id`. | **0 Typfehler fehlen** (2 Negativfälle kompilieren nicht); **0 Treffer** über alle Integrationsantworten | CI bei jedem Commit |
| T-RAND-Verteilung | S-RAND-2/3/4 (ergänzend) | Statistisch | N = 100 000 Tokens je Artefakttyp; Zeichenhäufigkeit je Position; Monobit- und Runs-Test auf Bitebene (NIST SP 800-22). | Chi-Quadrat je Position **p > 0,001**; Monobit **p > 0,001**; Runs **p > 0,001** | CI nächtlich |
| T-RAND-Kollision | S-RAND-2 (ergänzend) | Nebenläufigkeit | 1 Mio. Tokens in 8 parallelen Arbeitern erzeugen, in eine Menge schreiben. | `set.size === 1_000_000` | CI nächtlich |

---

### 6.6 TOKEN — Token-Wiederverwendung und Einmaligkeit

| Test-ID | prüft | Art | Vorgehen | Schwelle | läuft in |
|---|---|---|---|---|---|
| T-TOKEN-1 | S-TOKEN-1 | Statisch | AST-Scan aller SQL-Literale gegen `one_time_token`: jedes enthält `purpose` im `WHERE`. Zusätzlich Typprüfung, dass die Repository-Methode ohne Zweckargument nicht kompiliert. | **0 Literale ohne `purpose`**; Negativfall kompiliert nicht | CI bei jedem Commit |
| T-TOKEN-2 | S-TOKEN-2 | Integration, exhaustiv | Kreuzmatrix 4 Zwecke × 4 Einlösepfade = 16 Kombinationen. | **4 Diagonalfälle erfolgreich, 12 abgelehnt**; die 12 Antworten sind byteweise identisch zur Antwort auf einen erfundenen Token | CI bei jedem Commit |
| T-TOKEN-3 | S-TOKEN-3 | Integration | Zweimal hintereinander einen Reset anfordern, dann den ersten Token einlösen. | Nach der zweiten Anforderung **genau 1 Zeile** mit `(user_id, purpose)`; erster Token abgelehnt | CI bei jedem Commit |
| T-TOKEN-4 | S-TOKEN-4 | Integration | (i) E-Mail-Wechsel-Token für Nutzer A erzeugen und mit dem Sitzungscookie von Nutzer B einlösen. (ii) Verknüpfung aus der Sitzung von A starten, Callback mit A's Zeiger-Cookie und B's Sitzungscookie aufrufen. Zusätzlich AST-Scan: kein Handler liest eine Nutzerkennung aus der Eingabe eines Einlösepfads. | **2/2: die Wirkung trifft A** (`user.email` bzw. `identity.user_id`), **0 Zeilenänderungen an B**; **0 AST-Treffer** | CI bei jedem Commit |
| T-TOKEN-5 | S-TOKEN-5 | Integration, reflektierend | Testnutzer mit einer Zeile in jeder der 13 nutzergebundenen Tabellen anlegen, `DELETE FROM velve.user` ausführen, alle Tabellen zählen. Die Liste der Tabellen stammt aus `information_schema`, nicht aus einer Konstante. | `count(*)` = **0 in 13/13 Tabellen** | CI bei jedem Commit |
| T-TOKEN-6 | S-TOKEN-6 | Integration, reflektierend | Nach dem Ausführen aller Migrationen (Kern und Testplugin) `information_schema` abfragen: jede Tabelle im Schema `velve` mit `user_id`-Spalte muss eine FK-Bedingung mit `ON DELETE CASCADE` tragen. Zusätzlich eine absichtlich fehlerhafte Plugin-Migration einspielen. | **0 Tabellen ohne Cascade**; die fehlerhafte Migration wird vom Läufer mit einem Fehler abgewiesen | CI bei jedem Commit |

---

### 6.7 RATE — Ratenbegrenzung

| Test-ID | prüft | Art | Vorgehen | Schwelle | läuft in |
|---|---|---|---|---|---|
| T-RATE-1 | S-RATE-1 | Unit, tabellengetrieben | Vektortabelle Eingabe → erwarteter Schlüssel: `2001:db8::1`, `2001:0db8:0000:…:0001`, `2001:DB8::1`, `2001:db8:0:0:ffff::9999` → alle `2001:db8::/64`; `::ffff:203.0.113.5` und `203.0.113.5` → gleich; `::1`; `0.0.0.0`; `::`; Leerstring; `not-an-ip`; `1.2.3.4, 5.6.7.8`. | **20/20 Vektoren korrekt** | CI bei jedem Commit |
| T-RATE-2 | S-RATE-2 | Integration | 1000 Anfragen von 1000 Adressen aus einem `/64`; Gegenprobe 1000 Anfragen aus 1000 verschiedenen `/64`. | Genau **`limit` Erfolge** im ersten Fall; **1000 Erfolge** im zweiten | CI bei jedem Commit |
| T-RATE-3 | S-RATE-3 | Integration | (i) `trustedProxies` leer, 100 Anfragen mit zufälligem `X-Forwarded-For` von derselben Socket-Adresse. (ii) `trustedProxies = ["10.0.0.0/8"]`, Socket `10.0.0.5`, `XFF: 1.2.3.4, 10.0.0.9` → Schlüssel `1.2.3.4`. (iii) Socket `203.0.113.1` (nicht vertrauenswürdig), `XFF: 9.9.9.9` → Schlüssel `203.0.113.1`. | **6/6 Konstellationen**; in (i) genau `limit` Erfolge | CI bei jedem Commit |
| T-RATE-4 | S-RATE-4 | Integration | Anfragen ohne ermittelbare Peer-Adresse (Unix-Socket-Transport oder gesetzter Testschalter). | Nach `limit` Anfragen kommt die Ablehnung; **0 übersprungene Prüfungen** im Zähler-Protokoll | CI bei jedem Commit |
| T-RATE-5 | S-RATE-5 | Integration | Sieben Pfadvarianten derselben Route gemischt senden: `/sign-in/password`, `//sign-in/password`, `/sign-in/password/`, `/./sign-in/password`, `/sign-in//password`, `/sign-in/passw%6Frd`, `/SIGN-IN/PASSWORD`. | **Alle 7 teilen einen Eimer**: nach insgesamt `limit` Anfragen kommt die Ablehnung, unabhängig von der Mischung | CI bei jedem Commit |
| T-RATE-6 | S-RATE-6 | Nebenläufigkeit | 200 Anfragen per `Promise.all` gegen echtes Postgres bei Limit 20; 50 Wiederholungen. | **Exakt 20 Erfolge und 180 Ablehnungen in 50/50 Läufen, Toleranz 0** | CI nächtlich |
| T-RATE-7 | S-RATE-7 | Integration + Statisch, kontrollierte Uhr | `capacity` Fehlversuche plus einen gegen ein existierendes Konto und gegen einen nicht existierenden Bezeichner; danach Uhr um die Nachfüllzeit vorstellen und mit korrektem Kennwort anmelden. `rate_bucket.bucket_key` nach dem Bezeichner durchsuchen. Typprüfung: der Optionstyp enthält keinen Schlüssel für eine Verzögerung oder Sperre. | Der **(capacity + 1)-te** Versuch liefert `rate_limited` — für beide Bezeichner nach derselben Anzahl; Anmeldung nach Nachfüllen **erfolgreich**; Medianlatenz der abgelehnten Antworten **kleiner** als die einer regulären Fehlanmeldung (kein KDF, keine Verzögerung); **0 Klartexttreffer** in `bucket_key`; **0 Optionsschlüssel** | CI bei jedem Commit |
| T-RATE-8 | S-RATE-8 | Integration | Globalen Routenzähler mit einem niedrigen Schwellwert konfigurieren, Schwelle überschreiten. | Alarm-Callback **≥ 1-mal** aufgerufen; **0 Anfragen abgelehnt** | CI bei jedem Commit |

---

### 6.8 COOKIE — Cookie-Attribute

| Test-ID | prüft | Art | Vorgehen | Schwelle | läuft in |
|---|---|---|---|---|---|
| T-COOKIE-1 | S-COOKIE-1 | Integration | `Set-Cookie` nach erfolgreicher Anmeldung parsen und gegen ein Fixture vergleichen. | Name **exakt** `__Host-velve_session`; Attributmenge exakt `{HttpOnly, Secure, SameSite=Lax, Path=/}`; **0 Abweichungen** | CI bei jedem Commit |
| T-COOKIE-2 | S-COOKIE-2 | Statisch | Typprüfung: der Optionstyp enthält keinen Schlüssel für Cookie-Attribute; AST-Scan: der Attributsatz wird an genau einer Stelle konstruiert und nicht per Spread erweitert. | **0 Optionsschlüssel**; **genau 1 Konstruktionsstelle**, **0 Spread-Erweiterungen** | CI bei jedem Commit |
| T-COOKIE-3 | S-COOKIE-3 | Integration, kontrollierte Uhr | Anmeldung mit zweitem Faktor auslösen, Cookie parsen; Uhr um 5 min + 1 s vorstellen, `POST /factor/verify` aufrufen. | Name `__Host-velve_pending`, `Max-Age` **300**, gleiche Attributmenge; nach Ablauf **abgelehnt** | CI bei jedem Commit |
| T-COOKIE-4 | S-COOKIE-4 | Integration | Cookie-Wert nach jeder sitzungserzeugenden Antwort dekodieren und auf Länge und Struktur prüfen. | Wert ist **genau ein** base64url-Token von 43 Zeichen; **0 weitere Felder**, keine Trennzeichen | CI bei jedem Commit |
| T-COOKIE-5 | S-COOKIE-5 | Integration | Anfrage mit `Cookie: __Host-velve_session=A; __Host-velve_session=B` senden, wobei B gültig ist. | **HTTP 400**; **keine** Sitzung aufgelöst; kein Zugriff auf A oder B | CI bei jedem Commit |
| T-COOKIE-6 | S-COOKIE-6 | Integration, reflektierend | Über die gesamte Integrationssuite jeden `Set-Cookie`-Namen sammeln und gegen die Konstante `ALL_COOKIES` abgleichen. | Gesammelte Menge **gleich** `ALL_COOKIES`; **0 unbekannte Namen**, **0 nie gesetzte Einträge** | CI bei jedem Commit |

---

### 6.9 CSRF — Cross-Site Request Forgery

| Test-ID | prüft | Art | Vorgehen | Schwelle | läuft in |
|---|---|---|---|---|---|
| T-CSRF-1 | S-CSRF-1 | Integration, generiert + Statisch | Jede Route aus der Routentabelle mit fremdem `Origin` aufrufen — einmal über den HTTP-Handler, einmal über die direkte Servermethode. Statisch: genau eine Route trägt `originCheck: "exempt"`. | **Alle Routen außer dem OAuth-Callback abgelehnt** mit `origin_not_allowed` auf beiden Wegen; 0 Zeilenänderungen; **genau 1** Route mit `exempt`, und das ist `signIn.oauth.callback` | CI bei jedem Commit |
| T-CSRF-2 | S-CSRF-2 | Statisch + Unit | AST-Scan: in `core/http/origin.ts` kein `startsWith`, `includes`, `endsWith`, `RegExp`. Unit: erlaubter Origin, gleicher Origin mit anderem Port, mit anderem Schema. | **0 Treffer**; **3/3 Unit-Fälle** korrekt | CI bei jedem Commit |
| T-CSRF-3 | S-CSRF-3 | Integration, exhaustiv | Alle zustandsändernden Routen × 8 Origin-Varianten: erlaubt, fehlend, `null`, `http://` statt `https://`, `sub.erlaubt.de`, `erlaubt.de.evil.com`, `erlaubt.de:8443`, `evil.de`. | Nur die Variante *erlaubt* ist erfolgreich; **alle Ablehnungen byteweise identisch** | CI bei jedem Commit |
| T-CSRF-4 | S-CSRF-4 | Statisch + Integration | Routentabelle filtern: jede `GET`-Route ist der OAuth-Callback oder eine der sieben lesenden Routen aus S-CSRF-4. Integration: jede lesende `GET`-Route aufrufen und die Zeilenzahl aller Tabellen vorher und nachher vergleichen (`last_used_at`/`idle_expires_at` der eigenen Sitzung ausgenommen). | **0 unklassifizierte GET-Routen**; **0 Zeilenänderungen** durch lesende Routen | CI bei jedem Commit |
| T-CSRF-5 | S-CSRF-5 | Integration | Vollständigen OAuth-Fluss in Kontext A starten, Callback-URL in Kontext B (anderes Zeiger-Cookie) aufrufen; zusätzlich ohne jedes Cookie. | **2/2 abgelehnt**; **0** neue Zeilen in `session` und `identity` | CI bei jedem Commit |
| T-CSRF-6 | S-CSRF-6 | Integration + Statisch | Testplugin, das versucht, eine Middleware vor der Origin-Prüfung zu registrieren und die Prüffunktion zu ersetzen. | Registrierung führt zu einem **Startfehler**; der Kontext ist eingefroren (`Object.isFrozen` = true) | CI bei jedem Commit |
| T-CSRF-Parser | S-CSRF-2/3 (ergänzend) | Property | fast-check erzeugt Hostnamen mit Präfix-, Suffix-, Port-, Unicode- und Punycode-Varianten der erlaubten Hosts. | **2000 Fälle, 0 Gegenbeispiele**, fester Seed | CI nächtlich |

---

### 6.10 OWNER — Fehlende Eigentümerbindung / IDOR

| Test-ID | prüft | Art | Vorgehen | Schwelle | läuft in |
|---|---|---|---|---|---|
| T-OWNER-1 | S-OWNER-1 | Statisch | `ts-morph`: aus `information_schema` die Tabellen mit `user_id`-Spalte lesen, jede Repository-Methode ermitteln, die auf eine davon zugreift, und prüfen, ob ihre Signatur einen `actor` trägt. | **0 Methoden ohne `actor`**; der Test schlägt auch fehl, wenn eine neue Tabelle mit `user_id` ohne zugehöriges Repository auftaucht | CI bei jedem Commit |
| T-OWNER-2 | S-OWNER-2 | Statisch | AST-Scan aller SQL-Literale, die auf einer nutzergebundenen Tabelle `DELETE` oder `UPDATE` ausführen: jedes muss `user_id` im `WHERE` enthalten. Ergänzend: kein `SELECT` auf dieselbe Tabelle unmittelbar davor in derselben Funktion. | **0 Literale ohne `user_id`-Prädikat**; **0 Vorab-`SELECT`** | CI bei jedem Commit |
| T-OWNER-3 | S-OWNER-3 | Integration | Nutzer A und B legen je zwei WebAuthn-Zugangsdatensätze an (damit `last_sign_in_method` nicht greift). B ruft `POST /factor/webauthn/remove` mit A's `credentialId` auf; danach mit einer frei erfundenen UUID. | **2/2 abgelehnt**, Antworten **byteweise identisch**; `SELECT count(*)` auf A's Datensatz vor/nach **unverändert** | CI bei jedem Commit |
| T-OWNER-4 | S-OWNER-4 | Integration | B ruft `POST /session/revoke` mit A's `targetSessionId` auf; anschließend mit einer erfundenen Kennung. | **2/2 Antworten 204 und byteweise identisch**; A's Sitzung bleibt gültig; **0 Zeilenänderungen** in `velve.session` | CI bei jedem Commit |
| T-OWNER-5 | S-OWNER-5 | Integration | B löst A's Identitätsverknüpfung. | Abgelehnt; `velve.identity` **0 Zeilenänderungen**; Antwort identisch zur Antwort auf eine erfundene Kennung | CI bei jedem Commit |
| T-OWNER-6 | S-OWNER-6 | Integration, generiert | Für jede Route mit einem Parameter, der in mehr als einer Quelle stehen könnte: Anfrage mit widersprüchlichen Werten in Query und Körper. | **HTTP 400 auf allen betroffenen Routen**; nie wird einer der beiden Werte gewählt | CI bei jedem Commit |
| T-OWNER-7 | S-OWNER-7 | Statisch | AST-Scan: keine Zuweisung aus `req.body`, `req.query` oder einem Kopfeintrag an eine Variable vom Typ `UserId` oder `Actor`. | **0 Treffer** | CI bei jedem Commit |
| T-OWNER-8 | S-OWNER-8 | Integration, generiert | Für jede Route mit Objektkennung: einmal mit fremder, einmal mit erfundener Kennung aufrufen und die Antworten byteweise vergleichen. | **0 abweichende Bytes** über alle Routenpaare | CI bei jedem Commit |
| T-OWNER-9 | S-OWNER-9 | Statisch | Migrationsartefakt gegen `information_schema` prüfen: keine Spalte vom Typ `serial`, `bigserial`, `integer` oder `bigint` ist Primärschlüssel einer nutzergebundenen Tabelle. | **0 fortlaufende Primärschlüssel** | CI bei jedem Commit |
| T-OWNER-10 | S-OWNER-10 | Integration | Testplugin versucht (i) direkten `INSERT` in `velve.session` über den Treiber aus dem Kontext, (ii) `ctx.repositories = …`. | (i) Der Kontext bietet keinen rohen Treiber — kompiliert nicht; (ii) wirft `TypeError` (eingefrorenes Objekt): **2/2** | CI bei jedem Commit |
| T-OWNER-11 | S-OWNER-11 | Integration | Testplugin registriert eine Route mit dem Pfad einer Kernroute; zweites Testplugin kollidiert mit dem ersten. | **2/2 führen zu einem Startfehler**; die Fehlermeldung nennt beide Beitragenden | CI bei jedem Commit |
| T-OWNER-12 | S-OWNER-12 | Integration | Testplugin-Hook gibt einen Antwortkörper zurück und versucht, den Verifier zu ersetzen. | Der Rückgabewert des Hooks **beeinflusst die Antwort nicht**; das Ersetzen kompiliert nicht; ein werfender Hook lehnt die Operation ab: **3/3** | CI bei jedem Commit |

---

### 6.11 LINK — Kontoübernahme über Identitätsverknüpfung

| Test-ID | prüft | Art | Vorgehen | Schwelle | läuft in |
|---|---|---|---|---|---|
| T-LINK-1 | S-LINK-1 | Statisch + Integration | AST-Scan: keine Abfrage auf `velve.identity` oder `velve.user`, die eine Anbieter-E-Mail als Verknüpfungsprädikat verwendet. Integration: zwei Anbieter melden dieselbe E-Mail mit verschiedenen `subject`. | **0 Treffer**; die Integration erzeugt **2 getrennte Identitätszeilen**, nicht eine Verknüpfung | CI bei jedem Commit |
| T-LINK-2 | S-LINK-2 | Integration, Zustandsmatrix | 3 lokale Zustände (nicht vorhanden, vorhanden unverifiziert, vorhanden verifiziert) × 2 Anbieterzustände (`email_verified` true/false) × 2 (`trustedProviders` enthält den Anbieter / nicht) = **12 Fälle**, Erwartungstabelle als Fixture. | **12/12 laut Erwartung**; insbesondere führt (lokal unverifiziert, Anbieter verifiziert, vertrauenswürdig) **nicht** zu einer stillen Verknüpfung | CI bei jedem Commit |
| T-LINK-3 | S-LINK-3 | Integration + Statisch | Anbieterattrappe liefert eine E-Mail-Adresse als `sub`. AST-Scan: die Zuweisung an `subject` stammt aus dem `sub`-Claim, nie aus `email`. | Gespeicherter `subject` ist der `sub`-Wert; **0 AST-Treffer** | CI bei jedem Commit |
| T-LINK-4 | S-LINK-4 | Integration | Angreiferpfad nachstellen: Konto mit Kennwort registrieren (unverifiziert), Magic Link an dieselbe Adresse einlösen, danach mit dem ursprünglichen Kennwort anmelden. Gegenprobe: Konto mit Kennwort registrieren und in derselben Sitzung den Bestätigungslink einlösen. Dritter Fall: Magic Link, während eine Anbieteridentität mit derselben E-Mail existiert. | Angreiferpfad: `email_verified_at` gesetzt, `password_credential` **0 Zeilen**, alle vor der Bestätigung erzeugten Sitzungen widerrufen (**0 Zeilen**), Anmeldung mit dem ursprünglichen Kennwort scheitert mit `invalid_credentials`. Gegenprobe: `password_credential` **1 Zeile**, Sitzung bleibt gültig. Dritter Fall: `velve.identity` **0 neue Zeilen** | CI bei jedem Commit |
| T-LINK-5 | S-LINK-5 | Integration + Statisch | Anbieterattrappe liefert keine E-Mail. AST-Scan: keine Zeichenkettenverkettung, die eine E-Mail-Adresse aus einer Kennung erzeugt (`@`-Literal in einer Zuweisung an `email`). | `user.email IS NULL`; **0 AST-Treffer** | CI bei jedem Commit |
| T-LINK-6 | S-LINK-6 | Integration | Nutzer mit zwei Identitäten; Anbieter 1 meldet `email_verified: true`, Anbieter 2 `false`. | `provider_email_verified` ist **je Zeile korrekt**; eine Änderung an Zeile 1 lässt Zeile 2 unverändert | CI bei jedem Commit |
| T-LINK-7 | S-LINK-7 | Integration | In bestehender Sitzung eine zweite Identität verknüpfen, Token vorher und nachher vergleichen. | `T2 ≠ T1`; alte Zeile **0 Treffer** in `velve.session` | CI bei jedem Commit |

---

### 6.12 CACHE — Autorisierungsentscheidung aus einem Cache

| Test-ID | prüft | Art | Vorgehen | Schwelle | läuft in |
|---|---|---|---|---|---|
| T-CACHE-1 | S-CACHE-1 | Integration + Statisch | Zählender Treiber: für *n* aufeinanderfolgende Anfragen mit demselben Cookie die Zahl der Auflösungsabfragen zählen. AST-Scan nach `Map`, `LRU`, `WeakMap` in `core/session/`. Antwort-Abfangfunktion über die gesamte Integrationssuite prüft `Cache-Control` und `Vary`. | **n Abfragen bei n Anfragen** (Verhältnis exakt 1,0); **0 Cache-Strukturen** im Modul; **100 %** der Antworten tragen `Cache-Control: no-store` und `Vary: Cookie` | CI bei jedem Commit |
| T-CACHE-2 | S-CACHE-2 | Integration + Statisch | Vier Negativfälle: unbekannter Token, `idle_expires_at` in der Vergangenheit, `absolute_expires_at` in der Vergangenheit, `disabled_at` gesetzt. Zusätzlich SQL-Literal gegen ein Fixture vergleichen. | **4/4 abgelehnt** (dreimal `null`, bei `disabled_at` `account_disabled`); das Auflösungs-SQL ist **byteweise gleich** dem Fixture (jede Änderung ist eine bewusste Entscheidung) | CI bei jedem Commit |
| T-CACHE-3 | S-CACHE-3 | Integration | Sitzung anlegen, geschützte Route aufrufen (Erfolg), `disabled_at` setzen, sofort erneut aufrufen. | Ablehnung bei der **ersten** Folgeanfrage, gemessene Latenz zwischen Sperre und Wirkung **< 100 ms** | CI bei jedem Commit |
| T-CACHE-4 | S-CACHE-4 | Integration, exhaustiv | Im Zwischenzustand (nur `__Host-velve_pending`) **jede** registrierte Route aufrufen. | **Genau 4 Routen** verhalten sich anders als bei einer Anfrage ohne jedes Cookie, und es sind genau die mit `caller: "pending"`; alle übrigen liefern die **byteweise identische** Antwort | CI bei jedem Commit |
| T-CACHE-5 | S-CACHE-5 | Integration | Testplugin versucht, `resolveSession` zu überschreiben und einen eigenen Auflösungs-Hook zu registrieren. | Kompiliert nicht bzw. **Startfehler**; die Zahl der Auflösungsabfragen bleibt bei Verhältnis 1,0 | CI bei jedem Commit |

---

### 6.13 REDIR — Open Redirect und URL-Validierung

| Test-ID | prüft | Art | Vorgehen | Schwelle | läuft in |
|---|---|---|---|---|---|
| T-REDIR-1 | S-REDIR-1 | Statisch | Typprüfung der Routendeklaration: jedes Feld, das ein Weiterleitungsziel trägt, hat den Typ `RedirectPath`, nie `string` oder `URL`. | **0 Felder vom Typ `string`** in dieser Rolle | CI bei jedem Commit |
| T-REDIR-2 | S-REDIR-2 | Unit, Korpus | Vektordatei mit mindestens 120 bösartigen Eingaben: protokollrelativ, Backslash, Userinfo, Suffix, Teilstring, Port, IDN/Punycode, doppelt kodiert, `\r\n`-Injektion, Nullbyte, `javascript:` in 8 Schreibweisen. | **120/120 abgelehnt, 0 falsch-negativ**; der Korpus wächst bei jedem Fund um den Vektor | CI bei jedem Commit |
| T-REDIR-3 | S-REDIR-3 | Integration, global | Antwort-Abfangfunktion über die gesamte Integrationssuite: jeden `Location`-Wert erfassen und prüfen, dass er mit genau einem `/` beginnt und weder `:` vor dem ersten `/`-Segment noch `//` noch `/\` enthält; zusätzlich zählen, welche Routen überhaupt `Location` setzen. | **0 `Location`-Werte** mit Schema oder Host; `Location` kommt **nur** in der Antwort des OAuth-Callbacks vor | CI bei jedem Commit |
| T-REDIR-4 | S-REDIR-4 | Integration, global | Dieselbe Abfangfunktion durchsucht `Location` und alle Query-Strings nach den in diesem Testlauf erzeugten Token-Klartexten. | **0 Treffer** über die gesamte Suite | CI bei jedem Commit |
| T-REDIR-5 | S-REDIR-5 | Statisch | AST-Scan über `core/http/`: kein `startsWith`, `includes`, `endsWith`, `RegExp` und kein Platzhalterzeichen in einem Origin-Vergleich. | **0 Treffer** | CI bei jedem Commit |
| T-REDIR-6 | S-REDIR-6 | Statisch + Integration | AST-Scan: jede ausgehende Anfrage-URL stammt aus dem Konfigurationsobjekt. Integration: Anbieterattrappe liefert im Discovery-Dokument abweichende Endpunkte. | **0 URLs aus Anfragedaten**; die abweichenden Endpunkte werden **nicht** aufgerufen | CI bei jedem Commit |
| T-REDIR-7 | S-REDIR-7 | Integration, global | Über die gesamte Suite `Content-Type` jeder Antwort prüfen; zusätzlich jeden Antwortkörper nach einem Kanarienwert durchsuchen, der zuvor in jedes Eingabefeld geschrieben wurde. | **100 % `application/json`**; **0 Kanarientreffer** in Antwortkörpern | CI bei jedem Commit |

---

### 6.14 REST — Geheimnisse at rest

| Test-ID | prüft | Art | Vorgehen | Schwelle | läuft in |
|---|---|---|---|---|---|
| T-REST-1 | S-REST-1 | Integration | Testnutzer mit allen Artefakttypen anlegen (Kennwort und sein PHC-String, Sitzungstoken, Zwischenzustandstoken, 4 Einmal-Token, TOTP-Geheimnis, 10 Wiederherstellungscodes, WebAuthn-Challenge, `state`, PKCE-Verifier, fremdes Zugriffs- und Erneuerungstoken). `pg_dump --schema=velve` als Text erzeugen und jeden Klartextwert sowie dessen Base64- und Hex-Kodierung suchen. | **0 Treffer bei 24 Werten × 3 Kodierungen = 72 Suchen** | CI bei jedem Commit |
| T-REST-2 | S-REST-2 | Integration + Statisch | Für die 5 Hash-Spalten: Wert aus der Datenbank lesen und gegen `sha256(klartext)` vergleichen; Spaltentyp aus `information_schema` prüfen. | **5/5 Spalten sind `bytea` mit exakt 32 Byte** und stimmen mit dem berechneten Hash überein | CI bei jedem Commit |
| T-REST-3 | S-REST-3 | Integration | 10 Codes erzeugen; Zeilenzahl prüfen; gespeicherten Wert gegen `HMAC-SHA256(pepper, code)` mit dem `token-pepper`-Schlüssel der in `key_version` genannten Version vergleichen; Code 3 einlösen, erneut einlösen, Code 4 einlösen. | **10 Zeilen**, Wert stimmt, `key_version` = aktuelle Version in **10/10**; **3/3**: Erfolg, Ablehnung, Erfolg; nach Einlösung von Code 3 sind **9 Zeilen** übrig | CI bei jedem Commit |
| T-REST-4 | S-REST-4 | Integration | Für die 5 verschlüsselten Spalten: Rohbytes lesen, Envelope parsen, mit dem Zweckschlüssel entschlüsseln, gegen den Eingabewert vergleichen; zusätzlich mit einem falschen Zweckschlüssel entschlüsseln. | **5/5 entschlüsselbar** mit dem richtigen Schlüssel; **5/5 scheitern** mit dem falschen; das Chiffrat enthält den Klartext nicht als Teilfolge | CI bei jedem Commit |
| T-REST-5 | S-REST-5 | Unit + Integration | Für jedes der elf Präfixe der Weiche aus Abschnitt 3.3 einen Hash importieren; die Rohbytes von `password_credential.phc` lesen, mit dem Schlüssel `password-enc` der in `key_version` genannten Version entschlüsseln und das Präfix prüfen; die Rohbytes nach `$` durchsuchen. Zusätzlich AST-Scan nach einer Speicherung in `phc` ohne den Verschlüsselungsaufruf. | **11/11 entschlüsselte Werte beginnen mit dem erwarteten Präfix**; **0 `$`-Bytes** an Position 0 der Rohbytes; `scheme` ist Klartext und stimmt; **0 AST-Treffer** | CI bei jedem Commit |
| T-REST-6 | S-REST-6 | Integration + Statisch | OAuth-Fluss ohne gesetzte Option abschließen; Spalten prüfen. Typprüfung: `storeTokens` ist optional und die Vorgabe ist `false`. | `access_token_enc`, `refresh_token_enc`, `id_token_enc` **alle NULL**; Vorgabewert im Typ **`false`** | CI bei jedem Commit |
| T-REST-7 | S-REST-7 | Unit | Hash erzeugen, PHC-String parsen; anschließend einen Hash mit schwächeren Parametern und einen bcrypt-Hash prüfen und `needsRehash` auswerten. | Erzeugte Parameter **exakt** `m=19456,t=2,p=1`, Salz 16 Byte, Ausgabe 32 Byte; `needsRehash` = **true in beiden Altfällen**, **false** beim aktuellen | CI bei jedem Commit |

---

### 6.15 KEY — Schlüsselverwaltung und Rotation

| Test-ID | prüft | Art | Vorgehen | Schwelle | läuft in |
|---|---|---|---|---|---|
| T-KEY-1 | S-KEY-1 | Unit | Aus einem festen Wurzelschlüssel alle sechs Zweckschlüssel ableiten und paarweise vergleichen; Ableitung gegen Testvektoren aus RFC 5869 prüfen. | **6 paarweise verschiedene Schlüssel**; HKDF stimmt mit **allen 7 Testvektoren aus RFC 5869 Anhang A** überein | CI bei jedem Commit |
| T-KEY-2 | S-KEY-2 | Unit, exhaustiv | Alle geordneten Paare der 6 Zwecke (30 Kombinationen): mit Zweck *i* erzeugen, mit Zweck *j ≠ i* prüfen bzw. entschlüsseln. | **30/30 schlagen fehl** | CI bei jedem Commit |
| T-KEY-3 | S-KEY-3 | Integration | Jeden geschützten Wert erzeugen (TOTP-Geheimnis, PKCE-Verifier, fremde OAuth-Tokens, PHC-String, Wiederherstellungscode) und die Versionsangabe lesen (Envelope oder Spalte). | **5/5 Werte tragen die aktuelle Version**; **0 Werte ohne Version** | CI bei jedem Commit |
| T-KEY-4 | S-KEY-4 | Unit | `byVersion` für eine im Ring vorhandene und für eine entfernte Version aufrufen; anschließend einen mit der entfernten Version verschlüsselten Wert entschlüsseln. | Vorhandene Version liefert einen Schlüssel; entfernte liefert **`null`**; die Entschlüsselung wirft einen benannten Fehler (`KeyVersionUnavailable`), **kein generischer Absturz** | CI bei jedem Commit |
| T-KEY-5 | S-KEY-5 | Integration | Sitzung anlegen, verschlüsseltes Feld schreiben. Ring auf `v2,v1` umstellen und Prozess neu starten; danach Ring auf `v2` reduzieren und erneut starten. | Sitzung nach **beiden** Schritten gültig; Feld nach Schritt 1 entschlüsselbar; neue Werte tragen `v2`: **4/4 Zusicherungen** | vor jedem Release |
| T-KEY-6 | S-KEY-6 | Unit | Startversuche mit Wurzelschlüsseln der Längen 0, 8, 31 und 32 Byte sowie mit fehlendem `keys`-Feld. | **4 von 5 verweigern den Start**, nur 32 Byte startet: **5/5** | CI bei jedem Commit |
| T-KEY-7 | S-KEY-7 | Unit | ID-Token mit `alg: "none"`, mit `HS256` unter dem Wurzelschlüssel, mit einem fremden RSA-Schlüssel und mit dem korrekten JWKS-Schlüssel prüfen. | **3/3 abgelehnt**, 1 akzeptiert; die Erlaubnisliste ist eine Konstante und wird im Test gelesen | CI bei jedem Commit |

---

### 6.16 RACE — Nebenläufigkeit beim Konsum von Einmal-Artefakten

| Test-ID | prüft | Art | Vorgehen | Schwelle | läuft in |
|---|---|---|---|---|---|
| T-RACE-1 | S-RACE-1 | Nebenläufigkeit | Für jeden der 4 Einmal-Token-Zwecke: `Promise.all` mit 50 identischen Anfragen gegen echtes Postgres; 20 Wiederholungen. | **Exakt 1 Erfolg und 49 Fehlschläge in 20/20 Läufen je Zweck, Toleranz 0** | CI nächtlich |
| T-RACE-2 | S-RACE-2 | Statisch + Nebenläufigkeit | AST-Regel: kein `find*`/`SELECT` auf einer Tabelle, gefolgt von `delete*`/`update*` auf derselben Tabelle in derselben Funktion. Ergänzend derselbe Nebenläufigkeitstest wie T-RACE-1, aber mit 50 ms künstlicher Verzögerung zwischen Lesen und Schreiben per Treiber-Hook. | **0 AST-Treffer**; mit Verzögerung weiterhin **1/49 in 20/20 Läufen** | CI bei jedem Commit (statisch) / CI nächtlich (Nebenläufigkeit) |
| T-RACE-3 | S-RACE-3 | Nebenläufigkeit | 50 parallele Einreichungen desselben TOTP-Codes bei fixierter Uhr; 20 Wiederholungen. | **Exakt 1 Erfolg in 20/20 Läufen**; `totp_used_step` enthält **genau 1 Zeile** | CI nächtlich |
| T-RACE-4 | S-RACE-4 | Nebenläufigkeit | 50 parallele Einreichungen desselben Wiederherstellungscodes; 20 Wiederholungen. | **Exakt 1 Erfolg in 20/20 Läufen**; danach **9 Zeilen** in `recovery_code` | CI nächtlich |
| T-RACE-5 | S-RACE-5 | Integration, Fehlerinjektion | Treiber-Hook wirft nach dem `INSERT` der neuen Sitzung und vor dem `DELETE` der alten; separat nach dem Kennwort-`UPDATE` und vor dem Widerruf. | Nach dem Rollback: `velve.session` **unverändert**; Kennwort **unverändert**: **2/2** | CI bei jedem Commit |
| T-RACE-6 | S-RACE-6 | Integration, Nebenläufigkeit | Zwei gleichzeitige Anmeldungen desselben Nutzers mit rehash-bedürftigem Hash; anschließend eine Anmeldung, bei der ein Dritter den Hash zwischen Lesen und Schreiben ändert. | **Genau 1** der beiden Rehashes wirkt, der andere ändert 0 Zeilen; **0 Fehler** in der Antwort; der Hash ist nach beiden Läufen gültig | CI nächtlich |

---

### 6.17 DEFAULT — Unsichere Vorgabewerte

| Test-ID | prüft | Art | Vorgehen | Schwelle | läuft in |
|---|---|---|---|---|---|
| T-DEFAULT-1 | S-DEFAULT-1 | Statisch + Integration | Aus dem Optionstyp alle sicherheitsrelevanten Schlüssel in einer Konstante `SECURITY_OPTIONS` führen; für jeden ist der Vorgabewert als Fixture hinterlegt. Beim Start mit einer abweichenden Belegung wird die Protokoll-Senke geprüft. | Vorgabewerte **exakt gleich** dem Fixture; jede Abweichung erzeugt **genau 1** Protokolleintrag mit dem Optionsnamen; der Test schlägt fehl, wenn der Optionstyp einen Schlüssel enthält, der nicht in `SECURITY_OPTIONS` steht | CI bei jedem Commit |
| T-DEFAULT-2 | S-DEFAULT-2 | Statisch | Typprüfung: kein Optionsschlüssel enthält die Zeichenfolge `revoke` als abschaltbaren Schalter; Integrationsgegenprobe siehe T-FIX-6. | **0 Optionsschlüssel** | CI bei jedem Commit |
| T-DEFAULT-3 | S-DEFAULT-3 | Statisch | Typprüfung gegen eine Liste verbotener Optionsnamen (`disablePkce`, `disableOriginCheck`, `disableRateLimit`, `skipStateCheck` und Varianten). | **0 Treffer**; der Test liest die Liste aus einer Konstante | CI bei jedem Commit |
| T-DEFAULT-4 | S-DEFAULT-4 | Unit | `createVelveAuth({ identity: "username" })` ohne `recoveryCodes: true` aufrufen; danach mit. | **Erster Aufruf wirft**, zweiter startet: **2/2**; die Meldung nennt beide Optionen | CI bei jedem Commit |
| T-DEFAULT-5 | S-DEFAULT-5 | Integration | Drei Konfliktarten je einmal: Plugin-Route gegen Kernroute, Tabellenpräfix zweier Plugins, Fehlercode zweier Plugins. | **3/3 Startfehler**; **0 Warnungen ohne Fehler** | CI bei jedem Commit |
| T-DEFAULT-6 | S-DEFAULT-6 | Unit | Konfigurationen mit `m = 19456/t = 2/p = 1`, mit höheren Werten und mit jeweils einem niedrigeren Wert je Parameter. | Standard und höhere Werte starten; **3/3 niedrigere Werte** führen zu einem Startfehler | CI bei jedem Commit |
| T-DEFAULT-7 | S-DEFAULT-7 | Integration | Denselben Satz aus 20 Kennwörtern einmal mit vorhandener und einmal mit fehlender `hash-wasm`-Abhängigkeit hashen und kreuzweise prüfen. | **20/20 erzeugte PHC-Strings byteweise gleich**; jede Kreuzprüfung erfolgreich: **40/40** | vor jedem Release |

---

### 6.18 DOS — Ressourcenerschöpfung durch das KDF

| Test-ID | prüft | Art | Vorgehen | Schwelle | läuft in |
|---|---|---|---|---|---|
| T-DOS-1 | S-DOS-1 | Unit | KDF-Spion zählt Aufrufe. Eingaben: leeres Kennwort, 7 Zeichen, 8 Zeichen, 4096 Byte, 4097 Byte, 1 MiB. | **0 KDF-Aufrufe** bei leer, 7 Zeichen, 4097 Byte und 1 MiB; **1 Aufruf** bei 8 Zeichen und bei 4096 Byte | CI bei jedem Commit |
| T-DOS-2 | S-DOS-2 | Integration | Anmeldung mit 1-MiB-Kennwort gegen eine existierende und gegen eine nicht existierende Kennung; instrumentierter Treiber zählt Abfragen; 200 Messungen je Gruppe. | Antworten **byteweise identisch**; **0 Datenbankabfragen und 0 KDF-Aufrufe** in beiden Fällen; Differenz der Medianzeiten **< 5 ms** | CI nächtlich |
| T-DOS-3 | S-DOS-3 | Nebenläufigkeit | 200 gleichzeitige Anmeldungen; laufende KDF-Aufrufe über einen Zähler im Semaphor beobachten; Speicher über `process.memoryUsage().rss` messen. | Beobachtetes Maximum gleichzeitiger KDF-Aufrufe **≤ min(4, cpus)**; RSS-Zuwachs **< min(4, cpus) × 19 MiB × 1,5** | CI nächtlich |
| T-DOS-4 | S-DOS-4 | Nebenläufigkeit | 500 gleichzeitige Anmeldungen bei Semaphorgröße 1 und künstlich verlangsamtem KDF. | **500/500 Antworten** mit gültigem Statuscode; **0 Abstürze**, **0 unbehandelte Ablehnungen**; jede Antwort trifft innerhalb der Wartegrenze von 5 s plus 500 ms Toleranz ein, und jede Antwort nach der Wartegrenze trägt `rate_limited` | CI nächtlich |
| T-DOS-5 | S-DOS-5 | Integration | Ratenlimit auf 5 setzen, 100 Anfragen von einer IP senden, KDF-Spion zählen. | **Höchstens 5 KDF-Aufrufe** bei 100 Anfragen | CI bei jedem Commit |
| T-DOS-6 | S-DOS-6 | Nebenläufigkeit | 50 Anmeldungen mit rehash-bedürftigen Hashes; Semaphorzähler beobachten. | Maximum gleichzeitiger KDF-Aufrufe (Prüfung **und** Rehash zusammen) **≤ min(4, cpus)** | CI nächtlich |

---

### 6.19 Testinfrastruktur

**Echte PostgreSQL-Instanz, kein Mock.** Ein In-Memory-Adapter testet die falsche Semantik. Vier Gruppen von Anforderungen dieses Berichts sind Aussagen über das Verhalten der Datenbank und nicht über den Anwendungscode: die Atomarität von `DELETE … RETURNING` (S-RACE-1, S-RACE-2), die Serialisierung über Primärschlüsselkonflikte (S-RACE-3, S-RACE-4), die Wirkung des `UPDATE`-Triggers auf `session.user_id` (S-FIX-2) und die Kaskadenlöschung (S-TOKEN-5, S-TOKEN-6). Ein Mock, der `DELETE … RETURNING` in JavaScript nachbildet, ist genau der Code, dessen Fehlen der Test beweisen soll. Hinzu kommt, dass alles SQL von Hand geschrieben ist (Abschnitt 3.2) — ein Syntaxfehler oder eine falsche Indexnutzung fällt nur gegen einen echten Server auf. Konkret: **Testcontainers mit PostgreSQL 14** als niedrigster unterstützter Version, zusätzlich ein nächtlicher Lauf gegen die aktuelle Hauptversion. Jeder Testfall läuft in einem eigenen Schema-Namensraum oder in einer Transaktion mit Rollback; Nebenläufigkeitstests brauchen eine echte Datenbank ohne Rollback-Isolation und räumen selbst auf.

**Kontrollierbare Uhr.** Alle Ablauf-, Fenster- und TOTP-Tests brauchen eine deterministische Zeit. Der Kern liest die Zeit ausschließlich über die Konfigurationsoption `clock: Clock` (Abschnitt 3.15 A.2, `interface Clock { now(): Date }`) und über `now()` in der Datenbank. `@velve/auth/testing` (Abschnitt 3.1) exportiert eine stellbare `Clock`, die der Test in die Konfiguration gibt; `vi.useFakeTimers` wird nur für die Wartegrenze des Semaphors gebraucht (S-DOS-4), weil sie über einen Zeitgeber läuft und nicht über `clock`. Für die Datenbankseite werden die Ablaufzeitpunkte im Test direkt geschrieben, statt die Serverzeit zu verschieben; ein Test, der beides braucht, stellt `clock` und schreibt `expires_at` passend.

**Deterministischer Zufall, und wie man ihn produktiv unmöglich macht.** Reproduzierbare Gegenbeispiele brauchen einen setzbaren Seed; ein setzbarer Seed in Produktion wäre die schwerste denkbare Schwachstelle. Drei Schranken zusammen:

1. Die Umschaltung liegt ausschließlich in `@velve/auth/testing` — einem eigenen Subpfad-Export (Abschnitt 3.1). Der Kern importiert dieses Modul nicht; die Umkehrung wird per AST-Regel geprüft (**Schwelle: 0 Importe von `testing` in `core/`**).
2. Der Kern nimmt den Zufallsgenerator nicht als Parameter entgegen. Die Umschaltung erfolgt über eine Setter-Funktion, die beim ersten Aufruf prüft, ob `process.env.NODE_ENV === "test"` **und** ob das Testmodul der Aufrufer ist; sonst wirft sie.
3. Ein Ausliefertest prüft das gepackte Artefakt: das Paket enthält den Setter nur im `testing`-Subpfad, und der Kern-Einstiegspunkt enthält die Zeichenfolge des Setternamens nicht (**Schwelle: 0 Treffer in `dist/index.js`, läuft vor jedem Release**).

Damit ist ein produktives Einschalten nicht durch Disziplin verhindert, sondern durch die Paketstruktur, und der Fehlerfall ist ein Wurf statt eines stillen Verhaltenswechsels.

**Mailversand-Attrappe.** Die Bibliothek liefert keinen Mailversand, sondern einen Callback (Abschnitt 3.15 A.7, `email: { send }`; Abschnitt 3.14). Die Attrappe implementiert diesen Callback, sammelt Nachrichten in einem Array und stellt drei Abfragen bereit: Anzahl der Aufrufe, Empfänger, `kind` der Nachricht. Sie ist die Messstelle für S-ENUM-4 (Symmetrie der Nebenwirkung), für S-TIM-6 (genau ein Callback-Aufruf je Anfrage, unabhängig von der Existenz des Kontos, L-1) und für alle Flüsse, deren sichtbarer Unterschied laut Abschnitt 3.13 „ausschließlich in die versendete E-Mail" wandert. Sie muss auch werfen können, weil A.7 festlegt, dass ein werfendes `send` die Operation scheitern lässt und das Einmal-Token zurückrollt.

**WebAuthn-Simulator.** `@simplewebauthn/server` (Abschnitt 2.7) prüft Attestierungen und Assertions; für den Test wird die Gegenseite gebraucht. Der Simulator hält ein P-256-Schlüsselpaar je virtuellem Authentifikator, erzeugt `clientDataJSON` und `authenticatorData` mit setzbaren Flags (UP, UV, BE, BS) und setzbarem `signCount` und signiert korrekt. Damit sind vier Dinge prüfbar, die sonst nur manuell gehen: die Unterscheidung gerätegebunden gegen synchronisiert über BE/BS (Abschnitt 3.6), die `sign_count`-Behandlung, die Einmaligkeit der Challenge (T-REPLAY-5) und die auffindbare Anmeldung ohne vorherige Nutzerkennung. Der Simulator muss auch *falsch* signieren können — sonst prüft man die Ablehnung nie.

**Zusammenfassung der Werkzeuge.** Vitest als Läufer; `@fast-check/vitest` für die Property-Tests; Testcontainers für PostgreSQL; `ts-morph` für die eigenen statischen Regeln (Actor-Pflicht, Find-then-Delete, Secret-Vergleiche, SQL-Literal-Analyse); `simple-statistics` für Welch-t und Chi-Quadrat, Cliff's Delta als eigene Funktion von rund 20 Zeilen; `osv-scanner` und Renovate für die Lieferkette — GHSA-x732-6j76-qmhm (`rou3`) und GHSA-hq75-xg7r-rx6c (`better-call`) waren beide transitive Fehler.

---

### 6.20 Umgang mit Flakiness bei Zeitmessungen

Das ist das praktische Hauptproblem dieses Prüfplans. Ein Timing-Test misst eine Differenz von wenigen Mikrosekunden auf einer Maschine, die parallel andere Container bedient, ihre Taktfrequenz nach Temperatur regelt und deren Scheduler den Prozess jederzeit verdrängt. Ein naiv gebauter Test ist deshalb entweder rot ohne Fehler oder grün trotz Fehler.

**Der `dudect`-Ansatz.** Reparaz, Balasch und Verbauwhede beschreiben in IACR ePrint 2016/1123 ein Verfahren, das ohne Hardwaremodell auskommt: zwei Eingabeklassen (eine feste, eine zufällige), verschränkt gemessen, ausgewertet mit Welchs t-Test — und die Entscheidung fällt an einem **t-Wert**, nicht an einem p-Wert. Die übliche Verwerfungsschwelle ist **|t| > 4,5**. Der Grund ist der entscheidende Punkt für diesen Plan: Bei n = 1000 je Gruppe ist ein p-Wert-Test so trennscharf, dass jede CI-Störung — ein Nachbarcontainer, ein Turbo-Boost-Abfall — einen p-Wert unter 0,05 erzeugt. Die t-Schwelle ist dagegen über Stichprobengrößen hinweg vergleichbar interpretierbar. Trail of Bits' Testing Handbook (`appsec.guide/docs/crypto/constant_time_tool/dudect/`) ergänzt drei praktische Punkte: Ausreißer über mehrere Perzentil-Schnitte parallel entfernen statt über einen; den Prozess per `taskset` auf einen Kern binden und dabei Kern 0 und 1 meiden, weil dort Kernel- und Interruptlast liegt; und Läufe länger als fünf Minuten ansetzen, weil mehr Messungen die Erkennungswahrscheinlichkeit erhöhen.

**Die Messmethodik für Velve Auth, konkret.**

| Parameter | Wert | Begründung |
|---|---|---|
| Wiederholungen | 1000 je Gruppe, verschränkt in zufälliger Reihenfolge | Nicht erst alle X, dann alle Y — sonst misst man Cache-Aufwärmung statt des Codepfads |
| Warmlauf | erste 100 Messungen je Gruppe verworfen | JIT-Kompilierung, Verbindungsaufbau, Seitenfehler beim ersten Argon2id-Aufruf |
| Messgröße | `process.hrtime.bigint()` um den Handler; zusätzlich TTFB über einen echten Socket | Die Wanduhr enthält Scheduler-Rauschen, das der Test nicht messen will; auf Linux zusätzlich CPU-Zyklen über `perf_event_open`, wo verfügbar |
| Ausreißerbehandlung | 10-%-getrimmtes Mittel; ergänzend Median-Absolut-Abweichung mit Faktor 3 als zweiter Schnitt | Zwei unabhängige Schnitte, damit die Entscheidung nicht am gewählten Schnitt hängt |
| Primärkriterium | **\|Welch-t\| < 4,5** | dudect-Konvention |
| Zweitkriterium | **Cliff's δ < 0,147** | verteilungsfrei, unempfindlich gegen Nicht-Normalität; „vernachlässigbarer Effekt" nach Romano |
| Kalibrierung | Ein Paar nachweislich identischer Operationen wird im selben Lauf mitgemessen | Der Quotient `t_test / t_kalibrierung` rechnet Maschinendrift heraus |
| Umgebung | dedizierter Läufer, kein geteilter CI-Container, Prozess per `taskset` auf einen Kern ≥ 2 gepinnt | Ein geteilter Läufer ist die häufigste Ursache für Fehlalarme |

**Was passiert, wenn ein Timing-Test in CI rot wird.** Nicht deaktivieren. Die Reihenfolge ist festgelegt:

1. **Ein einzelner roter Lauf ist ein Verdacht, kein Befund.** Ein Alarm wird erst ausgelöst, wenn **drei aufeinanderfolgende nächtliche Läufe** die Schwelle reißen. Das drückt die Fehlalarmrate um etwa drei Größenordnungen und senkt die Erkennungsfähigkeit für ein echtes, konstantes Leck nicht, weil ein echtes Leck jede Nacht auftritt.
2. **Der erste Schritt nach dem Alarm ist der deterministische Test, nicht der statistische.** T-TIM-1b (Aufrufsequenz) und T-TIM-3 (Vergleichsoperatoren) sind flakefrei und benennen die Ursache. Wenn einer davon rot wird, ist der statistische Test nur noch die Bestätigung.
3. **Bleibt der deterministische Test grün, wird die Kalibrierung geprüft.** Steigt auch der Kalibrierungs-t-Wert, ist der Läufer die Ursache und nicht der Code — dann wird der Läufer getauscht, nicht die Schwelle.
4. **Die Schwelle wird nie gelockert, um den Test grün zu bekommen.** Wenn der Test auf der verfügbaren Infrastruktur nicht stabil zu bekommen ist, wird er aus dem blockierenden Pfad genommen und meldet weiter als Ticket — mit einem Eintrag im Prüfplan, der sagt, dass die Klasse derzeit nur strukturell und nicht empirisch abgesichert ist. Ein entschärfter Test ist schlimmer als ein abgeschalteter, weil er Sicherheit vortäuscht.
5. **Zweistufiges Gating als Dauerzustand.** T-TIM-1b, T-TIM-3, T-TIM-7 und alle `Statisch`-Tests blockieren jeden Commit. T-TIM-1, T-TIM-5, T-TIM-6 und T-DOS-2 laufen nächtlich und erzeugen Tickets. Das ist keine Notlösung, sondern die Bauweise: die deterministischen Tests finden die Ursache, der statistische findet, was die deterministischen nicht vorhergesehen haben.

---

### 6.21 Was nicht getestet wird, und warum

Diese Abgrenzung ist Teil des Prüfplans, nicht eine Lücke darin. Der Kern der Begründung: Velve Auth schreibt keine Kryptografie selbst; die Primitive kommen aus den in Abschnitt 2.7 genannten Paketen und aus `crypto.subtle`, eigener Code ist nur der PHC-Parser. Die Korrektheit einer Bibliothek zu testen, die man nicht schreibt, prüft die falsche Sache — was geprüft werden muss, ist die **Verwendung**: die Parameter, die Kodierung, die Fehlerbehandlung und die Grenzfälle an der Schnittstelle.

| Nicht getestet | Stattdessen abgesichert durch |
|---|---|
| Die Korrektheit von `@noble/hashes` (Argon2id, scrypt) | Bekannte Testvektoren, siehe 6.22. Zusätzlich der Bitgleichheitsvergleich gegen `hash-wasm` (T-DEFAULT-7) — zwei unabhängige Implementierungen, die übereinstimmen, sind ein stärkeres Argument als ein eigener Test gegen eine von beiden |
| Die Korrektheit von `crypto.subtle` (SHA-2, HMAC, AES-256-GCM, PBKDF2) | Plattformzusage von Node ≥ 20 (Abschnitt 2.5); die Vektoren aus 6.22 laufen trotzdem mit, weil sie nichts kosten |
| Die Korrektheit von `@simplewebauthn/server` (COSE-Dekodierung, Attestierungsformate, Signaturprüfung) | Der WebAuthn-Simulator aus 6.19 prüft die **Verwendung**: Origin- und RP-ID-Bindung, Challenge-Einmaligkeit, `userVerification`-Politik, BE/BS-Auswertung, `signCount`-Behandlung. Attestierungsformate werden nicht durchgetestet — Velve Auth wertet keine Attestierung aus |
| Die Korrektheit von `otpauth` (HOTP/TOTP-Berechnung) | RFC-6238-Testvektoren (6.22) plus die eigenen Tests für Replay-Schutz, Toleranzfenster und Zeitschrittbindung — das ist der Teil, den `otpauth` nicht leistet |
| Die Korrektheit von `jose` (JWS-Prüfung, JWKS-Abruf) | Die Algorithmus-Erlaubnisliste (T-KEY-7) und die `iss`/`nonce`-Prüfung (T-REPLAY-6). Die Signaturmathematik selbst wird nicht nachgeprüft |
| Die Korrektheit von `bcryptjs` | Die Referenzvektoren aus 6.22; zusätzlich der dokumentierte 72-Byte-Abschnitt als eigener Test, weil das eine Eigenschaft ist, auf die sich der Import verlässt (Abschnitt 3.3, „Bekannte Einschränkung") |
| Der Browser selbst: ob `__Host-` wirklich `Domain` verbietet und ob `SameSite=Lax` wirkt | Das ist Verhalten der Browser-Engine. Geprüft wird nur, dass Velve Auth die Attribute korrekt setzt (T-COOKIE-1, T-FIX-5) und dass die Restunsicherheit abgefangen wird (T-COOKIE-5). Ein einmaliger manueller Durchlauf gegen Chrome, Firefox und Safari beim Entwurf dokumentiert die Annahme |
| PostgreSQLs Transaktions- und Constraint-Semantik | Wird als gegeben angenommen. Die Nebenläufigkeitstests prüfen, dass Velve Auth sie **benutzt**, nicht dass sie funktioniert |
| Die Nutzeroberfläche des E-Mail-Versands, Zustellbarkeit, Vorlagentexte | Velve Auth liefert keinen Versand, nur einen Callback (Abschnitt 3.14) |
| Lasttests, Durchsatzmessungen, Skalierungsverhalten | Kein Sicherheitsziel dieses Berichts. Ausnahme: T-DOS-3 und T-DOS-4 messen Speicher und Antwortverhalten unter Last, weil sie eine Sicherheitsanforderung prüfen |

---

### 6.22 Testvektoren

Für jedes unterstützte Hash-Verfahren müssen bekannte Vektoren durchlaufen, bevor irgendein Verhaltenstest aussagekräftig ist. Alle Vektortests sind Unit-Tests, laufen bei jedem Commit und haben die Schwelle **„alle Vektoren stimmen byteweise; 0 Abweichungen"**.

| Verfahren | Quelle der Vektoren | Umfang | Bemerkung |
|---|---|---|---|
| Argon2id | **RFC 9106**, Abschnitt 5.3 (und 5.1/5.2 für Argon2d/Argon2i) | Der Referenzvektor mit `p=4, τ=32, m=32, t=3`, Passwort/Salz/Secret/AD aus dem RFC | Die RFC-Vektoren nutzen bewusst andere Parameter als die Produktionskonfiguration — das ist richtig so: der Vektor prüft die Implementierung, der Parametertest (T-REST-7) prüft die Konfiguration |
| scrypt | **RFC 7914**, Abschnitt 11 | Alle 4 Vektoren, einschließlich `N=1048576, r=8, p=1` | Der große Vektor braucht 1 GiB und läuft nur nächtlich; die drei kleinen bei jedem Commit |
| PBKDF2-HMAC-SHA1 | **RFC 6070** | Alle 6 Vektoren | Prüft die Zählerbehandlung und den 16 777 216-Iterationen-Fall (nächtlich) |
| PBKDF2-HMAC-SHA256 / -SHA512 | RFC 7914 Abschnitt 11 nutzt PBKDF2-HMAC-SHA256 intern; ergänzend die verbreiteten Vektoren aus RFC 6070 mit ausgetauschter PRF | Je 4 Vektoren | RFC 6070 definiert nur SHA-1; die SHA-256/512-Varianten werden gegen `crypto.subtle` und `@noble/hashes` kreuzgeprüft — zwei unabhängige Implementierungen |
| bcrypt | Die Referenzvektoren aus Provos' und Mazières' `crypt_blowfish`-Testsuite, wie sie in den gängigen Implementierungen als `wordlist`/`test vectors` geführt werden; zusätzlich die vier Präfixvarianten `$2a$`, `$2b$`, `$2y$`, `$2x$` | ≥ 20 Vektoren | Muss ausdrücklich einen Vektor mit einem Kennwort > 72 Byte enthalten und den Abschnitt dokumentieren (Abschnitt 3.3) sowie einen mit einem Nullbyte, weil sich `$2a$` und `$2x$` dort unterscheiden |
| HKDF-SHA256 | **RFC 5869**, Anhang A | Alle 7 Vektoren | Grundlage für T-KEY-1 |
| TOTP | **RFC 6238**, Anhang B | Alle 18 Vektoren (SHA-1, SHA-256, SHA-512 × 6 Zeitpunkte) | Velve Auth erzeugt nur SHA-1 (Abschnitt 3.6); die übrigen Vektoren laufen mit, weil `otpauth` sie kann und ein Fehler dort ein Bibliotheksfehler wäre |
| HMAC-SHA256 | **RFC 4231** | Alle 7 Vektoren | Grundlage für die Wiederherstellungscodes |

**Firebase-scrypt: den Vektor selbst beschaffen.** Für `$fbscrypt$` gibt es keinen normativen Vektor, weil das Verfahren eine Google-eigene Zusammensetzung ist: scrypt mit einem Salz-Separator, gefolgt von AES-256-CTR unter einem `signer_key`. Ein belastbarer Vektor kommt nur aus einem echten Export. Der Weg:

1. Ein Wegwerf-Firebase-Projekt anlegen und in der Authentifizierung einen Nutzer mit einem bekannten Kennwort per E-Mail/Kennwort registrieren — das Kennwort ist die einzige Information, die der Export nicht enthält, also muss sie vorher feststehen.
2. Die Hash-Parameter des Projekts abrufen. In der Firebase-Konsole stehen sie unter *Authentication → Users → Überlaufmenü → Password hash parameters*; auf der Kommandozeile liefert `firebase auth:export` sie im Kopf der Ausgabe. Es sind vier Werte: `hash_config.signer_key` (Base64), `salt_separator` (Base64), `rounds` und `mem_cost`.
   **`signer_key` ist ein projektweites Geheimnis** — der Vektor gehört deshalb in ein Wegwerfprojekt, das danach gelöscht wird, und niemals in ein Projekt mit echten Nutzern.
3. `firebase auth:export users.json --format=json --project <id>` ausführen. Der Eintrag enthält `passwordHash` und `salt`, beide Base64.
4. Aus den sechs Werten (Kennwort im Klartext, `salt`, `salt_separator`, `signer_key`, `rounds`, `mem_cost`) und dem erwarteten `passwordHash` einen Testvektor bilden und in das PHC-Format aus Abschnitt 3.3 übersetzen: `$fbscrypt$v=1,n=<mem_cost>,r=<rounds>,p=1,ss=<salt_separator_b64>,sk=<signer_key_b64>$<salt_b64>$<hash_b64>` (Abschnitt 3.3).
5. Den Vektor als Fixture ins Repository legen, mit einem Kommentar, aus welchem Projekt er stammt und dass das Projekt gelöscht wurde. **Mindestens zwei Vektoren**, davon einer mit einem Kennwort mit Nicht-ASCII-Zeichen — die Kodierung vor dem KDF ist die wahrscheinlichste Fehlerquelle beim Import.
6. Gegenprobe mit einem falschen Kennwort, damit der Test auch die Ablehnung prüft.

*SCHÄTZUNG: Schritte 1–4 kosten etwa 30 Minuten und sind einmalig; der Vektor veraltet nicht, solange Firebase das Format nicht ändert.* Dieselbe Vorgehensweise gilt sinngemäß für den Better-Auth-scrypt-Vektor (`salt_hex:hash_hex` → `$scrypt$ln=14,r=16,p=1$…`, Abschnitt 3.3): ein Wegwerf-Better-Auth-Projekt mit bekanntem Kennwort, ein `pg_dump` der `account`-Tabelle, und daraus zwei Vektoren.

---

### 6.23 Abdeckungsziel

**Die Zahl: 90 % Zweigabdeckung im Verzeichnis `core/`, gemessen mit V8-Coverage über Vitest, als blockierende Schwelle bei jedem Commit.** Für die Unterverzeichnisse `core/password/`, `core/session/`, `core/token/` und `core/keys/` gilt zusätzlich **100 % Zweigabdeckung**. Für `core/db/`, `core/http/` und `core/plugin/` gilt dieselbe Schwelle von 90 %. Für `@velve/auth/import` gilt **85 %**, weil dort viele Zweige seltene Fremdformate behandeln, die nur über Testvektoren erreichbar sind.

**Warum Zweige und nicht Zeilen.** Zeilenabdeckung ist in diesem Codebestand fast bedeutungslos. Der Prüfpfad aus Abschnitt 3.3 besteht aus wenigen Zeilen mit sehr vielen Zustandskombinationen; eine einzige Anmeldung deckt jede Zeile ab und trotzdem keinen einzigen der Fehlerfälle. Zweigabdeckung zählt genau das, was hier zählt: dass jede Bedingung in beide Richtungen ausgeführt wurde. Der Unterschied ist bei S-ENUM-2 (fünf Kontozustände, eine Antwort) und bei S-LINK-2 (zwölf Zustandskombinationen, eine Regel) am größten.

**Warum 90 % und nicht 100 %.** Die verbleibenden 10 % sind in der Praxis drei Dinge: Fehlerbehandlung für Datenbankfehler, die sich nur per Injektion erzeugen lassen; defensive Zweige, die per Konstruktion unerreichbar sind (ein `switch` über ein String-Enum mit einem `default`, der wirft); und plattformabhängige Zweige (`crypto.subtle` mit `@noble/ciphers` als Rückfall, Abschnitt 2.4). Diese auf 100 % zu treiben erzeugt Tests, die Attrappen prüfen statt Verhalten. Für die vier Kernverzeichnisse gilt trotzdem 100 %, weil dort jeder Zweig eine Sicherheitsentscheidung ist und die genannten drei Kategorien dort nicht vorkommen.

**Mutationstesting mit Stryker auf dem Kryptopfad — ja, aber begrenzt.** Zweigabdeckung beweist, dass ein Zweig ausgeführt wurde, nicht dass sein Ergebnis geprüft wird. Genau diese Lücke ist bei Sicherheitscode gefährlich: ein Test, der `verify()` aufruft und den Rückgabewert nicht auswertet, erzeugt volle Abdeckung und fängt nichts. Mutationstesting findet das, indem es `===` zu `!==` verdreht, Bedingungen negiert und Rückgabewerte ersetzt; überlebt eine Mutante, fehlt eine Zusicherung.

Für ein Ein-Personen-Team lohnt sich das **nicht auf dem gesamten Bestand**: ein Stryker-Lauf über einen mittelgroßen TypeScript-Bestand mit Integrationstests gegen eine echte Datenbank dauert Stunden, und der Großteil der Mutanten ist uninteressant. *SCHÄTZUNG: ein Vollauf über `core/` läge bei 4–8 Stunden.* Es lohnt sich **auf einem eng gezogenen Ausschnitt**:

- **Ausschnitt:** `core/password/` (Verfahrensweiche, PHC-Parser, Rehash-Politik), `core/token/` (Erzeugung und Konsum) und `core/keys/` (HKDF-Ableitung, Envelope, Ring). Das sind die Stellen, an denen eine verdrehte Bedingung eine stille Authentifizierungsumgehung ergibt.
- **Nur mit Unit-Tests als Prüfern**, nicht mit den Integrationstests. *SCHÄTZUNG: damit fällt die Laufzeit auf 10–20 Minuten.*
- **Ziel: Mutations-Score ≥ 85 % auf diesem Ausschnitt**, gemessen **vor jedem Release**, nicht bei jedem Commit.
- **Der Wert für ein Ein-Personen-Team ist nicht die Zahl, sondern die Liste der überlebenden Mutanten.** Sie ist eine Arbeitsliste fehlender Zusicherungen und ersetzt den Code-Review durch eine zweite Person an genau der Stelle, an der ein solcher Review am meisten wert wäre.

**Abdeckung ist kein Sicherheitsmaß.** Die 127 Testfälle dieses Plans sind das Sicherheitsmaß; die Abdeckungszahl ist nur die Warnleuchte, die anzeigt, dass ein neuer Zweig ohne Testfall hinzugekommen ist. Kein Testfall dieses Plans darf mit dem Argument „die Abdeckung stimmt ja" entfallen.

---

## 7. Entscheidungsprotokoll

Dieses Protokoll wird als `CASE-STUDY.md` in das Repository übernommen und dort während des Baus fortgeschrieben. Es ist der Ausgangsbestand, nicht das Ergebnis. Jeder Eintrag hält fest, was entschieden wurde, was verworfen wurde und warum — damit die Fallstudie am Ende die tatsächlichen Gründe enthält und nicht die, die sich hinterher gut erzählen.

Format: **E-nn — Entscheidung.** Kontext · Verworfen · Grund · Preis.

---

### Laufzeit und Auslieferung

**E-01 — Reines TypeScript, kein eigenes Rust/WASM.**
*Kontext:* Argon2id ist der teuerste Rechenschritt der Bibliothek.
*Verworfen:* (a) Kryptokern in Rust, als WASM eingebunden. (b) `hash-wasm` im Pflichtpfad.
*Grund:* Der Gewinn eines eigenen Moduls gegenüber fertigem WASM beträgt Faktor 1,6 (47 ms gegen 76 ms), und der schnelle Weg dorthin braucht `node:wasi`, `node:worker_threads` und `node:fs` — genau die Module, die auf Caprock nicht zugesichert sind. `hash-wasm` scheitert in Cloudflare Workers an `Wasm code generation disallowed by embedder`. Eine Bibliothek, deren Zweck Ortsunabhängigkeit ist, darf ihren Kern nicht an eine Ausführungsart binden, die verbreitete Laufzeiten verbieten.
*Preis:* 263 ms statt 76 ms je Kennwortprüfung im Messaufbau (2 vCPU; auf Serverhardware niedriger bei gleichem Faktor). Abgefedert durch den Semaphor aus E-13 und dadurch, dass die Rechenmaschine austauschbar bleibt (E-02).

**E-02 — Die Argon2id-Implementierung ist austauschbar, weil die Ausgaben bitgleich sind.**
*Kontext:* E-01 legt sich auf die langsamste Variante fest.
*Verworfen:* Die Rechenmaschine fest in den Kern zu verdrahten.
*Grund:* Messung zeigt: `@noble/hashes`, `hash-wasm` und eine Rust-WASI-Variante erzeugen bytegleiche Hashes und verifizieren sich gegenseitig. Damit ist die Wahl reversibel, ohne dass ein einziger gespeicherter Hash angefasst wird. Die Entscheidung E-01 kostet also keine Zukunft.
*Preis:* Eine zusätzliche Abstraktionsschicht von etwa dreißig Zeilen.

**E-03 — `crypto.subtle` überall dort, wo es die Primitive schon gibt.**
*Kontext:* PBKDF2, SHA-2, HMAC und AES-GCM liegen im heißen Pfad (Abschnitt 2.7).
*Verworfen:* Alles über `@noble/*` laufen lassen, der Einheitlichkeit wegen.
*Grund:* PBKDF2 mit 600.000 Iterationen: 269 ms über `crypto.subtle`, 926 ms in JavaScript, **2161 ms über WASM**. SHA-2 auf großen Blöcken fast dreimal so schnell. AES-GCM hardwarebeschleunigt. Es ist Nicht-JavaScript ohne native Bindings — genau das, was gesucht war.
*Preis:* Zwei Wege statt einem. `@noble/ciphers` bleibt als Rückfall für unvollständige Web-Crypto-Implementierungen.

**E-04 — Nur ESM, nur Node ab 20, vorkompiliert ausgeliefert.**
*Kontext:* Auslieferungsform des npm-Pakets (Abschnitt 2.5).
*Verworfen:* Doppelausgabe ESM+CJS.
*Grund:* Doppelausgabe verdoppelt die Testmatrix und erzeugt die bekannten Dual-Package-Fehler. Node 20 macht `crypto`, `crypto.subtle` und `getRandomValues` global — damit fällt jedes Laufzeit-Sondergehäuse weg.
*Preis:* CommonJS-Nutzer brauchen dynamisches `import()`.

**E-05 — Ein npm-Paket mit Subpfaden, kein Monorepo.**
*Kontext:* Ein-Personen-Team; Subpfade nach Abschnitt 3.1.
*Verworfen:* Better Auths Zuschnitt mit 23 Paketen.
*Grund:* Bei einem Ein-Personen-Team ist Versionsdrift zwischen eigenen Paketen die teuerste Fehlerklasse: Sie tritt erst beim Nutzer auf und ist dort schwer zu diagnostizieren. Schwere Abhängigkeiten bleiben trotzdem draußen, weil `@velve/auth/import` nur beim Import geladen wird.
*Preis:* Größeres Repository, gröbere Freigabegranularität.

### Datenbank

**E-06 — Nur PostgreSQL, kein Abfrageaufbauer, handgeschriebenes SQL.**
*Kontext:* Die Datenbankschicht ist bei Better Auth mit 58 Funktionen der größte Block an Abstraktion (Abschnitt 1 F).
*Verworfen:* (a) Adapter für MySQL und SQLite. (b) ORM-Adapter für Prisma, Drizzle, Kysely.
*Grund:* Better Auths Abstraktion zahlt Portabilität mit dem kleinsten gemeinsamen Nenner: `supportsArrays: false` selbst für PostgreSQL, keine partiellen Indizes, kein `ON CONFLICT`, kein `citext`, ein Transformationsdurchlauf pro Zeile in JavaScript. Der Ratenbegrenzer emuliert dort ein Upsert mit bis zu vier Round-Trips, das hier eine Anweisung ist. Ein Adapter, den niemand betreibt, ist keine Reichweite, sondern eine unbewiesene Behauptung.
*Preis:* Kein MySQL, kein SQLite, keine ORM-Integration. Wer das braucht, nimmt Better Auth — und das ist eine ehrliche Antwort.

**E-07 — Eigenes Postgres-Schema `velve`.**
*Kontext:* Die Tabellen liegen in der Datenbank der Anwendung, neben deren eigenen.
*Verworfen:* Tabellen mit Präfix im `public`-Schema.
*Grund:* `user` ist in SQL ein reserviertes Wort; ein eigenes Schema löst das Anführungszeichenproblem und die Kollision mit der `users`-Tabelle der Anwendung in einem Zug. Rechtevergabe und Sicherung lassen sich am Schema festmachen.
*Preis:* `search_path` muss stimmen; alle Abfragen qualifizieren voll.

**E-08 — Versionierte, transaktionale, vorwärtsgerichtete SQL-Migrationen.**
*Kontext:* Sechzehn Tabellen (Abschnitt 3.17), die sich über Versionen ändern werden.
*Verworfen:* Schemaableitung zur Laufzeit aus der Konfiguration, wie Better Auth sie betreibt.
*Grund:* Dort ist `migrate` nur additiv, nicht transaktional, kennt keine Versionshistorie, kann nicht umbenennen, löschen oder umtypisieren, rüstet Indizes auf bestehenden Spalten nicht nach und funktioniert nur mit Kysely. Das ist kein Migrationssystem, sondern ein Schemaangleicher. Ausgeliefertes SQL kann der Betreiber außerdem lesen, prüfen und mit eigenem Werkzeug anwenden.
*Preis:* Handarbeit bei jeder Schemaänderung.

### Kennwörter

**E-09 — Multi-Verfahren-Weiche im Kern, nicht als Plugin.**
*Kontext:* Nicht verhandelbare Anforderung.
*Verworfen:* Ein austauschbares `hash`/`verify`-Paar wie in Better Auth.
*Grund:* Dort ersetzt der Haken **beide** Richtungen. Wer bcrypt verifizieren will, erzeugt zwangsläufig auch bcrypt — für alle Nutzer, dauerhaft. Genau das empfehlen die dortigen Migrationsanleitungen wörtlich (`docs/.../supabase-migration-guide.mdx:971`, gleichlautend in `clerk-migration-guide.mdx:47` und `auth0-migration-guide.mdx:595`), und niemand sagt dazu, dass das Zielsystem damit dauerhaft auf bcrypt(10) festliegt. Prüfen und Erzeugen müssen getrennte Entscheidungen sein.
*Preis:* Vier Verifizierer im Kern, die dauerhaft gepflegt werden.

**E-10 — Ein kanonischer PHC-String, Weiche am Präfix, kein fremdes Rohformat in der Datenbank.**
*Kontext:* Fünf Quellen mit mehr als einem Dutzend Hash-Formaten (Abschnitt 4).
*Verworfen:* Fremdformate speichern und eine Herkunftsspalte mitführen.
*Grund:* Better Auths `salt_hex:hash_hex` trägt weder Algorithmus noch Parameter. Die Folge ist, dass die scrypt-Parameter nie erhöht werden können, ohne alle Nutzer auszusperren — der Bestand ist eingefroren. Ein selbstbeschreibender String macht Parameterwechsel zu einem Nicht-Ereignis. Für Firebase-Hashes wird bewusst GoTrues bestehendes `$fbscrypt$`-Format übernommen statt eines eigenen, damit Supabase-Bestände unverändert durchlaufen.
*Preis:* Der Import muss jedes Quellformat umschreiben, nicht durchreichen.

**E-11 — Stiller Rehash nach der Antwort, per Vergleich-und-Tausch.**
*Kontext:* `needsRehash` ist nach jeder Anmeldung mit einem Fremd-Hash wahr (Abschnitt 3.3, Schritt 5).
*Verworfen:* (a) Rehash synchron vor der Antwort. (b) Rehash in einem Wartungslauf.
*Grund:* Synchron verdoppelt die Anmeldelatenz auf über eine halbe Sekunde. Ein Wartungslauf ist unmöglich, weil das Klartextkennwort nur im Moment der Anmeldung existiert. Die Schreiboperation `WHERE user_id = $1 AND phc = $alt` ist gegen gleichzeitige Anmeldungen sicher, und ein verlorener Rehash ist folgenlos — der nächste Versuch holt ihn nach.
*Preis:* Eine Hintergrundaufgabe, deren Fehlschlag protokolliert und nicht gemeldet wird.

**E-12 — Der PHC-String wird verschlüsselt gespeichert, statt gepeppert.**
*Kontext:* Festgelegt in L-2 (Abschnitt 3.16); Schlüsselzweck `password-enc`, Spalte `key_version`, Rotation auf dem Weg des Rehashs.
*Verworfen:* Klassischer Pepper in der Ableitung.
*Grund:* Ein Pepper in der Ableitung bricht jeden importierten Hash, denn der wurde ohne ihn erzeugt. Umschlagverschlüsselung der Spalte erreicht dieselbe Wirkung — ein Datenbankauszug allein nützt nichts — und wirkt für erzeugte und importierte Hashes gleichermaßen. Sie ist außerdem rotierbar, ein Pepper ist es praktisch nicht.
*Preis:* Schlüsselverlust bedeutet Kennwortverlust. Steht an erster Stelle der Betriebsdokumentation.

**E-13 — Semaphor über gleichzeitige KDF-Aufrufe.**
*Kontext:* Argon2id belegt 19 MiB je Aufruf; die Anmeldung ist unauthentifiziert erreichbar.
*Verworfen:* Keine Begrenzung, wie in Better Auth.
*Grund:* Argon2id mit 19 MiB und hundert gleichzeitigen Anmeldungen sind 1,9 GB. Ohne Begrenzung ist die Anmeldung selbst der Angriffsvektor. Better Auth prüft an `/sign-in/email` nicht einmal die Eingabelänge vor dem KDF-Aufruf und hasht auch bei unbekannter Adresse (`api/routes/sign-in.ts:526-539`); `/change-password` hasht das neue Kennwort sogar **vor** der Prüfung des alten (`api/routes/update-user.ts:276-277`). Die Längenprüfung vor dem KDF folgt L-7: mindestens 8 Zeichen, höchstens 4096 Byte, keine Zusammensetzungsregeln; ein Abgleich gegen Leak-Korpora hängt an `password.validate` und läuft nie bei der Anmeldung.
*Preis:* Unter Last wartet die Anmeldung, statt zu scheitern — bis zur Wartegrenze von 5 Sekunden (L-1).

**E-14 — Keine Antwort-Deadline.**
*Kontext:* Aufzählungsschutz über Zeitverhalten (Abschnitt 3.13, L-1).
*Verworfen:* Feste Mindestdauer je Endpunkt, wie Better Auth sie mit 500 ms bei `send-verification-email` einsetzt.
*Grund:* Eine Deadline verdeckt Ungleichförmigkeit, statt sie zu verhindern, und leckt oberhalb der Schwelle wieder. Die Regel „ein Codepfad, gleiche Arbeit unabhängig vom Ergebnis" ist stärker und im Test nachweisbar.
*Preis:* Der Nachweis ist ein statistischer Test, der in CI gepflegt werden muss. Davon getrennt bleibt die Wartegrenze des Semaphors von 5 Sekunden — eine Ressourcengrenze, keine Zeitangleichung (L-1).

### Identität

**E-15 — Drei Identitätskonfigurationen als diskriminierte Union, materialisiert als CHECK-Constraint.**
*Kontext:* `email`, `username`, `username_email` (Abschnitt 3.4).
*Verworfen:* Alle Felder immer optional und zur Laufzeit prüfen.
*Grund:* Wenn die Konfiguration den Typ bestimmt, existiert `auth.username.changeUsername` in der Konfiguration `email` nicht — der Fehler tritt beim Kompilieren auf, nicht beim Nutzer. Das Constraint sorgt dafür, dass auch ein direkter Datenbankzugriff die Invariante nicht bricht.
*Preis:* Ein Wechsel der Konfiguration nach der Einführung ist eine echte Migration.

**E-16 — Die E-Mail ist nirgends Pflicht und wird nirgends erfunden.**
*Kontext:* `velve.user.email` ist NULL-fähig (Abschnitt 3.2).
*Verworfen:* Better Auths Weg: `email NOT NULL UNIQUE` plus Platzhalteradressen.
*Grund:* Dort ist das keine Doku-Empfehlung, sondern eingebauter Produktionscode — `createPlaceholderEmail` wird von Roblox, TikTok, WeChat, Reddit, Twitter, SIWE, Anonymous und dem Entra-Helfer aufgerufen und erzeugt Adressen wie `<id>@<ns>.placeholder.invalid`, an die kein Plugin je etwas senden kann. Issue #9124 ist dazu offen, die Doku räumt es ein (`concepts/oauth.mdx:409`). Eine ungültige Adresse in der Datenbank ist schlimmer als gar keine, weil nachgelagerte Systeme sie für echt halten.
*Preis:* Jeder Codepfad muss `email IS NULL` aushalten.

**E-17 — Benutzernamen: Anzeigeform und Vergleichsform getrennt, mit Zeichen-Erlaubnisliste.**
*Kontext:* Der Benutzername ist in zwei der drei Konfigurationen Anmeldename.
*Verworfen:* Nur eine Spalte, kleingeschrieben.
*Grund:* Eine Erlaubnisliste ist der wirksamste Homoglyphenschutz, weil sie das Problem gar nicht entstehen lässt; eine Skelettbildung nach Unicode-Confusables wäre die aufwendigere und fehleranfälligere Alternative. Die getrennte Anzeigeform erhält die Schreibweise, die der Nutzer gewählt hat.
*Preis:* Nicht-lateinische Benutzernamen sind in der Vorgabe ausgeschlossen. Die Erlaubnisliste ist konfigurierbar, mit dokumentierter Warnung.

**E-18 — In der Konfiguration `username` gibt es kein Zurücksetzen per E-Mail, und das ist ein Startfehler ohne Wiederherstellungscodes.**
*Kontext:* Konfiguration `username` ohne Postfach (Abschnitt 3.4).
*Verworfen:* — Es gibt keinen zweiten Kanal, den die Bibliothek erfinden könnte.
*Grund:* Ohne Postfach gibt es keinen Kanal außerhalb des Kennworts. Das lässt sich nicht wegkonfigurieren, nur ehrlich benennen. Die Bibliothek verweigert den Start, statt die Lücke offenzulassen.
*Preis:* Eine Pflichtoption, die man erklären muss.

**E-19 — Benutzernamen sind aufzählbar, und das wird gesagt.**
*Kontext:* Verfügbarkeitsprüfung bei der Registrierung.
*Verworfen:* Die Prüfung nicht anzubieten.
*Grund:* Wer eine Verfügbarkeitsprüfung anbietet, verrät die Existenz — daran ändert keine Formulierung etwas. Sie nicht anzubieten macht Registrierungsformulare unbrauchbar. Also: anbieten, hart begrenzen, dokumentieren. E-Mail-Aufzählung bleibt vollständig geschlossen.
*Preis:* Eine Einschränkung im Datenblatt statt einer stillen Lücke.

### Sitzungen

**E-20 — Datenbanksitzungen, undurchsichtiges Token, nur `sha256` gespeichert.**
*Kontext:* Sofortiger Widerruf ist das Kernversprechen des Sitzungsmodells (Abschnitt 3.5).
*Verworfen:* (a) JWT mit Refresh-Rotation. (b) Klartext-Token in der Datenbank, wie Better Auth es tut.
*Grund:* Sofortiger Widerruf ist die Eigenschaft, um die es geht; JWT kann sie prinzipiell nicht liefern, und die Reuse-Detection dafür ist eine eigene Fehlerklasse — Better Auths eigener OAuth-Server hat sie zweimal falsch gehabt (GHSA-7w99-5wm4-3g79, GHSA-392p-2q2v-4372). Das Klartext-Token dort ist eine unnötige Preisgabe: der Server vergleicht nur, also genügt der Hash. Bemerkenswert ist, dass dieselbe Codebasis für `verification.identifier` sehr wohl eine Hashing-Option kennt.
*Preis:* Ein indizierter Datenbanktreffer je Anfrage. Bei einem Unique-Index auf 32 Byte ist das die günstigste Abfrage im System. Die Zeile hält `ip` und `user_agent` in der Vorgabe gekürzt — `/24` bzw. `/64`, Browser- und Systemfamilie (L-10); wer den vollen Wert braucht, schaltet ihn ein.

**E-21 — Kein Cookie-Cache, in keiner Variante.**
*Kontext:* Der Datenbanktreffer aus E-20 ist die Stelle, an der ein Zwischenspeicher lockt.
*Verworfen:* Signiertes Cookie, JWE-Cookie, Redis-Zwischenspeicher.
*Grund:* Der schwerste veröffentlichte Fehler in Better Auth hängt genau daran: GHSA-xg6x-h9c9-2m83, CVSS 9.1 — der Cookie-Cache legte die Sitzung ab, bevor der zweite Faktor geprüft war, und umging damit 2FA vollständig. Dazu kommt, dass widerrufene Sitzungen im Cache bis zum Ablauf weiterleben und der Vorgabewert `compact` Sitzung und Nutzer einschließlich Adresse **unverschlüsselt** im Browser ablegt. Ein Zwischenspeicher darf Daten halten, niemals eine Autorisierungsentscheidung. Aus demselben Grund setzt jeder Handler `Cache-Control: no-store` und `Vary: Cookie` (L-6) — ein vorgelagertes CDN ist der Normalfall, und auch dort darf keine Antwort der Bibliothek liegen bleiben.
*Preis:* Ein Datenbanktreffer je Anfrage bleibt bestehen.

**E-22 — Zwei Fristen: Leerlauf und absolut.**
*Kontext:* Lebensdauer einer Sitzung (Abschnitt 3.5).
*Verworfen:* Ein gleitendes Fenster wie bei Better Auth und NextAuth.
*Grund:* Ein rein gleitendes Fenster läuft nie ab, solange jemand es benutzt — auch ein Angreifer. Die absolute Frist begrenzt den Schaden eines gestohlenen Tokens ohne Zutun.
*Preis:* Nutzer melden sich in festen Abständen neu an.

**E-23 — Neuvergabe bei jedem Vertrauenswechsel, immer als Einfügen plus Löschen in einer Transaktion.**
*Kontext:* Anmeldung, zweiter Faktor, Kennwortänderung und Verknüpfung ändern die Vertrauensstufe.
*Verworfen:* Die bestehende Zeile per `UPDATE` umschreiben.
*Grund:* `UPDATE session SET user_id` existiert nicht und wird durch Lint-Regel **und** Datenbank-Trigger verhindert. Zwei Sperren gegen dieselbe Fehlerklasse sind hier angemessen, weil ihr Eintreten unbemerkt bleibt.
*Preis:* Etwas mehr Schreiblast bei der Anmeldung.

**E-24 — Kennwortänderung und Reset widerrufen andere Sitzungen. Ohne Schalter.**
*Kontext:* Ein Reset ist meist die Reaktion auf einen Verdacht.
*Verworfen:* Eine Option mit sicherem Vorgabewert.
*Grund:* In Better Auth ist `revokeSessionsOnPasswordReset` eine Option ohne Vorgabewert (`api/routes/password.ts:328-330`). Ein Reset, der die Sitzungen des Angreifers stehen lässt, erfüllt seinen Zweck nicht — und die Auswertung der 33 Advisories zeigt: fast jede kritische Einstufung hing an einer Voreinstellung, nicht an einem Fehler.
*Preis:* Keiner, der es wert wäre.

### Zweiter Faktor

**E-25 — Der Zwischenzustand ist eine eigene Tabelle, keine Sitzung, und erreicht genau vier Routen.**
*Kontext:* Der Moment zwischen korrektem Kennwort und zweitem Faktor (Abschnitt 3.6).
*Verworfen:* Eine Sitzung mit Markierung „zweiter Faktor ausstehend".
*Grund:* Hier hat Better Auth es richtig gemacht — eigenes Cookie plus Verifikationszeile statt Sitzung — und das wird ausdrücklich übernommen. Der Zusatz ist die Beschränkung auf genau die vier Routen mit `caller: "pending"`: sonst ist der Zwischenzustand ein halber Ausweis, der irgendwo als ganzer gelesen wird. Nach fünf Fehlversuchen wird die Zeile gelöscht und der Vorgang beginnt beim Kennwort von vorn; kein Kontosperren (L-8).
*Preis:* Eine Tabelle mehr.

**E-26 — WebAuthn ist ein eigenständiger Anmeldeweg, und synchronisierte Passkeys sind von gerätegebundenen unterscheidbar.**
*Kontext:* Passkey-Anmeldung ohne Kennwort und WebAuthn als zweiter Faktor (Abschnitt 3.6).
*Verworfen:* WebAuthn nur als zweiter Faktor; die Flags verwerfen.
*Grund:* Die Flags `backupEligible` und `backupState` kommen ohnehin in den Authenticator-Daten an; sie nicht zu speichern wäre Informationsverlust ohne Gegenwert. Sie werden gespeichert und weitergereicht — eine Richtlinie darauf ist Sache der Anwendung, nicht der Bibliothek. Nach derselben Logik wird ein rückläufiger `sign_count` als Feld `signCountRegressed` gemeldet, nicht abgelehnt: Synchronisierte Passkeys führen den Zähler nicht verlässlich (L-9). Und weil WebAuthn ein eigener Anmeldeweg ist, zählt er zu den Wegen, deren letzter nicht entfernt werden darf — der Versuch scheitert mit `last_sign_in_method` (L-13).
*Preis:* Zwei Spalten und ein erklärungsbedürftiges Begriffspaar in der Dokumentation.

**E-27 — Wiederherstellungscodes: 160 bit, HMAC gespeichert, Nachschlagen statt Durchlaufen.**
*Kontext:* Zehn Codes je Nutzer; in der Konfiguration `username` der einzige Weg zurück ins Konto.
*Verworfen:* Argon2id auf jedem Code.
*Grund:* Bei 160 bit Entropie aus einem CSPRNG bringt eine speicherharte Ableitung nichts — es gibt kein Wörterbuch. Sie würde aber zehn KDF-Aufrufe je Prüfung erzwingen, wenn man die Codes durchläuft. Der HMAC erlaubt den direkten Indextreffer. Jede Zeile trägt `key_version`, damit eine Rotation von `token-pepper` die Codes nicht entwertet (L-3).
*Preis:* Die Begründung muss in der Dokumentation stehen, sonst liest es sich wie eine Nachlässigkeit.

**E-28 — TOTP-Replay über `PRIMARY KEY (user_id, time_step)`.**
*Kontext:* Toleranz ±1 Schritt (Abschnitt 3.6); ein Code darf im Fenster nur einmal gelten.
*Verworfen:* Lesen und Einfügen als zwei Anweisungen.
*Grund:* Der Einfügeversuch **ist** die Prüfung. Das ist race-frei ohne Sperre und ohne zusätzliche Abfrage.
*Preis:* Eine Tabelle, die aufgeräumt werden muss — über `auth.maintenance.sweep()` oder das mitgelieferte SQL, nicht über einen Zeitgeber im Kern (L-11).

### Drittanbieter

**E-29 — `(provider, subject)` ist der einzige Verknüpfungsschlüssel. Die E-Mail ist nie einer.**
*Kontext:* Anbieterverknüpfung (Abschnitt 3.10) und Import (Abschnitt 4.0.6).
*Verworfen:* Verknüpfung über E-Mail-Gleichheit, auch bei verifizierter Anbieteradresse.
*Grund:* Das ist die häufigste schwere Fehlerklasse überhaupt: CVE-2026-53516 (CVSS 8,3), GHSA-qq9h-g4jm-xgf3 (8,3), GHSA-fmh4-wcc4-5jm3 (7,7) — dreimal dieselbe Ursache in einer Codebasis. Automatisch verknüpft wird nur, wenn der Anbieter die Adresse als verifiziert meldet **und** das lokale Konto verifiziert ist **und** der Anbieter als vertrauenswürdig konfiguriert ist. Drei Bedingungen, alle drei notwendig. Dieselbe Regel gilt nach innen: Wird eine Adresse erstmals bestätigt und stammt das vorhandene Kennwort aus einer anderen Sitzung als der, die jetzt bestätigt, wird die Kennwortanmeldung gelöscht und jede Sitzung widerrufen (L-12) — sonst bleibt der Vorabzugang eines Angreifers gültig, genau der Fehler aus GHSA-qq9h-g4jm-xgf3.
*Preis:* Mehr ausdrückliche Verknüpfungen im Nutzerfluss.

**E-30 — Vierzehn Anbieter statt sechsunddreißig.**
*Kontext:* Anbieterliste zum Start (Abschnitt 3.10).
*Verworfen:* Gleichziehen mit Better Auths Anbieterliste.
*Grund:* Die Schnittstelle ist der Wert, nicht die Anzahl. Anbieter sind der Teil, der sich später am billigsten nachziehen lässt — und jeder einzelne ist Wartungslast, wenn sich sein OAuth-Verhalten ändert. Better Auths Anbieterabstraktion ist übrigens die sauberste Ecke seiner Codebasis und dient hier als Vorbild.
*Preis:* Eine kürzere Liste auf der Produktseite.

**E-31 — Fremde Tokens werden standardmäßig nicht gespeichert.**
*Kontext:* Access-, Refresh- und ID-Tokens der Anbieter nach dem Anmelden.
*Verworfen:* Speichern als Vorgabe, verschlüsselt.
*Grund:* Was nicht gespeichert ist, kann nicht auslaufen. Die meisten Anwendungen brauchen nach dem Anmelden kein Anbieter-Token; wer es braucht, schaltet es ein und bekommt es verschlüsselt.
*Preis:* Eine Option, die manche übersehen und dann suchen.

### Erweiterbarkeit

**E-32 — Aufgezählte Erweiterungspunkte statt offener Erweiterbarkeit.**
*Kontext:* Plugin-Schnittstelle (Abschnitt 3.11).
*Verworfen:* Better Auths Modell, in dem ein Plugin Kernendpunkte überschreiben, den Kontext per `Object.assign` mutieren, `password.hash` ersetzen und die Optionen fremder Plugins beschreiben kann.
*Grund:* Dort ist das keine theoretische Möglichkeit: Das Stripe-Plugin schreibt tatsächlich in die Optionen des Organization-Plugins (`packages/stripe/src/index.ts:256`) und erzeugt damit eine unsichtbare Reihenfolgeabhängigkeit. Kollisionen werden nur protokolliert, `init` läuft ohne `try/catch`, und `plugin.migrations` sowie `plugin.adapter` sind toter Code. Ein Plugin ist ein Zuhörer mit Vetorecht, kein Miteigentümer.
*Preis:* Manches Plugin, das dort möglich wäre, ist hier unmöglich. Das ist beabsichtigt.

**E-33 — Namenskollision ist ein Startfehler.**
*Kontext:* Zwei Plugins, oder Plugin und Kern, beanspruchen denselben Routen- oder Tabellennamen.
*Verworfen:* Warnung im Protokoll, wie Better Auth es tut.
*Grund:* Eine Warnung im Protokoll wird im Betrieb nicht gelesen. Ein Fehler beim Start wird gelesen.
*Preis:* Weniger Nachsicht bei der Einführung.

**E-34 — Eine Routendeklaration erzeugt Handler, Servermethode und Client.**
*Kontext:* Client und Server müssen dieselbe Oberfläche kennen (Abschnitt 3.12).
*Verworfen:* Better Auths Laufzeit-Proxy über Pfadsegmente mit der Heuristik „Body vorhanden, also POST".
*Grund:* Dort gibt es keinen Laufzeitvertrag zwischen Client und Server; die Typen entstehen rein statisch aus `Auth["api"]`, was zu den bekannten Inferenzproblemen führt (Issues #1252, #4654 mit TS2742, #5159). Aus einer Deklaration abgeleitet, kann ein Aufruf, den es nicht gibt, nicht kompilieren.
*Preis:* Eine Deklarationsschicht, die gepflegt werden muss.

### Umfang

**E-35 — Keine Rollen, keine Berechtigungen, keine Organisationen.**
*Kontext:* Vorgabe des Auftraggebers.
*Verworfen:* Rollen und Organisationen als optionales Modul im selben Paket.
*Grund:* Die Zahlen stützen sie: In Better Auth entfallen 133 von 618 Funktionen auf Autorisierung und Identitätsanbieter-Rollen (Abschnitt 1 I und J); allein die Dokumentation des Organization-Plugins umfasst 2586 Zeilen. Das ist ein eigenes Produkt, das nur zufällig im selben Paket wohnt. Die Bibliothek beantwortet, wer angemeldet ist — was diese Person darf, weiß nur die Anwendung.
*Preis:* Wer beides will, braucht zwei Dinge. Das ist die richtige Anzahl.

**E-36 — 322 von 618 Funktionen werden weggelassen.**
*Kontext:* Ergebnis des Funktionsvergleichs (Abschnitt 1).
*Verworfen:* Funktionsgleichheit mit Better Auth als Ziel.
*Grund:* Nicht als Sparmaßnahme, sondern weil 133 davon außerhalb des Zwecks liegen, 32 auf Sitzungsvarianten entfallen, die dem Widerrufsversprechen widersprechen, und 28 auf Datenbankabstraktion, die mit der Festlegung auf PostgreSQL entfällt. Übernommen oder anders gelöst werden 268, übertroffen 28.
*Preis:* Velve Auth ist kein Ersatz für jeden Better-Auth-Einsatz. Wo es einer ist, ist es ein besserer.

**E-37 — Kein E-Mail-Versand, kein Audit-Log, keine Admin-Oberfläche.**
*Kontext:* Betriebsfunktionen rund um die Anmeldung (Abschnitt 3.14).
*Verworfen:* Eingebauter Versand, Audit-Tabelle im Schema, mitgelieferte Oberfläche.
*Grund:* Versand ist ein Callback, weil jede ernsthafte Anwendung schon einen Versandweg hat und die Bibliothek dort nicht dazwischenstehen soll. Audit-Log und Oberfläche gehören zur Anwendung, die den fachlichen Kontext kennt. Better Auth hat beides ebenfalls nicht im offenen Teil — dort allerdings, weil es kostenpflichtige Produkte sind.
*Preis:* Mehr Arbeit beim Einbau.

### Migration

**E-38 — Migration ist Kernfunktion mit Trockenlauf, nicht eine Anleitung im Wiki.**
*Kontext:* Fünf Quellen als Vorgabe des Auftraggebers (Abschnitt 4).
*Verworfen:* Anleitungen mit Beispielskript, wie Better Auth sie liefert.
*Grund:* Better Auth hat fünf Anleitungen; die drei, die Kennwörter betreffen, empfehlen alle dasselbe — global auf bcrypt(10) umstellen — und für Firebase, die einzige Quelle mit nicht-trivialem Hash, gibt es gar keine. Ein Import ohne vorherigen Trockenlauf ist ein Blindflug: Welche Verfahren im Bestand liegen, weiß man vorher nicht.
*Preis:* Der aufwendigste Einzelbaustein nach dem Kern.

**E-39 — md4, md5, sha1 und roher HMAC werden nicht verifiziert.**
*Kontext:* Auth0-`custom_password_hash` und Clerk-`password_hasher` können solche Verfahren enthalten (Abschnitte 4.2 d und 4.3 d).
*Verworfen:* Einmalige Verifikation mit sofortigem Rehash.
*Grund:* Das würde dauerhafte Altfläche im Kern für Hashes schaffen, die faktisch Klartext sind — und der Einmal-Charakter ließe sich nicht erzwingen. Die Regel lautet: kein Verfahren, das weder iteriert noch speicherhart ist; sie trifft ebenso `sha256`, `sha512` und `ldap` bei Auth0 sowie zehn der neunzehn Clerk-Verfahren. Betroffene erhalten den Reset-Pfad (E-41).
*Preis:* Bei einer Auth0-Migration mit Altbestand müssen diese Nutzer ihr Kennwort neu setzen.

**E-40 — Keine automatische Zusammenführung bei Kollision.**
*Kontext:* Zwei Quellkonten mit derselben E-Mail (Abschnitt 4.0.6).
*Verworfen:* Zusammenführen; „ältestes Konto gewinnt" nur auf ausdrückliche Anweisung (`skip-duplicates`).
*Grund:* Beim Zusammenführen zweier Quellkonten mit derselben Adresse überlebt nur ein Kennworthash — das ist eine Rechteausweitung durch Migration und bricht dieselbe Regel, die E-29 für OAuth aufstellt.
*Preis:* Kollisionen brechen den Lauf ab und müssen entschieden werden.

**E-41 — Nicht verifizierbare Hashes führen zu einer Reset-Pflicht in einer eigenen Tabelle, nicht zu einem Sentinel im PHC-Feld.**
*Kontext:* Reset-Pfad für Nutzer ohne brauchbaren Hash (Abschnitt 4.0.5).
*Verworfen:* Ein Platzhalterwert in `password_credential.phc`.
*Grund:* Ein Sentinel-Wert hätte eine weitere Präfixzeile in der Weiche erzwungen und damit den Prüfpfad um einen Sonderfall erweitert, der kein Hash ist. Die Antwort bei der Anmeldung bleibt byteweise identisch; der Hinweis wandert in die E-Mail.
*Preis:* Eine Tabelle und eine Zusatzabfrage im Fehlerzweig.

### Sicherheit als Vorgabe

**E-42 — Jede sicherheitsrelevante Einstellung ist im Vorgabewert sicher.**
*Kontext:* Better Auths Advisory-Historie (Abschnitt 5).
*Verworfen:* Bequeme Vorgaben mit Sicherheitsoptionen zum Einschalten.
*Grund:* Die Auswertung der 33 Advisories ergibt: Die häufigste Ursache ist keine Kryptoschwäche, sondern eine fehlende Eigentümerprüfung (10 Fälle), und fast jede kritische Einstufung hing an einer Voreinstellung. Abschwächung muss ausdrücklich, protokolliert und beim Start sichtbar sein.
*Preis:* Weniger Bequemlichkeit bei der Einführung.

**E-43 — Jede Repository-Methode auf nutzergebundenen Tabellen verlangt einen `actor`.**
*Kontext:* Zehn von 33 Advisories der Klasse „fehlende Eigentümerbindung".
*Verworfen:* Eigentümerprüfung im Handler, per Review erzwungen.
*Grund:* Die zehn Advisories der Klasse „fehlende Eigentümerbindung" haben dieselbe Gestalt: eine fehlende Zeile `AND user_id = :actor`. Wenn die Signatur den Aufrufer zwingt, den Handelnden zu nennen, kann man ihn nicht vergessen — man kann ihn nur falsch angeben, und das ist ein sichtbarer Fehler statt eines unsichtbaren.
*Preis:* Etwas mehr Tipparbeit im Kern.

**E-44 — Zweckgetrennte Schlüssel per HKDF, Version im Umschlag jedes erzeugten Werts.**
*Kontext:* Sechs Schlüsselzwecke (Abschnitt 3.8).
*Verworfen:* Ein Secret für alles, wie Better Auth es tut.
*Grund:* Dort signiert `ctx.secret` Cookies, E-Mail-JWTs und den Cache-HMAC; die Rotation ist nur für Verschlüsselung umgesetzt, Signaturen rotieren nicht, und ein Secret-Wechsel entwertet alle Sitzungen und alle offenen Links gleichzeitig. Hier überlebt jede Rotation sämtliche Sitzungen, weil Sitzungen undurchsichtige Datenbankzeilen sind und mit keinem Schlüssel zusammenhängen. Wo kein Umschlag existiert, steht die Version als Spalte: `password_credential.key_version` für `password-enc` (L-2) und `recovery_code.key_version` für `token-pepper` (L-3).
*Preis:* Ein Schlüsselring, der verwaltet werden will.

**E-45 — `__Host-`-Präfix für alle Cookies der Bibliothek.**
*Kontext:* `__Host-velve_session` und `__Host-velve_pending` (Abschnitte 3.5, 3.6).
*Verworfen:* `__Secure-` mit konfigurierbarem `Domain`.
*Grund:* Das Präfix lässt den Browser `Secure` und `Path=/` erzwingen und `Domain` verbieten — Cookie-Tossing aus einer übernommenen Subdomain ist damit ausgeschlossen. Better Auth definiert das Präfix (`cookies/cookie-utils.ts:35`), setzt es aber nie — `cookies/index.ts:75` wählt nur zwischen `__Secure-` und keinem Präfix.
*Preis:* Kein `Domain`-Scope, also braucht Cross-Subdomain einen Tokenaustausch statt eines geteilten Cookies.

**E-46 — Aufzählungsschutz ist der Vorgabewert und liegt an einer Stelle.**
*Kontext:* Anmeldung, Registrierung, Reset und E-Mail-Wechsel (Abschnitt 3.13).
*Verworfen:* Schutz je Endpunkt, nachrüstbar.
*Grund:* In Better Auth wurde er viermal einzeln nachgemeldet (#7972, #7944, #5017, #8096), greift auch in 1.7.3 nicht im Standardaufbau, und `/sign-up/email` protokolliert die Adresse im Klartext, während es 422 zurückgibt. Nachgerüsteter Schutz ist lückenhafter Schutz. Zwei Folgen daraus: „Konto deaktiviert" ist bei der Anmeldung unsichtbar und erscheint nur bei der Auflösung einer bestehenden Sitzung (L-4); und der kontobezogene Zähler wird auf dem Bezeichner gebildet, nicht auf der Konto-ID, damit er vor der Nutzerauflösung greift und existierende wie nicht existierende Konten gleich behandelt — Überschreitung lehnt ab, statt zu verzögern, weil eine Verzögerung ein Zeitkanal wäre (L-5). Aus demselben Grund gibt es kein `requireEmailVerification`: Eine Anmeldesperre für unbestätigte Konten wäre ein Aufzählungskanal und zugleich eine Sackgasse, weil `email.requestVerification` eine Sitzung verlangt. Anmeldung und Registrierung liefern immer eine Sitzung, `User.emailVerifiedAt` trägt den Zustand, die Anwendung entscheidet (Abschnitt 1, A5; S-TIM-7).
*Preis:* Fehlermeldungen sind für Entwickler unbequemer. Der wahre Grund steht im Serverprotokoll.