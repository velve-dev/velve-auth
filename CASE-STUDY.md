# Velve Auth — Fallstudie

Dieses Protokoll ist der Ausgangsbestand aus Abschnitt 7 der Zielarchitektur
(`VELVE-AUTH-ARCHITEKTUR.md`), unverändert übernommen, und wird während des Baus
fortgeschrieben. Es ist nicht das Ergebnis, sondern das Mitschreiben.

Jeder Eintrag hält fest, was entschieden wurde, was verworfen wurde und warum —
damit die Fallstudie am Ende die tatsächlichen Gründe enthält und nicht die, die
sich hinterher gut erzählen. Wo eine Entscheidung aus einem schlechten Grund
fiel und sich später als richtig erwies, steht der schlechte Grund hier.

Format: **E-nn — Entscheidung.** Kontext · Verworfen · Grund · Preis.

Die Einträge E-01 bis E-46 stammen aus dem Entwurf. Ab E-47 stehen die
Entscheidungen, die beim Bauen fielen.

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

---

## Entscheidungen aus dem Bau

**E-47 — Englisch als Repository-Sprache, `CASE-STUDY.md` als einzige Ausnahme.**
*Kontext:* Der Bauauftrag verlangt, sich einmal festzulegen und dabei zu bleiben. Die Zielarchitektur und der Auftrag sind auf Deutsch, das Paket ist ein öffentliches MIT-Paket auf npm.
*Verworfen:* Durchgehend Deutsch, passend zur Vorlage.
*Grund:* Die Leser des Pakets sind nicht die Leser des Entwurfs. Wer `@velve/auth` installiert, findet Bezeichner, Fehlercodes und `DOCUMENTATION.md` vor; deutschsprachige Bezeichner in einer öffentlichen Bibliothek schließen ohne Gegenwert aus. `CASE-STUDY.md` ist ausgenommen, weil der Auftrag die wörtliche Übernahme von E-01 bis E-46 vorschreibt — eine Übersetzung wäre eine Änderung, und die Fortschreibung muss im selben Format und derselben Sprache weiterlaufen wie der Bestand.
*Preis:* Das Repository ist zweisprachig. Wer die Gründe sucht, liest Deutsch; wer die Bibliothek benutzt, liest Englisch.

**Licence addendum.** The *Kontext* above says MIT because that is what the
package was when this entry was written, and it stays that way. The package is
Apache-2.0 now. `E-505` carries the decision, why Apache 2.0 rather than MIT,
and its price. This paragraph exists because the alternative considered was to
edit the *Kontext* line instead, and leaving the line alone tells a reader both
what the entry said and what is true now, which the edit would not have.

**E-48 — Node ab 20.19 ist Bauvoraussetzung, nicht nur Laufzeitvoraussetzung.**
*Kontext:* Abschnitt 2.5 nennt Node 20.19 als Laufzeituntergrenze, abgeleitet aus `@noble/hashes` 2.x und den globalen Web-Crypto-Objekten. Beim Aufsetzen des Gerüsts stellte sich heraus, dass dieselbe Grenze schon für das Bauwerkzeug gilt: Die native Bindung von Rolldown, auf der `tsdown` aufsetzt, fordert `^20.19.0 || >=22.12.0`.
*Verworfen:* Ein Bundler ohne native Bindung, um unterhalb von 20.19 bauen zu können.
*Grund:* Der Fehler war zunächst unsichtbar — pnpm überspringt eine optionale Abhängigkeit, deren `engines`-Bedingung die laufende Node-Version verfehlt, ohne Warnung; sichtbar wurde nur ein fehlendes Modul zur Bauzeit. Ein Ausweichen auf ein anderes Werkzeug hätte die Untergrenze verdeckt, die ohnehin für die Laufzeit gilt. Zwei Untergrenzen, von denen die niedrigere nur für das Bauen gilt, sind eine Fehlerquelle ohne Nutzen.
*Preis:* Zwei Zahlen, die auseinanderlaufen dürfen und es tun: `engines` nennt mit `>=20.19` die Untergrenze, die das Paket seinen Nutzern zusagt, `.node-version` nennt die Fassung, mit der am Paket gearbeitet wird. Sie sind nicht dasselbe und sollen es nicht sein — deshalb prüft CI beide, die zugesagte Untergrenze und die aktuelle Fassung. Ohne diese Matrix wäre die Zusage in `engines` unbelegt.

**E-49 — Der npm-Name bleibt `@velve/auth`, obwohl das Repository `velve-dev/velve-auth` heißt.**
*Kontext:* Abschnitt 3.1 legt `@velve/auth` fest. Die GitHub-Organisation heißt `velve-dev`, das Repository `velve-auth` — beim Aufsetzen kam die Frage auf, ob das Paket dem Repository folgen sollte.
*Verworfen:* (a) `@velve-dev/velve-auth`, exakt wie der GitHub-Pfad. (b) `@velve-dev/auth`. (c) `velve-auth` ohne Scope.
*Grund:* Paketname und Repositoryname müssen nicht übereinstimmen und tun es bei Scoped Packages selten. `@velve-dev/velve-auth` wiederholt „velve" in jeder Importzeile, und das Paket hat neun Subpfade — die Wiederholung steht damit neunmal in jeder Einbindung und in jedem Beispiel der Dokumentation. Der Scope ist die Marke, das Paket ist das Produkt; `-dev` in einem Scope liest sich zudem wie ein Vorabkanal, was es nicht ist. Ohne Scope wäre der Namensraum für spätere Velve-Pakete verschenkt.
*Preis:* Die npm-Organisation `velve` musste beanspruchbar sein, und ob ein Organisationsname frei ist, zeigt npm erst beim Anlegen. Der Vorbehalt ist aufgelöst: Die Organisation ist angelegt, der Name steht. Wäre er vergeben gewesen, wäre `@velve-dev/auth` die Rückfallebene gewesen — die Entscheidung gegen die doppelte Nennung von „velve" wäre davon unberührt geblieben.

**E-50 — Die sechs Kernabhängigkeiten stehen von Anfang an in `package.json` und sind bis zu ihrer ersten Verwendung von `knip` ausgenommen.**
*Kontext:* Das Gerüst deklariert die sechs Abhängigkeiten aus Abschnitt 2.5, benutzt aber noch keine. `knip` meldet sie als unbenutzt und blockiert damit das Tor.
*Verworfen:* Jedes Feature fügt die Abhängigkeit hinzu, die es zuerst braucht.
*Grund:* Das wäre ehrlicher gegenüber `knip`, würde aber `package.json` zu einer Datei machen, die sich acht Features teilen — genau der geteilte Schreibzugriff, den die Konfliktregel des Bauauftrags ausschließt. Eine Datei mit einem Eigentümer und einer befristeten Ausnahme ist billiger als acht Features, die um dieselbe Datei konkurrieren.
*Preis:* Eine Prüfung ist vorübergehend abgeschaltet, und abgeschaltete Prüfungen werden vergessen. Gegenmaßnahme: Das Freigabetor in Welle 6 leert `ignoreDependencies` und lässt `knip` ohne Ausnahme laufen; bleibt dort eine Abhängigkeit übrig, ist sie tatsächlich unbenutzt und fliegt raus.

**E-51 — Die Attributionsprüfung nimmt die Regeldatei aus, statt die Muster zu entschärfen.**
*Kontext:* Der CI-Auftrag, der AI-Attribution ablehnt, schlug beim ersten Lauf auf `CLAUDE.md` an — dort stehen die verbotenen Begriffe, weil die Regel sie benennen muss. Eine Prüfung, die ein regelkonformes Repository ablehnt, ist keine Prüfung.
*Verworfen:* (a) Die Muster so verengen, dass der Regeltext nicht mehr trifft. (b) Nur den Diff prüfen statt des Baums.
*Grund:* Ein verengtes Muster hätte genau die Formulierungen freigegeben, die es fangen soll — der Regeltext und eine echte Attribution sind derselbe Wortlaut, unterschieden nur durch die Datei, in der sie stehen. Also unterscheidet die Prüfung nach Datei: Spezifikation, Prüfung und Regel dürfen die Begriffe nennen, alles andere nicht. Zugleich wurde die Prüfung erweitert, weil der Main-Gate-Agent zu Recht anmerkte, dass sie die eigene Regel nicht durchsetzte: Eine Urheberschaftsbehauptung in einem gewöhnlichen Zeilenkommentar wäre durchgelaufen, weil nur `Co-Authored-By`-Zeilen erfasst waren. Jetzt gibt es zwei Muster, Marker und Urheberschaftsbehauptung, beide gegen Commit-Verlauf und Baum.
*Preis:* Drei Dateien sind von der Prüfung ausgenommen und müssen von Hand gelesen werden. Für `CLAUDE.md` ist das vertretbar, weil der Main-Gate-Agent sie ohnehin jedes Mal ganz liest.

**E-52 — Der API-Schnappschuss entsteht in Welle 0, nicht wenn es eine Oberfläche gibt.**
*Kontext:* Das Main-Gate verlangt einen Vergleich der öffentlichen Oberfläche gegen einen Schnappschuss. In Welle 0 besteht die Oberfläche aus einer Konstanten — es gäbe nichts zu vergleichen.
*Verworfen:* Den Schnappschuss einführen, sobald die erste echte Oberfläche entsteht.
*Grund:* Ein Torpunkt ohne Umsetzung ist ein Torpunkt, der beim ersten Feature vergessen wird, und dann ist die erste echte Oberfläche genau die, die ungeprüft durchgeht. Der Schnappschuss liest die gebauten `.d.mts`-Dateien aller neun Subpfade; er ist heute fast leer und wächst mit. Dass er heute nichts fängt, ist kein Argument gegen ihn, sondern der Grund, warum er heute billig einzuführen ist.
*Preis:* Jede beabsichtigte Änderung der Oberfläche verlangt ein bewusstes Aktualisieren des Schnappschusses. Das ist der Zweck.

**E-53 — Die Fallstudie umschreibt die verbotenen Formulierungen, statt sich von der Prüfung ausnehmen zu lassen.**
*Kontext:* E-51 beschrieb den Befund und zitierte dabei die Formulierung, die er betrifft. Damit schlug die Prüfung auf `CASE-STUDY.md` an — derselbe Fehler wie zuvor auf `CLAUDE.md`, eine Datei später.
*Verworfen:* `CASE-STUDY.md` zur vierten Ausnahme erklären.
*Grund:* Jede Ausnahme ist ein Loch, und dieses wäre das größte gewesen: Die Fallstudie ist die längste Datei des Repositories und wächst mit jedem Feature, also hätte sich echte Attribution dort am leichtesten versteckt. Eine Beschreibung ist ohne Verlust möglich — die Fallstudie muss sagen, welche *Art* von Formulierung durchrutschte, nicht deren Wortlaut.
*Preis:* Die Fallstudie ist an dieser Stelle eine Spur abstrakter als nötig. Das ist der billigere der beiden Preise.

**E-54 — Die Attributionsprüfung liest Baum *und* Diff, nicht eines von beiden.**
*Kontext:* E-51 verwarf „nur den Diff prüfen statt des Baums". Der Main-Gate-Agent zeigte, dass die Umkehrung dieselbe Lücke hat: Text, der in einem Commit hinzugefügt und in einem späteren entfernt wird, steht nicht mehr im Baum, aber weiterhin im Verlauf und in der Diff-Ansicht des Pull Requests. Ein gepflanzter Fall lief durch.
*Verworfen:* Sich für eine der beiden Prüfungen entscheiden.
*Grund:* Die beiden Prüfungen decken verschiedene Zeiträume ab und nicht verschiedene Gründlichkeitsgrade. Der Baum sieht, was vor dem Branch schon dastand; der Diff sieht, was während des Branches kurz dastand. Die Wahl zwischen ihnen ist keine Abwägung, sondern ein Denkfehler — sie kostet zusammen eine Zeile mehr.
*Preis:* Der Diff-Durchlauf wird bei langen Branches langsam, weil er jeden Commit-Inhalt einmal liest.

**E-55 — Die Prüfung ist case-insensitiv, weil die wahrscheinlichste Schreibweise die großgeschriebene ist.**
*Kontext:* Die erste Fassung suchte kleingeschrieben. Der Main-Gate-Agent pflanzte vier Varianten, die alle durchliefen: satzinitiale Großschreibung in einem Kommentar und die Form `@author`.
*Verworfen:* Die Schreibweisen einzeln aufzählen.
*Grund:* Ein Kommentar beginnt üblicherweise mit einem Großbuchstaben, und `@author` ist nach `Co-Authored-By` die verbreitetste Urheberschaftsangabe in einer Quelldatei. Eine Prüfung, die genau die häufigste Form verfehlt, prüft nichts. Die Aufzählung wäre zudem immer unvollständig gewesen — die Fehlerklasse ist „Schreibweise", nicht „diese vier Schreibweisen".
*Preis:* Mehr Fehlalarme. Die drei ausgenommenen Dateien fangen sie ab; wäre die Liste länger, wäre der Preis zu hoch.

**E-56 — `pnpm test` baut vorher, damit der Schnappschuss nicht gegen ein veraltetes `dist/` grün wird.**
*Kontext:* Der API-Schnappschuss aus E-52 liest die gebauten Deklarationen. Wer die Quelle ändert und `pnpm test` ohne vorherigen Build aufruft, bekommt grün auf einem alten Stand.
*Verworfen:* Sich darauf verlassen, dass `pnpm gate` und CI ohnehin vorher bauen.
*Grund:* Beide tun das, und das Tor war nie gefährdet. Gefährdet war die Person, die während der Arbeit `pnpm test` aufruft und daraus schließt, die Oberfläche sei unverändert. Ein Schnappschuss, dem man nur in einer bestimmten Aufrufreihenfolge trauen kann, ist ein Schnappschuss, dem man nicht traut.
*Preis:* Jeder Testlauf baut, auch wenn sich nichts geändert hat. Bei rund 300 ms ist das der billigere Preis.

**E-57 — Der Slogan nennt die Herkunft, nicht den Umfang.**
*Kontext:* Better Auth wirbt mit „The most comprehensive authentication framework". Für das Banner und die README wurde eine Zeile in derselben Form gebraucht.
*Verworfen:* (a) „Everything you need to know who is signed in" — dieselbe Wortwahl wie der Wettbewerber, aber auf die eine Frage bezogen. (b) „Authentication that never leaves your database". (c) „The authentication library that never phones home".
*Grund:* Auf dem Feld Umfang ist gegen 618 Funktionen nicht zu gewinnen, und es wäre auch gelogen — Abschnitt 3.14 streicht Rollen, Organisationen, SCIM, SAML und Bezahlmodule ausdrücklich. Die tragfähige Position ist die Herkunft: Auth0, Clerk, Supabase und Firebase sind US-Dienste, und eine Bibliothek, die im Prozess des Betreibers läuft und keinen Dritten beteiligt, ist deren Gegenentwurf. „European" sagt das in einem Wort.
*Preis:* Die Zeile verspricht mehr, als die Bibliothek allein halten kann. Wo die Daten liegen, entscheidet der Betreiber, nicht das Paket — die Bibliothek macht Souveränität möglich, sie garantiert sie nicht. Die verworfene Variante (b) wäre in diesem Punkt genauer gewesen, weil sie eine technische Eigenschaft nennt statt einer Herkunft. Der Fließtext der README trägt die Einschränkung deshalb nach: „no third-party service is involved at any point".

**E-58 — Das Banner wird verlustfrei komprimiert und von Hand neu geblockt.**
*Kontext:* Das gelieferte Banner wog 1,2 MB, was eine npm-Seite spürbar verlangsamt.
*Verworfen:* Palettenquantisierung mit `pngquant` (36 KB statt 274 KB).
*Grund:* Die Quantisierung erzeugte sichtbare Ringe im violetten Verlauf hinter dem Logo — genau die Artefaktklasse, für die weiche Verläufe anfällig sind. Rund 240 KB Ersparnis sind ein sichtbar beschädigtes Hero-Bild nicht wert. Verlustfrei bleiben 274 KB.

Die Begründung dafür stand hier zweimal falsch, und beide Fassungen bleiben stehen, weil der Weg zur richtigen Zahl der eigentliche Inhalt dieses Eintrags ist. Zuerst notiert war, der Gewinn komme daher, dass `oxipng` den durchgehend deckenden Alphakanal entfernen kann. Der Prüflauf dagegen war keiner: `oxipng` reduziert den Farbtyp standardmäßig, also entfernte auch der vermeintliche Kontrolllauf das Alpha und lieferte erwartungsgemäß dasselbe Ergebnis — eine Kontrolle, die nichts kontrollierte. Mit `--nc`, das die Farbtypreduktion abschaltet, ergibt sich die tatsächliche Aufteilung: 1208 KB roh, 320 KB nach reiner Neukomprimierung unter Beibehaltung des Alphakanals, 274 KB nach zusätzlichem Wegfall desselben. Die Neukomprimierung mit erschöpfender Filtersuche trägt also rund 95 Prozent der Ersparnis, der Alphakanal rund 5. Die gelieferte Datei war schlicht schwach komprimiert.
*Preis:* Ein Zwischenschritt, der nicht offensichtlich ist: `oxipng` schrieb die Bilddaten als einen einzigen 280-KB-`IDAT`-Block, und daran verschluckte sich der Bildbetrachter von macOS — die Datei lud endlos, ohne Fehlermeldung. Derselbe Datenstrom, wieder in Blöcke zu 64 KB geteilt, öffnet normal. Ein gültiges PNG ist nicht dasselbe wie ein PNG, das jeder Decoder mag.

**E-59 — Der Zweck bestimmt den Schlüsseltyp, nicht der Aufrufer.**
*Kontext:* S-KEY-2 verlangt, dass ein unter einem Zweck erzeugter Wert unter einem anderen Zweck nicht lesbar ist. Naheliegend wäre gewesen, alle sechs Zweckschlüssel gleich zu importieren und die Trennung allein der HKDF-Ableitung zu überlassen.
*Verworfen:* Sechs identisch importierte Rohschlüssel, Trennung nur über den Ableitungskontext.
*Grund:* Die Ableitung trennt die Bytes, aber nicht die Verwendung — ein Programmierfehler hätte den `cookie-sig`-Schlüssel zum Verschlüsseln benutzen können, und das wäre erst im Betrieb aufgefallen. `rootKeyProvider` importiert die beiden Signierzwecke deshalb als HMAC-Schlüssel und die vier Verschlüsselungszwecke als AES-GCM-Schlüssel. Damit lehnt Web Crypto den falschen Zweck ab, bevor eine Zeile dieser Bibliothek läuft. Die Anforderung wird zur Eigenschaft der Laufzeit statt zur Sorgfaltspflicht des Lesers.
*Preis:* Der `KeyProvider` muss wissen, welcher Zweck welcher Art ist — eine Tabelle, die bei einem siebten Zweck mitgepflegt werden müsste. Da die Zwecke ein geschlossener Satz sind, ist das kein Wachstumspfad.

**E-60 — Die Verschlüsselungsschlüssel sind exportierbar, damit die Rückfallebene überhaupt existieren kann.**
*Kontext:* E-03 hält `@noble/ciphers` als Rückfall für Laufzeiten ohne vollständige Web-Crypto-Implementierung bereit. Der Rückfall rechnet auf Rohbytes, die Schnittstelle aus 3.8 liefert aber einen `CryptoKey`.
*Verworfen:* (a) Die Rohbytes zusätzlich in einer `WeakMap` neben dem `CryptoKey` halten. (b) Den Rückfall streichen und E-03 dabei belassen, dass er „vorgesehen" ist.
*Grund:* Die `WeakMap` wäre ein zweiter, unsichtbarer Aufbewahrungsort für Schlüsselmaterial gewesen, der an der Schnittstelle vorbeiführt — genau die Art Nebenweg, die später niemand mehr findet. Ein Rückfall, der nur auf dem Papier steht, ist keiner. Also holt der Rückfall die Bytes über `crypto.subtle.exportKey`, und `rootKeyProvider` importiert die vier Verschlüsselungszwecke als `extractable`. Die beiden Signierzwecke bleiben nicht exportierbar, weil sie den Rückfall nicht brauchen.
*Preis:* Wer eine eigene `KeyProvider`-Implementierung schreibt und auf einer Laufzeit ohne AES-GCM landet, muss exportierbare Schlüssel liefern; sonst kommt `key_material_not_exportable`. Und ehrlich benannt: eine Laufzeit, deren `crypto.subtle` gar keinen AES-GCM-Schlüssel importieren kann, kann auch keinen `CryptoKey` erzeugen — dort hilft nur eine eigene Implementierung der Schnittstelle. Die Rückfallebene deckt die Lücke zwischen „kann importieren" und „kann verschlüsseln", nicht mehr.

**E-61 — Die Wahl der AES-GCM-Rechenmaschine fällt durch einen Versuch, nicht durch eine Abfrage.**
*Kontext:* Es gibt keine verlässliche Möglichkeit, eine Laufzeit zu fragen, ob ihr `crypto.subtle` AES-GCM beherrscht.
*Verworfen:* Auf das Vorhandensein von `globalThis.crypto.subtle` prüfen und daraus schließen.
*Grund:* Genau dieser Schluss ist der Fehler, den die Rückfallebene abfangen soll: Die problematischen Laufzeiten haben ein `subtle`-Objekt, nur eben ein unvollständiges. Also wird einmal ein leerer Wert unter einem Wegwerfschlüssel verschlüsselt; gelingt das, bleibt es bei `crypto.subtle`, sonst übernimmt `@noble/ciphers`. Das Ergebnis wird für den Prozess gemerkt.
*Preis:* Eine zusätzliche Verschlüsselung beim ersten Aufruf. Der Test, dass beide Rechenmaschinen bytegleiche Ausgaben erzeugen und die Ausgabe der jeweils anderen lesen, ist dafür die Absicherung, die E-02 für Argon2id hat.

**E-62 — base64url wird selbst dekodiert.**
*Kontext:* Der Wurzelschlüssel kommt nach 3.15 A.8 als base64url-Zeichenkette in die Konfiguration.
*Verworfen:* `atob`.
*Grund:* Abschnitt 2.6 zählt die Annahmen der Bibliothek auf und sagt ausdrücklich „und keine weiteren". `atob` steht nicht darin. Der Dekodierer ist knapp dreißig Zeilen und macht die Liste nicht länger. Dass `atob` faktisch überall existiert, ist ein Argument dafür, es zu benutzen, und kein Argument dafür, die Annahmeliste stillschweigend zu erweitern.
*Preis:* Dreißig Zeilen, die woanders schon stehen. Und eine offene Frage: Sitzungstoken werden nach 3.5 base64url kodiert, brauchen also den Gegenweg — der Kodierer gehört dann in dasselbe Modul und nicht in ein zweites.

**E-63 — Der Zufall liegt vorerst in `core/keys/`, obwohl S-RAND-5 ihn in `core/token/` verortet.**
*Kontext:* Die Umschlagverschlüsselung braucht eine Nonce. S-RAND-5 verlangt, dass die Erzeugung von Geheimnissen in genau einem Modul gekapselt ist, und 3.1 nennt dafür `core/token/`. Dieses Verzeichnis gehört in dieser Welle einem anderen Autor.
*Verworfen:* Die Nonce an Ort und Stelle aus `crypto.getRandomValues` ziehen.
*Grund:* Das wäre der Anfang genau der Zersplitterung, die S-RAND-5 verhindert: Jedes Modul zieht sich seinen Zufall selbst, und beim vierten ist niemand mehr sicher, ob alle vier dieselbe Quelle benutzen. Ein Modul mit der richtigen Regel am falschen Ort ist billiger zu verschieben als vier verstreute Aufrufe zusammenzusuchen.
*Preis:* Eine Datei liegt am falschen Ort und muss umziehen, sobald `core/token/` existiert. Das ist ausdrücklich eine Schuld, keine Entscheidung — sie wird beim Zusammenführen fällig.

**E-64 — Der Ableitungskontext trägt den Zweck, aber nicht die Version.**
*Kontext:* HKDF bekommt Salz und `info`. Es lag nahe, die Schlüsselversion in `info` mitzuführen.
*Verworfen:* `info` aus Zweck und Version zusammensetzen.
*Grund:* Der Ring bildet Version auf einen *eigenen* Wurzelschlüssel ab, nicht auf denselben. Die Versionen sind also bereits durch unterschiedliches Schlüsselmaterial getrennt, und S-KEY-1 verlangt wörtlich „genau einen Ableitungskontext je Zweck". Die Version zusätzlich hineinzurechnen hätte nichts getrennt, was nicht schon getrennt war, und die Anforderung wörtlich verletzt.
*Preis:* Wer zwei Versionen versehentlich mit demselben Wurzelschlüssel bestückt, bekommt für beide dieselben Zweckschlüssel. Das ist ein Konfigurationsfehler, den die Bibliothek nicht erkennen kann, und er ist folgenlos, solange die Version nur zum Auffinden des Schlüssels dient.

**E-65 — Der Umschlagkopf ist die Additional Data jeder AES-GCM-Operation.**
*Kontext:* Der Kopf trug das Algorithmus-Präfix und die Schlüsselversion, aber außerhalb der Authentifizierung. Der Prüfer hielt fest, dass das heute nicht ausnutzbar ist: Wer die Version umschreibt, bekommt einen anderen Schlüssel, und der Tag schlägt fehl.
*Verworfen:* Es dabei belassen, weil der Tag den Umschreibversuch ohnehin fängt.
*Grund:* Das Argument stimmt genau so lange, wie es nur ein Algorithmus-Präfix gibt. Sobald ein zweites existiert — und das Präfix steht ausdrücklich dafür da, dass es eines geben wird —, ist die Herabstufung ein Eingabewert, den das Format nicht authentifiziert, und der Angreifer wählt ihn. Entscheidend ist aber der Zeitpunkt: Additional Data lässt sich nachträglich nicht einführen. Jeder verschlüsselte PHC-String, jedes TOTP-Geheimnis, jedes fremde OAuth-Token und jeder PKCE-Verifier in jeder Installation würde beim Wechsel unlesbar. Solange noch nichts gespeichert ist, kostet die Änderung nichts; einen Tag nach der ersten Auslieferung kostet sie eine Migration, die niemand fahren will. Das ist keine Abwägung zwischen Sicherheit und Aufwand, sondern zwischen „jetzt umsonst" und „später gar nicht".
*Preis:* Die Spaltenform trägt die Additional Data mit, obwohl ihre Version in einer eigenen Spalte steht — sie wird aus der Version rekonstruiert. Dafür ist `key_version` dort jetzt ebenfalls authentifiziert, was vorher nicht galt.

**E-66 — Nur vier der sechs Zwecke kommen überhaupt an die Verschlüsselung heran.**
*Kontext:* `sealEnvelope(keys, "cookie-sig", …)` ließ sich übersetzen und scheiterte erst zur Laufzeit — mit einer `DOMException: InvalidAccessError` aus Web Crypto, die keinen Code trägt. Die Regeln dieses Repositories verlangen an jedem Fehler einen stabilen maschinenlesbaren Code.
*Verworfen:* Den Web-Crypto-Fehler abfangen und in einen `KeyError` umhüllen.
*Grund:* Das Umhüllen hätte den Code nachgeliefert und den Fehler stehen lassen. Die beiden Teilmengen stehen ohnehin schon im Typ — `EncryptionKeyPurpose` und `SigningKeyPurpose` werden aus demselben Tupel abgeleitet, aus dem `KeyPurpose` kommt, es wird also nichts doppelt aufgezählt. Damit übersetzt der Missbrauch nicht mehr. Der Laufzeitwächter bleibt trotzdem, weil die Bibliothek auch aus JavaScript ohne Typen aufgerufen wird; dort liefert er `purpose_cannot_encrypt` statt der uncodierten Ausnahme.
*Preis:* Vier Testdateien mussten den Missbrauch, den sie absichtlich erzeugen, über eine einzige Hilfsfunktion führen, die den Typ aushebelt. Das ist der richtige Ort dafür: Genau eine Stelle im Prüfbestand darf das, und sie ist benannt.

**E-67 — base64url wird nur in seiner kanonischen Schreibweise gelesen.**
*Kontext:* Ein 32-Byte-Schlüssel endet auf einem Zeichen, dessen letzte zwei Bit zu keinem Byte gehören. Der Dekodierer warf sie weg.
*Verworfen:* Die überzähligen Bits weiter ignorieren, wie `atob` und die meisten Dekodierer es tun.
*Grund:* Vier verschiedene Zeichenketten ergaben denselben Wurzelschlüssel. Wer sich beim letzten Zeichen vertippt, bekommt mit drei von vier Fehlern stillschweigend den richtigen Schlüssel — und merkt beim vierten nicht, dass die Ursache dieselbe war. Bei einem Wert, dessen Verlust alle Kennwörter kostet, ist „fast richtig wird angenommen" die falsche Voreinstellung.
*Preis:* Wer seinen Wurzelschlüssel mit einem nachlässigen Kodierer erzeugt hat, muss ihn neu kodieren. Base64url-Kodierer erzeugen die kanonische Form; die Nachlässigkeit sitzt praktisch immer auf der Leseseite.

**E-68 — Eine Fehlerklasse mit Code, nicht eine Klasse je Fehler.**
*Kontext:* Der Prüfplan nennt den Fehler bei einer nicht mehr vorhandenen Schlüsselversion `KeyVersionUnavailable`. Umgesetzt ist er als `KeyError` mit `code: "key_version_unknown"`.
*Verworfen:* Eine eigene Ausnahmeklasse je Fehlerfall, wie der Prüfplan sie benennt.
*Grund:* Die Regeln dieses Repositories verlangen an jedem Fehler einen stabilen maschinenlesbaren Code und legen die Entscheidung, was ein Aufrufer erfährt, an genau eine Stelle. Ein Baum von Klassen bringt beides durcheinander: Der Name wird zur Schnittstelle, und jede neue Fehlerursache erweitert die öffentliche Oberfläche. Mit einem Code bleibt die Oberfläche eine Klasse und eine Aufzählung von Zeichenketten, und `instanceof` trennt weiterhin die Absage dieses Moduls von einem Fehler der Laufzeit darunter. Der Name aus dem Prüfplan ist damit erfüllt, nur eben als Code statt als Klasse.
*Preis:* Wer nach `KeyVersionUnavailable` sucht, findet nichts. Deshalb steht der Unterschied hier und nicht nur im Kopf des Autors.

**E-69 — `equalsInConstantTime` und `KEY_PURPOSES` bleiben, obwohl `src/` sie nicht aufruft.**
*Kontext:* Beide werden derzeit nur von Tests benutzt; `knip` bleibt still, weil die Testdateien seine Einstiegspunkte sind.
*Verworfen:* Beide entfernen und wiederherstellen, wenn der erste Aufrufer kommt.
*Grund:* Sie sind nicht übrig geblieben, sondern vorausgesetzt. Abschnitt 2.7 führt den zeitkonstanten Vergleich als eigenes Primitiv der Bibliothek auf; die Aufrufer sind Sitzungstoken, Einmal-Token und Wiederherstellungscodes, also Welle 2 — und die Alternative ist nicht „später hinzufügen", sondern „jedes Modul schreibt seine eigene Schleife", genau der Zustand, den E-63 beim Zufall verhindert. `KEY_PURPOSES` ist zusätzlich tragend, ohne aufgerufen zu werden: `KeyPurpose`, `EncryptionKeyPurpose` und `SigningKeyPurpose` werden daraus abgeleitet, und der statische Prüftest liest es als die verbindliche Aufzählung aus 3.8. Ein Wert, aus dem drei Typen entstehen, ist kein toter Code.
*Preis:* Zwei Ausfuhren, die bis Welle 2 nur der Prüfbestand benutzt. Wenn dort kein Aufrufer entsteht, gehören sie entfernt — das ist eine Prüfung für das Ende von Welle 2, nicht für heute.

**E-70 — Eine Stelle beantwortet, ob ein Zweck verschlüsselt.**
*Kontext:* Nach E-66 gab es die Antwort dreimal: `purpose.ts` leitete sie aus dem Namen ab, der Umschlagwächter prüfte den Namen erneut, und der Schlüsselring zählte die vier Namen ein drittes Mal in einer Menge auf. Alle drei stimmten überein, und keine der drei wusste von den anderen.
*Verworfen:* Es dabei belassen, weil der Zwecksatz geschlossen ist und die drei Fassungen also nie auseinanderlaufen können.
*Grund:* Der Satz ist geschlossen, bis jemand ihn öffnet, und genau dann fällt die Falle zu: Ein siebter Zweck `session-enc` im Tupel wird vom Typ angenommen, vom Umschlagwächter durchgewinkt und vom Schlüsselring in den `else`-Zweig geschoben, wo er einen HMAC-Schlüssel bekommt. Das Ergebnis ist die uncodierte `DOMException`, die E-66 gerade beseitigt hat — im einzigen Modul, in dem ein falscher Schlüsseltyp am teuersten ist. Der Fehler wäre laut und schnell aufgefallen; das ändert nichts daran, dass er vermeidbar war, solange die Antwort noch an einer Stelle steht. `isEncryptionPurpose` steht jetzt neben dem Typ, auf den es verengt, und Ring wie Umschlag fragen es.
*Preis:* Die Aufteilung hängt am Namen: Ein Verschlüsselungszweck muss auf `-enc` enden. Das ist eine Konvention und keine Zusicherung, deshalb prüft der statische Test sie ausdrücklich mit — dass die sechs Namen sich zwei zu vier teilen, dass die Funktion einmal existiert, dass beide Aufrufer sie benutzen und dass der Schlüsselring keinen Zwecknamen mehr selbst schreibt.

**E-71 — Auch der fehlgeschlagene Authentifizierungs-Tag bekommt einen Code.**
*Kontext:* E-68 begründet, dass der Code die Schnittstelle ist. Ausgerechnet der sicherheitsrelevanteste Fehler des Moduls hatte keinen: Ein falscher Zweck, ein falscher Schlüssel, ein gekipptes Bit oder ein umgeschriebener Kopf verließen das Modul als `DOMException` oder als schlichter `Error`. Wer das naheliegende `if (error instanceof KeyError) … else throw` schreibt, wirft die uncodierte Ausnahme genau bei der Eingabe weiter, auf die es ankommt.
*Verworfen:* Die Zusage in der Dokumentation auf „jeder Fehler, den dieses Modul selbst auslöst" einzuschränken.
*Grund:* Die Einschränkung wäre wahr gewesen und hätte das Problem beim Aufrufer gelassen. „Entschlüsselung fehlgeschlagen" ist die eine Bedingung, die jeder Aufrufer behandeln muss; sie darf nicht davon abhängen, auf welcher Laufzeit die Chiffre gelaufen ist — auf der Rückfallebene wäre es ohnehin ein anderer Ausnahmetyp gewesen als auf `crypto.subtle`. Ein `KeyError` der Rechenmaschine behält seinen eigenen Code, damit `key_material_not_exportable` aus E-60 nicht verschluckt wird.
*Preis:* Ein echter Ausfall der Laufzeit beim Entschlüsseln — ein `crypto.subtle`, das mitten im Betrieb aufhört zu funktionieren — wird jetzt als `authentication_failed` gemeldet und sieht damit aus wie ein Angriff. Das Verschlüsseln bleibt deshalb unverpackt: Dort gibt es nach E-66 keinen gegnerisch auslösbaren Fehler mehr, also darf ein Laufzeitfehler dort als er selbst nach oben.

**E-80 — Das ausgelieferte SQL steht zweimal im Repository, und ein Test hält beide Fassungen gleich.**
*Kontext:* Abschnitt 7 der Regeln verbietet `node:fs` auf dem Pflichtpfad, E-08 verlangt, dass der Betreiber das SQL lesen und mit eigenem Werkzeug anwenden kann. Die Datei auf der Platte kann also nicht die Quelle sein, aus der der Läufer liest.
*Verworfen:* (a) Nur `.sql`-Dateien und zur Laufzeit lesen. (b) Nur eine TypeScript-Konstante, kein lesbares SQL. (c) Die Konstante beim Bauen aus der Datei erzeugen.
*Grund:* (a) bricht die Zusage, dass die Bibliothek ohne Dateisystem läuft, und damit die serverlose Ausführung. (b) nimmt dem Betreiber die Prüfbarkeit, die E-08 ausdrücklich als Vorteil gegenüber der Laufzeitableitung nennt. (c) wäre die richtige Lösung; sie hätte `tsdown.config.ts` gebraucht, eine Datei, die diesem Feature nicht gehört. Der ehrliche Grund für die Doppelung ist damit nicht technisch, sondern organisatorisch.
*Preis:* Zwei Fassungen desselben Textes, die auseinanderlaufen können. Gegenmaßnahme ist ein Test, der sie byteweise vergleicht; er ist billig, aber er ersetzt eine Erzeugung durch eine Verabredung. Sobald ein Feature `tsdown.config.ts` besitzt, sollte (c) das hier ablösen.

**E-81 — Die Identitätsbedingung ist Migration 2 in drei Fassungen, nicht Teil von Migration 1.**
*Kontext:* Abschnitt 3.2 verlangt, dass die Migration genau eine von drei `CHECK`-Bedingungen auf `velve.user` anlegt; 3.17 verlangt, dass Migration 1 alle Tabellen unmittelbar in der Endform anlegt. Die Bedingung hängt von der Konfiguration ab, die Tabellen nicht.
*Verworfen:* Migration 1 aus dem Modus erzeugen und je Modus eine eigene Prüfsumme führen.
*Grund:* Dann wäre die ausgelieferte Datei `0001_initial_schema.sql` nicht mehr die Anweisung, die tatsächlich läuft — genau die Trennung, die E-80 gerade vermeidet. Eine Migration, deren Text von der Konfiguration abhängt, ist außerdem eine Migration, deren Prüfsummenwächter beim Lesen der Konfiguration Alarm schlägt statt beim Ändern des Schemas.
*Preis:* Ein Moduswechsel nach der Migration meldet sich als geänderte Prüfsumme von Version 2. Die Meldung nennt die Prüfsumme, nicht den Modus — sie ist richtig, aber sie erklärt dem Betreiber nicht, was er getan hat.

**E-82 — Die Migrationssperre ist transaktionsgebunden, nicht sitzungsgebunden.**
*Kontext:* E-08 verlangt eine eigene Transaktion je Schritt. Die Treiberschnittstelle aus 3.2 sagt nichts darüber, ob zwei aufeinanderfolgende `query()`-Aufrufe dieselbe Verbindung sehen; bei einem Pool sehen sie es nicht.
*Verworfen:* `pg_advisory_lock` einmal über den gesamten Lauf, freigegeben am Ende.
*Grund:* Eine Sitzungssperre über `query()` ist bei jedem Pool-Treiber unbestimmt, und eine Sperre, die auf einer anderen Verbindung freigegeben wird als sie genommen wurde, wird nie freigegeben. `pg_advisory_xact_lock` innerhalb der ohnehin nötigen Transaktion braucht keine Zusage, die die Schnittstelle nicht macht, und ein Absturz gibt sie mit der Transaktion frei.
*Preis:* Die Sperre wird je Migration neu genommen. Zwei gleichzeitig gestartete Prozesse können sich beim Anwenden abwechseln — jede Migration läuft genau einmal, aber nicht notwendig alle im selben Prozess. Der Bericht eines Laufs nennt deshalb nur, was *dieser* Lauf angewandt hat, und liest den Endstand danach neu aus dem Verzeichnis.

**E-83 — Die Cascade-Pflicht wird am Katalog geprüft, nicht am Text der Migration.**
*Kontext:* S-TOKEN-6 verlangt, dass der Läufer eine Migration abweist, die eine Tabelle mit Verweis auf `velve.user` ohne `ON DELETE CASCADE` anlegt.
*Verworfen:* Ein Muster über den SQL-Text der Migration.
*Grund:* Ein Textmuster prüft, was dasteht, nicht was entsteht. Ein `CREATE TABLE` ohne Fremdschlüssel plus ein späteres `ALTER TABLE … ADD CONSTRAINT` in derselben Migration wäre durchgelaufen, und ein Plugin, das seine Tabelle in einer Funktion erzeugt, ohnehin. Die Abfrage auf `pg_constraint` sieht das Ergebnis; sie läuft in derselben Transaktion, also nimmt der Rückzug die Tabelle mit.
*Preis:* Zwei Katalogabfragen nach jeder einzelnen Migration, auch nach denen, die keine Tabelle anlegen. Das ist messbar, aber nur beim Migrieren.

**E-84 — Der Schemaname wird als Bezeichner geprüft, und im ausgelieferten SQL wird `velve` textuell ersetzt.**
*Kontext:* `schema` ist konfigurierbar (Vorgabe `velve`), das ausgelieferte SQL nennt aber einen festen Namen.
*Verworfen:* (a) Ein Platzhalter `{{schema}}` in den `.sql`-Dateien. (b) Bezeichner in Anführungszeichen setzen statt sie zu prüfen.
*Grund:* (a) macht die ausgelieferte Datei für `psql` unbrauchbar und nimmt ihr genau den Zweck, den E-08 ihr gibt. (b) würde Namen erlauben, die Groß- und Kleinschreibung unterscheiden oder Sonderzeichen tragen; die Bibliothek hat für keinen davon eine Verwendung, und jeder von ihnen ist eine Stelle, an der später jemand das Zitieren vergisst. Geprüft wird gegen `^[a-z_][a-z0-9_$]*$` und 63 Byte; alles andere ist ein Startfehler.
*Preis:* Eine textuelle Ersetzung über SQL — die Art von Umgang mit SQL, die dieses Projekt sonst meidet. **Der hier ursprünglich behauptete Preis war falsch:** Die erste Fassung ersetzte jedes Vorkommen des Wortes `velve`, nicht den Bezeichner, also auch in Zeichenkettenliteralen und in Spaltennamen. In einem Schema mit anderem Namen hätte eine Plugin-Migration mit dem Literal `'velve'` einen anderen Wert eingefügt als geschrieben, und eine Spalte namens `velve` wäre umbenannt worden. Der unabhängige Review hat das gefunden und mit zwei fehlschlagenden Tests festgehalten; die Behebung steht in E-90.

**E-85 — `pg` wird auch im Testbaum nicht installiert; der Treiber ist gegen einen Strukturtyp geschrieben.**
*Kontext:* `@velve/auth/pg` darf `pg` nicht zur Laufzeitabhängigkeit des Kerns machen — der Aufrufer bringt den Pool mit. Für einen Test gegen den echten Treiber bräuchte es `pg` als devDependency und damit eine Änderung an `package.json`, einer Datei, die diesem Feature nicht gehört (E-50).
*Verworfen:* `pg` als devDependency aufnehmen.
*Grund:* Die Konfliktregel des Bauauftrags erlaubt keinem Feature, eine fremde Datei zu ändern; der Weg wäre gewesen, es zu melden und zu warten. Der ehrliche Zusatz: hätte ich `package.json` ändern dürfen, hätte ich `pg` genommen und mir die Handarbeit aus E-86 gespart.
*Preis:* Der Treiber wird gegen eine Attrappe geprüft, die den Strukturtyp erfüllt, nicht gegen `node-postgres`. Dass ein echter `Pool` den Typ erfüllt, ist damit **unbewiesen** — die Überladungen der `pg`-Typdeklarationen sind der wahrscheinlichste Ort, an dem es klemmt. Das muss ein Lauf mit installiertem `pg` zeigen, bevor das Paket veröffentlicht wird.

**E-86 — Die Testsuite bringt einen eigenen Postgres-Client mit.**
*Kontext:* Schema, Trigger und Migrationsläufer lassen sich nur gegen einen echten Server zeigen, und nach E-85 gibt es keinen Client im Baum.
*Verworfen:* (a) `psql` als langlebiger Unterprozess je Verbindung. (b) Auf Integrationstests verzichten und alles gegen eine Attrappe prüfen.
*Grund:* (a) hätte Parameterbindung über `\bind` gebraucht, das erst ab `psql` 16 existiert, und hätte die Suite von einem Programm abhängig gemacht, das im CI-Abbild vorhanden sein muss, aber nicht zugesagt ist; die Alternative wäre gewesen, Parameter selbst in den Text zu setzen. (b) hätte genau die Aussagen nicht geprüft, die dieses Feature schuldet — dass der Trigger greift, dass `ON DELETE CASCADE` alle dreizehn Tabellen leert, dass zwei Läufer sich nicht ins Gehege kommen. Der Client spricht das Frontend-Protokoll direkt: Start, Trust, Klartext und SCRAM-SHA-256, einfache und erweiterte Abfrage, und darüber die `Driver`-Schnittstelle, damit die Tests dasselbe treiben wie die Anwendung.
*Preis:* Rund vierhundert Zeilen Testinfrastruktur, die niemand ausliefert und die trotzdem gepflegt werden muss. SCRAM ist gegen den Vektor aus RFC 7677 geprüft, aber gegen keinen Server, der es verlangt — lokal steht `pg_hba` auf `trust`. Der erste echte Beweis läuft in CI.

**E-87 — Der Trigger schlägt bei jedem `UPDATE` zu, das `user_id` nennt, auch bei einer Zuweisung ohne Änderung.**
*Kontext:* E-23 verlangt, dass `UPDATE session SET user_id` nicht existiert und durch einen Trigger verhindert wird.
*Verworfen:* `WHEN (OLD.user_id IS DISTINCT FROM NEW.user_id)`, also nur bei tatsächlicher Änderung auslösen.
*Grund:* Die `WHEN`-Fassung lässt `SET user_id = user_id` durch. Das ändert nichts, aber es ist die Formulierung, die beim nächsten Refactoring zu `SET user_id = $1` wird, und dann greift der Trigger erst, wenn der Fehler schon geschrieben ist. Der Trigger soll die *Formulierung* verbieten, nicht nur ihre Wirkung.
*Preis:* Ein `UPDATE`, das `user_id` mitschreibt, ohne es zu ändern, schlägt fehl, obwohl es harmlos wäre. Diese Anweisung schreibt niemand absichtlich; wer sie schreibt, hat den Eigentümer im Sinn.

**E-88 — Eine verschachtelte `transaction()` tritt der offenen bei, statt einen Sicherungspunkt zu setzen.**
*Kontext:* Der `pg`-Treiber gibt dem Rumpf einen Treiber, der an dieselbe Verbindung gebunden ist. Ruft der Rumpf darauf wieder `transaction()` auf, muss etwas passieren.
*Verworfen:* `SAVEPOINT` je verschachtelter Transaktion, mit `ROLLBACK TO` im Fehlerfall.
*Grund:* Die Bibliothek braucht keine Teilrücknahme. Jede Stelle, die eine Transaktion verlangt (3.5 Neuvergabe, 3.7 Konsum, der Migrationsläufer), will Alles-oder-nichts. Sicherungspunkte hätten eine Semantik eingeführt, auf die sich später jemand verlässt, ohne dass sie irgendwo gefordert ist.
*Preis:* Ein Fehler im inneren Rumpf lässt sich nicht abfangen und weiterarbeiten — PostgreSQL bricht die Transaktion nach einer fehlgeschlagenen Anweisung ohnehin ab, aber die Schnittstelle sieht so aus, als könnte man es. Wer das braucht, schreibt den Sicherungspunkt von Hand.

**E-89 — Der API-Schnappschuss wurde von diesem Feature aktualisiert, obwohl die Datei nicht in seiner Liste steht.**
*Kontext:* `@velve/auth/pg` bekommt eine öffentliche Oberfläche, und `test/__snapshots__/api-surface.md` (E-52) vergleicht genau die. Ohne Aktualisierung ist `pnpm test` rot; die Datei gehört aber keinem der Features dieser Welle ausdrücklich.
*Verworfen:* Die Änderung melden und den roten Test stehen lassen.
*Grund:* Der Schnappschuss ist kein Quelltext, sondern die Bekanntgabe einer Oberflächenänderung — ihn nicht zu aktualisieren hieße, die Änderung nicht anzukündigen. Der Zweck aus E-52 ist erfüllt, wenn die Aktualisierung bewusst und im selben Zweig geschieht.
*Preis:* Zwei Features derselben Welle, die beide eine Oberfläche beitragen, ändern dieselbe Datei und stoßen beim Zusammenführen zusammen. Der Konflikt ist auflösbar, weil die Datei erzeugt ist — aber er wird auftreten, und die Regel „kein Feature ändert eine fremde Datei" ist hier gebrochen worden, nicht umgangen.

**E-90 — Aus dem Wortersetzer wurde ein Abtaster.**
*Kontext:* E-84 ersetzte `\bvelve\b` im Text der Migration. Der Review zeigte an zwei Fällen, dass das falsch ist: `INSERT … VALUES ('velve')` schrieb in einem umbenannten Schema einen anderen Wert, und `CREATE TABLE velve.t (velve text)` benannte die Spalte um.
*Verworfen:* (a) Die Ersetzung auf `velve.` verengen, also nur mit folgendem Punkt. (b) Einen echten SQL-Parser einbinden.
*Grund:* (a) hätte die beiden gemeldeten Fälle erschlagen, aber nicht `'velve.user'` in einem Literal und nicht `CREATE SCHEMA IF NOT EXISTS velve`, das gar keinen Punkt hat. (b) wäre eine siebte Abhängigkeit für eine Aufgabe, die kein Verständnis der Grammatik braucht, sondern nur das Wissen, wo Text *kein* Bezeichner ist. Der Abtaster überspringt Zeilen- und Blockkommentare, Zeichenketten, zitierte Bezeichner und Dollar-Quoting und ersetzt in genau zwei Stellungen: vor einem Punkt und als Name hinter `CREATE`/`DROP`/`ALTER SCHEMA`.
*Preis:* Etwa neunzig Zeilen Abtaster, die SQL-Lexik nachbilden, ohne SQL zu verstehen. Kommentare bleiben unverändert — in einem umbenannten Schema erwähnt der Kommentar weiter `velve.user`. Das ist eine bewusste Wahl: Kommentare sind Prosa, und eine Umbenennung, die Prosa mitschreibt, behauptet mehr Wissen, als der Abtaster hat.

**E-91 — Die Statusabfrage schreibt nichts, auch nicht die Tabelle, aus der sie liest.**
*Kontext:* F35 und F37 verlangen neben dem Läufer eine Statusabfrage, damit eine Versionsabweichung ein Startfehler wird. Der Rückgabewert von `runMigrations` ist das nicht: wer ihn hat, hat schon migriert.
*Verworfen:* Die Statusabfrage das Verzeichnis anlegen lassen, wie der Läufer es tut.
*Grund:* Eine Abfrage, die beim Start läuft und dabei ein Schema anlegt, migriert nebenbei. Auf einer Datenbank ohne Rechte zum Anlegen wäre sie außerdem ein Fehler statt einer Antwort. `to_regclass` beantwortet „gibt es das Verzeichnis" ohne Ausnahme und ohne Schreibzugriff; fehlt es, ist die Antwort Version 0.
*Preis:* Zwei Wege, die dasselbe Verzeichnis lesen — der Läufer über seine eigene Abfrage, der Status über `to_regclass`. Sie könnten auseinanderlaufen; sie tun es nur, wenn jemand den Tabellennamen an einer Stelle ändert.

**E-92 — Reservierte Schlüsselwörter sind als Schemaname verboten, als Tabellenname erlaubt.**
*Kontext:* Der Review fand, dass `assertIdentifier("user")` durchging und der Fehler dann als Syntaxfehler von PostgreSQL kam statt als `invalid_identifier`.
*Verworfen:* Reservierte Wörter überall verbieten.
*Grund:* Genau das ginge nicht: Die Kerntabelle **heißt** `user`, und sie darf so heißen, weil `velve.user` hinter dem Punkt gültig ist (E-07). Verboten werden muss das Wort nur dort, wo es unqualifiziert in ein Statement gerät — und das ist ausschließlich der Schemaname, in `CREATE SCHEMA` und als linke Seite jeder Qualifizierung. Also gibt es zwei Prüfungen: `assertIdentifier` prüft die Gestalt, `assertSchemaName` zusätzlich die Wortliste.
*Preis:* Eine Liste von rund hundert Schlüsselwörtern aus Anhang C der PostgreSQL-Dokumentation, fest im Quelltext. Sie wächst mit PostgreSQL-Versionen, und niemand wird daran denken. Der Schaden bei einem fehlenden Wort ist ein Syntaxfehler statt einer klaren Meldung — also derselbe Zustand wie vorher, nicht schlimmer.

**E-93 — `ResolvedSession` wird hier definiert, aber noch nicht verlangt.**
*Kontext:* Der Review hielt fest, dass `actorOfResolvedSession({ userId })` strukturell typisiert ist. Die Marke auf `Actor` verhindert, dass eine nackte Zeichenkette als Aktor durchgeht, und der Konstruktor gibt dieselbe Lücke eine Zeile später zurück: `actorOfResolvedSession({ userId: req.body.userId })` übersetzt.
*Verworfen:* Den Parameter sofort auf den nominalen Typ ziehen.
*Grund:* Zwei Gründe, und der zweite ist der ehrlichere. Erstens kann dieses Feature keinen legitimen Erzeuger für `ResolvedSession` liefern — die Sitzungsauflösung gehört Welle 2, und ein `as ResolvedSession` hier hätte die Lücke nur eine Datei weiter geschoben. Zweitens hält ein Test des Reviews (`test/db-actor-provenance.test.ts`, „mints one from any object carrying a userId") genau die heutige Gestalt fest; ihn umzudrehen hieße, eine fremde Prüfdatei zu ändern, und die Regel dieses Bauauftrags verbietet das.
*Was Welle 2 zu tun hat, wörtlich:* In `src/core/db/actor.ts` wird `actorOfResolvedSession(session: { readonly userId: string })` zu `actorOfResolvedSession(session: ResolvedSession)`. Danach muss `actorOfResolvedSession({ userId: "…" })` ein Übersetzungsfehler sein; der genannte Test hält dann die falsche Aussage fest und wird zu `@ts-expect-error` umgedreht. Der einzige Erzeuger von `ResolvedSession` ist die Sitzungsauflösung, und ihre Rückgabe ist die einzige Stelle im Paket, an der die Marke gesetzt werden darf.
*Preis:* Bis dahin ist S-OWNER-7 typseitig nur halb durchgesetzt: der Aktor kann nicht aus einer Zeichenkette entstehen, wohl aber aus einem selbstgebauten Objekt. Bis Welle 2 gibt es keinen Aufrufer außerhalb der Tests, also ist das Fenster leer — aber es ist offen, und das steht hier, damit es nicht vergessen wird.

**E-94 — S-FIX-2 wird derzeit von einem Test getragen, nicht von einer Lint-Regel.**
*Kontext:* S-FIX-2 verlangt wörtlich „eine Lint-Regel weist einen solchen Aufruf im Quelltext zurück **und** ein Datenbank-Trigger weist ein `UPDATE` zur Laufzeit ab". Der Trigger steht (E-23, E-87). Die statische Hälfte leistet `test/db-static-sql.test.ts`, das alle SQL-Literale des Quelltextes abtastet. `biome.json` gehört diesem Feature nicht.
*Verworfen:* Die Testfassung als gleichwertig zu erklären und die Anforderung als erfüllt abzuhaken.
*Grund:* Sie ist nicht gleichwertig, und zwar in beide Richtungen. Der Test kann etwas, das eine Lint-Regel nicht kann: er prüft zuerst, dass er überhaupt Literale findet (`length > 5`), und schlägt damit fehl, wenn die Suche ins Leere greift — eine Lint-Regel, die nichts findet, ist von einer abgeschalteten nicht zu unterscheiden. Die Lint-Regel kann etwas, das der Test nicht kann: sie meldet sich im Editor beim Schreiben, nicht erst im Testlauf, und genau dort entsteht der Fehler. Beides ist zu haben, und die Anforderung nennt ausdrücklich die Regel.
*Was gebraucht wird:* ein Biome-Plugin (GritQL) auf Zeichenketten- und Template-Literalen mit dem Muster `UPDATE` … `session` … `SET` … `user_id`, als `error` eingehängt in `biome.json`. Falls die Plugin-Fähigkeit dafür nicht reicht, tut es ein eigenes Skript im Tor, das dieselbe Suche über den Baum fährt — die Regel muss vor dem Testlauf greifen, nicht notwendig in Biome.
*Preis:* Bis das eingehängt ist, wird die statische Hälfte von S-FIX-2 von einem Test gehalten, der im selben Lauf grün wird wie alles andere. Das ist mehr als nichts und weniger als gefordert.

**E-95 — `src/index.ts` wurde von diesem Feature geändert, obwohl es ihm nicht gehört.**
*Kontext:* Die Eigentumsregel wurde nach dem Review erweitert: `src/schema/index.ts` gehört jetzt diesem Feature. `src/index.ts` ausdrücklich nicht. Die Prüfdatei `test/db-package-reach.test.ts` verlangt aber `actorOfResolvedSession` und `createOwnedRowRepository` aus dem Wurzelpfad `@velve/auth`, nicht aus `@velve/auth/schema`.
*Verworfen:* (a) Die beiden über `@velve/auth/schema` ausliefern und die Prüfung als falsch melden. (b) Die Prüfung stehen lassen und rot melden.
*Grund:* (a) wäre falsch am Ziel vorbei: Der Aktor und die Repository-Fabrik sind Kernbegriffe, keine Migrationswerkzeuge; Abschnitt 3.1 gibt dem Wurzelpfad „alle Kernoperationen". (b) hätte das Tor blockiert, ohne dass jemand etwas gelernt hätte. Geändert wurden zwei Zeilen, beide additiv, `VELVE_AUTH_VERSION` bleibt unberührt.
*Preis:* Das Feature, dem `src/index.ts` gehört, findet dort zwei Zeilen vor, die es nicht geschrieben hat, und muss sie beim Aufbau der eigentlichen Oberfläche einsortieren. Das ist die zweite Abweichung dieser Art nach E-89; beide entstehen an derselben Stelle — dort, wo eine Datei allen gehört, weil sie die Oberfläche ist.

**E-96 — Der Cascade-Wächter ist eine Torprüfung, keine Überwachung.**
*Kontext:* Der Review hielt fest, dass die Prüfung aus E-83 nur läuft, wenn tatsächlich eine Migration angewandt wird. Ein Fremdschlüssel, den jemand später von Hand ohne `ON DELETE CASCADE` neu setzt, fällt bis zur nächsten Migration niemandem auf.
*Verworfen:* Die Prüfung bei jedem Lauf ausführen, auch wenn nichts anzuwenden ist, oder sie in die Statusabfrage hängen.
*Grund:* Beides verschiebt die Grenze, statt sie zu ziehen. Eine Prüfung bei jedem Start, die eine bestehende Datenbank ablehnt, weil ein Betreiber vor Monaten etwas geändert hat, ist ein Startfehler ohne Handlungsweg — und die Statusabfrage soll nach E-91 nichts tun außer antworten. S-TOKEN-6 verlangt, dass der Läufer eine *Migration* abweist; genau das tut er. Wer eine Bedingung hinter dem Rücken des Läufers fallen lässt, hat das Schema geändert, ohne es zu migrieren, und dagegen schützt kein Wächter, sondern nur der Entzug des Rechts dazu.
*Preis:* Die Zusage ist schmaler, als sie beim Lesen von S-TOKEN-6 klingt: geprüft wird, was Migrationen anlegen, nicht, was in der Datenbank steht. Das steht jetzt in der Dokumentation, damit niemand die Prüfung für eine Überwachung hält. Dasselbe gilt für ihren Umfang — sie liest nur das konfigurierte Schema, also sieht sie eine Tabelle in einem anderen Schema nicht, die auf `velve.user` verweist.

**E-97 — Eine Migration mit Schemanamen im Dollar-Quoting wird abgewiesen, nicht umgeschrieben.**
*Kontext:* E-90 lässt den Abtaster Dollar-Quoting überspringen und begründet das damit, dass ein Funktionsrumpf beliebiger Code ist. Was dort nicht gewogen wurde, hat das Freigabetor live nachgewiesen: Eine Plugin-Migration mit `$$ … velve.user … $$` wird in einem umbenannten Schema **angewandt**, der Läufer meldet Erfolg, und erst der erste Aufruf der Funktion scheitert mit `relation "velve.user" does not exist`. Die Kernmigration entgeht dem nur, weil ihr eigener Trigger-Rumpf zufällig keine Tabelle nennt.
*Verworfen:* (a) Doch im Rumpf ersetzen. (b) Jede Migration mit Dollar-Quoting ablehnen. (c) Es als Einschränkung dokumentieren und weiter anwenden.
*Grund:* (a) ist genau der Fehler, den E-90 gerade behoben hat, eine Ebene tiefer — der Rumpf kann PL/pgSQL sein, aber auch Python oder JavaScript, und ein Wortersetzer darin ist unbelegbar. (b) trifft auch Rümpfe, die gar kein Schema nennen, und damit die eigene Migration 1. (c) lässt die stille Fehlfunktion stehen, und still ist die einzige Eigenschaft, die hier nicht verhandelbar ist. Also wird genau der Fall abgewiesen, der bricht: ein Rumpf, in dem der Abtaster einen Qualifizierer fände. Die Prüfung läuft vor der Transaktion.
*Preis:* Ein Plugin, das eine Funktion mit fest qualifizierten Namen ausliefern will, kann das nur für den Standard-Schemanamen. Das ist eine echte Einschränkung, und sie steht jetzt in der Dokumentation statt in einem Fehlerbild Wochen später.

*Korrektur an der ersten Fassung dieses Eintrags. Gemessen am gebauten Paket, nicht überlegt.*

Die erste Fassung nannte einen Rumpf, der `velve.` in einer Zeichenkette führt, als **Falsch-Positiv**. Es ist das Gegenteil: Genau dieser Fall ist das **Falsch-Negativ** und kommt durch, weil der Regionen-Abtaster auch innerhalb des Rumpfes Zeichenketten überspringt.

```
EXECUTE 'SELECT count(*) FROM velve.user' INTO n;   -- wird angewandt, bricht beim ersten Aufruf
```

Das ist dieselbe stille Fehlfunktion, gegen die dieser Eintrag geschrieben wurde, eine Anführungsebene tiefer. Falsch-**positiv** ist stattdessen Attributzugriff, den der Abtaster nicht als solchen lesen kann: ein plpython-Rumpf mit einem Objekt namens `velve` wird abgewiesen, obwohl er kein Schema meint. Die Asymmetrie bleibt trotzdem, wie sie ist — eine Ablehnung ist laut und hat einen dokumentierten Ausweg, eine angenommene kaputte Funktion ist still.

Dieselbe Messung hat den zweiten der beiden Auswege widerlegt, die hier ursprünglich standen: `SET search_path = velve` an der Funktion wird **ebenfalls nicht** umgeschrieben, weil `velve` dort weder vor einem Punkt noch hinter `CREATE SCHEMA` steht. Der Rat, den Rumpf unqualifiziert zu lassen und den Suchpfad zu setzen, war also falsch und ist gestrichen. Übrig bleibt genau ein Weg, und er ist deshalb **verpflichtend**, nicht empfohlen: Wer aus einem Funktionsrumpf auf die Tabellen der Bibliothek zugreift, baut den Namen zur Laufzeit aus einem Schemawert, der dort vorliegt — in einer Triggerfunktion `TG_TABLE_SCHEMA`, sonst ein Argument des Aufrufers — und setzt ihn mit `format('%I.user', …)` zusammen. Wer das nicht kann, liefert die Migration nur für den Standard-Schemanamen aus.

**E-98 — Der Läufer zerlegt die Migration in Anweisungen, statt den Vertrag der Treiberschnittstelle zu dehnen.**
*Kontext:* `Driver.query` ist als „eine Anweisung" dokumentiert, und der Läufer übergab den ganzen Migrationsrumpf. Das Freigabetor hat den Grund gefunden, warum das überhaupt lief: `pg`s `requiresPreparation()` endet mit `return this.values.length > 0`, ein leeres Parameterfeld fällt also in den einfachen Abfrageweg. Mit `values: [1]` scheitert dieselbe Anweisung. Zusätzlich liefert `pg` in diesem Fall ein *Feld* von Ergebnissen, dessen `rows` es nicht gibt — der Treiber gab `undefined` zurück und versprach `T[]`.
*Verworfen:* (a) Den Mehr-Anweisungs-Fall in den Vertrag aufnehmen. (b) Eine zweite Methode `execute` an `Driver` hängen.
*Grund:* (a) hätte jeden künftigen Treiberautor verpflichtet, den einfachen Abfrageweg zu unterstützen — bei einem Treiber auf dem erweiterten Protokoll schlägt dann jede Migration fehl, und zwar bei ihm, nicht bei uns. (b) ist die sauberere Schnittstelle und war der Vorschlag des Tores, hätte aber die Schnittstelle aus Abschnitt 3.2 um eine dritte Methode erweitert, die dort nicht steht, und drei Treiber betroffen, von denen zwei anderen Features gehören. Das Zerlegen braucht keine der beiden Änderungen: Der Abtaster aus E-90 weiß bereits, wo ein Semikolon kein Trenner ist, und die Atomarität hängt an der Transaktion, nicht am Protokoll.
*Preis:* Statt einem Round-Trip je Migration nun einer je Anweisung — bei Migration 1 sind das vierunddreißig statt einer. Das läuft einmal beim Aufsetzen. Dafür hängt kein Verhalten mehr an einer nicht dokumentierten Zeile in `pg`; die Risikonotiz, die hier sonst gestanden hätte, ist gegenstandslos geworden.

**E-99 — Die Prüfung auf Zeichenkettenliterale war eine Behauptung, bis das Tor sie geprüft hat.**
*Kontext:* E-90 behauptet, der Abtaster überspringe Zeichenkettenliterale. Für `E'…\'…'` stimmte das nicht: PostgreSQLs Escape-Strings beenden das Literal mit `\'` nicht, mein Abtaster schon. Und weil `$` als Bezeichnerzeichen zählte, las er `AS$$` als ein Wort und den folgenden Funktionsrumpf als Code, während `AS $$` richtig lief.
*Verworfen:* Die beiden Fälle einzeln nachbessern.
*Grund:* Beide Fehler haben dieselbe Ursache: Der Abtaster entschied zeichenweise und hielt den Zustand „wo bin ich gerade" in Kontrollfluss statt in Daten. Jetzt zerlegt er die Anweisung zuerst in Regionen und läuft nur über die Code-Regionen; ob vor einem Dollar-Quoting ein Leerzeichen steht, ist damit keine Frage mehr, und dieselbe Zerlegung trägt zusätzlich das Anweisungs-Zerlegen aus E-98 und die Rumpfprüfung aus E-97.
*Preis:* Die Zerlegung baut die gesamte Anweisung ein zweites Mal als Zeichenkette auf. Bei Migrationen ist das folgenlos; auf einem heißen Pfad läge sie falsch, und dort läuft sie auch nicht.

**E-100 — Ein rohes NUL-Byte machte eine Prüfdatei für die Attributionsprüfung unsichtbar.**
*Kontext:* Ein Prüffall benutzte `"velve\0"` als feindlichen Schemanamen, und meine Testverbindung verglich den Feldabschluss einer Fehlermeldung mit demselben Byte. Git stuft eine Datei mit NUL als binär ein; `git grep -I` überspringt sie und `git log -p` zeigt `Bin`. Das Tor hat einen Attributionsmarker in die Prüfdatei gepflanzt und den CI-Auftrag wörtlich laufen lassen: kein Treffer.
*Verworfen:* Die Prüfung um ein `--text` erweitern und die Dateien lassen.
*Grund:* Das Tor hat beides getan, und das ist richtig so — aber die Datei bleibt auch dann ein Diff, den niemand liest. Der Wert des Bytes ist im Test nicht der Punkt, nur seine Wirkung; `String.fromCharCode(0)` erzeugt denselben Namen, und der Byte-Vergleich in der Testverbindung war ohnehin klarer als Zahl zu schreiben.
*Preis:* Der Commit, der das behebt, zeigt für die Prüfdatei weiterhin `Bin`, weil eine Seite des Vergleichs der alte binäre Blob ist. Erst der nächste Commit auf diese Datei ist wieder lesbar. Rückwirkend wäre nur Historienumschreiben, und das ist der teurere Preis. Das Tor hat stattdessen alle 137 historischen Blobs als Rohbytes durchsucht: der gesamte je unlesbare Inhalt ist eine Zeile — das Literal `"velve\0"` selbst —, und ein Marker steht nirgends.

*Zwei Korrekturen an der ersten Fassung dieses Eintrags. Beide sind gemessen, nicht geschlossen.*

*(a) Die Ursache.* Die erste Fassung schrieb, der Formatierer habe die Escape-Sequenz in ein echtes NUL umgeschrieben. **Das ist falsch.** Es war eine Rekonstruktion, die als Beobachtung dastand: Ich habe die naheliegende Erklärung genommen, statt sie zu prüfen, und damit die Frage geschlossen. Das Tor hat sie mit der Biome-Fassung und der Konfiguration dieses Repositories vierfach gemessen — eine Datei mit `"velve "`, eine mit einem Leerzeichen und eine mit einem bereits vorhandenen rohen NUL kommen sowohl aus `biome format --write` als auch aus `biome check --write --unsafe` unverändert heraus; `tsdown` schreibt nur nach `dist/`, `vitest` nur nach `test/__snapshots__/`, und Bauen, Formatieren, unsicheres Beheben und Testen ließen jede versionierte Datei bytegleich. Kein Werkzeug dieser Kette kann das Byte erzeugen. **Die Datei wurde so geschrieben.** Die Richtung ist der Punkt: Der Wächter schützt gegen einen Autor, nicht gegen einen Unfall, und eine Regel muss sagen, gegen welchen von beiden.

*(b) Die Reichweite.* Der Titel der ersten Fassung sprach von zwei unsichtbaren Dateien. Nur eine war je binär. Das NUL in `test/db-postgres-connection.ts` stand an Byte 13735 und damit jenseits des 8000-Byte-Fensters, in dem Git auf Binärdaten prüft; diese Datei war durchgehend lesbar und wurde durchgehend geprüft. Der Commit, der beide behebt, behauptet in seinem Rumpf dasselbe zu weit — er ist gepusht und wird nicht umgeschrieben, diese Zeile ist die Korrektur dazu.

**E-101 — Die Fallstudie und die Dokumentation bekamen einen Prüfsatz, der über die Behauptung hinausgeht.**
*Kontext:* Drei Befunde dieses Durchgangs — der Wortersetzer (E-90), die Zeichenkettenprüfung (E-99) und das Dollar-Quoting (E-97) — hatten dieselbe Gestalt: Die Dokumentation beschrieb eine Eigenschaft, die der Code nur ungefähr hatte, und niemand hat den Unterschied bemerkt, weil die Beschreibung plausibel war.
*Verworfen:* Sorgfältiger schreiben.
*Grund:* Das ist kein Verfahren. Was hilft, ist eine Prüfung, die die Behauptung derselben Datei entnimmt: `test/db-documented-imports.test.ts` liest jede `@velve/auth`-Einbindung aus `DOCUMENTATION.md` und lädt sie aus dem gebauten Paket. Für die Sätze über den Abtaster gibt es kein Äquivalent — sie sind Prosa —, aber jeder von ihnen hat jetzt einen Testfall neben sich, der genau die Eingabe fährt, die der Satz beschreibt.
*Preis:* Die Prosa in `DOCUMENTATION.md` bleibt ungeprüft, und dieser Eintrag behauptet nicht, dass das gelöst wäre. Er hält fest, dass drei von drei Befunden dieses Durchgangs in der Lücke zwischen einem plausiblen Satz und dem Code lagen.

**E-110 — Fehlerklasse, Statustabelle und Abbildung stehen in einer einzigen Datei.**
*Kontext:* 3.13 verlangt, dass der Unterschied zwischen innen und außen an genau einer Stelle liegt. Die Klasse `VelveError` braucht Status und Nachricht im Konstruktor, die Abbildung braucht die Klasse.
*Verworfen:* Eine Datei `errors.ts` für die Klasse und `error-map.ts` für die Tabellen.
*Grund:* Die Trennung hätte einen Importzyklus ergeben, der nur über eine Fabrikfunktion auflösbar gewesen wäre — und dann hätte es zwei Stellen gegeben, an denen man nachsieht, was der Aufrufer erfährt. Die Vorgabe nennt eine.
*Preis:* `error-map.ts` ist mit rund 230 Zeilen die längste Datei des Moduls, und drei Viertel davon sind Tabellen.

**E-111 — Vier innere Gründe heißen `user_disabled_on_…` statt viermal `user_disabled`.**
*Kontext:* 3.15 F.1 führt `user_disabled` unter vier verschiedenen äußeren Codes auf. Eine Tabelle Grund → Code kann denselben Schlüssel nicht viermal tragen.
*Verworfen:* Den äußeren Code an der Wurfstelle mitgeben, etwa `new ConcealedError("user_disabled", "invalid_token")`.
*Grund:* Damit entschiede die Wurfstelle über die Sichtbarkeit, und genau das soll ausschließlich die Abbildung tun. Vier unterscheidbare Namen kosten nichts und halten die Tabelle eindeutig.
*Preis:* Vier Namen, die so nicht in der Spezifikation stehen. Wer F.1 gegen den Quelltext liest, muss sie zuordnen.

**E-112 — Die HTTP-Schicht verschiebt Token aus dem Antwortkörper ins Cookie.**
*Kontext:* Die Servermethode gibt `sessionToken` zurück (3.15 C.1), über HTTP darf das Klartexttoken den Prozess aber nur im Cookie verlassen (3.5).
*Verworfen:* Jede Route setzt ihr Cookie selbst.
*Grund:* Die Regel wäre über 46 Routen verteilt und an einer davon irgendwann vergessen worden — und der Körper hätte das Token trotzdem getragen, weil das Setzen des Cookies das Feld nicht entfernt. Das Entfernen muss ohnehin zentral geschehen; dann kann dieselbe Stelle auch das Cookie setzen.
*Preis:* Die HTTP-Schicht kennt zwei Feldnamen der Ausgabetypen. Ein Ausgabefeld, das zufällig `sessionToken` hieße und kein Token wäre, verschwände aus dem Körper.

**E-113 — Eine unbekannte Route antwortet mit 404 ohne Körper.**
*Kontext:* Eine Route, die es im gewählten Modus nicht gibt, ergibt 404 (3.15 D.3). Unter den 25 Codes gibt es keinen für „diese Route existiert nicht".
*Verworfen:* Einen 26. Code einführen; oder 404 mit `invalid_input` im Körper beantworten.
*Grund:* Die Codeliste ist stabil und wächst laut 3.15 F nur mit einer neuen Route, nicht mit einem neuen Zustand. Ein Körper mit einem erfundenen Code wäre eine zweite Fehlerhülle neben der einen dokumentierten.
*Preis:* Der Client erkennt diesen Fall nur am Status, nicht am Code; er wird dort zu einem `VelveTransportError`.

**E-114 — Basispfad und Client-Adresse sind Parameter, keine Kopfzeilen.**
*Kontext:* `toWebHandler(auth)` bekommt einen Web-`Request`. Der kennt weder den Montagepunkt der Anwendung noch die Verbindungsadresse.
*Verworfen:* `X-Forwarded-Host` für den Basispfad und `X-Forwarded-For` für die Adresse auszuwerten; hilfsweise den längsten passenden Pfadsuffix zu raten.
*Grund:* Beide Kopfzeilen setzt der Aufrufer selbst — GHSA-569q-mpph-wgww ist genau dieser Fehler, und S-RATE-3 verbietet ihn. Ein sichtbarer zweiter Parameter, den man einmal beim Einbau setzt, ist ehrlicher als eine Heuristik, die dauerhaft falsch sein kann.
*Preis:* `toWebHandler` hat einen zweiten Parameter, den 3.15 D.1 nicht vorsieht. Wer `clientAddress` nicht setzt, zählt jede Anfrage auf denselben Eimer je Route — das ist S-RATE-4, aber es ist ein grober Eimer.

**E-115 — Die Ratenbegrenzung hängt an einer benannten Naht, nicht an einer Middlewarekette.**
*Kontext:* Der Zähler entsteht erst in einer späteren Welle, muss aber vor jedem Handler laufen (3.11) und darf die HTTP-Dateien dann nicht mehr anfassen.
*Verworfen:* Eine Liste von Vorprüfungen in der Umgebung, die die Pipeline der Reihe nach abarbeitet.
*Grund:* 3.11 sagt, die Erweiterungspunkte sind aufgezählt und nicht offen. Eine Kette hätte genau das erlaubt, was ein Plugin nicht darf — sich vor die Sicherheitsmiddleware zu setzen. Ein Feld vom Typ `RateLimiter` ist eine Naht für genau eine Sache.
*Preis:* Wer eine zweite Vorprüfung braucht, kann sie nicht einhängen, ohne diese Dateien zu ändern. Das ist beabsichtigt und wird beim nächsten Bedarf wehtun.

**E-116 — Den IP-Eimer zieht die Pipeline, den Kontoeimer die Route.**
*Kontext:* 3.15 D.2 setzt die Ratenbegrenzung vor `input.parse`. Der Schlüssel des kontobezogenen Eimers ist nach L-5 der normalisierte Bezeichner — den es vor dem Parsen nicht gibt.
*Verworfen:* Die Reihenfolge umzudrehen und beide Eimer nach dem Parsen zu ziehen.
*Grund:* Der IP-Eimer ist genau der Schutz davor, dass ungeprüfte Eingaben Arbeit auslösen; er muss vorne bleiben. L-5 verlangt, dass der Kontozähler **vor der Auflösung des Nutzers** greift, nicht vor dem Parsen — das ist erfüllt.
*Preis:* Die Route ruft `enforceAccountRateLimit` selbst auf. Eine Deklaration mit `perAccount` ohne diesen Aufruf zählt still nicht mit; das fängt ein Testfall ab, keine Typprüfung.

**E-117 — Doppelte Cookies werden nur bei den aufgezählten Namen abgelehnt.**
*Kontext:* S-COOKIE-5 verlangt, eine Anfrage mit zwei Cookies gleichen Namens abzulehnen, statt eines auszuwählen.
*Verworfen:* Jede Anfrage abzulehnen, in der irgendein Cookiename doppelt vorkommt.
*Grund:* Pfadgebundene Anwendungscookies — `theme` auf `/` und auf `/app` — erreichen den Server regelmäßig doppelt. Eine Bibliothek, die daraufhin die Anmeldung verweigert, ist ein Ausfall und kein Schutz. Cookie-Tossing betrifft nur die Werte, denen die Bibliothek traut, und das sind die beiden aufgezählten.
*Preis:* Ein doppelter fremder Cookiename fällt nicht auf. Wer die strengere Lesart von S-COOKIE-5 will, bekommt sie hier nicht.

**E-118 — Das Sitzungstoken liegt im Kontext, der Zwischenzustand nur bei `caller: "pending"`.**
*Kontext:* `GET /session` antwortet mit `ResolvedSession | null` und darf deshalb nicht `caller: "session"` tragen — sonst wäre die Antwort 401 statt `null`. Das Cookie braucht die Route trotzdem.
*Verworfen:* Einen fünften Wert für `CallerRequirement`, etwa `"session_optional"`.
*Grund:* Die vier Werte stehen in 3.15 D.1 und tragen die Aussage „genau vier Routen lesen das Zwischenzustandscookie". Ein fünfter Wert hätte diese Zählung verwässert. Das Zwischenzustandscookie bleibt streng auf `caller: "pending"` beschränkt (S-CACHE-4); nur das Sitzungstoken liegt jedem Handler offen.
*Preis:* `RequestContext` trägt ein Feld mehr, als 3.15 D.1 aufzählt, und das rohe Sitzungstoken ist damit im Handler sichtbar.

**E-119 — `Session` und `PendingAuthentication` stehen vorerst in `core/http`.**
*Kontext:* Die Routendeklaration braucht die Typen des Aufrufers, damit ein Handler `context.session` lesen kann. `core/session` entsteht erst eine Welle später, und keine Welle darf die Dateien einer anderen anfassen.
*Verworfen:* (a) `RequestContext` generisch über die Aufrufertypen. (b) `unknown` und jede Route sichert selbst zu.
*Grund:* Die Generik hätte jede Routendeklaration gezwungen, den Kontexttyp zu annotieren, weil er sonst auf die Schranke zurückfällt — eine Schnittstelle, die ohne Dokumentation nicht mehr benutzbar ist. `unknown` hätte in jedem Handler eine Typzusicherung erzeugt.
*Preis:* Zwei Typen aus 3.15 C stehen im falschen Modul. Sobald `core/session` sie hat, muss zusammengeführt werden, und bis dahin kann es sie doppelt geben.

**E-120 — CORS wird bewusst nicht gebaut.**
*Kontext:* Liegt die Anwendung auf `app.example.com` und die API auf `api.example.com`, ist jeder Aufruf cross-origin, und ohne `Access-Control-Allow-Origin` verwirft der Browser die Antwort. Die Bibliothek führt bereits eine Liste erlaubter Ursprünge.
*Verworfen:* Die CORS-Kopfzeilen aus genau dieser `origins`-Liste abzuleiten — es wäre eine Zeile im Antwortpfad gewesen und hätte den häufigsten Einbaufehler beseitigt.
*Grund:* Die beiden Listen beantworten verschiedene Fragen. `origins` entscheidet, welche Anfrage **ausgeführt** wird; die CORS-Liste entscheidet, welche Seite eine Antwort **lesen** darf. Eine gemeinsame Liste hätte beides gekoppelt: Wer künftig eine weitere Seite lesen lassen will, hätte damit stillschweigend auch die CSRF-Erlaubnis erweitert, und die gefährlichere der beiden Wirkungen wäre die unsichtbare gewesen. Dazu kommt die Regel aus 3.14: Die Bibliothek beantwortet, wer angemeldet ist. HTTP-Richtlinien der Anwendung — CORS, HSTS, CSP — stehen davor, im Reverse Proxy, wo sie zusammen gepflegt werden.
*Preis:* Der Einbau bei getrennten Ursprüngen ist ohne Proxy-Konfiguration nicht funktionsfähig, und der Fehler zeigt sich erst im Browser. Die Dokumentation trägt deshalb ein vollständiges Traefik-Beispiel; das ersetzt keine Zeile Code, aber es benennt den Schritt.

**E-121 — Die Servermethode nimmt `origin` als Pflichtfeld ihrer Eingabe.**
*Kontext:* 3.15 D.1 schreibt `ServerMethodOf<R> = (input: I) => Promise<O>`. S-CSRF-1 verlangt die Origin-Prüfung aber auch beim direkten Serveraufruf, und ein `Request` gibt es dort nicht.
*Verworfen:* (a) Einen zweiten Parameter `(input, call)`. (b) Die Prüfung beim direkten Aufruf zu überspringen, weil „im Prozess kein Browser sitzt".
*Grund:* (b) wäre der Rückfall in genau die Lücke, die 3.11 schließt — die Servermethode ist derselbe Einstiegspunkt, nur ohne HTTP davor. (a) hätte die Signatur aus D.1 stärker verändert als ein zusätzliches Feld; D.2 nennt für `caller: "session"` bereits ein zusätzliches Eingabefeld `sessionToken`, also ist ein Feld die vorgesehene Form. `origin` ist Pflicht und nicht optional, weil ein weglassbares Sicherheitsfeld weggelassen wird; wer keinen Ursprung hat, schreibt `null` und bekommt eine Ablehnung.
*Preis:* Jede Servermethodensignatur weicht sichtbar von D.1 ab, und `ServerCallFields` schluckt fünf Feldnamen aus dem Namensraum der Eingabe. Ein Routen-Eingabefeld, das `origin` hieße, würde von der Hülle verdeckt.

**E-122 — Die geschriebenen Cookienamen kommen aus dem Quelltext, nicht aus der Konfiguration.**
*Kontext:* Die Prüfung fand einen Weg von der Konfiguration in die Kopfzeile: `` `__Host-${string}` `` beschränkt nur den Anfang, sodass `"__Host-velve_session=decoy; Domain=.evil.com"` ein gültiger Typ ist und als `Set-Cookie` mit fremder `Domain` herauskommt. A.5 sieht `cookieName` als Option vor.
*Verworfen:* Den Namen weiterhin aus der Konfiguration zu nehmen und ihn nur zu prüfen.
*Grund:* Die reine Prüfung hätte die Lücke geschlossen und die Frage offengelassen, wozu die Option da ist. Die Bestandsaufnahme beantwortet sie: H15 und H16 verwerfen konfigurierbare Cookienamen ausdrücklich, und S-COOKIE-1 nennt den Namen wörtlich. Damit ist die Option aus A.5 die Ausnahme und nicht die Regel, und der sicherere Zweig ist zugleich der einfachere: Der Schreiber nimmt den Namen aus der Aufzählung, die Prüfung im Antwortpfad vergleicht gegen dieselbe Aufzählung — vorher verglich sie gegen die Konfiguration, die die Namen erzeugt hatte, und konnte deshalb nie anschlagen. Die Zeichenprüfung des Namens bleibt zusätzlich, als letzte Linie.
*Preis:* Eine dokumentierte Konfigurationsoption aus A.5 wirkt nicht mehr. Wer zwei Instanzen derselben Anwendung auf einer Origin betreiben will, kann ihre Sitzungscookies nicht auseinanderhalten.

**E-123 — Auf einer GET-Route werden nicht deklarierte Query-Parameter ignoriert.**
*Kontext:* Das Eingabeschema lehnt unbekannte Schlüssel ab. Google, Microsoft und Apple hängen an den OAuth-Rückruf eigene Parameter (`authuser`, `prompt`, `hd`, `scope`), die keine Deklaration aufzählen kann. Der Rückruf hätte dauerhaft mit 400 geantwortet — auf der einzigen Route ohne Origin-Prüfung.
*Verworfen:* Das Schema der Rückrufroute um die bekannten Fremdparameter zu erweitern.
*Grund:* Die Liste ist nicht abschließbar und wächst mit jedem Anbieter; eine Aufzählung, die fehlschlägt, sobald ein Anbieter etwas Neues anhängt, ist ein Ausfall auf dem Anmeldeweg. Die Strenge bleibt dort, wo sie etwas nützt: Im POST-Körper ist ein unbekannter Schlüssel weiterhin ein Fehler, denn dort schreibt der Aufrufer die ganze Nachricht selbst.
*Preis:* Zwei Strengegrade in derselben Bibliothek. Die Regel steht in der Ableitung aus der Deklaration, also an einer Stelle — aber sie ist eine Regel mehr.

**E-124 — Pfadsegmente werden ohne Rücksicht auf Groß- und Kleinschreibung verglichen.**
*Kontext:* T-RATE-5 nennt sieben Schreibweisen desselben Pfades, die auf einem Eimer zählen müssen, darunter `/TEST/ECHO`. Der Vergleich war zeichengenau, also traf diese Form keine Route und lief an der Zählung vorbei.
*Verworfen:* Die Schwelle für falsch zu erklären, weil HTTP-Pfade laut RFC 3986 unterscheidend sind.
*Grund:* Formal stimmt der Einwand, praktisch ist er wertlos: Wer eine Route sucht, an der ein Zähler nicht greift, probiert genau diese Schreibweise. Die Gegengefahr — ein vorgelagerter Cache, der `/A` und `/a` verschieden ablegt — ist durch `no-store` auf jeder Antwort bereits ausgeschlossen (L-6). Mitgenommen wurden zwei kleinere Fälle derselben Klasse: ein `.`-Segment wird verworfen, ein `..`-Segment führt zu 404 statt zu einem Aufstieg.
*Preis:* Die Bibliothek weicht an dieser Stelle bewusst von RFC 3986 ab, und Pfadparameter behalten ihre Schreibweise, während Literalsegmente sie verlieren.

**E-125 — Die gebaute Route trägt ihren Handler nicht mehr.**
*Kontext:* Aus der Deklaration entstand ein Objekt mit `invoke` und dem `handler` der Deklaration. Das Haupttor zeigte, dass damit jeder, der die Routentabelle in der Hand hat, den Handler ohne Origin-Prüfung, ohne Ratenzähler, ohne Fehlerabbildung und ohne Protokollzeile ausführen kann — bei `originCheck: "checked"` und einem Eimer der Größe 1 gemessen: null Zähleraufrufe.
*Verworfen:* Die Lücke stehen zu lassen, weil ein Prüftest sie bereits beschrieb. Das war die Fehlentscheidung der vorigen Runde: Der Test stand unter der Überschrift der Anforderung, die er verletzt, also war er eine Bestandsaufnahme des Lochs und keine Zusicherung.
*Grund:* 3.11 („Origin-Prüfung und Ratenbegrenzung liegen immer davor") kennt keine Ausnahme für einen Aufrufer im selben Prozess. Die Ausführung liegt jetzt unter einem modulprivaten Symbol, das nur die Pipeline liest, und das gebaute Objekt trägt den Handler gar nicht mehr — ihn zu verstecken und den Handler daneben aufrufbar zu lassen wäre Theater gewesen.
*Preis:* Eine sichtbare Abweichung von 3.15 D.1: Dort gibt `defineRoute` dieselbe Form zurück, die es bekommt. Wer eine Route ableiten will, muss die Deklaration weiterreichen, nicht die gebaute Route (`defineRoute({ ...routeObjekt })` ist jetzt ein Typfehler).

**E-126 — Zwei Routen auf demselben gefalteten Pfad sind ein Startfehler.**
*Kontext:* E-124 hat den Vergleich unabhängig von Groß- und Kleinschreibung gemacht und die Folge nicht bedacht: `/attack/case` und `/attack/CASE` ließen sich beide anmelden, die erste gewann, die zweite war dauerhaft unerreichbar — ohne Meldung. Dazu faltete `toLowerCase()` Unicode, sodass `/lin%E2%84%AA` (KELVIN SIGN) auf `/link` traf, während der Basispfad gar nicht gefaltet wurde.
*Verworfen:* Die Faltung zurückzunehmen und T-RATE-5 als unerfüllt zu melden.
*Grund:* Die Schwelle bleibt richtig (E-124); falsch war nur, sie ohne ihre Nebenwirkungen einzuführen. Gefaltet wird jetzt ausschließlich `A`–`Z`, weil eine Faltung, die mehr Zeichen zusammenzieht als die Schwelle verlangt, neue Kollisionen erfindet statt vorhandene zu erkennen. Der Basispfad wird wie jedes andere Segment behandelt, und die Kollisionsprüfung läuft beim Bau des Handlers — dem frühesten Zeitpunkt, an dem diese Schicht die ganze Tabelle sieht.
*Preis:* Die Prüfung liegt in `toWebHandler` und damit später als ein echter Startfehler in `createVelveAuth`; wer nur Servermethoden benutzt und nie einen Handler baut, bekommt sie nicht zu sehen.

**E-127 — Ein doppelter Query-Parameter lehnt die Anfrage ab.**
*Kontext:* `?code=a&code=b` nahm stillschweigend den letzten Wert. Betroffen ist ausgerechnet der OAuth-Rückruf, die einzige Route ohne Origin-Prüfung, deren Sicherheit an `state` und `code` hängt.
*Verworfen:* Den ersten Wert zu nehmen, wie es die meisten Server tun.
*Grund:* Es gibt keine richtige Wahl, sondern nur eine Wahl, bei der ein vorgelagerter Proxy oder eine WAF anders entscheiden kann als die Bibliothek — und genau diese Differenz ist der Angriff (Parameter Pollution). Dieselbe Überlegung hat bei Cookies zu S-COOKIE-5 geführt; die Bibliothek wendet ihre eigene Regel jetzt auch auf die Query an.
*Preis:* Ein Aufrufer, der aus Versehen zweimal denselben Parameter anhängt, bekommt 400 statt einer Antwort. Das ist bei einem Anbieter-Rückruf unwahrscheinlich und ansonsten sein Fehler.

**E-128 — Ein Weiterleitungsziel darf überhaupt keine Query tragen.**
*Kontext:* Die Naht erlaubte `?` und `#`, also war `redirectTo("/x?token=SECRET")` möglich. S-REDIR-4 ist absolut: In `Location` und in dessen Query steht nie ein Token.
*Verworfen:* Die Query zu erlauben und beim Schreiben auf verbotene Parameternamen zu prüfen.
*Grund:* Eine Namensliste ist eine Aufzählung, die vollständig sein müsste, und die Bibliothek weiß nicht, wie die Anwendung ihre Parameter nennt. Ohne Query gibt es keine Stelle, an der ein Token mitfahren könnte — der Zustand liegt ohnehin serverseitig, also kostet das Verbot nichts. Zusätzlich ist das Ziel jetzt ein `RedirectPath` und keine Zeichenkette mehr (T-REDIR-1), gemünzt von `toRedirectPath`.
*Preis:* Eine Anwendung, die nach der Anmeldung `/app?welcome=1` anspringen will, kann das über diese Naht nicht ausdrücken.

**E-129 — Die Ausnahme wandert in ein eigenes Protokollfeld, nicht in den Grund.**
*Kontext:* Bei einer unerwarteten Ausnahme protokollierte die Schicht nur das Wort `unhandled_exception`; die Ausnahme selbst wurde verworfen, und die Dokumentation behauptete das Gegenteil. Ein 500er war damit aus dem Protokoll heraus nicht diagnostizierbar.
*Verworfen:* Die Nachricht der Ausnahme in das Feld `reason` zu schreiben.
*Grund:* `reason` trägt genau einen Wert aus der Aufzählung der inneren Gründe; ein freier Text darin hätte die Tabelle aus 3.15 F.1 aufgeweicht, die von Prüfungen zeilenweise gelesen wird. Die Nachricht steht deshalb in `cause` daneben. Der Antwortkörper bleibt unverändert wortkarg.
*Preis:* Das Protokoll kann jetzt fremden Text enthalten, etwa Verbindungszeichenketten aus einer Treiberausnahme. Das ist der Preis dafür, dass ein 500er überhaupt untersuchbar ist, und es steht in der Dokumentation.

**E-130 — Die Wartezeit steht zusätzlich in `Retry-After`.**
*Kontext:* Die Bestandsaufnahme verlangt unter H13 ausdrücklich `Retry-After` nach RFC 9110, damit Clients und Zwischenschichten die Wartezeit auswerten können. Sie lag bislang nur als `retryAfterSeconds` im JSON-Körper — an der einzigen Stelle, die genau diese Zwischenschichten nicht lesen.
*Verworfen:* (a) Nur den Körper zu füllen, weil der eigene Client ihn ohnehin liest. (b) Nur die Kopfzeile zu setzen und das Feld zu streichen.
*Grund:* (a) übersieht, dass zwischen Bibliothek und Browser fremde Software steht, die JSON nicht kennt, aber Kopfzeilen kennt. (b) hätte die typisierte Rückgabe des Clients beschnitten, wo eine Maske die Sekunden anzeigen muss. Beides zu senden ist die einzige Fassung ohne Verlust, und die Wartezeit wird an genau einer Stelle geprüft — was der Aufrufer nicht auswerten kann, erscheint weder im Körper noch in der Kopfzeile.
*Preis:* Dieselbe Angabe steht zweimal in derselben Antwort, und wer sie ändert, muss an beide denken. Eine gemeinsame Prüffunktion bindet sie zusammen, die Ausgabe bleibt doppelt.

**E-131 — Ein Eingabefeld mit dem Namen eines Hüllenfeldes ist ein Startfehler.**
*Kontext:* E-121 nahm in Kauf, dass die fünf Felder der Aufrufhülle (`origin`, `sessionToken`, `pendingToken`, `ipAddress`, `userAgent`) Namen aus dem Eingabe-Namensraum verdecken, und nannte das als Preis. Das Haupttor hat gemessen, dass der Preis höher ist als angenommen: Eine Route mit einem Eingabefeld `sessionToken` antwortet über HTTP mit 200 und wirft über die Servermethode `invalid_input`, weil die Hülle das Feld dort vorher herausnimmt. Zwei Aufrufwege, dieselbe Deklaration, verschiedene Ergebnisse.
*Verworfen:* (a) Die Verdeckung zu dokumentieren, wie in E-121 vorgesehen. (b) Die Hülle in ein verschachteltes Feld zu legen und die Kollision damit unmöglich zu machen.
*Grund:* (a) ist zu wenig: Ein Unterschied zwischen zwei Aufrufwegen, den nur ein Absatz in der Referenz verhindert, ist ein Fehler, der irgendwann gemeldet und lange gesucht wird. (b) wäre die sauberere Form gewesen, hätte aber 3.15 D.2 widersprochen, wo das zusätzliche `sessionToken` ausdrücklich ein Feld neben der Eingabe ist. Also bleibt die flache Hülle, und die fünf Namen sind reserviert — auch als Pfadparameter, weil ein `:sessionToken` in derselben Eingabe landet. Der Preis aus E-121 ist damit abgelöst: Es gibt nichts mehr zu verdecken, weil die Deklaration gar nicht erst startet.
*Preis:* Fünf Namen, die eine Route nicht verwenden darf, ohne dass der Typ es sagt — die Prüfung läuft beim Bau der Route und meldet sich als Startfehler, nicht als Typfehler.

**E-140 — Die S-FIX-2-Prüfung liest das gebaute Paket, und Tests stehen außerhalb ihres Bereichs.**
*Kontext:* Der Detektor blockierte beim Zusammenführen das Feature `db` mit zehn Treffern über zwei Dateien — sämtlich in dessen Tests für den E-23-Trigger. Der Beweis, dass die Datenbank eine Umschreibung des Sitzungseigentümers zurückweist, besteht darin, sie zu versuchen.
*Verworfen:* (a) Das Angriffskorpus jedes betroffenen Tests in Datendateien auslagern. (b) Dem Detektor beibringen, dass eine Anweisung, die an eine Hilfsfunktion wie `expectRefused` geht, eine Behauptung ist und keine Ausführung.
*Grund:* T-FIX-2 verlangt beides zugleich — null Treffer einer statischen Prüfung **und** ein direktes `UPDATE velve.session SET user_id` über den Treiber gegen die Testdatenbank. Beide Forderungen sind nur erfüllbar, wenn der Bereich der statischen Prüfung genau den Test ausnimmt, den die Spezifikation vorschreibt. Der Ausschluss von `test/` ist damit kein Zugeständnis an die Bequemlichkeit, sondern die einzige Lesart, unter der T-FIX-2 überhaupt erfüllbar ist. Variante (a) hätte fremde Tests umgebaut und die Datei-für-Datei-Ausnahmeliste zurückgebracht, die sich zweimal als Loch erwiesen hat — und sie hätte nichts gelöst, weil der Wortlaut ohnehin in einem Test stehen muss. Variante (b) hätte die Sicherheitsprüfung an den Namen einer Testhilfsfunktion gekoppelt; eine Umbenennung hätte sie laut brechen lassen, aber jeder beliebige Code mit einer gleichnamigen Funktion hätte still eine Ausnahme bekommen.
*Preis:* Der Quelltextpfad allein kann nicht belegen, was ausgeliefert wird — eine Datei unter `test/`, die aus `src/` re-exportiert wird, landet in `dist/` wie jede andere, und das Tor blieb dabei vollständig grün. Der Ausschluss ist deshalb nur zusammen mit einer zweiten Prüfung vertretbar, die das **gebaute Artefakt** liest. Erst die beantwortet die Frage, die S-FIX-2 tatsächlich stellt, nämlich ob die Bibliothek die Anweisung enthält, statt der Frage, wie ihr Quelltext gegliedert ist.

**E-141 — Die S-FIX-2-Prüfung liest die Zuweisungsliste, nicht den Tabellennamen.**
*Kontext:* Der Prüfer des `session`-Features hat eine echte Eigentümer-Zuweisung in `src/core/db/repositories/session.ts` gepflanzt und gemessen, dass die Prüfung grün bleibt. Von 119 Statement-Abschnitten des Moduls betrachtete sie einen einzigen, und der enthielt das Wort `session` nicht — weil das Schema konfigurierbar ist und das Repository `UPDATE ${table} SET …` schreibt. Umgekehrt hätte dasselbe Muster das legitime Leerlauf-`UPDATE` als Zuweisung gemeldet, weil `user_id` hinter dem `WHERE` steht.
*Verworfen:* (a) Den Tabellennamen weiterhin fordern und die Interpolation nachbilden. (b) Die Prüfung auf Dateien beschränken, deren Name auf das Feature schließen lässt.
*Grund:* Beide Varianten hätten die Prüfung an eine Schreibweise gebunden statt an eine Eigenschaft. Ein Repository, das seinen Tabellennamen aus der Konfiguration bezieht, ist der Normalfall dieses Entwurfs und nicht die Ausnahme — eine Prüfung, die daran scheitert, prüft die falsche Sache. Sie liest jetzt die **Zuweisungsliste zwischen `SET` und `WHERE`** und meldet jede Zuweisung an eine Eigentümerspalte, auf welcher Tabelle auch immer.
*Preis:* Die Regel ist breiter als S-FIX-2 verlangt, und zwei Fälle, die bisher ausdrücklich erlaubt waren, sind jetzt verboten: `UPDATE velve.identity SET user_id` und eine Tabelle, deren Name der Sitzungstabelle nur ähnelt. Das ist beabsichtigt. Eine verknüpfte Identität auf ein anderes Konto umzuschreiben ist genau die Kontoübernahme aus CVE-2026-53516; die Bibliothek verknüpft durch Einfügen und nie durch Umschreiben. Wer hier je eine legitime Ausnahme braucht, muss sie benennen und begründen, statt sie durch eine Lücke im Muster zu bekommen.

**E-142 — Eine Anweisung, die keinen Actor prüfen kann, sagt das in ihrem eigenen Text.**
*Kontext:* Die verschärfte Eigentümer-Prüfung aus E-141 nahm die Einlösung eines Einmal-Tokens per Muster auf den Tabellennamen `one_time_token` aus. Der Tor-Agent zeigte beim Zusammenführen, dass die Ausnahme nicht greift: Das Repository schreibt `DELETE FROM ${table}`, der Name steht dort nicht. Derselbe Eintrag E-141 argumentiert, eine Prüfung dürfe nicht vom ausgeschriebenen Tabellennamen abhängen — und die Ausnahme, die er dazu formulierte, tat genau das.
*Verworfen:* (a) Die Ausnahmeliste um jede weitere Anweisung erweitern, die keinen Actor hat. (b) Die Interpolation nachbilden und den Tabellennamen auflösen.
*Grund:* Eine Liste in der Prüfdatei wächst mit jedem Feature und steht weit entfernt von der Anweisung, für die sie gilt; wer die Anweisung liest, sieht die Ausnahme nicht, und wer die Liste pflegt, sieht die Anweisung nicht. Eine Markierung im Statement selbst — `-- no owner predicate: S-TOKEN-4` — reist mit dem Statement mit, überlebt jede Interpolation und zwingt den Autor, die Anforderung zu benennen, die den Verzicht erlaubt. Aus einer Ausnahme, die jemand anders gewährt, wird eine Begründung, die der Autor abgibt.
*Preis:* Zwei Features müssen ihre Anweisungen um eine Zeile ergänzen, und eine Markierung ohne Anforderungsnummer wird abgelehnt. Zusätzlich fiel auf, dass `FOR UPDATE` das Wort `UPDATE` enthält und die Prüfung eine sperrende `SELECT`-Anweisung für eine zeilenändernde hielt — ein Fehlalarm, den erst der Tor-Agent fand, weil auf `main` bis dahin keine Sperre existierte.

**E-143 — `velve.user` wird zuerst gesperrt, und eine Prüfung setzt das durch.**
*Kontext:* Zwei Features griffen unabhängig voneinander zu `SELECT … FOR UPDATE`, um Invarianten zu sichern, die der sperrfreie Entwurf nicht abdeckt — `token` für die Eindeutigkeit eines Zwecks, `identity` für den letzten Anmeldeweg. Die Spezifikation kennt Zeilensperren nicht: Eine Suche über die Abschnitte 1 bis 7 nach `FOR UPDATE`, `deadlock` oder `Sperrreihenfolge` liefert keinen Treffer, und jeder dort beschriebene Nebenläufigkeitsmechanismus ist konstruktiv sperrfrei.
*Verworfen:* (a) Es beim Protokolleintrag belassen, den der `token`-Schreiber selbst geschrieben hatte. (b) Sperren ganz verbieten.
*Grund:* Beide Features sperren heute zufällig in derselben Reihenfolge — beide zuerst `velve.user`. Zwei Autoren, dieselbe Reihenfolge, aus gutem Instinkt und ohne Absprache. Genau dafür gibt es Regeln: Der erste, der später eine Zeile sperrt und *danach* die Nutzerzeile, schließt den Zyklus, und eine Verklemmung zeigt sich unter Last in der Produktion, nicht im Testlauf — sie braucht zwei bestimmte Transaktionen, die sich auf demselben Konto verschränken, und keinen Test in diesem Repository konstruiert das. Ein Risiko, das in einem 130 KB langen Protokoll am Ende eines Feature-Blocks steht, ist keine Kontrolle; niemand liest es rechtzeitig.
*Preis:* Die Prüfung kann durch einen interpolierten Tabellennamen hindurch nicht sehen, welche Tabelle gesperrt wird. Sie erkennt deshalb die fünfzehn Tabellen, die *nicht* `user` sind, statt nach `user` zu suchen — womit eine Sperre, deren Ziel ausschließlich aus einer Variablen besteht, durchgelassen wird. Das ist bewusst: Ein Fehlalarm auf `${owners}` hätte die Prüfung sofort unglaubwürdig gemacht, und die Regel steht zusätzlich in Abschnitt 7.

**E-144 — Der Nachtlauf bekommt einen eigenen Auftrag, weil ein Schalter ohne Zeitplan nichts einschaltet.**
*Kontext:* Abschnitt 6 legt einen Teil der Prüfungen auf einen nächtlichen Rang — die statistischen und die mit hoher Wiederholungszahl. Das `token`-Feature hat seine Verteilungsprüfung entsprechend hinter `VELVE_NIGHTLY` gestellt und dabei gemeldet, dass diese Variable nichts startet: Ein Skript gehört in `package.json`, ein Zeitplan in einen Workflow, und beide Dateien gehören keinem Feature.
*Verworfen:* (a) Die Prüfungen im blockierenden Rang lassen. (b) Sie ganz streichen und die Anforderung als unerfüllbar vermerken.
*Grund:* Im blockierenden Rang schaden sie doppelt. Sie kosten bei jedem Commit Minuten, und sie schlagen falsch an: Zweiundvierzig unabhängige χ²-Prüfungen bei p = 0,001 verwerfen rund vier von hundert Läufen auch bei einem einwandfreien Generator. Ein Tor, das ohne Fehler rot wird, wird ignoriert, und dann ist es wertlos für den Fall, in dem es recht hat. Streichen wäre die andere Richtung desselben Fehlers.
*Preis:* Ein Fehler, den nur der Nachtlauf findet, wird bis zum nächsten Morgen nicht bemerkt, und niemand steht davor, wenn er auftritt — der Auftrag muss also so geschrieben sein, dass sein Fehlschlag von selbst auffällt. Zusätzlich ist der Rang selbst prüfbedürftig: Auf `main` existierte zum Zeitpunkt dieser Änderung keine einzige nachtgesteuerte Prüfung, der Schalter war also von einem defekten nicht zu unterscheiden. Belegt wurde er mit einer eingesetzten Prüfung — 524 Tests ohne, 525 mit —, weil sonst genau die Verwechslung entstünde, vor der Abschnitt 5 der Regeln warnt.


**E-145 — Die Markierung ist ein Blockkommentar, weil ein Zeilenkommentar den Rest der Anweisung verschluckt.**
*Kontext:* E-142 führte `-- no owner predicate: S-…` als Markierung ein, mit der eine Anweisung ihren fehlenden Eigentümer-Filter selbst begründet. Der Tor-Agent des `session`-Features hat gezeigt, wohin das führt: `DELETE FROM ${table} -- no owner predicate: …\nWHERE token_sha256 = $1` wird, sobald irgendetwas den Zeilenumbruch normalisiert — ein Protokollierer, ein Formatierer, ein vorgelagerter Proxy —, zu `DELETE FROM velve.session`. Jede Sitzungszeile.
*Verworfen:* (a) Die Markierung an das Ende der Anweisung zwingen, hinter `RETURNING`. (b) Es bei der Zeilenform belassen, weil kein ausgelieferter Treiber SQL umschreibt.
*Grund:* Variante (a) funktioniert und wurde nachgemessen, macht die Sicherheit aber von einer Position abhängig, die jemand beim nächsten Umformatieren verschiebt. Variante (b) verwechselt „heute nicht erreichbar" mit „ungefährlich" — und der Schaden wäre nicht der Fehler, den die Markierung erklärt, sondern ein unqualifiziertes `DELETE`. Ein Blockkommentar kann nichts verschlucken, an welcher Stelle er auch steht.
*Preis:* Zwei Features müssen ihre Markierung umschreiben, und der Fehler lag in der Form, die ich vorgegeben hatte, nicht in ihrer Anwendung. Beide hatten sie korrekt benutzt. Beim Nachmessen fiel zusätzlich auf, dass die Zeilenform nach dem Kollaps weiterhin als gültige Markierung erkannt wird — die Prüfung wäre also grün geblieben, während die Anweisung ihren Filter verloren hat.

**E-146 — Die NUL-Prüfung wandert in das lokale Tor, weil vier Vorfälle kein Zufall sind.**
*Kontext:* Ein rohes NUL-Byte in einer Quelldatei lässt git sie als binär einstufen; sie entkommt damit beiden Hälften der Attributionsprüfung und zugleich dem menschlichen Blick, weil ihr Diff nur `Bin` zeigt. Der CI-Auftrag weist das seit E-141 zurück. Trotzdem sind es inzwischen vier Vorfälle in vier verschiedenen Features, und zwei davon erreichten erst das Tor.
*Verworfen:* (a) Es bei der CI-Prüfung belassen und die Schreiber deutlicher darauf hinweisen. (b) Den Formatierer die Bytes ersetzen lassen.
*Grund:* Ein Hinweis in einem Briefing ist keine Prüfung, und vier Wiederholungen belegen, dass die Stelle des Fehlers nicht die Aufmerksamkeit ist, sondern der Zeitpunkt der Rückmeldung: Wer die Datei schreibt, erfährt es erst Stunden später von einem Tor-Agent. Dieselbe Prüfung im lokalen `pnpm gate` meldet es in dem Moment, in dem sie entsteht. Variante (b) wäre still — eine Reparatur, die niemand bemerkt, lehrt niemanden, und der Autor wollte in allen vier Fällen ein NUL-Byte im Test haben, nur eben als Escape geschrieben.
*Preis:* Eine weitere Prüfung im Tor, die auf einem sauberen Baum nichts findet — also selbst dem Verdacht unterliegt, den sie behandelt. Sie wurde deshalb gegen ein eingesetztes Byte verifiziert, und ihre Meldung nennt die Datei und die Schreibweise, die stattdessen gemeint war.

**E-147 — Eine Sperre nennt ihr eigenes Ziel, weil keine Prüfung es aus dem SQL lesen kann.**
*Kontext:* E-143 führte die Sperrreihenfolge samt Prüfung ein. Der Tor-Agent des `token`-Features hat zwei Fehler darin belegt. Erstens lief die Prüfung **gar nicht in CI** — ich hatte Skript und Regel geliefert und das Verdrahten vergessen, während `CLAUDE.md` und `DOCUMENTATION.md` beide behaupteten, sie werde erzwungen. Zweitens erkannte sie fünfzehn wörtliche Tabellennamen, und **jedes** Repository dieses Entwurfs baut seinen Tabellennamen aus dem konfigurierten Schema. Eine gepflanzte Sperre auf `${table}` blieb grün; eine Verkürzung des Kommentars über einer korrekten Sperre erzeugte einen Fehlalarm.
*Verworfen:* (a) Die Interpolation auflösen und die Variable zurückverfolgen. (b) Die Liste der Nicht-Nutzer-Tabellen erweitern.
*Grund:* Beide Varianten kämpfen gegen dieselbe Tatsache an: Der Tabellenname steht zur Prüfzeit schlicht nicht da. E-143 hatte das als hingenommene Grenze notiert — die Prüfung ließ eine Sperre durch, deren Ziel nur aus einer Variablen bestand — und dabei übersehen, dass das nicht der Randfall ist, sondern **der Normalfall**. Damit bestand die Prüfung für die *Abwesenheit* eines Namens statt für die Anwesenheit des richtigen. Wer nicht lesen kann, muss fragen: Die Anweisung erklärt jetzt selbst, was sie sperrt, in derselben Blockform wie die Eigentümer-Markierung aus E-145.
*Preis:* Eine Sperre ohne Erklärung wird abgewiesen, auch die korrekte — das ist beabsichtigt, weil eine nicht erklärte Sperre genau die ist, über die niemand nachgedacht hat. Und die Erklärung ist eine Behauptung des Autors: Wer `/* locks: user */` über eine Sperre auf `session` schreibt, kommt durch. Die Prüfung erzwingt, dass jemand die Frage beantwortet, nicht dass die Antwort stimmt. Dasselbe gilt für die Markierung aus E-142, und beide Male ist der Wert derselbe: Die Behauptung steht im Code, wo sie beim Lesen auffällt, statt in niemandes Kopf.


**E-148 — Eine Fundstelle, die auf den falschen Eintrag zeigt, wird von Hand gefunden, weil keine Prüfung sie finden kann.**
*Kontext:* Abschnitt 6 der Regeln nennt die schlimmste Fehlerart des Protokolls beim Namen: eine Fundstelle, die nicht ins Leere zeigt, sondern **auf den falschen Eintrag**, und die `test/decision-log.test.ts` deshalb nicht sehen kann — der Test kennt nur Nummern, die es nirgends gibt. Eine Handdurchsicht der siebenundvierzig Fundstellen des Repositoriums hat den ersten belegten Fall gefunden. `src/core/keys/root-key-provider.ts:104` begründete die exportierbaren Verschlüsselungsschlüssel mit E-03. E-03 entscheidet, welche Primitive auf `crypto.subtle` laufen statt auf `@noble/*`; die Rückfallebene kommt dort nur im Preis vor. Die Entscheidung, die diese Zeile trägt, ist E-60, und deren Grund schreibt sie wörtlich aus: „`rootKeyProvider` importiert die vier Verschlüsselungszwecke als `extractable`. Die beiden Signierzwecke bleiben nicht exportierbar, weil sie den Rückfall nicht brauchen."
*Verworfen:* (a) Eine Prüfung bauen, die eine Fundstelle gegen den Text des genannten Eintrags hält. (b) Es dabei belassen, weil E-03 verwandt ist und der Kommentartext selbst stimmt.
*Grund:* (a) scheitert genau an diesem Beispiel. Ein Abgleich über gemeinsame Wörter hätte E-03 **bestätigt**, nicht verworfen: Dessen Preis enthält „Rückfall" und „`@noble/ciphers`" — dieselben Wörter wie der Kommentar. Der falsche Eintrag schneidet hier besser ab als der richtige, weil er die Wörter teilt und nur die Aussage nicht. Wer entscheiden will, ob ein Eintrag eine Zeile trägt, muss beide lesen. (b) unterschätzt, was eine Fundstelle leistet: Sie ist eine Abkürzung für den Leser, der wissen will, warum eine Zeile so aussieht. Wer dieser hier folgt, landet bei einer Leistungsentscheidung und schließt daraus, die Exportierbarkeit sei um der Geschwindigkeit willen gewählt — statt bei der Zusage, ohne die die Rückfallebene nicht existieren könnte. Er nimmt sie dann beim nächsten Umbau als verhandelbar an. Verwandt genug, um plausibel zu wirken, ist die schlechtere Lage und nicht die bessere; eine offensichtlich absurde Nummer wäre beim Lesen aufgefallen.
*Preis:* Die Durchsicht ist der Mechanismus, und sie skaliert nicht — dreizehn Fundstellen in `keys`, siebenundvierzig im Repositorium, alle einzeln gelesen, und beim nächsten Mal wieder. Sie sagt außerdem nichts über die Module, die sie nicht gelesen hat. Und eine zweite Fundstelle blieb bewusst stehen: `src/core/keys/base64url.ts` zitiert auf dem Zweig `feature/token` E-62 für den Kodierer, obwohl E-62 den **Dekodierer** entschieden hat; der Kodierer wurde von einem Eintrag aus dem Bereich der Welle 2 dorthin gelegt, dessen Nummer auf `main` noch nicht existiert und hier deshalb nicht ausgeschrieben steht — sie zu zitieren hieße, eine Fundstelle ins Leere zeigen zu lassen. Auf `main` steht in der Datei noch gar keine Nummer. Die Datei zu ändern hieße, einem offenen Zweig einen Konflikt in eine Zeile zu legen, die er selbst gerade bearbeitet; die Fundstelle wird gemeldet und dort behoben, wo sie entsteht.

### A parameter list needs at least one non-empty value
`E-160` · password · phc parsing, frozen

**Context.** The PHC grammar lets a parameter carry an empty value, and the salt field of an imported `$fbscrypt$` string carries Base64 padding. Together those make the field `aac=` ambiguous: readable as the parameter `aac` with no value, and as a padded salt. Guess wrong and salt and hash shift by one field; the verifier then fails with no error at all and reports "wrong password".
**Rejected.** (a) Forbidding padding in the salt and hash fields, as the PHC specification itself does. (b) Counting the fields from the right.
**Reason.** (a) would have broken the adoption of Supabase and Firebase estates: GoTrue stores `$fbscrypt$…$<salt_b64>$<hash_b64>` with padding, and section 4.4 requires exactly that string be taken over unchanged. (b) fails because the hash field is optional — counted from the right, a salt without a hash cannot be told from a hash without a salt. A field therefore counts as a parameter list only when at least one pair carries a non-empty value. None of the eight schemes in 3.3 uses an empty parameter value, and the padding consists of nothing but empty values.
**Price.** A future scheme whose only parameter is deliberately empty would be read as a salt. That stands in the reference, and the switch is a closed enumeration — such a scheme could not arrive unnoticed.

### The password module's Base64 codec is its own code beside the key module's
`E-161` · password · encoding, duplication

**Context.** `src/core/keys/base64url.ts` already holds a hand-written decoder. It uses the URL alphabet, while PHC wants the standard one with `+` and `/`, and it is deliberately strict: only the canonical spelling is accepted, so that a mistyped root key is noticed instead of quietly decoding to the same bytes.
**Rejected.** Extending the existing decoder with an alphabet argument and a strictness argument, and using it from both modules.
**Reason.** Two reasons, one formal and one substantive. Formally the file belongs to the key module merged in wave 1; changing it lies outside this building block's file ownership (rules §5). Substantively the two requirements pull against each other: an imported PHC string may bring either spelling, a root key may not. A shared codec would have to make strictness a parameter and so soften the exact place where it counts — a wrongly set argument would be silent there.
**Price.** Two Base64 implementations in the core, some sixty duplicated lines. Whoever repairs a corner of one has to look at the other.

### An unknown core count falls to the ceiling, not to one
`E-162` · password · concurrency, superseded by E-183

**Context.** S-DOS-3 sizes the semaphore at `min(4, cpus)`. The core may not use `node:os` (rules §7), which leaves `navigator.hardwareConcurrency` — absent under Node 20.19, the lower build boundary.
**Rejected.** Falling back to 1 when the core count is unknown.
**Reason.** 1 would be the careful choice for memory and the wrong one for everything else: on every Node 20 installation exactly one password verification would run at a time, four concurrent sign-ins would queue at 90 ms each, and L-1's wait limit would be reached under a load that is not load. The ceiling of 4 is also the number the documentation names as the memory bound (4 × 19 MiB), so the fallback promises nothing that is not already promised.
**Price.** On a two-core machine under Node 20, up to four Argon2id calls run instead of two. That is not a memory problem, but it means more context switching than necessary; whoever objects sets `concurrentHashLimit` explicitly.

### The `validate` hook receives the normalised form and does not get to explain itself
`E-163` · password · policy hook, frozen

**Context.** L-7 gives exactly one hook for an application's password policy. Two things were open: which form of the password it sees, and what becomes of its exception.
**Rejected.** (a) Giving it the raw input. (b) Passing its exception through so the application can show its own reason.
**Reason.** (a) would have created the case where a check against a leak corpus runs on a string that is never stored that way — the derivation always works on the NFKC form per 3.3. A hit would then depend on spelling, which is precisely what normalisation is there to remove. (b) contradicts rules §3: what the outside learns is decided by `error-map.ts` and by nothing else. A foreign exception passed through would become `internal_error` with status 500 at the main gate — the wrong answer for a rejected password policy.
**Price.** The caller gets `password_unacceptable` with the text "The password does not meet the length requirements.", even when the length was fine and the hook refused for an entirely different reason. That text belongs to `error-map.ts` and lies outside this building block; the inaccuracy is in the reference and has been reported.

### The length check measures three times, in ascending order of cost
`E-164` · password · input limits, superseded by E-181

**Context.** L-7 names two limits in two different units — 8 characters and 4096 bytes — and 3.3 requires NFKC normalisation before every KDF call. Normalisation therefore sits between the two measurements, and it is not free itself: normalising a one-megabyte "password" costs memory and time before any limit bites.
**Rejected.** Normalising first and checking both limits afterwards.
**Reason.** The second attack vector in 5.18 (a) is exactly input length, and it lands before the KDF. So the count of UTF-16 code units is measured first against the byte ceiling: a UTF-8 encoding is never shorter than that count, so the check rejects nothing that would have passed, and it needs no allocation at all. Only then is the value normalised, then characters counted, then bytes — that measurement last, because NFKC can lengthen a compatibility character.
**Price.** Three measurements instead of two, and the first is an estimate that has to be explained to a reader. Its comment is one of the few places in the module where a sentence of prose is needed.

### The sign-in path takes the length policy, not the configuration
`E-165` · password · policy hook, frozen

**Context.** L-7 requires that `validate` run when setting and changing a password and never at sign-in. That could be written as a rule and held by a check.
**Rejected.** One shared function with a `runValidateHook: boolean` switch.
**Reason.** A switch is a rule someone can set wrongly, and the fault would be silent: the hook would run on the hot path, the plaintext password would reach foreign code on every sign-in, and nothing about the answer would change. Instead the sign-in entry point takes the type `PasswordPolicy` with exactly two fields. There is no `validate` there to call — the guarantee is in the type and not in a check.
**Price.** Two entry points instead of one, and `acceptNewPassword` calls `acceptSubmittedPassword`, which sounds briefly wrong on reading. The inner name describes where the input came from, not the operation.

### The semaphore's refusal carries no retry hint
`E-166` · password · errors, frozen

**Context.** `rate_limited` is the same error code the rate limiter of 3.9 uses, and that one sets `retryAfterSeconds` and the `Retry-After` header per E-130. The semaphore can throw the same code for a different reason.
**Rejected.** Passing the remaining wait limit as `retryAfterSeconds`, so that every `rate_limited` answer carries the same field.
**Reason.** The semaphore knows only that the queue was full, not when it will empty — that depends on how much longer the running derivations take and how many requests stand ahead of this one. A number derived from the wait limit would be an invention, and a client that obeys it either waits too long or runs straight back into the same queue. A missing field says "unknown"; a guessed one says something false with the authority of a header.
**Price.** Two refusals with the same code behave differently — one carries `Retry-After`, the other does not. A caller who treats the field as guaranteed has to treat it as optional; that is in the type and in the reference.

### The wait limit runs on a timer, not on the configurable clock
`E-167` · password · scheduling, frozen

**Context.** Per 6.19 the core reads time only through the configuration option `clock`, so that expiry and window tests are deterministic. The semaphore's wait limit is not an expiry time though, but a duration that has to pass while the process works.
**Rejected.** Checking the wait limit against `clock.now()`, in a loop or when a place falls free.
**Reason.** A check when a place falls free does not bite: if no place falls free — exactly the case the limit catches — the check never runs. A loop would be a timer with extra steps. Section 6.19 exempts this case explicitly: "`vi.useFakeTimers` is needed only for the semaphore's wait limit (S-DOS-4), because it runs on a timer and not on `clock`."
**Price.** A test of the wait limit has to drive the timers and cannot use the same configurable clock as the other time tests. Two time mechanisms in one test plan, and whoever needs both in one test drives both.

### The accelerator is used only for Argon2 version 1.3
`E-168` · password · accelerator, frozen

**Context.** 2.7 promises that `hash-wasm` produces byte-identical output and that switching needs no migration; S-DEFAULT-7 makes that a requirement. A cross-check over both versions showed otherwise: `hash-wasm` accepts the `version` option and **ignores it**. For `version: 0x10` it returns the same result as for `0x13`, while `@noble/hashes` correctly returns two different values.
**Rejected.** (a) Treating the divergence as immaterial, because the library itself only ever creates 0x13. (b) Not verifying version 1.0 at all any more.
**Reason.** (a) is precisely the fault S-DEFAULT-7 exists to prevent: whether `hash-wasm` is installed would decide whether an imported Argon2 1.0 hash verifies — the same sign-in would pass on one server and fail on another. (b) would have locked out an estate that 3.3 requires be verifiable. The accelerator is therefore chosen only for 0x13; every other version runs the pure path. That is the only shape in which the presence or absence of the dependency changes nothing but runtime.
**Price.** The choice of engine now depends on a field of the stored string, not only on the environment. A reader has to know why — the comment says so, and the cross-check stands beside it as a test.

### `$2x$` is verified as `$2a$`
`E-169` · password · legacy schemes, frozen

**Context.** The switch in 3.3 carries four bcrypt prefixes. `bcryptjs` knows three of them and throws "Invalid salt revision" on `$2x$`. An imported `$2x$` hash would therefore be permanently unverifiable and every sign-in on it a silent failure.
**Rejected.** (a) Letting `$2x$` fail and sending the user down the reset path. (b) Reimplementing the crypt_blowfish variant.
**Reason.** `$2x$` and `$2a$` differ only in how crypt_blowfish handled bytes with the high bit set. For an ASCII password both derivations are identical; for any other they cannot agree by accident — the rewrite can turn a certain false rejection into a correct answer and can never produce a false acceptance. (a) would have discarded an estate that consists mostly of ASCII passwords. (b) would mean pulling a known faulty implementation into the core to serve an edge case; that is the wrong place for the effort.
**Price.** A `$2x$` password with non-ASCII characters still fails and leads to the reset path. The library cannot say which of the two cases it is holding, and the answer is the same in both — which it has to be.

### The optional dependency's specifier is assembled, not written
`E-170` · password · accelerator, superseded by E-180

**Context.** `hash-wasm` is an optional peer dependency. As a string literal in `import()` it produces two findings: the main gate's dead-code check reports "Referenced optional peerDependencies" and fails, and a caller's bundler tries to resolve at build time a package that is allowed to be absent.
**Rejected.** (a) Listing `hash-wasm` under `ignoreDependencies` in `knip.json`. (b) Not looking for the accelerator at all, but taking it through the configuration.
**Reason.** (a) is the cleaner solution and the one that actually belongs; but `knip.json` belongs to no feature of this wave, and the file ownership in rules §5 is binding — a building block that touches a shared configuration file while three others run in parallel creates exactly the conflict the rule prevents. That is the immediate reason and it is named as such rather than reinterpreted afterwards as a technical one. The second, independent reason carries on its own: a bundler that wants to resolve a deliberately absent package breaks the build of a caller who uses the library without the accelerator. (b) contradicts 2.7, where the dependency is found and not handed in.
**Price.** The specifier is no longer visible at build time. No tool — not the bundler, not the dead-code check, not a dependency analysis — sees the edge; whoever removes `hash-wasm` from `package.json` gets no warning, just a slower library. That is a real loss of traceability, and the recommendation to the main gate is to add `hash-wasm` to `knip.json` and bring the literal back afterwards.

### The published Firebase test vector lives in the repository; everything else is drawn per run
`E-171` · password · test fixtures, frozen

**Context.** Passwords and derived hashes do not belong in a checked-in fixture; the key fixtures of wave 1 therefore draw their material fresh on every run. For `$fbscrypt$` though, 4.4 d) explicitly requires a test vector, because swapping `n` and `r` produces **no error**, only hashes that never match.
**Rejected.** Generating the fbscrypt case entirely by ourselves too.
**Reason.** A self-generated vector proves only that the verifier agrees with its own derivation. That is exactly the fault pitfall 1 describes: derivation and check would both be swapped, the test green, and the first real Firebase estate would fail silently. The vector comes from the public reference implementation, belongs to an invented `user1` and is nobody's credential.
**Price.** A string in the repository that is formally a password and a hash over it. It is marked as such and carries its source; whoever reads the rule literally sees an exception, and it stands here so that it is not missed on a review pass.

### The brand type `Secret<…>` is created in the password module
`E-172` · password · types, reported

**Context.** S-TIM-3 forbids `===`, `startsWith`, `includes` and `localeCompare` on a value of type `Secret<…>`, and T-TIM-3 checks that statically. The specification defines the type nowhere, and no previous wave introduced it — so the check would have found nothing and been green, because there were no branded values.
**Rejected.** Leaving the type where it belongs, in a shared module, and building it together with the module that needs it second.
**Reason.** A static check that finds nothing because there is nothing to find is exactly the case rules §5 names as "green because it applied to no file". The type is therefore created where the first branded value is created: at the output of the KDF. A shared location would be a file outside this building block's ownership.
**Price.** The type sits in the wrong module. As soon as the session or the factor module needs it, it has to move, and the move touches a file that then belongs to two building blocks. That is reported.

### A missing `v=` field means Argon2 version 1.0
`E-173` · password · phc parsing, frozen

**Context.** The PHC string of an imported Argon2 hash need not carry the version field. What holds in its absence decides whether the hash verifies.
**Rejected.** Reading a missing field as 1.3, because that is the only version the library creates itself.
**Reason.** Argon2's reference decoder (`argon2_decode_string`) sets version 1.0 when `v=` is absent, and every tool that produced such strings produced them under that assumption. Assuming 1.3 would be convenient and would derive every one of those hashes wrongly — again with no error, again as "wrong password".
**Price.** The library therefore verifies a version it never creates, and the accelerator cannot compute it (E-168). Together that means an estate without the version field runs slower than one with it. After the first sign-in it is lifted to Argon2id 1.3 anyway.

### The path without a user still asks for a credential, and asks for the nil UUID
`E-174` · password · timing, frozen

**Context.** S-TIM-1 requires the same sequence of database and KDF calls for existing and non-existing identifiers, and T-TIM-1b checks four cases for byte-identical call sequences. Resolving the user belongs to another building block; this one is handed a user id or `null`.
**Rejected.** Skipping the credential query on `null` and making only the KDF call against the dummy.
**Reason.** The sequence would then be exactly one query shorter — measurable, and in a range (0.1–2 ms per 5.1 (a)) that becomes visible over the network with a few hundred samples. The dummy KDF call would have covered the larger difference and left the smaller one standing. The query therefore always runs, and when there is no user id it runs with the nil UUID: a syntactically valid `uuid` that `gen_random_uuid()` does not produce and that hits the same primary key index as any other.
**Price.** One database query per sign-in attempt on a non-existent identifier that never returns a row. That is an index lookup with no hit, and it is exactly the lookup the real case makes too. Creating the row with the nil UUID would destroy the uniformity — it cannot be created, because `velve.user` has no such row and the foreign key forbids it.

### An unreadable key version is not disguised as a wrong password
`E-175` · password · key ring, superseded by E-179

**Context.** Per L-2 the PHC string is stored encrypted. If the named key version is missing from the ring, the key module throws `key_version_unknown` (S-KEY-4). Per L-1 the verification path would properly have to fold that into the same uniform failure answer as any other failure.
**Rejected.** Catching the exception and refusing the sign-in as `invalid_credentials`.
**Reason.** The case arises only after an operator error — someone removed a key version from the ring under which rows are still written. Disguised as "wrong password" it would be a silent mass lockout: every affected user would get the same answer as for a typo, the log would say `password_mismatch`, and nobody would think of the key ring. As a named error it is loud, immediately visible and fixed in a minute by putting the version back. That is what S-KEY-4 is for.
**Price.** A deviation from uniformity, and it is named: while the operator error stands, the answer for an account with a dead key version (500) differs from the answer for a non-existent account (401). An attacker could enumerate in that window — but only after the operator has already locked the affected accounts out, and the window is exactly as long as the operator needs to notice a very loud error.

### A legacy scheme that is no longer accepted is computed anyway
`E-176` · password · timing, frozen

**Context.** `acceptLegacy` narrows the estate: whoever drops bcrypt wants no more bcrypt sign-ins. The obvious implementation checks the scheme after reading the row and refuses before any KDF runs.
**Rejected.** Exactly that — refuse early, waste no KDF call.
**Reason.** The early refusal would be a whole KDF call faster than any other answer and so an oracle with a 50 to 250 ms signal — not for whether an account exists, but for whether it came from the import. That is a list an attacker wants: accounts with an old hash are the ones with the old, often reused password. So this case runs over the dummy too, with the same parameters, through the same semaphore.
**Price.** An operator who empties `acceptLegacy` pays the same memory and the same time for every sign-in on a retired credential as for a real one. That is the price of the retirement being invisible from outside, and the right way out of the state is the reset path anyway, not starving the verification path.

### The column and the credential must name the same function
`E-177` · password · scheme switch, frozen

**Context.** `acceptLegacy` is evaluated on the cleartext column `scheme` — per L-2 the only field readable without a key, and the one that makes the estate surveyable. The Argon2 verifier, by contrast, took its variant from the identifier **inside** the decrypted credential. The reviewer played it out: a row with `scheme='argon2id'` whose content is `$argon2i$…` is answered `verified` under `acceptLegacy: []`. An operator who has turned off every legacy scheme still verifies Argon2i and Argon2d.
**Rejected.** (a) Evaluating the policy on the decrypted identifier instead of on the column. (b) Correcting the column against the content on read.
**Reason.** (a) would have given up the surveyability L-2 explicitly buys: whoever wants to know how many bcrypt rows are left could no longer run `SELECT scheme, count(*)` but would have to decrypt every row. (b) would have created a silent write on the verification path and covered the disagreement instead of answering it. Instead the match is now a precondition: the PHC identifier must repeat the column verbatim, or the switch answers `false`. The check sits in `overPhc` and so covers all seven PHC schemes at once, not just Argon2.
**Price.** A row whose column does not match its content because of a faulty import is no longer verifiable — it would have worked before. That is intended and leads to the reset path: a credential the database claims something else about than it claims itself is not one to issue a session on.

### No lookup in the module reads a name off `Object.prototype`
`E-178` · password · lookup tables, frozen

**Context.** The switch was an object literal indexed by the `scheme` column; the PBKDF2 digest table likewise, indexed by the identifier of the parsed credential. `constructor` resolves on both to a function, and `await Object(password, stored)` returns an object the caller reads as a hit. The second case is the reachable one: the identifier comes out of the stored string, `constructor` passes the identifier regex, and only a later fault on the derivation path turned it into `false`.
**Rejected.** (a) Checking the return value for `=== true` at the end. (b) `Object.create(null)` as the tables' prototype.
**Reason.** (a) would have caught the symptom value and left standing the call of an arbitrary inherited function with the password as its first argument. (b) would be correct, but the type would still say "object with arbitrary keys", while `Map` records in its signature which keys exist and returns `undefined` for every other. The same holds for the check that the accelerator has its three functions: it now asks `Object.hasOwn` before it reads.
**Price.** Three lookup tables are longer to write than a literal, and `Map` allows no `as const` inference of the key type — it now stands twice, in the type argument and in the entries. The reviewer found the case, not the author; that stands here because it bears on how much the module's other lookups can be trusted.

### A dead key version is reported at startup, not at sign-in
`E-179` · password · key ring, supersedes E-175

**Context.** E-175 deliberately passed the key module's exception upward, so that a removed key version would not vanish as "wrong password". The reviewer held two things against it. First, the `throw` violates S-TIM-1 literally: between step 2 and step 4 there is neither `return` nor `throw`, without qualification. Second — and E-175 does not name this — that very branch splits users into "written before the rotation" and "written after", and so is an enumeration channel throughout every rotation window, not only after an operator error.
**Rejected.** (a) The `throw` stays (E-175). (b) The failure is disguised as `invalid_credentials` and nothing else.
**Reason.** The choice between (a) and (b) was posed wrongly; both answers lie on the request path, and the report does not belong there. It is addressed to the operator, not to the user, and it is right once instead of on every sign-in. `assertStoredKeyVersionsAreKnown` reads the present `key_version` values from `password_credential` and holds them against the ring — one query, at assembly, loud, with the missing versions in the error. The sign-in path then swallows the failure silently and carries on verifying against the dummy string that is kept in the open, so with **one** decryption attempt and **one** verifier call like every other case.
**Price.** The dummy additionally holds its PHC string in cleartext in memory. That is the hash of a randomly drawn value and nobody's password, but it is a second representation of the same value, and whoever reads the memory sees it. The second price: the startup check belongs to assembly, and assembly does not belong to this building block — it is exported and has to be called. Until that happens, the operator error is silent.

### The accelerator's specifier is a literal again
`E-180` · password · accelerator, supersedes E-170

**Context.** E-170 assembled the specifier because `knip.json` belongs to no building block of this wave and the dead-code check reports a referenced optional peer dependency as a finding. That entry explicitly asked for the change to be undone; `main` now carries `hash-wasm` in `ignoreDependencies`.
**Rejected.** Keeping the assembly, because it also stops a bundler resolving a deliberately absent package.
**Reason.** The second reason in E-170 does not carry as far as it was written there, and the price was larger than named: not only the dead-code check fails to see the edge, but so does every dependency and security scanner. An advisory against `hash-wasm` would never have surfaced as "affects this line", and the reviewer could not instrument the accelerator under its real name without breaking the gate. A dynamic import is not a static one anyway; a bundler that cannot resolve it warns instead of failing.
**Price.** The exemption now sits in a file no feature owns, and has to stay there. Whoever ever removes `hash-wasm` from `package.json` has to touch `knip.json` too, or the check reports an exemption for a package that does not exist.

### The cheap pre-check is a bound, not a measurement
`E-181` · password · input limits, supersedes E-164

**Context.** E-164 justified the first of the three measurements with the claim that a UTF-8 encoding is never shorter than the count of UTF-16 code units. That is true — for the same string. But the check compares the code units of the **raw** input against the byte ceiling of the **normalised** form, and NFKC can compose: `U 0308 0301` is three code units and five bytes and becomes one code unit and two bytes. `"Ǘ"` in decomposed spelling, repeated 1400 times, is 4200 code units and normalises to 2800 bytes — the policy allows it, the pre-check refused it. Not a hole but a lockout, and precisely for the inputs normalisation exists to serve.
**Rejected.** (a) Dropping the pre-check and always normalising first. (b) Measuring the raw UTF-8 length first and comparing that.
**Reason.** (a) would have reopened the second attack vector of 5.18 (a): a one-megabyte "password" would be normalised before any limit bites. (b) has the same fault as before, only in the right unit — the raw byte length is not the normal form's either. There is no cheap exact measurement; there is only a bound. UAX #15 bounds the shrinkage from canonical composition in UTF-8 by a factor of three, and the pre-check computes with four. So it rejects nothing that would have passed, and it still keeps out everything large enough to do harm.
**Price.** In the boundary case the library normalises up to 16 KiB instead of 4 KiB before it refuses. And the number four is a safety margin over a guarantee of the Unicode standard, not over anything this code recomputes — should Unicode change that guarantee, nobody here would notice.

### A stored cost parameter has a ceiling, and it is not configurable
`E-182` · password · cost ceilings, frozen

**Context.** S-DOS-3 promises that occupied memory does not exceed semaphore size times memory parameter. But the memory parameter sits per record in the stored string, and whoever writes it is the import. `m`, `ln` and `i` were allowed up to ten digits and ran into the KDF unchecked; `needsRehash` compares only **downwards**. The real bound was therefore the largest value any import ever wrote.
**Rejected.** (a) Deriving the ceiling from the configured Argon2id parameters. (b) Carrying it as another configuration option.
**Reason.** (a) would have refused every imported hash stronger than the local policy — exactly the estates one least wants to force into a reset. (b) would be a switch whose only upward movement is a weakening; per S-DEFAULT-1 it would have to be set explicitly and logged at startup, and the case is too rare for that. The limits are fixed, with room above everything the five sources in section 4 actually deliver: 64 MiB of memory against 32 MiB for Better Auth's scrypt and 16 MiB for Firebase, two million PBKDF2 rounds against Django's 1.2 million.
**Price.** An estate over the limit is unverifiable and leads to the reset path — with no configuration option, so no way out for the operator but a bug report. That is deliberate: a number that was only guessed and never measured belongs in a report with data beside it, not in an option.

### Without a reported core count the answer is one
`E-183` · password · concurrency, supersedes E-162

**Context.** E-162 fell back to the ceiling of 4 when the core count is unknown, and named throughput as the reason. The reviewer held the requirement against it: S-DOS-3 says `min(4, cpus)`, and T-DOS-3 measures exactly that. On a one- or two-core container 4 is not the ceiling but a breach of it — the default misses the requirement it is about, and on the sort of machine where memory is tightest.
**Rejected.** (a) Staying at 4 (E-162). (b) Using `node:os.availableParallelism()`, which Node 20.19 has. (c) Reading `process.availableParallelism` — which does not exist, the function sits on `node:os`.
**Reason.** (a) misses the requirement. (b) would mean pulling a `node:` import into the core, which per section 2.6 assumes Web standards; it would have to be loaded dynamically, and `resolvePasswordConfig` answers synchronously. (c) was simply wrong and was caught while writing this up — recorded here because the first attempt at this correction failed on exactly that. What remains is `navigator.hardwareConcurrency`, and where that is absent, the careful number.
**Price.** On Node 20.19 — the lower build boundary — exactly one password verification runs at a time without an explicit setting, and four concurrent sign-ins queue at 90 ms each. That is the throughput collapse E-162 wanted to avoid. It now stands in the reference with the instruction beside it: whoever runs on Node 20 sets `concurrentHashLimit`.

### The input length ceiling has three faults, so three codes
`E-184` · password · errors, frozen

**Context.** `maximum_length_above_ceiling` was thrown for three different cases — above 4096, below `minimumLength`, and not an integer — and the message named only the first. Whoever triggered the second got a text that said nothing about their configuration.
**Rejected.** Rewording the message so that it covers all three cases.
**Reason.** An error code is a machine-readable statement (rules §3), and folding three causes under one code makes it worthless to the caller — it cannot decide which field to touch. A collective text would have had the same problem in prose.
**Price.** Two more codes in an enumeration a caller has to handle exhaustively when upgrading.

### The upsert states the owner condition instead of letting it follow from the primary key
`E-185` · password · sql, frozen

**Context.** After merging `main`, the static check for S-OWNER-2 reads every statement containing `UPDATE` anywhere — including as `ON CONFLICT … DO UPDATE` inside an `INSERT`, because a data-modifying CTE begins with `WITH` and the anchoring therefore had to go. Writing the credential had no `WHERE` clause: the conflict key `user_id` is at once the primary key and the owner column, so the binding was there, but only to someone who knows the schema.
**Rejected.** (a) Asking the gate to accept `ON CONFLICT (user_id) DO UPDATE` as an owner binding. (b) Splitting the statement into an `UPDATE` preceded by an `INSERT … ON CONFLICT DO NOTHING`.
**Reason.** (a) would have widened the check by a special case whose correctness depends on the conflict key always being the owner column — an assumption that can already be false for the next table. (b) would have made two statements out of one and opened a window between them. Instead the `DO UPDATE` now carries `WHERE credential.user_id = $1`. The condition is redundant to the conflict key and therefore free, and it turns a property of the schema into a statement of the statement. Verified against PostgreSQL 16, because `ON CONFLICT` addresses the target table through the alias and not through the qualified name.
**Price.** A condition that can never be false stands in the statement and has to be recognised as redundant on reading. The comment says why it is there.
**Addendum.** Two things were missing from this entry. First the third option, which the main gate found and which would have been preferable to this one: a marker in the statement per E-142, with which a statement justifies its missing owner condition itself. It was not chosen here because the condition is in fact expressible, and an expressed condition is worth more than a justified omission — but it was the obvious alternative and it was not in the entry. Second, and heavier: `ON CONFLICT … DO UPDATE … WHERE` **does not throw** when its condition is false, it silently changes nothing, and `write()` threw its result away. On the day this tautology stops being one — a `BEFORE INSERT` trigger rewriting `NEW.user_id`, a composite conflict key, or this pattern copied to another table — `setPassword` would have reported success and not stored the password. The statement now carries `RETURNING user_id`, and a row count other than one is an error; `replaceIfUnchanged` two functions deeper had this right from the start. Two of this building block's test fixtures answered the insert with an empty list — so they asserted exactly the failure case and got away with it; that too only the row count exposed.

### Yield to the timer phase, not the microtask queue
`E-186` · password · scheduling, frozen

**Context.** The comment on the tick constant claimed that yielding every 10 ms keeps one derivation from blocking every other request. For the pure path that is true; for the default case with `hash-wasm` installed it is not. The accelerator computes in **one** synchronous WebAssembly call and settles its promise in a microtask — the chain of release the semaphore, admit the next waiter, derive again runs entirely inside the microtask drain and never reaches the timer phase. The gate measured it: 800 concurrent sign-ins against a wait limit of 5000 ms, **14,684 ms total, zero refusals**, and in that time **not one timer in the process fired** — no rate window, no HTTP timeout, no readiness probe. The same flood with `hash-wasm` mocked away: 1 verified, 19 `rate_limited`.
**Rejected.** (a) Documenting that S-DOS-4 does not hold with `hash-wasm`. (b) Splitting the accelerator into blocks, as `asyncTick` does on the pure path. (c) Using `scheduler.yield()` where it exists.
**Reason.** (a) would have given up a requirement in the default position — the dependency is optional, but it is installed the moment somebody lists it, and then the library behaves differently from what it promises. That is exactly what S-DEFAULT-7 forbids. (b) is not possible: the call is a single WASM function with no entry point in the middle. What works is yielding **between** derivations, and that suffices: the 20 ms block of a single call is shorter than the 10 ms × several rounds of the pure path, and the timers run in between. (c) fails on two counts that have nothing to do with which phase it reaches. In this runtime `globalThis.scheduler` does not exist at all; `scheduler.yield()` is reachable only from `node:timers/promises`, and section 2.6 has the core assume Web standards rather than Node builtins, so importing it is not open to this module. And `setTimeout` is the very primitive the wait limit itself uses — yield and deadline then sit in one queue and cannot outrun each other, which no other yield gives.
**Price.** One timer round per derivation, so about one millisecond in twenty — roughly five per cent of what the accelerator buys. And the library now yields differently in two places depending on the engine; whoever changes one has to remember the other. The test plan records it: the case runs against the engine the runtime actually chooses, and fails if that engine starves the timer phase.
**Addendum.** The reason first written down here for rejecting (c) was false, and it is left standing above the correction rather than quietly swapped: it said `scheduler.yield()` "returns to a continuation queue, and what has to run here is the timer phase". That is true of the browser Prioritized Task Scheduling API and false of Node, where the implementation is `setImmediate`-based and reaches the timer phase perfectly well. Measured on this repository's runtime — Node 26.8.1, 30 accelerated derivations against a 10 ms interval, three runs, identical every time: no yield → 0 timer firings, `setTimeout(…, 0)` → 29, `setImmediate` → 29, `scheduler.yield()` → 29, `queueMicrotask` → 0. The shipped decision is unchanged and the two reasons that do carry it are now in the entry. The lesson is the cheaper one: a rejection that names a mechanism is a claim about behaviour, and this one was never run.

### The column is held against the credential at write time too
`E-187` · password · scheme switch, frozen

**Context.** E-177 made the match of the `scheme` column and the PHC identifier a precondition of verifying. On the write side it did not exist: the caller — the core on registration, the importer writing an estate — could store any combination. A row with a contradictory column is per E-177 permanently unverifiable, and the user learns that as "wrong password" without an error standing anywhere.
**Rejected.** (a) Dropping the `scheme` parameter and deriving it in the repository from the string. (b) Leaving it at read time and warning the importer in the documentation.
**Reason.** (a) would be the tightest form and would have made the contradiction impossible instead of merely forbidden; rejected because eight call sites in this building block's tests pass the column explicitly and passing it is exactly what the test wants to check — a derived value could no longer be wrong and so could no longer be checked. (b) shifts a fault the library finds in one row onto the operation of somebody else's estate. So the repository checks the match before it encrypts, and throws `scheme_does_not_match_credential`. That is also the first caller of `schemeOfStoredHash` in `src/` — the function carrying the switch from 3.3 had until then only tests.
**Price.** The importer can no longer store a row "as it came" when source column and source string disagree; it has to decide, and the decision is its own. For the case where a source delivers both and both contradict, there is now no silent path — only an error at import or one record fewer.

### `concurrentHashLimit` lowers the bound and never raises it
`E-188` · password · configuration, frozen

**Context.** The reference promised that every limit of this module points in the safe direction and that an attempt to weaken one is refused. For the semaphore that was untrue: `resolvePasswordConfig({ concurrentHashLimit: 100_000 })` was accepted and thereby asserted a memory bound of 1855 GiB — on exactly the S-DOS-3 argument the paragraph rests on. bcrypt came on top: the four cost limits of E-182 applied to "every stored credential", except bcrypt has no memory parameter and was not among them. An imported `$2a$31$` row occupies a semaphore place for hours.
**Rejected.** (a) Weakening the promise in the reference instead of binding the code. (b) Deriving the ceiling for `concurrentHashLimit` from the reported core count, so that a 64-core machine gets more.
**Reason.** (a) would have saved the statement and given up the requirement. S-DOS-3 names `min(4, cpus)` as **the** bound of the library, not as a starting value, and T-DOS-3 measures exactly that — an installation with a higher value does not meet the requirement, however large the machine. (b) would have moved the same problem into a formula. The option now lowers and never raises; whoever needs more concurrent derivations runs more processes. For bcrypt the cost number is the only available bolt, and 14 is four steps above what GoTrue, Auth0 and Clerk write.
**Price.** Two values a configuration used to accept are now startup errors, and an estate with bcrypt cost above 14 is no longer verifiable and goes down the reset path. The second price is more honestly named: both gaps stood in the reference as a promise before they stood in the code — the documentation ran ahead of the code, and that is the order in which a promise becomes false.

### The decision log turns English, and its backstop learns to read both forms
`E-189` · password · decision log, frozen

**Context.** The log was German by rule, because it continued the specification's own log verbatim. That rule was reversed centrally: entries are written in English from here on, in a headed form — `### title`, then `` `E-nn` `` with owner and tags, then `**Context.** / **Rejected.** / **Reason.** / **Price.**`. `test/decision-log.test.ts` recognises only `**E-nn — title**` with the four German labels. Converting this feature's twenty-nine entries under that test does not fail loudly; the converted entries simply stop being entries, and every `E-160` to `E-188` cited from code, tests and the reference then resolves to nothing.
**Rejected.** (a) Converting every entry in the file, so that only one form has to be recognised. (b) Leaving this feature's entries German and converting nothing.
**Reason.** (a) touches entries owned by four other features and by the waves before them, which rules §5 forbids and which would collide with every branch still open. (b) would leave the file in the form the rule no longer wants and push the work onto whoever merges next. So the backstop reads both forms and keeps every check it had — the two label sets are matched per entry, so an entry in the new form with a German label missing is still reported as incomplete rather than skipped. Verified the way rules §5 requires: with a planted duplicate number in the new form, with an entry missing `**Price.**`, and with a citation of a number no entry carries. Each failed; then they were removed.
**Price.** Two forms in one file for as long as it takes the other features to convert, and a test that is longer than the thing it checks. The dangling-citation check remains the only guard against a renumber, and it still cannot see a citation that resolves to the *wrong* entry — that is what the reserved ranges are for, not this test.

**E-190 — `IdentityMode` bleibt bei der Migration, das Identitätsmodul importiert ihn.**
*Kontext:* `src/core/db/migrations/identity-mode.ts` definiert den Typ bereits, weil die Migration 2 anhand des Modus eines von drei CHECK-Constraints auswählt. Das Identitätsmodul braucht denselben Typ.
*Verworfen:* Den Typ nach `core/identity/` verschieben und die Migration von dort importieren lassen.
*Grund:* Zwei Gründe, und der zweite ist der ehrlichere. Erstens kehrte der Umzug die Schichtung um: Welle 1 hat die Datenbank gebaut und ist zusammengeführt, Welle 2 baut darauf auf; ein Import aus `core/identity/` in einer Migration hieße, dass die untere Schicht die obere braucht. Der Typ steht außerdem genau dort, wo er wirkt — neben dem SQL, das er auswählt. Zweitens: Der Dateibesitz dieses Features endet bei `src/core/identity/**`, und ein Umzug hätte zwei fremde Dateien angefasst. Der erste Grund trägt auch ohne den zweiten, aber der zweite hat entschieden.
*Preis:* Das Identitätsmodul importiert seinen zentralsten Typ aus einem Migrationsordner. Von außen sieht das nach der falschen Richtung aus und braucht diesen Eintrag als Erklärung.

**E-191 — Die Zeichen-Erlaubnisliste gilt für die Vergleichsform, nicht für die Anzeigeform.**
*Kontext:* Die Vorgabe ist `/^[a-z0-9_-]+$/` (3.15 A.3), und die Anzeigeform behält die Schreibweise des Nutzers (E-17).
*Verworfen:* (a) Die Liste auf die Anzeigeform anwenden. (b) Beide Formen prüfen.
*Grund:* (a) verbietet jeden Großbuchstaben, weil die Vorgabe nur Kleinbuchstaben nennt — `Alice` wäre abgelehnt, und die getrennte Anzeigeform aus E-17 hätte nichts mehr zu erhalten. (b) ist wirkungslos: Die Vergleichsform **ist** die kleingeschriebene Anzeigeform, eine zweite Prüfung prüft dasselbe noch einmal. Entschieden wird auf der Form, die im eindeutigen Index steht — was verglichen wird, muss auch geprüft werden.
*Preis:* Die Anzeigeform kann theoretisch ein Zeichen tragen, das die Liste nicht nennt, solange es beim Falten in ein erlaubtes fällt. Praktisch sind das die Großbuchstaben A–Z; alles andere fällt vorher bei NFKC oder beim Falten heraus.

**E-192 — Zeichen werden vor der Länge geprüft.**
*Kontext:* Ein Benutzername kann gleichzeitig zu kurz sein und ein verbotenes Zeichen tragen; `T-ENUM-8` schickt einen Platzhalter (`*`, `%`) an `GET /username/available` und erwartet `reason: "invalid_characters"`.
*Verworfen:* Länge zuerst, weil sie billiger zu prüfen ist.
*Grund:* Ein einzelnes `*` ist beides — ein Zeichen zu wenig und ein Zeichen zu viel. Mit der Länge zuerst käme `too_short` heraus, und der Prüffall wäre nicht erfüllt. Die Reihenfolge ist damit keine Geschmacksfrage, sondern Teil der Anforderung.
*Preis:* Die Reihenfolge steht nur im Code und in der Referenz; ein Umstellen bricht einen Test, der von außen wie ein Detail aussieht.

**E-193 — Die Erlaubnisliste ist ein `RegExp`, und ihre gefährlichen Formen sind ein Startfehler.**
*Kontext:* 3.15 A.3 schreibt `allowedCharacters: RegExp` vor. Ein Aufrufer übergibt damit ein Objekt mit Zustand.
*Verworfen:* (a) Eine Zeichenmenge statt eines Musters. (b) Das Muster ungeprüft übernehmen.
*Grund:* (a) widerspricht der Vorgabe und nimmt Bereiche weg, die ein Muster mühelos ausdrückt. (b) hat zwei Löcher, die beide still sind: Ein unverankertes Muster prüft einen Teil des Namens und lässt den Rest ungesehen durch — aus einer Erlaubnisliste wird eine Enthält-Prüfung. Und ein Muster mit `g` oder `y` führt `lastIndex` zwischen zwei Aufrufen mit, akzeptiert denselben Namen einmal und lehnt ihn beim nächsten Mal ab. Beides fällt beim Start auf oder gar nicht.
*Preis:* Zwei Regeln, die ein Aufrufer nicht erwartet, und eine Fehlermeldung, die sie erklären muss.

**E-194 — E-Mail-Adressen werden strukturell geprüft, obwohl die Vorgabe keine Regel nennt.**
*Kontext:* 3.4 verlangt für E-Mail nur trimmen, NFKC und `lower()`. Eine Syntaxregel steht nirgends.
*Verworfen:* (a) Gar nicht prüfen und alles speichern, was normalisiert werden kann. (b) Eine vollständige RFC-5322-Grammatik.
*Grund:* (a) schreibt `"   "` oder `"alice"` als Adresse in eine Spalte, die jedes nachgelagerte System für eine Adresse hält — dieselbe Fehlerklasse wie die erfundenen Platzhalter aus E-16, nur ohne Absicht. (b) ist die bekannte Falle: Jede vollständige Umsetzung lehnt irgendwann gültige Adressen ab, und ob eine Adresse existiert, beantwortet ohnehin erst der Bestätigungslink. Geprüft wird deshalb genau so viel, wie eine Adresse von etwas anderem unterscheidet: genau ein `@`, beide Seiten nicht leer, kein unsichtbares oder trennendes Zeichen, höchstens 254 Byte.
*Preis:* Eine Regel, die die Vorgabe nicht kennt. Sie steht in der Referenz, und sie kann eine exotische, aber gültige Adresse ablehnen.

**E-195 — Laufzeit und CHECK werden gegeneinander bewiesen, nicht aus einer Quelle erzeugt.**
*Kontext:* Migration 2 legt je Konfiguration ein CHECK-Constraint an. Dieselbe Regel muss in der Laufzeit gelten, bevor ein `INSERT` scheitert.
*Verworfen:* (a) Das SQL der Migration aus einer Tabelle des Identitätsmoduls erzeugen. (b) Das SQL zur Laufzeit lesen und die Regel daraus ableiten.
*Grund:* (a) wäre die einzige Quelle gewesen und ist die richtige Form, aber sie hätte die Migration umgeschrieben — eine Datei, die diesem Feature nicht gehört und deren Prüfsumme im Migrationsläufer steht. (b) macht eine Sicherheitsregel von einem Textmuster in einer Zeichenkette abhängig; wer das SQL umformatiert, ändert stillschweigend das Verhalten. Geblieben ist eine Tabelle in `columns.ts` und ein Test, der die geforderten Bezeichner aus dem ausgelieferten SQL herausliest, mit ihr vergleicht und zusätzlich gegen eine laufende Datenbank prüft, dass keine erzeugte Spaltenbelegung vom Constraint abgelehnt wird.
*Preis:* Zwei Stellen, die dieselbe Regel nennen, und ein Test als einzige Klammer. Fällt der Test weg, driften sie.

**E-196 — Die Auflösung fragt die Datenbank auch dann, wenn kein Bezeichner gültig ist.**
*Kontext:* `findUserByIdentifier` normalisiert die Eingabe als Adresse und als Benutzernamen; scheitert beides, kann es keinen Treffer geben.
*Verworfen:* Früh `null` zurückgeben und die Abfrage sparen.
*Grund:* Genau dieses frühe `return` ist das Orakel aus 5.1: Eine Eingabe, die die Erlaubnisliste ablehnt, wäre messbar schneller beantwortet als eine, die ein Konto nennt. Ein Angreifer misst damit nicht Kennwörter, sondern reduziert eine Liste. Also läuft immer dieselbe Anweisung mit denselben zwei Parametern, notfalls beide `NULL` — was nie trifft, weil `NULL = x` in SQL nicht wahr wird.
*Preis:* Eine Abfrage, die sicher leer ausgeht, bei jeder Anfrage mit unsinniger Eingabe. Der Test hält die Anzahl der Anweisungen und ihren Wortlaut fest, damit die Ersparnis nicht später „aufgeräumt" wird.

**E-197 — Der aufgelöste Nutzer trägt Wahrheitswerte statt Zeitstempel.**
*Kontext:* `velve.user` hat `email_verified_at` und `disabled_at` als `timestamptz`. Die Auflösung gibt eine Zeile an den Anmeldepfad weiter.
*Verworfen:* Beide Spalten als `Date | null` durchreichen.
*Grund:* Der Treiber ist ein Parameter und kein Import (Abschnitt 2). Ob `timestamptz` als `Date`, als Zeichenkette oder als etwas Drittes in JavaScript ankommt, entscheidet der Treiber; ein Feld vom Typ `Date | null` wäre eine Zusage, die die Bibliothek nicht halten kann. `IS NOT NULL` in SQL liefert `boolean`, und `boolean` dekodiert jeder Treiber gleich.
*Preis:* Wer den Zeitpunkt braucht, liest die Spalte selbst. Für die zwei Fragen des Anmeldepfads — bestätigt, deaktiviert — reicht der Wahrheitswert.

**E-198 — `assertSignInMethodRemains` sperrt die Nutzerzeile, statt nur zu zählen.**
*Kontext:* L-13 verlangt, dass immer ein Anmeldeweg bleibt. Zwei Wege lassen sich gleichzeitig entfernen.
*Verworfen:* Nur zählen und darauf vertrauen, dass niemand zweimal gleichzeitig entfernt.
*Grund:* Ein Nutzer mit Kennwort und einer Identität, der beide gleichzeitig entfernt, liest zweimal „zwei Wege, einer bleibt" und löscht zweimal — danach ist keiner übrig, und L-13 ist ohne einen einzigen Fehler verletzt. `SELECT … FOR UPDATE` auf `velve.user` serialisiert die Entfernungen je Konto; die zweite zählt erst, nachdem die erste festgeschrieben ist, und wird mit `last_sign_in_method` abgelehnt.
*Preis:* Die Funktion verlangt eine Transaktion und nicht irgendeinen Treiber, und sie serialisiert alle Entfernungen eines Kontos. Der Parameter heißt deshalb `transaction`. Die erste Fassung des Tests bewies die Sperre nicht: Zwei Transaktionen über `Promise.allSettled` liefen in der Praxis nacheinander und der Test blieb grün, als die Sperre versuchsweise entfernt wurde. Er prüft jetzt mit `FOR UPDATE NOWAIT` aus einer zweiten Verbindung und scheitert ohne die Sperre.

**E-199 — Die Zählung nimmt die zu entfernende Zeile über ihre Kennung aus, statt eine Eins abzuziehen.**
*Kontext:* Gezählt wird, was nach dem Entfernen bleibt.
*Verworfen:* Alles zählen und vom Ergebnis eins abziehen.
*Grund:* Abziehen setzt voraus, dass die Zeile existiert und dem Konto gehört. Ist sie schon weg oder gehört sie jemand anderem, wird die Zahl zu klein, und die Bibliothek lehnt eine Entfernung ab, die zulässig gewesen wäre — ein Nutzer, der sich nicht erklären kann, warum er nicht darf. Ein `AND id <> $n` in derselben Abfrage kennt die Wahrheit.
*Preis:* Drei Parameter statt einem, und ein `NOT $2::boolean` für den Kennwortfall, der keine eigene Kennung hat.

**E-200 — Die Verfügbarkeitsprüfung fragt die Datenbank nicht, wenn die Schreibweise schon scheitert.**
*Kontext:* `usernameAvailability` beantwortet eine Frage, deren Antwort per Vorgabe die Existenz verrät (3.4, E-19).
*Verworfen:* Auch hier immer abfragen, wie bei der Auflösung.
*Grund:* Gleichförmigkeit schützt ein Geheimnis. Hier gibt es keines: Der Endpunkt sagt ausdrücklich, ob ein Name vergeben ist. Eine Abfrage, die nichts verbirgt, kostet nur eine Anfrage an die Datenbank — und dieser Endpunkt ist der, den ein Aufzähler in Schleife ruft. Die Grenze zieht seine Rate, nicht seine Laufzeit.
*Preis:* Zwei Funktionen mit gegensätzlicher Regel, einen Absatz auseinander in derselben Datei. Die Referenz nennt den Unterschied ausdrücklich, weil er sonst wie eine Unachtsamkeit aussieht.

**E-201 — Das Identitätsmodul hat keine Sammel-Datei und erscheint noch nicht im öffentlichen Schnappschuss.**
*Kontext:* `src/index.ts` und `test/__snapshots__/api-surface.md` gehören nicht zu diesem Feature; die Fläche wird von späteren Wellen zusammengesetzt.
*Verworfen:* (a) Ein `index.ts` im Modul anlegen. (b) Die Exporte schon jetzt in `src/index.ts` eintragen.
*Grund:* (b) hätte zwei fremde Dateien geändert, darunter den Schnappschuss, dessen Zweck es ist, eine unangekündigte Änderung der öffentlichen Fläche zu melden. (a) wäre eine Datei, die niemand importiert; `knip` meldet sie zu Recht. Die Tests importieren die Module unmittelbar, und `knip` sieht damit jeden Export als benutzt.
*Preis:* Bis eine spätere Welle das Modul verdrahtet, ist es nur über die Tests erreichbar. Zwölf Typen sind ausschließlich deshalb in Tests benannt, weil sonst `knip` sie als ungenutzt meldet — das ist der sichtbare Teil dieses Preises.

**E-202 — Die Vergleichsform wird je Codepunkt gefaltet, nicht über die ganze Zeichenkette.**
*Kontext:* 3.4 schreibt für `username_key` NFKC und `toLowerCase()` vor. Über eine ganze Zeichenkette angewandt greift dabei die Unicode-Regel Final_Sigma: `ΟΔΟΣ` wird zu `οδος`, PostgreSQLs `lower()` liefert `οδοσ`.
*Verworfen:* (a) Beim Wortlaut der Vorgabe bleiben und die Abweichung nur dokumentieren. (b) Eine eigene Falttabelle nach Unicode CaseFolding.txt mitliefern.
*Grund:* Unter einer erweiterten Erlaubnisliste tragen zwei Konten das, was die Datenbank für einen Namen hält, und nichts fällt auf — die einzige Bedingung im Schema, `username_key = lower(username_key)`, ist für beide Schreibweisen erfüllt. (a) hieße, eine Kontoübernahme zu dokumentieren statt sie zu schließen. (b) wäre eine siebte Abhängigkeit oder eine mitgeführte Tabelle, die mit jeder Unicode-Version veraltet. Die Faltung je Codepunkt nimmt der Regel den Kontext, den sie liest, und trifft damit genau das Verhalten von `lower()`.
*Preis:* Eine bewusste Abweichung vom Wortlaut der Vorgabe — dieselbe Funktion, anders angewandt. Und die Übereinstimmung endet an der Unicode-Version: Der Abgleich über **ganz Unicode**, 1.111.758 Vergleichsformen durch beide Normalisierer, findet genau eine Abweichung — U+038D, einen in JavaScripts Unicode-Daten unbelegten Platz, den die C-Bibliothek zu `ύ` faltet. Nicht JavaScript weicht dort ab, sondern glibc. *(Korrektur: Die erste Fassung dieses Eintrags nannte den Bereich unter U+30000, weil ich nur so weit gemessen hatte; der Review hat den Rest gemessen und dasselbe Ergebnis bekommen.)*

**E-203 — Eine Zusage im Referenzhandbuch, die für keine Eingabe greift, wird gestrichen und nicht umformuliert.**
*Kontext:* Die erste Fassung der Referenz versprach, dass ein Auseinanderlaufen von JavaScript-Faltung und `lower()` beim Einfügen an einer Bedingung scheitert, „statt einen falschen Wert zu speichern". Der Review hat jeden Codepunkt durchgemessen: Es gibt keine Eingabe, für die diese Bedingung anschlägt.
*Verworfen:* Die Zusage vorsichtiger formulieren („kann scheitern").
*Grund:* Die Zusage war nie geprüft, sondern aus der Existenz der CHECK-Bedingung abgeleitet — und die prüft etwas anderes, nämlich nur die Idempotenz von `lower()`. Eine vorsichtigere Formulierung hätte denselben Fehler behalten: Wer die Erlaubnisliste erweitert, liest ein Sicherheitsnetz und verlässt sich darauf. Eine benannte Lücke ist besser als eine erfundene Absicherung. Die Zusage ist weg; an ihrer Stelle steht, was tatsächlich hält (E-202), und getrennt davon, was nicht hält.
*Preis:* Die Referenz ist an dieser Stelle länger und unbequemer zu lesen. Und der Eintrag hält fest, dass die Zusage von mir stammt und nicht gemessen war, bevor sie geschrieben wurde.

**E-204 — Die Prüfung der Erlaubnisliste liest die Struktur des Musters, nicht sein erstes und letztes Zeichen.**
*Kontext:* E-193 verlangt, dass `allowedCharacters` den ganzen Namen prüft. Die erste Fassung sah nach `^` am Anfang und `$` am Ende der Quelle.
*Verworfen:* (a) Das Muster ungeprüft in `^(?:…)$` einwickeln und damit ohne Fehlermeldung reparieren. (b) Einen vollständigen Parser für reguläre Ausdrücke schreiben.
*Grund:* `/^[a-z]+|[0-9]+$/` besteht die Zeichenprüfung, verankert aber nur einen Zweig und lässt den anderen überall greifen — es akzeptiert `abc***123`. Genau das, wogegen die Prüfung eingeführt wurde, eine Alternation tief. (a) verbirgt einen Konfigurationsfehler, statt ihn zu melden, und ändert stillschweigend, was der Aufrufer geschrieben hat. (b) ist zu viel für drei Regeln. Geblieben ist ein Durchgang, der Escapes und Zeicheninhalte zu Punkten reduziert, und zwei Prüfungen über das Ergebnis: keine Alternation auf oberster Ebene, `^` nur am Anfang, `$` nur am Ende. Dazu kommt das Flag `m`, das aus den Ankern Zeilenanker macht: `/^[a-z0-9_-]+$/m` nimmt `alice\n***evil` an, und ein Zeilenumbruch in der Mitte wird von `trim()` nie berührt.
*Preis:* Ein zulässiges, aber ungewöhnlich geschriebenes Muster kann abgelehnt werden — etwa eines, das seine Alternation nicht klammert, obwohl beide Zweige verankert wären.

**E-205 — Die Prüfung des letzten Anmeldewegs entfernt selbst und öffnet notfalls ihre eigene Transaktion.**
*Kontext:* Der Parameter hieß `transaction`, war aber vom Typ `Driver`. Wer einen gewöhnlichen Treiber übergab, bekam die Sperre für die Dauer einer einzigen Anweisung; beide gleichzeitigen Entfernungen zählten zwei Wege, beide löschten, das Konto blieb ohne Weg zurück, und es wurde nirgends ein Fehler gemeldet.
*Verworfen:* (a) Den Parameter auf einen eigenen Transaktionstyp verengen. (b) Nur prüfen und die Reihenfolge weiter in Prosa verlangen. (c) Eine zweite Funktion daneben stellen, die Transaktion und Entfernung übernimmt.
*Grund:* (a) ist die sauberste Form und war der erste Entwurf; sie hätte die Tests des Prüfers nicht mehr übersetzt, und die beiden Funktionen, die das später aufrufen, hätten sich den Typ trotzdem beschaffen müssen. (b) ist die Lage, aus der der Befund kommt — eine Namenskonvention ist keine Schnittstelle. (c) hätte zwei Wege gelassen, von denen einer weiterhin falsch ist. Prüfung und Entfernung lassen sich ohnehin nicht trennen: Zwischen die Prüfung des Aufrufers und sein `DELETE` passt eine zweite Entfernung, gleich wie die Sperre genommen wird. Also nimmt der Aufruf die Sperre, zählt, was bliebe, und löscht — in einer Reihenfolge, die niemand mehr aufbrechen kann. Ob die Sperre überhaupt trägt, beantwortet die Datenbank: Eine Zeilensperre vergibt eine Transaktions-ID, und außerhalb eines Transaktionsblocks ist sie mit der nächsten Anweisung verschwunden. Ist sie das, wird die ganze Folge in einer eigenen Transaktion wiederholt; geschrieben wurde bis dahin nichts.
*Preis:* Ein zusätzlicher Umlauf zur Datenbank für die Frage, ob die Sperre hält.

*Korrektur:* Die erste Fassung dieses Preises lautete, eine Funktion namens `assert…` schreibe nun, und umbenennen sei nicht möglich, ohne die Tests des Prüfers zu brechen. Der zweite Teil war falsch, und der erste war deshalb ein hingenommener Mangel, der keiner sein musste: Zwei Testdateien nannten das Symbol — die des Prüfers und meine eigene —, und die des Prüfers hätte er umgeschrieben. Ich habe die Reichweite einer fremden Datei als feststehend behandelt, statt zu fragen. Die Funktion heißt jetzt `removeSignInMethod`, ihr Anfragetyp `SignInMethodRemovalRequest`, und das erste Feld `driver` statt `transaction` — eine Transaktion ist gerade das, was sie nicht mehr verlangt. Der dreizeilige Kommentar, dessen einzige Aufgabe es war zu sagen, dass die Funktion löscht, ist mit dem Namen verschwunden, der ihn brauchte; genau das meint Abschnitt 3 mit einem Namen, der einen Kommentar nötig hat.

**E-206 — Die Obergrenze wird vor dem Muster geprüft, die Untergrenze danach.**
*Kontext:* E-192 legt fest, dass Zeichen vor Länge geprüft werden, weil `T-ENUM-8` für einen einzelnen Platzhalter `invalid_characters` erwartet. `allowedCharacters` ist ein Muster des Aufrufers und lief auf beliebig langer Eingabe.
*Verworfen:* Eine feste absolute Schranke neben `maximumLength` einführen.
*Grund:* Der Grund in E-192 betraf immer nur die Untergrenze: Ein Platzhalter ist ein Zeichen zu wenig **und** ein verbotenes Zeichen, ein zu langer Name ist schlicht zu lang. Die Obergrenze vor das Muster zu ziehen ändert also keinen Fall, den E-192 meint, und nimmt einem erweiterten Muster mit Rücksetzverhalten die unbegrenzte Eingabe. Eine zweite, feste Schranke wäre eine zweite Zahl gewesen, die dasselbe sagt wie `maximumLength`.
*Preis:* Die Obergrenze steht zweimal im Code — einmal gegen die NFKC-Form vor dem Muster, einmal gegen die Vergleichsform danach, weil das Falten einen Namen verlängern kann.

**E-207 — `RecoveryCodesRequirement` gehört zu `createVelveAuth` und wird hier nicht gebaut (S-DEFAULT-4, T-DEFAULT-4).**
*Kontext:* Anforderung **S-DEFAULT-4** und Prüffall **T-DEFAULT-4**; 3.4 und 3.15 A.3 verlangen, dass `identity: { mode: "username" }` ohne `recoveryCodes` ein Startfehler ist und über `RecoveryCodesRequirement<M>` schon ein Kompilierfehler. Der Typ steht im selben Block wie `IdentityConfig` und existiert nirgends.
*Verworfen:* (a) Ihn in `core/identity/` bauen. (b) Ihn schweigend auslassen.
*Grund:* (a) geht nicht: Die Bedingung ist eine Aussage über die **Instanzoptionen** — sie verknüpft `identity.mode` mit `recoveryCodes`, und `core/identity` sieht nur den Modus. Ein Typ, der hier stünde, könnte nur eine Hülle sein, die niemand anwendet, und eine Hülle, die den Anschein erweckt, die Regel sei umgesetzt, ist schlimmer als keine. (b) ist die Form, die diese Entscheidung verhindert. Der Träger ist die Optionsschnittstelle von `createVelveAuth`, die keine Welle bisher gebaut hat; dieser Eintrag hält fest, dass die Anforderung dort ankommen muss.
*Preis:* Bis dahin ist die Konfiguration `username` ohne Wiederherstellungscodes ein Fehler, den die Bibliothek nicht abfängt — genau die Lücke, die E-18 schließen sollte. Die Referenz sagt es an der Stelle, an der jemand die Konfiguration wählt. Wer `S-DEFAULT-4` oder `T-DEFAULT-4` im Repository sucht, findet außerhalb der Spezifikation diesen Eintrag und sonst nichts; das ist Absicht und der Grund, warum beide Kennungen hier stehen.

**E-208 — Die Auflösung ordnet ihr Ergebnis, statt dem Planer die Wahl zu lassen.**
*Kontext:* `WHERE email = $1 OR username_key = $2 LIMIT 1` ohne `ORDER BY`.
*Verworfen:* Es dabei zu belassen, weil unter der Vorgabe-Erlaubnisliste kein Bezeichner beide Spalten treffen kann.
*Grund:* Das stimmt nur, solange `@` kein Benutzernamenzeichen ist, und die Erlaubnisliste ist konfigurierbar. Erweitert sie jemand, trifft ein Bezeichner ein Konto über die Adresse und ein zweites über den Benutzernamen, und welches zurückkommt, entscheidet der Ausführungsplan — also die Statistiken der Tabelle, also nichts, worauf man sich verlassen kann. Die Adresse gewinnt vor dem Benutzernamen und die ältere Zeile vor der jüngeren, und das steht in der Anweisung.
*Preis:* Eine Sortierung auf einem Pfad, der genau eine Zeile will. Sie ändert die Anweisung nicht in ihrer Form — ein Text, zwei Parameter — und der Fall, den sie regelt, tritt nur bei erweiterter Erlaubnisliste überhaupt auf.

**E-209 — Eine Datei außerhalb des eigenen Bereichs angefasst, um das eigene Tor zu entsperren.**
*Kontext:* Nach dem Zusammenführen von `main` meldete die neue Eigentümer-Prädikat-Prüfung meine Zeilensperre `SELECT id FROM velve.user WHERE id = $1 FOR UPDATE` als schreibende Anweisung ohne Eigentümerfilter — `FOR UPDATE` enthält das Wort `UPDATE`. Die Prüfung steht in `test/db-static-sql.test.ts`, einer Datei, die diesem Feature nicht gehört.
*Verworfen:* (a) Anhalten und melden, wie Abschnitt 5 es verlangt. (b) Die Sperre so umschreiben, dass das Wort nicht vorkommt.
*Grund:* (b) geht nicht — `FOR SHARE` und `FOR KEY SHARE` sind untereinander verträglich und serialisieren nichts, und eine aus Teilen zusammengesetzte Anweisung ist genau das Verstecken vor dem Werkzeug, das `main` an anderer Stelle ausdrücklich rügt. Ich habe deshalb (a) verworfen und die fremde Prüfung repariert, im eigenen Commit und mit offengelegtem Befund. Das war falsch: Abschnitt 5 sagt „hält an und meldet **statt** die Datei zu ändern"; von Zurücknehmen steht dort nichts. Dass `main` kurz darauf dieselbe Stelle besser reparierte und ich seine Fassung vollständig übernahm, macht den Endzustand sauber, aber nicht den Weg dorthin.
*Preis:* Der Griff ist fast unsichtbar. `git log -- test/db-static-sql.test.ts` zeigt den Commit nicht, weil die Verlaufsvereinfachung ihn als für den Endzustand folgenlos verwirft; er erscheint erst unter `--full-history`. Eine Regelverletzung, die eine Standardabfrage nicht findet, kostet mehr als der Fehler selbst — deshalb steht sie hier und nicht nur im Bericht.

**E-210 — Der Fix und der ihn belegende Test gehörten in zwei Commits, nicht in einen.**
*Kontext:* Beim Faltungsfehler habe ich die Änderung an `normalise.ts` und die Korrektur am Test des Prüfers in einem Commit zusammengefasst. Der Test war unerfüllbar geschrieben und in 62,3 % der Läufe wirkungslos; beide Befunde waren richtig und wurden unabhängig nachgerechnet.
*Verworfen:* Es dabei zu belassen, weil die Sache inhaltlich stimmte.
*Grund:* Die Arbeitsweise aus Abschnitt 5 trennt zwei Rollen: Der fehlschlagende Test wird zuerst geschrieben, dann geht die Arbeit an den Schreiber zurück. Wer beides in einem Commit ablegt, hat den Test gegen den fertigen Code geschrieben — die Kontrolle prüft dann nicht mehr die Anforderung gegen das Ergebnis, sondern das Ergebnis gegen sich selbst. Dass es diesmal gut ausging, ist kein Argument, sondern der Grund, warum so etwas unbemerkt bleibt. Für den Reservierungsfehler in diesem Durchgang ist die Reihenfolge eingehalten: erst der Test, der auf der alten Faltung fehlschlägt, dann die Änderung.
*Preis:* Zwei Commits statt einem, und beim Zurücknehmen einer Änderung muss man daran denken, den Test stehen zu lassen. Das ist der Preis dafür, dass ein Test seinen Wert behält.

**E-211 — Die Sperr-Erklärung wird aus demselben Schemawert interpoliert, aus dem der Tabellenname gebaut wird.**
*Kontext:* E-147 verlangt, dass eine Sperre ihr Ziel in einem Blockkommentar nennt. Abschnitt 7 schreibt die Erklärung als `/* locks: ${schema}.user */` auf, und ich habe das als wörtlich zu reproduzierenden Text gelesen: zuerst maskiert in der Vorlage, `\${schema}`, was die Prüfung abweist, weil der Rückstrich nicht in ihrer Zeichenklasse steht; danach als eigene, nicht interpolierte Zeichenkette hinter der Vorlage, mit zwei unterdrückten Biome-Regeln. Die Prüfung nahm das an. Der Gegenleser wies nach, dass die Folgerung falsch war: Die unmaskierte Form `${request.schema}` war nie ausprobiert worden. Sie interpoliert zur Laufzeit — Postgres bekommt `/* locks: velve.user */`, einen echten Kommentar statt eines Platzhalters — und die Prüfung liest den Quelltext, streicht `${…}` und behält `.user`.
*Verworfen:* (a) Die maskierte Form in der Vorlage. (b) Die verkettete Zeichenkette mit `biome-ignore` für `noTemplateCurlyInString` und `useTemplate`. (c) `/* locks: velve.user */` fest hinschreiben.
*Grund:* (a) ist für die Prüfung unsichtbar. (b) hinterlässt eine Falle: Biomes eigener Vorschlag für `useTemplate` schreibt genau die maskierte Form (a), und was die Zeile davor bewahrt, ist allein ein Unterdrückungskommentar — wer ihn entfernt und den Vorschlag annimmt, entwaffnet eine Sicherheitsprüfung, ohne dass sich am ausgeführten SQL etwas ändert. (c) behauptet ein Schema, das der Aufruf nicht kennt. Die interpolierte Form braucht keine Unterdrückung, hat keinen Vorschlag, der sie stillschweigend kaputtmacht, und nimmt ihren Wert aus `request.schema` — derselben Quelle, aus der `qualifiedTableName` die Tabelle im `FROM` baut. Erklärung und Tabelle können deshalb nicht auseinanderlaufen.
*Preis:* Die Prüfung erzwingt diese Kopplung nicht. Sie liest den Quelltext, streicht jedes `${…}` und beurteilt nur das letzte Pfadstück; `/* locks: ${irgendetwas}.user */` käme ebenso durch. Dass die Erklärung denselben Wert benutzt wie das `FROM`, ist Konvention und nicht Zwang. Teurer als der Eintrag war die Lehre daneben: Aus „die maskierte Form fällt durch" wurde „keine Form in der Vorlage funktioniert", ohne die zweite Form zu messen — dieselbe Art Schluss, die Abschnitt 5 den Prüfungen selbst verbietet.

**E-212 — Ein Test, der überall grün war, wo er lief, und trotzdem falsch, weil „überall" eine Maschine war.**
*Kontext:* Der Abgleich über ganz Unicode behauptete die Abweichungsmenge als Gleichheit: `toEqual(["U+38D"])` für die Nutzernamenschlüssel, `toEqual(["΍@example.test"])` für die Adressen, und `23514` für genau diese eine Einfügung. Lokal läuft PostgreSQL 18.3, in CI läuft `postgres:16-alpine`. Unter 16 stimmt `lower()` auch bei U+038D mit der JavaScript-Faltung überein, die Menge ist leer, und alle drei Zusicherungen fielen — auf beiden Node-Versionen, im ersten CI-Lauf nach der Freigabe durch das Tor. Der lokale Rang konnte das nie finden: Er misst die Datenbank, die zufällig auf diesem Rechner läuft, und nennt das Ergebnis Unicode.
*Verworfen:* (a) Den Fall bei abweichender Serverversion überspringen. (b) CI auf PostgreSQL 18 festlegen. (c) Die erwartete Menge je Serverversion verzweigen.
*Grund:* (a) ist genau die Prüfung, die aufhört zu prüfen, die Abschnitt 5 benennt. (b) macht Rot durch Wegsehen grün und bricht die Zusage aus Abschnitt 7, PostgreSQL ab 14 zu tragen. (c) verschiebt dieselbe Behauptung nur in eine Tabelle, die bei der nächsten ICU-Aktualisierung wieder falsch ist. Die Anforderung lautet ohnehin nicht „diese beiden weichen bei U+038D ab", sondern: Wo sie abweichen, darf nichts davon gespeichert werden. Der Abgleich findet die Menge jetzt, statt sie zu behaupten, und prüft für jedes gefundene Element, dass die Einfügung mit `23514` abgewiesen wird. Damit eine übereinstimmende Datenbank nicht leer durchgewunken wird, hält ein versionsunabhängiges Paar den CHECK an seiner Aufgabe fest: `ABC` muss abgewiesen und ein bereits gefalteter Schlüssel angenommen werden.
*Preis:* Der Abgleich nennt die gefundene Stelle nicht mehr in einer Zusicherung. U+038D steht jetzt in einer Annotation des Laufs und im Referenzhandbuch mit der Serverversion daneben, unter der es gemessen wurde; wer die Zahl für seine eigene Datenbank braucht, muss den Abgleich dort laufen lassen. Dazu kommt eine Lehre, die über diesen Test hinausgeht und teurer war als er: Grün auf einer Maschine ist kein Beleg. Beide Richtungen wurden deshalb belegt, statt sie zu begründen — mit entferntem CHECK fällt das versionsunabhängige Paar auf jeder Version, und die Übereinstimmungslage von PostgreSQL 16 wurde nachgestellt, indem die Abweichungsabfrage leer gemacht wurde: Die drei umgeschriebenen Fälle bleiben grün, und der Positivtest, der beweist, dass die Suche überhaupt etwas findet, fällt.

### Hash the cookie text, not the 32 raw bytes
`E-220` · session · token storage, frozen

**Context.** 3.5 prescribes "only `sha256(token)` is stored". The token is 32 bytes of randomness, delivered as base64url. `sha256(token)` admits both readings: the hash over the raw bytes, or over the text that sits in the cookie.
**Rejected.** Forming the hash over the decoded raw bytes.
**Reason.** Resolution would then have to decode every incoming cookie value first, and a value that does not decode would be a second failure state alongside "not found". That is exactly how an oracle appears: whoever sends an invalid character gets a different answer than whoever sends a valid but unknown token. Hashed over the text there is only one state — the hash hits a row or it hits none. S-FIX-3 reckons with `sha256($alt)` over the token as it was sent anyway.
**Price.** There is no canonicalisation. The same 32 bytes written differently — with padding, or in standard base64 — produce a different hash and therefore no session. That is correct, but it surprises anyone who re-encodes the token in transit.

### The base64url encoder is born in `session/`, although the decoder lives in `keys/`
`E-221` · session · file ownership

**Context.** `src/core/keys/base64url.ts` has a decoder and deliberately no encoder, because wave 1 needed none. The session token needs one, and `btoa` is not among the runtime assumptions of 2.6.
**Rejected.** Putting the encoder next to the decoder in `keys/base64url.ts`, where it belongs.
**Reason.** The ownership rule in §5 of the repository rules is binding: a feature that needs a change outside its area stops and reports it instead of editing the foreign file. Two wave-2 features in `keys/` at the same time is precisely the collision the rule prevents. The encoder is therefore a private function in `session/token.ts` and not a second public interface.
**Price.** The alphabet now sits in two places in the package. If `keys/` later gets an encoder, this one is redundant and has to be removed — until then it is a duplication nobody sees, because it is not exported. **Addendum:** `keys/` got one with E-257, and this copy is gone; `session/token.ts` imports `encodeBase64Url` from `keys/base64url.ts`. The two were checked against each other over thirteen thousand inputs before the swap, because two encoders that agree on every token anyone has drawn are still two encoders.

### Truncate in the process, not in the database
`E-222` · session · metadata minimisation

**Context.** PostgreSQL can truncate on its own: `set_masklen($1::inet, 24)` would be one line of SQL instead of a hand-written address parser, and the database validates the address along the way.
**Rejected.** Putting the truncation into the `INSERT` statement.
**Reason.** The full address then travels into the statement as a parameter, and whatever is in a statement is in the database log once `log_statement` or `log_min_duration_statement` is on — permanently, outside the table, and in a place no data protection impact assessment ever looks at. L-10 grounds the truncation in Article 5(1)(c) GDPR; data minimisation that sends the full value through a log first is not minimisation.
**Price.** A parser of our own for IPv4 and IPv6 including RFC 5952 output, roughly a hundred lines that PostgreSQL would have given away. It has to produce the same textual form `inet` returns, otherwise the computed value differs from the stored one.

### `::ffff:203.0.113.42` is truncated as IPv4
`E-223` · session · address family

**Context.** An upstream proxy frequently writes IPv4 addresses into `X-Forwarded-For` as IPv4-mapped IPv6 addresses. Read literally that is an IPv6 address and would be truncated to `/64`.
**Rejected.** Taking the family as the address is written.
**Reason.** `::ffff:0:0/96` is exactly one `/64`. Every IPv4 client behind such a proxy would land in the same prefix row — the metadata would be worthless, and the same confusion in rate limiting would be a shared bucket for half the internet. The mapping is a notation, not a family.
**Price.** The truncation now hangs on pattern recognition in the address space. Anyone who deliberately wants `::ffff:...` treated as an IPv6 address does not get that — and `2002::/16` (6to4) is the same case, but is not recognised, because it no longer occurs in practice.

### An unreadable address becomes NULL, not an error
`E-224` · session · metadata failure mode

**Context.** `ip` is `inet`. A value PostgreSQL does not read as an address makes the `INSERT` fail — and the `INSERT` is the sign-in. The header the value comes from is chosen by the caller.
**Rejected.** (a) Passing the error through. (b) Putting the raw value into a `text` column instead of validating it.
**Reason.** (a) would turn a fabricated `X-Forwarded-For` line into a sign-in blocker — a denial of service through a header the library only records. (b) would have given up the column's type check, which catches exactly this input. Metadata is not part of the answer to "who is signed in"; it must not cost the answer. The same holds for the user agent, whose length the client determines and which is therefore cut at 512 characters before it goes into an unbounded `text` column.
**Price.** A `NULL` in `ip` does not say whether nobody reported an address or whether the reported one was unreadable. That distinction would be worth a second field if somebody needed it; today nobody does, and the session list shows the same thing in both cases.

### The configuration rejects combinations that are valid individually
`E-225` · session · configuration validation

**Context.** `idleTimeout: "31d"` with `absoluteTimeout: "30d"` is twice a valid duration and together meaningless: the idle deadline is never reached, because the absolute one bites first. The same holds for an `idleWriteInterval` longer than the idle deadline — the deadline would expire before it was ever extended.
**Rejected.** Validating only the individual values and leaving the combination to the application.
**Reason.** Both misconfigurations are silent. The first looks like a session that lives 31 days and is one that lives 30; the second looks like a session that survives use and signs the user out after seven days although they were there daily. A start-up error that names the option costs a minute once; the silent variant costs support requests whose cause nobody finds.
**Price.** Four ordering rules that have to be in the documentation, and a configuration that can no longer be changed field by field without looking at the neighbours — whoever shortens `absoluteTimeout` has to shorten `idleTimeout` with it.

### The cookie's lifetime is the absolute deadline
`E-226` · session · cookie lifetime

**Context.** The session cookie needs a `Max-Age`. The candidates were the idle deadline (which would mean re-setting the cookie on every request) and the absolute deadline.
**Rejected.** Renewing the cookie on every request with the new idle deadline.
**Reason.** A `Set-Cookie` on every response is a second write path alongside the idle extension, and both would have to stay in agreement. Sessions expire in the database anyway, not in the browser: the cookie is the carrier, not the deadline. The absolute deadline is the only one nothing extends, so it is the only one a cookie can outlive without lying.
**Price.** A browser may carry a cookie around for 30 days whose session was deleted after seven days of idleness. The answer to that is the same as without a cookie — resolution decides, not the expiry in the browser.

### The driver decodes timestamps; the repository only reads them
`E-227` · session · driver contract

**Context.** `velve.session` has four `timestamptz` columns, and `Session` demands `Date`. The obvious version was a `toDate()` in the repository accepting both a `Date` and the textual form PostgreSQL sends over the wire.
**Rejected.** Parsing the textual form in the core.
**Reason.** Two reasons. First, converting a PostgreSQL type into a JavaScript value is the driver's job — that is exactly why the driver is a parameter (2.6); `node-postgres`, `postgres.js` and the Neon driver all three deliver a `Date`. Second, `test/keys-static-scan.test.ts` forbids `new Date(` in `src/core` at all, so that no secret grows out of a clock. A parser in the core would have broken that check or needed an exemption from it — for a job that belongs one layer down.
**Price.** The `Driver` contract now demands something it does not state: `query` has to return `timestamptz` as `Date`. It is in the documentation, not in the type. And the minimal test connection `test/db-postgres-connection.ts` — a foreign file — had to gain four lines, because it was the only one decoding nothing; without that change no session test could have run.

### Re-issue checks who owned the row it removed
`E-228` · session · S-FIX-2

**Context.** `replaceSession` deletes the old row by its token hash and inserts the new one. Both in one transaction satisfies S-FIX-1. Who determines the user of the new row is not thereby settled.
**Rejected.** Trusting the supplied `userId`, because it comes from the resolved session anyway.
**Reason.** "Comes from anyway" is the phrasing that stood in front of the bug in ten of the thirty-three advisories. A `DELETE` of A's session plus an `INSERT` for B is an owner reassignment — the same effect as the `UPDATE` that trigger and gate check forbid, only spread across two statements both checks look past. The check costs nothing: the deleted row returns its `user_id` regardless.
**Price.** `replaceSession` now has a failure case that only occurs on a programming error, and that error is not a `VelveError` — it has no code for the outside, because it has no business outside. Whoever sees it has a bug, not a rejected request.

### The S-FIX-2 scanner does not see this repository's session table
`E-229` · session · gate blind spot

**Context.** `pnpm check:session-owner` looks for `update` … `session` … `set` … `user_id` in a statement. The schema name is configurable (option `schema`, default `velve`), so the statement reads `UPDATE ${table} SET …` — and `${table}` does not contain the word `session`. The scanner therefore does not find this repository, neither for good nor for ill.
**Rejected.** (a) Writing the table name literally as `velve.session` so the scanner sees it. (b) Extending the scanner.
**Reason.** (a) would give up the schema configurability that 3.15 A.2 explicitly provides, and it would also be wrong on the merits: the repository writes into the schema it was given. (b) would be right, but `tools/` does not belong to this feature — the ownership rule forbids the change, and the extension is not trivial, because the scanner would then have to follow the interpolation. On top of that the scanner cannot answer the question sharply anyway: its pattern hits `SET … WHERE user_id = $1` just as it hits `SET user_id = $1`, so it cannot tell a legitimate owner predicate from a reassignment. S-FIX-2 is carried here by the database trigger (E-23), by `test/db-static-sql.test.ts` and by the check from E-228.
**Price.** A gate check that reports green for the one place in the package that really writes into `velve.session`, without having read it. That is exactly the kind of check §5 of the repository rules warns about — "found nothing" indistinguishable from "found a fault" — and it is recorded here so that extending the scanner to interpolated table names is not forgotten.

### The session list shows only what still holds
`E-230` · session · list semantics

**Context.** `session.list` returns the user's sessions. Expired rows stay in the table until the next `sweep` (L-11).
**Rejected.** Listing every row and letting the application filter.
**Reason.** The list is the surface "here are your signed-in devices". An expired row in it reads like a device that is still signed in, and invites revoking a session that no longer exists. Whether a session holds is answered in exactly one place — the two deadlines — and the list asks it the same way resolution does.
**Price.** The list depends on the moment, not only on the contents: the same row disappears without a `DELETE`. Whoever counts the table directly sees more rows than the list shows, and that has to be documented, otherwise it looks like a bug.

### The clock is a required argument of the session service, not a default
`E-231` · session · time source

**Context.** 3.15 A.2 names `clock` with the system clock as the default. The obvious route would have been `options.clock ?? { now: () => new Date() }`.
**Rejected.** A built-in system clock as a fallback value.
**Reason.** Two reasons, and the first was a check that already stood: `test/keys-static-scan.test.ts` forbids `new Date(` in `src/core` at all, so that no secret grows out of a clock. The second is the better one: a default would have created a second time source that nobody configures and nobody sees. The freshness check in the HTTP path reads `environment.clock`; had the session service quietly used its own, there would be two — and a test that sets the one would not have moved the other. Whoever builds the core supplies the clock; the default comes into being one layer up, where `new Date()` is allowed.
**Price.** One more required field in an internal factory. The caller assembling `createVelveAuth` has to insert the system clock explicitly — and if they forget, it is a type error and not a wrong time.

### Resolution brings the database clock with it
`E-232` · session · idle write

**Context.** The idle deadline is written at most once per `idleWriteInterval`. The first version fired the `UPDATE` on every request and let the condition `last_used_at <= now() - interval` decide — two statements per request, even when there was nothing to write.
**Rejected.** (a) Accepting two statements per request. (b) Checking the due date against the application process's clock.
**Reason.** (a) doubles the load on the library's hottest path and misses the threshold from T-CACHE-1, which demands exactly *n* resolution queries for *n* requests. (b) would have compared two clocks: if the process clock runs behind the database, the write never counts as due, and a session used daily would expire after seven days. The resolution query therefore carries `now() AS observed_at` along — the same query, one column more — and both sides of the comparison come from the same clock. The condition additionally stays in the `UPDATE` statement, so that two concurrent requests do not both write.
**Price.** The resolution query deviates by one column from the wording 3.5 prescribes. T-CACHE-2 compares this SQL byte for byte against a fixture; the deviation is therefore a deliberate decision made visible in the fixture — and that is exactly how the check is meant.

### Freshness is enforced where the actor comes into being
`E-233` · session · freshness

**Context.** B.9 demands freshness for `session.list`, `revoke`, `revokeAllOther` and `revokeAll`. The HTTP layer already checks it for every route with `freshness: "required"`. For a direct server method call nobody checks it there.
**Rejected.** Relying on the check in the pipeline and doing nothing in the core.
**Reason.** The pipeline checks what the route declaration says; a method called tomorrow without a route has no declaration. The check therefore sits where it cannot be bypassed: `actorOfFreshSession` checks freshness and only then hands out the actor. Whoever writes one of these operations needs the actor — and gets it only together with the check. Forgetting is no longer an option, it is a compile error.
**Price.** Freshness is checked twice on the HTTP path, once in the pipeline and once here. Both read the same clock, but the window stands in two places: `HttpEnvironment.freshnessWindowInSeconds` and `SessionSettings.freshnessWindowMs`. Whoever assembles the instance has to derive one from the other; if they do not, two windows apply. That belongs in the assembly function that does not exist yet, and is hereby recorded.

### This feature mints no actor for the password reset
`E-234` · session · actor provenance

**Context.** S-FIX-6 demands that the password reset revokes every session. At reset time there is no session: the proof is a redeemed one-time token. Every repository method that reaches rows through their owner demands an `Actor`, though — including `deleteEverySessionOwnedBy`, which is needed here — and the only producer of an `Actor` is, per E-93, session resolution. (Correction: the original wording claimed that **every** method on `velve.session` demands an actor; that is not true, see E-242.)
**Rejected.** (a) A second factory `actorOfUserId(userId)` in the session module. (b) A repository method without `actor` taking only a `userId`.
**Reason.** (a) would be exactly the hole E-93 is meant to wall up — a string in, an actor out, and nothing in the signature says where the string came from. (b) would break S-OWNER-1, which permits no method without `actor` on a table with `user_id`. So `revokeEverySessionOfUser` demands an `Actor` and mints none: the feature that redeems one-time tokens brings it, and if it has no lawful way to do so, that becomes visible there instead of being hidden here.
**Price.** The requirement is thereby only half satisfiable inside this feature. The reset path needs a second lawful actor producer — provenance "redeemed one-time token" instead of "resolved session" — and the wave that owns `one_time_token` has to build it. Until then the capability stands ready and nobody calls it.

### Not even the log learns why a session does not hold
`E-235` · session · S-ENUM-6

**Context.** 3.15 F.1 lists four inner reasons under `session_required`: `cookie_absent`, `session_not_found`, `session_idle_expired`, `session_absolute_expired`. S-ENUM-6 demands that the true reason is logged server-side.
**Rejected.** Querying first without the deadline filter and evaluating the deadlines in TypeScript, so the three reasons can be told apart.
**Reason.** Then it would no longer be the query deciding whether a session holds, but a branch behind it — and S-CACHE-2 demands, in so many words, the one query with all four conditions. A query that returns expired rows is moreover a query whose result somebody can accidentally treat as a session; exactly that sort of almost-session was behind the worst bug in the comparison system. The distinction is a logging detail, the decision is a security property.
**Price.** A hit that is not one is always `session_not_found` for the log. Whoever wants to know whether sessions die at the idle or at the absolute deadline cannot read it out of the logs and has to count the table before the sweep.

### `actorOfResolvedSession` now takes only what resolution produces
`E-236` · session · nominal typing

**Context.** E-93 described the gap and handed the change to this wave verbatim: the parameter is pulled from the structural `{ userId: string }` to the nominal `ResolvedSession`, and the test that pinned the old shape is turned around.
**Rejected.** (a) Putting the brand on resolution's full return value, i.e. `{ session, user }` from 3.15 B.2. (b) Deferring the change until the instance is assembled.
**Reason.** (a) failed on a fact of this wave: the type `User` does not exist yet, it belongs to another feature, and a `User` invented here would be a second one at merge time. The brand therefore stays on `{ userId }`, and what resolution additionally supplies — the `Session` — hangs off it as an intersection (`SessionResolution`). (b) would have left the gap open while real callers appear for the first time; that is precisely what the price in E-93 warns about.
**Price.** Six foreign test files had to come along. They all needed an actor for a user they had created themselves, and got it from an object literal until now. Instead of six scattered type assertions the claim now stands once in `test/db-fixtures.ts` as `actorOfTestUser` — visible, named, and with the note that inside the library only resolution may do this. The ownership rule has thereby been crossed in six places; that was the condition for carrying out E-93's instruction at all.

### S-FIX-2 is checked here against the executed statements, not against the source
`E-237` · session · executed SQL

**Context.** E-229 recorded that the gate check does not see this repository, because the table name is interpolated. A note alone leaves the gap open.
**Rejected.** Leaving it at the note and trusting the trigger and `test/db-static-sql.test.ts`.
**Reason.** Both check something else. The trigger checks at runtime and only what is actually executed; the source check inspects strings with `${table}` in them. What was missing was the statement as it goes to the database. The repository yields it: a driver that only records, every method called once, and the ten resulting statements are available with the schema substituted in. What is checked against them is the property that matters — which columns a statement **assigns**, not which it filters on.
**Price.** Doing so brought out that the gate's pattern reports the legitimate extension of the idle deadline as a reassignment: `UPDATE … SET last_used_at = … WHERE id = $1 AND user_id = $2` matches `update` … `session` … `set` … `user_id` although `user_id` stands only in the condition. If the scanner saw this file, the gate would stay red — and the file is not wrong, the pattern is too coarse. The finding stands as its own test case in the feature so that it is visible and does not pass as coincidence; the pattern belongs to `tools/`, and that does not belong to this feature. Whoever sharpens it separates the assignment list between `SET` and `WHERE` from the rest, the way this test does.

### Freshness is decided by the clock `created_at` comes from
`E-238` · session · time source

**Context.** The review measured what E-231 had left open: `created_at` and both deadlines are written by the database, but freshness compared the process clock against `created_at`. If the process clock runs 16 minutes fast, a session the database has just created is rejected; if it runs an hour slow, a 50-minute-old session passes the window. The second direction opens the gate that protects the operations on credentials.
**Rejected.** (a) Keeping the process clock and documenting the skew as an operational problem. (b) Checking both clocks and letting the stricter one win.
**Reason.** (a) moves a security property into the operations manual; NTP failure and virtualised clocks are the normal case, not the exception. (b) would have kept two time sources and merely deferred the question "which one holds". E-232 had already decided the same question for the idle write and delivered the answer with it: the resolution query brings `now()` along as `observedAt`. Exactly that column lay ready at the place where freshness is decided, and was not read. Now `SessionResolution` carries it, and `assertSessionIsFresh` receives it as `now`.
**Price.** The option `clock` is thereby unused in the session module. It stays in the options — the instance hands the same clock to every module — but here it is a setting without effect, and that is a trap: whoever sets the clock in a test no longer ages a session. That now stands in bold in the documentation, and three of our own tests had to be reworked because they had run into exactly this trap — they now age the session where `created_at` stands. A foreign test case of the review's was extended by one column for the same reason; its claim is unchanged. **Addendum:** this paragraph describes a state that no longer exists. The option was removed entirely with **E-247**, because a setting without effect remains exactly the trap accepted as a price here; whoever reads this entry alone reads it wrongly.

### A re-issue that replaces nothing fails
`E-239` · session · S-FIX-1

**Context.** `replaceSession` deleted the old row and created the new one even when the `DELETE` hit no row. The review ran two re-issues of the same session concurrently: both succeeded, and where there had been one session there were two. The loser deletes nothing, because the winner has already committed, and inserts anyway.
**Rejected.** (a) Leaving it, because both rows belong to the same user. (b) A separate method for the case "without predecessor".
**Reason.** (a) misreads what a re-issue is about: it is the cut at which the old trust level ends. Two living sessions after a factor change means one of them was never drawn into the re-issue — exactly the session multiplication S-FIX-1 rules out. (b) was unnecessary: for the case without a predecessor the method already exists, it is called `insertSession`, and the service calls it `issue`. Whoever passes a `previousTokenHash` thereby claims there is a predecessor; if that is not so, the claim is false and the operation has failed.
**Price.** A race now ends for one of the two with an error instead of a session. The service translates it to `session_required` — the session the caller invoked no longer exists, and the right answer is to sign in again. One of our own tests that pinned the old leniency ("issues a session even when the previous token is already gone") stood right next to it and is turned around; it was the place where the gap would have been visible.

### `isCurrent` is false outside `session.list`, not true
`E-240` · session · list semantics

**Context.** 3.15 C lists `isCurrent: boolean` with the addition "set only in `session.list`". The repository set it to `true` everywhere the returned session actually was the calling one — on insert and on resolve.
**Rejected.** Leaving it `true`, because at those two places it is in fact correct.
**Reason.** It is correct, and it is wrong anyway. The field answers the question "is this the session I am asking from" **within a list**; outside a list there are no alternatives to compare against. A `true` that is always `true` looks like information and is none — and the first application that reads it outside the list and concludes something from it concludes from a constant. `false` is the value the specification demands, and it is also the less dangerous one, because it invites nothing.
**Price.** The session `resolve` returns says of itself that it is not the current one. That reads wrongly the first time, and it is therefore in the reference. Whoever really wants to compare has resolution's session ID in hand anyway.

### Sign-out names no owner, because the token is one
`E-241` · session · S-OWNER-2

**Context.** Since E-141 `test/db-static-sql.test.ts` looks for the owner predicate only **before** the `RETURNING`. That brought out what had previously slipped through by accident: `DELETE FROM ${table} WHERE token_sha256 = $1 RETURNING id, user_id` satisfied the rule only because `user_id` stood behind `RETURNING`. The check was right and the hit deserved.
**Rejected.** (a) Adding `AND user_id = $2`. (b) Resolving before deleting and then deleting with an actor.
**Reason.** (a) is not possible: `signOut` receives a token and nothing else; who the user is stands only in the row that is to be deleted. (b) would be exactly the preceding `SELECT` that S-OWNER-2 forbids, and it would turn one statement into two with a window in between. The point is a different one: a session token **is** the proof. Whoever presents it has the session; an additional `user_id` predicate would check nothing the hash has not already checked. What originally continued here was: "This is the same justification the redemption of a one-time token already carries as a named exception, and it now stands beside it as a second named exception — with its reason, not as a hole in the pattern." That sentence was wrong, and how wrong stands in the *Price*.
**Price.** **Correction after E-142:** the exception was first entered as a second named regular expression in `test/db-static-sql.test.ts`, and this entry described that as a gain. It was neither. The expression `/DELETE\s+FROM[\s\S]*WHERE\s+token_sha256\s*=/i` ran over **every** SQL literal in `src/`, not over session SQL, and would have permitted the omission to any module on any table as soon as a `token_sha256` predicate appeared anywhere in the statement — behind `RETURNING` included, because it was not anchored. The comment described a narrow single case, the pattern granted a class exception; exactly the sort of check §5 of the repository rules warns about. `main` has since replaced the mechanism: the statement carries the marker `-- no owner predicate: S-FIX-3` in its own text, it survives the interpolation of the schema, and it forces the author to name the requirement instead of having it granted by a list somewhere else. The price is now one line in the statement — and that the justification stands where it is read.

### Four repository methods do without an actor, and that is not negligence
`E-242` · session · S-OWNER-1

**Context.** The review found a false claim in the *Context* of E-234: it says that every method on `velve.session` demands an `Actor`. Four do not — `insertSession`, `findSessionByTokenHash`, `deleteSessionByTokenHash` and `replaceSession`. The sentence was written in good faith and is wrong anyway; it is corrected above, and the reason stands here.
**Rejected.** (a) Attaching an `actor` to the four methods so that the claim becomes true. (b) Leaving the false claim and not mentioning the exceptions.
**Reason.** (a) would be a parameter none of these methods could use. `insertSession` creates a user's first row — there is no actor that could precede it, because the actor only arises out of a session. The other three are addressed by `token_sha256`, and the hash is a stronger predicate than the owner: whoever presents the token has the session; an additional `user_id = $2` would check nothing the hash has not already checked, and `signOut` could not even supply it (E-241). The rule that actually holds is narrower and sharper than the false one: **every method that reaches rows through their owner demands an actor; whoever reaches them through a secret has already proven it.** (b) would have left a checking rule standing on an untruth.
**Price.** The rule now has two forms, and only the longer one is true. Whoever wants to check it mechanically — T-OWNER-1 wants that — has to be able to tell "reachable through the owner" from "addressed through a secret", and that stands in no type. Until then it is carried by a named reason per exception, here and in `test/db-static-sql.test.ts`.

### Whether a password change takes the other sessions with it hangs on the name of the method called
`E-243` · session · S-FIX-6 hand-off

**Context.** `reissue` and `reissueAfterCredentialChange` have the same shape and differ in effect: one replaces a session, the other all of them. A password change that accidentally calls `reissue` satisfies S-FIX-1 and loses S-FIX-6 — silently, and nobody here can notice it.
**Rejected.** (a) Merging the two methods into one with a flag. (b) Forbidding `reissue` when the user has further sessions.
**Reason.** (a) is exactly the flag S-FIX-6 rules out ("This is not a flag."), and rule 1 of the interface forbids the boolean parameter anyway. (b) would be wrong: completing the second factor is a re-issue **without** revoking the other sessions and the most frequent caller of `reissue`. The caller that has to get it right is the password feature, and the call stands there. This hand-off is therefore named the way E-233 and E-234 are named: **`password.change` and `password.set` call `reissueAfterCredentialChange`, `password.redeemReset` calls `revokeEverySessionOfUser`, and no password path calls `reissue`.**
**Price.** A requirement that depends on a choice of name at a foreign call site. It becomes checkable only once the call site exists — then as a test of the password feature: change the password, create a second session beforehand, count afterwards. Until then this is the only place stating what has to stand there.

### A weakened default is reported by the instance, not by the session service
`E-244` · session · S-DEFAULT-1 hand-off

**Context.** S-DEFAULT-1 demands that a setting weakening a default is logged at start-up. `sessionMetadata: "full"` is such a setting: it lifts the data minimisation from L-10. It is logged nowhere.
**Rejected.** Giving the session service a log sink.
**Reason.** There would then be two — `HttpEnvironment.log` already exists and is the instance's sink. Two sinks means two formats, two configurations and two places an operator has to search. Start-up belongs to the assembly function anyway: it reads the configuration, it knows the defaults, and it has the sink. The session service supplies it the basis by not hiding the chosen mode.
**Price.** Until that assembly function exists, S-DEFAULT-1 is unfulfilled for `sessionMetadata`, and nobody sees it. That is the third hand-off of this kind after E-233 and E-243; all three end in the same place, namely where `createVelveAuth` will come into being.

### Four exports without callers stay, and the test plan records which
`E-245` · session · knip

**Context.** `knip` treats every test file as an entry point, so an export only a test calls counts as used. `DEFAULT_SESSION_CONFIG`, `InvalidSessionConfigError`, `isSessionFresh` and `createSessionService` have no caller in `src/` outside their own file.
**Rejected.** Removing them one by one, or not exporting them until a caller exists.
**Reason.** All four are the module's interface upwards, and upwards there is nothing yet: `createVelveAuth` is the assembly function that will call them. Hiding them now would mean digging them out again at assembly — movement without insight. `isSessionFresh` is additionally the definition `assertSessionIsFresh` sits on; the predicate form without an exception is what a surface needs that wants to show "this session is fresh" instead of asking and catching.
**Price.** Four exports the gate does not recognise as dead, because tests keep them alive. The review pinned the list as a test case so that it stays a decision and does not become a catch-all: whoever adds a fifth has to change the list and say why while doing it.

### The re-issue after a credential change does not check freshness itself
`E-246` · session · freshness

**Context.** `list`, `revoke`, `revokeEveryOther` and `revokeEvery` fetch their actor through `actorOfFreshSession` and thereby check freshness (E-233). `reissueAfterCredentialChange` is the only method with resolution that does not.
**Rejected.** Building the check in there as well, for uniformity's sake.
**Reason.** B.9 places the demand on `password.set` and `password.change`, that is on the route, **before** work is done. The re-issue is the consequence of that work and runs afterwards — after an Argon2id run costing tenths of a second. A freshness check at this place could therefore fail **after** the password has already been changed: the new password holds, the other sessions live on, and the caller has no new session — exactly the half state S-FIX-6 rules out. A check that fails late enough to do damage is worse than no check.
**Price.** The rule "freshness is checked where the actor comes into being" has an exception, and it stands only here. Whoever calls `reissueAfterCredentialChange` from a path B.9 does not oblige to freshness anyway bypasses the check — and that is one more reason for the call list from E-243 to stay complete.

### The session service takes no clock at all any more
`E-247` · session · time source

**Context.** E-238 put freshness on the database clock and thereby removed the last use of the option `clock` in this module. That entry kept it anyway, so that an instance can hand every module the same clock, and described the price as a documentation task.
**Rejected.** Leaving the option as accepted-and-ignored, with a bold paragraph in the reference.
**Reason.** A parameter that exists, that type-checks and that is thrown away is an offer that lies. Whoever passes a test clock gets a service reading `now()` from the database; a test that advances that clock to age a session observes nothing and turns **green for the wrong reason**. That is not a supposition: three of our own tests had run into exactly this trap before E-238 made it visible, and a paragraph in the reference would not have saved them from it — a compile error on `clock:` would have. The caller's convenience does not demand that this module accept a parameter it discards; the assembly function hands each module what it reads.
**Price.** The absence is now itself the invariant and has to be documented as such, otherwise the next reader looks for the option. Two of the review's test cases that fed in a skewed process clock can no longer do so — they claim instead what now holds structurally, and their names say it. Gone with it is the possibility of simulating a clock skew at all; were there ever a moment the database does not supply, the clock would come back as a required field and this decision with it.

### The marker names the requirement deviated from, and the condition under which that is permissible
`E-248` · session · S-OWNER-2

**Context.** The marker on the sign-out `DELETE` first cited S-FIX-3, because a session row is addressed there by `token_sha256` alone. The gate agent took two things apart in that. First, S-FIX-3 governs the eight events that change the trust level — signing out is not one of them; whoever follows the citation number lands at a clause that does not speak of signing out. Second, as a line comment behind `DELETE FROM ${table}` the marker opened a trap: if the newline falls away — logging, forwarding, normalisation — the comment swallows the `WHERE`, and what remains is `DELETE FROM velve.session`. Every row.
**Rejected.** (a) Staying with S-FIX-3, because the reading of the hash as an address comes from there. (b) Putting the marker at the end behind `RETURNING`, where it can swallow nothing.
**Reason.** (a) confuses reason and deviation. What is deviated from is **S-OWNER-2** — the owner condition belongs in the predicate — and the justification is that the only version literally satisfying S-OWNER-2 would be a preceding `SELECT`, which the same requirement forbids elsewhere. The conflict **is** the justification; S-FIX-3 only supplies the reading that the hash is the address. What is cited is therefore the deviation, not the reading. (b) would be safe at this one place and not again elsewhere. A block comment ends where it ends, no matter how the whitespace is normalised — the property one wants then no longer hangs on position.
**Price.** The permissibility condition left over from the rejected two-exceptions limit stands only in prose: **a marker is permissible when the predicate is itself a secret** — the token hash here, the one-time token there. It cannot be checked mechanically; what the check sees is only that a requirement was named. Whoever places a third marker has to make that case, and whoever reads it has to demand it.

### Two branches wrote the same rule into the same gate file, and only a planted input told them apart
`E-249` · session · gate-tool ownership

**Context.** `test/db-static-sql.test.ts` holds the rule that a statement without an owner predicate has to declare itself. Both this branch and `main` rewrote that rule from a line comment to a block comment — independently, within the same wave, in the same file the working method says no two writers may share. Both arrived at the identical design and differed only in how the marker's body is matched: `main` wrote `[^*]*`, this branch wrote `[\s\S]*?`. On every statement in the repository the two agree, so the merge conflict looked like a formatting difference and nothing else.
**Rejected.** (a) Taking `main`'s form because `main` is the base and the base wins by default. (b) Keeping both expressions and accepting a marker either one accepts.
**Reason.** (a) is merge order deciding a rule, which is not a review; the reason it was rejected is that the difference had not been read yet, not that `main`'s form was known to be worse. Reading it settled it: `[^*]*` cannot cross an asterisk, so a marker whose reason contains one — `/* no owner predicate: S-TOKEN-4 (see the 5*3 rule) */` — is not recognised as a marker at all, and the statement is then reported as having no declaration whatsoever. That is the failure mode §5 of the repository rules names: the check can no longer tell "no marker" from "a marker it cannot parse", and the author is sent to fix something that is not wrong. (b) is worse than either single form, because a union of two patterns is a rule nobody can state in one sentence.
**Price.** The kept form is not the better one everywhere, and calling it a gain was wrong. `[\s\S]*?` stops at the first `*/` in the statement, so a marker that was opened and never closed is read as a complete declaration the moment any later comment supplies a closing marker — `/* no owner predicate: S-OWNER-2` followed further down by `/* anything */` counts as declared. PostgreSQL reads that same text as one comment running to the end, so the predicate the statement was exempted for is the predicate that got commented out. `main`'s `[^*]*` refused it, because it refuses every asterisk. Neither this check nor `check:sql-collapse` notices the result: the collapse check strips an unterminated comment the same way whichever order it works in, so the statement passes it too. The trade is therefore one blind spot for another, and the one taken on is the more dangerous of the two — it grants an exemption where the other only withheld one. It is left standing rather than patched a third time, because a third form of this expression needs its own argument and its own owner, and this branch has no claim to the file. The difference that decided the choice cannot be observed anywhere in the current tree — no marker in this repository contains an asterisk — so the resolution rests on a planted input and on nothing else, and it is only worth what that input is worth. The planted case is therefore now a test case in the same file, next to the two faults it must keep rejecting. The collision itself is not repaired by any of this: the file is still shared, nothing stopped either writer from opening it, and the next pair will meet in it the same way. Counting this branch alone, four crossings happened, not one — `test/decision-log.test.ts` for the English format, and `test/identity-sign-in-methods.test.ts`, `test/identity-last-method-race.test.ts` and their thirteen call sites once the narrowed `actorOfResolvedSession` met identity at the merge. All were reported rather than quietly taken; that is the whole of the safeguard, and it is a habit, not a mechanism. **Addendum:** one of the four was undone rather than kept. `test/decision-log.test.ts` is `main`'s again, taken whole when the central language pass landed; the version written here is gone, and nothing of it was merged back in.

**E-250 — Der Zufall zieht nach `core/token/` um, und `core/keys/` reicht ihn nicht weiter.**
*Kontext:* E-63 hat das Zufallsmodul bewusst als Schuld in `core/keys/` liegen lassen, weil `core/token/` damals einem anderen Autor gehörte. Jetzt gehört es diesem hier, und S-RAND-5 sowie 3.1 nennen `core/token/random.ts` als den Ort. Die Datei ist umgezogen, `core/keys/aes-gcm.ts` und `core/keys/envelope.ts` holen die Nonce jetzt aus `../token/random.js`.
*Verworfen:* Den Namen `randomBytes` weiterhin aus `core/keys/index.ts` zu re-exportieren, damit kein einziger fremder Test angefasst werden muss.
*Grund:* Zwei Importpfade für dasselbe Geheimniswerkzeug sind der erste Schritt zurück in die Zersplitterung, gegen die S-RAND-5 geschrieben ist: Wer den zweiten Pfad findet, hat keinen Anlass mehr, nach dem ersten zu fragen. Die Umschreibung ist mechanisch — zwölf Importzeilen — und einmalig; ein Weiterleitungsexport hätte dauerhaft die Frage offengelassen, welcher der beiden Pfade der richtige ist.
*Preis:* Elf Testdateien des Features `keys` tragen jetzt eine Importzeile, die auf `core/token/` zeigt, obwohl sie Schlüsselverwaltung prüfen. Das ist die richtige Abhängigkeitsrichtung — Schlüssel brauchen Zufall, nicht umgekehrt —, sieht in der Importliste aber nach einer Vermischung aus. Zusätzlich sind mit dem Modul auch dessen Prüfungen umgezogen: `test/keys-random.test.ts` heißt jetzt `test/token-random.test.ts`.

**E-251 — Die Tripwire für S-RAND-5 bleibt, wo der Prüfer sie hingelegt hat.**
*Kontext:* `test/keys-static-scan.test.ts` fixiert den Pfad des einzigen Moduls mit `crypto.getRandomValues`. Der Prüfer des Features `keys` hat ihn dort verankert, damit ein Umzug nicht stillschweigend passieren kann. Beim Umzug schlug die Prüfung wie vorgesehen fehl.
*Verworfen:* Die Prüfung nach `test/token-static-scan.test.ts` zu verschieben, weil S-RAND-5 zu diesem Feature gehört.
*Grund:* Der Wert dieser Zeile besteht darin, dass sie von jemandem stammt, der den Umzug nicht plant. Eine Prüfung, die im selben Zug mit dem Umzug in dessen eigenes Verzeichnis wandert, prüft den Umzug nicht mehr — sie folgt ihm. Sie bleibt also stehen und wird auf den neuen Pfad umgestellt; die Untergrenze von elf Dateien im Verzeichnis `core/keys/` bleibt unverändert, weil dort nach dem Umzug genau elf übrig sind.
*Preis:* Eine Behauptung über `core/token/` steht in einer Datei mit `keys` im Namen. Wer S-RAND-5 sucht, findet sie nicht dort, wo er zuerst nachsieht — deshalb steht dieselbe Behauptung zusätzlich in `test/token-static-scan.test.ts`, und beide müssen bei einem weiteren Umzug angefasst werden.

**E-252 — Die Frist rechnet die Datenbank, nicht der Prozess.**
*Kontext:* Der Konsum vergleicht `expires_at > now()`, also gegen die Uhr des Datenbankservers. Die Frist beim Ausstellen konnte entweder aus derselben Uhr oder aus der des Anwendungsprozesses kommen.
*Verworfen:* `expires_at` in TypeScript zu rechnen und als Parameter zu schicken.
*Grund:* Eine Frist, die von zwei Uhren abhängt, ist zwei Fristen. Geht die Anwendungsuhr fünf Minuten vor, ist ein Magic Link fünfzehn statt zehn Minuten gültig, und niemand merkt es, weil beide Seiten für sich stimmen. `now() + make_interval(...)` bindet Ausstellung und Ablauf an dieselbe Uhr. Hinzu kommt, dass die statische Kernprüfung des Features `keys` `Date.now` und `new Date(` im gesamten `core/` verbietet — die zweite Uhr war dort ohnehin nicht erreichbar.
*Preis:* Ein Test kann das Ablaufen nicht durch Vorstellen einer Uhr herbeiführen; er muss `expires_at` in der Zeile zurückdatieren. Das prüft dieselbe Bedingung, sieht aber weniger nach einer Simulation der Zeit aus und mehr nach einem Eingriff in die Daten.

**E-253 — `expiresAt` kommt als ISO-8601-Zeichenkette zurück, nicht als `Date`.**
*Kontext:* Die Ausstellung muss die Frist zurückgeben, weil sie in die versendete Nachricht gehört (3.15 A.7). Was ein Treiber aus einer `timestamptz`-Spalte macht, ist aber Treibersache: `node-postgres` liefert ein `Date`, das Textprotokoll eine Zeichenkette.
*Verworfen:* Ein `Date` zurückzugeben und im Kern umzuwandeln, wie 3.15 A.7 es für `EmailMessage` vorsieht.
*Grund:* Ein Rückgabetyp, der davon abhängt, welchen Treiber die Anwendung eingesetzt hat, ist kein Typ, sondern eine Wette. `to_char(expires_at AT TIME ZONE 'UTC', …)` liefert bei jedem Treiber dieselbe Zeichenkette. Dass der Kern `new Date(` nicht benutzen darf, hätte die Umwandlung ohnehin verhindert.
*Preis:* Die Schicht, die `EmailMessage` baut, muss die Zeichenkette in ein `Date` verwandeln. Das ist eine Zeile bei ihr statt einer Zeile hier, und die Typen der beiden Schichten stimmen an dieser Stelle nicht wörtlich überein.

**E-254 — Ersetzen und Einfügen sind eine Anweisung, keine Transaktion.**
*Kontext:* S-TOKEN-3 verlangt, dass eine neu angeforderte Marke die vorherigen desselben Zwecks desselben Nutzers „in derselben Transaktion" löscht.
*Verworfen:* `driver.transaction` um ein `DELETE` und ein `INSERT` zu legen.
*Grund:* Eine datenverändernde CTE erledigt beides in einer Anweisung und damit unteilbar, ohne dass das Repository eine Transaktion eröffnet. Das ist hier kein Schönheitsargument: Wirft der Mailversand, muss die ganze Ausstellung zurückgerollt werden (3.15 A.7) — die Transaktion gehört also dem Aufrufer, und ein Repository, das selbst eine eröffnet, nimmt sie ihm entweder weg oder verschachtelt sie.
*Preis:* Wer die Anweisung liest, muss wissen, dass eine schreibende CTE auch dann ausgeführt wird, wenn niemand sie referenziert. Das ist PostgreSQL-Wissen, das die Anweisung nicht selbst mitliefert; deshalb steht eine Zeile Kommentar mit der Anforderungsnummer daneben.

**E-255 — Der Konsum nimmt keinen `actor`, und das ist der Punkt.**
*Kontext:* S-OWNER-1 verlangt für jede Repository-Methode auf einer Tabelle mit `user_id`-Spalte einen `actor`. `velve.one_time_token` hat eine solche Spalte. S-TOKEN-4 verlangt zugleich, dass das Zielkonto **ausschließlich** aus `one_time_token.user_id` stammt.
*Verworfen:* Einen `actor` mitzuführen und zusätzlich gegen die Zeile zu prüfen.
*Grund:* Wer einen Kennwort-Reset einlöst, ist gerade nicht angemeldet — es gibt keinen Actor, den er beisteuern könnte. Ein Pflichtparameter, den der Aufrufer erfinden muss, ist schlimmer als keiner: Er sieht aus wie eine Eigentümerprüfung und ist keine, und beim nächsten Leser wird er zu einer. Die Actor-Pflicht aus 3.11 gilt der Plugin-Oberfläche; dieses Repository ist keine. Der Token selbst ist hier der Ausweis.
*Preis:* Die statische Prüfung des Features `db` verlangt für jede löschende Anweisung ein `user_id` im `WHERE`. Die Konsumanweisung besteht sie — aber nur, weil ihr `RETURNING user_id` hinter dem `WHERE` steht und der Ausdruck der Prüfung bis dorthin reicht. Sie besteht also aus dem falschen Grund. Das ist gemeldet und nicht stillschweigend ausgenutzt; die Ausnahme steht zusätzlich als eigene Behauptung in `test/token-static-scan.test.ts`, damit sie nicht irgendwann als Versehen gelesen wird.

**E-256 — Eine Zeile ohne Nutzer ist nicht einlösbar, wird aber verbraucht.**
*Kontext:* `one_time_token.user_id` ist im Schema nullbar. Die Bibliothek schreibt dort immer einen Nutzer hinein, aber das Schema garantiert es nicht.
*Verworfen:* (a) `userId` als `string` zu typisieren und die Garantie zu behaupten. (b) `AND user_id IS NOT NULL` in die Bedingung aufzunehmen.
*Grund:* (a) wäre eine Typlüge an genau der Stelle, an der S-TOKEN-4 verlangt, dass die Spalte das Konto bestimmt. (b) hätte die Anweisung verändert, die 3.7 wörtlich vorschreibt und die S-REPLAY-2 wörtlich festhält. Die Ablehnung liegt deshalb eine Ebene höher: keine Nutzerkennung, kein Ziel, also dieselbe Antwort wie bei jedem anderen ungültigen Token.
*Preis:* Die Zeile ist nach einem gescheiterten Versuch weg. Sie war ohnehin nicht einlösbar, aber wer sie zur Untersuchung stehen lassen wollte, kann das nicht.

**E-257 — Der base64url-Kodierer steht neben dem Dekodierer, also in `core/keys/`.**
*Kontext:* Ein Einmal-Token ist base64url. Im Kern gab es nur den Dekodierer; E-62 hat für den Gegenweg ausdrücklich denselben Platz vorgesehen.
*Verworfen:* Einen eigenen Kodierer in `core/token/` zu schreiben, um keine fremde Datei anzufassen.
*Grund:* Zwei Kodierungen desselben Alphabets in zwei Verzeichnissen sind eine Kodierung zu viel, und E-62 hatte den Platz reserviert, bevor die Frage gestellt wurde. Eine bestehende Entscheidung wegen einer Zuständigkeitsgrenze zu übergehen, kostet mehr als die Grenze wert ist.
*Preis:* Dieses Feature ändert eine Datei des Features `keys`. Das ist angekündigt und nicht heimlich, aber es ist eine Ausnahme von der Regel, dass zwei Autoren keine Datei teilen.

**E-258 — Die Nebenläufigkeitsprüfung läuft bei jedem Commit, obwohl Abschnitt 6 sie nächtlich einordnet.**
*Kontext:* T-RACE-1 und der nebenläufige Teil von T-RACE-2 sind dort dem nächtlichen Lauf zugewiesen: 4 Zwecke × 20 Wiederholungen × 50 gleichzeitige Einlösungen, Toleranz 0.
*Verworfen:* Sie aus `pnpm test` herauszunehmen und einem eigenen Lauf zu überlassen.
*Grund:* Gemessen kosten beide Fassungen zusammen etwa fünf Sekunden. Für diesen Preis nächtlich zu prüfen, ob ein Token zweimal eingelöst werden kann, wäre eine Sparsamkeit am falschen Ende. Der Wert der Prüfung ist belegt: Ersetzt man den atomaren Konsum durch ein `SELECT` mit anschließendem `DELETE`, gewinnen von 1000 Versuchen 962 bis 1000 statt 20 — mit der künstlichen Verzögerung aus T-RACE-2 sind es 1000 von 1000, also jeder einzelne.
*Preis:* Der Lauf hält fünfzig Verbindungen gleichzeitig offen. Bei einem PostgreSQL mit knappem `max_connections` und paralleler Ausführung der Testdateien ist das die Datei, die zuerst an die Grenze stößt.

**E-259 — Korrektur zu E-254: die CTE ist unteilbar, aber ihr `DELETE` sieht eine gleichzeitige Einfügung nicht.**
*Kontext:* E-254 hat Ersetzen und Einfügen in eine datenverändernde CTE gelegt und daraus geschlossen, die vorherigen Marken könnten die neue nicht überleben. Das war falsch, und der Kommentar im Quelltext behauptete es wörtlich. Unter `READ COMMITTED` arbeitet das `DELETE` mit dem Schnappschuss, den die Anweisung beim Start genommen hat; eine Zeile, die eine gleichzeitige Anforderung kurz davor eingefügt hat, steht nicht darin und wird nicht gelöscht. Gemessen: acht gleichzeitige `issue`-Aufrufe für denselben Nutzer und Zweck hinterlassen fünf bis acht lebende Zeilen, und sechs von acht lassen sich anschließend einlösen. Wer N gleichzeitige Reset-Anforderungen abschickt, hält N gültige Reset-Token — genau das, was 3.7 ausschließt.
*Verworfen:* (a) Einen `UNIQUE`-Index auf `(user_id, purpose)` anzulegen und den Konflikt aufzulösen. (b) Die Anforderung als sequenziell zu lesen und den Fall der gleichzeitigen Anforderung als Ausnahme zu dokumentieren.
*Grund:* (a) wäre die strukturell schönere Lösung, ändert aber das Schema aus 3.2, das dort keinen solchen Index vorsieht, und liegt damit außerhalb dieses Features. (b) hätte eine Verhaltensanforderung in eine Empfehlung umgedeutet: 3.7 sagt nicht „bei nacheinander eintreffenden Anforderungen". Stattdessen serialisiert eine Sperre auf der Nutzerzeile — `SELECT 1 FROM velve.user WHERE id = $1 FOR UPDATE` in derselben Transaktion, vor der Ersetzung. Die zweite Anforderung wartet, bis die erste festgeschrieben ist, und ihr `DELETE` nimmt den Schnappschuss danach. Für den Rücklauf beim gescheiterten Mailversand (3.15 A.7) stand hier zunächst eine falsche Prämisse — „beide Treiber verbinden sich mit einer bereits offenen Transaktion“. Ausgeliefert wird genau ein Treiber, `@velve/auth/pg`. Dass `transaction` auf einem gebundenen Treiber der offenen Transaktion beitritt statt eine zweite zu eröffnen, verlangt die Referenz von jedem Treiber — es steht aber im Text und nicht im Typ, denn `Driver` sind zwei Methodensignaturen. `createNodePostgresDriver` erfüllt es, also gilt die Schlussfolgerung für den ausgelieferten Treiber; für jeden anderen ist sie eine Bedingung, die er erfüllen muss.
*Preis:* Die Sperre wirkt weiter, als dieser Eintrag zunächst behauptet hat. Nicht nur Anforderungen desselben Zwecks laufen nacheinander: Solange sie gehalten wird, wartet **jedes Schreiben einer nutzergebundenen Zeile für dieses Konto** — ein gleichzeitiges `INSERT INTO velve.session` für denselben Nutzer blockiert, gemessen vom Haupttor. Und weil die Transaktion nach 3.15 A.7 den Mailversand enthält, hält ein hängender SMTP-Anbieter die Sperre für die Dauer seines Zeitlimits; jede Anmeldung dieses Kontos wartet so lange mit. Dazu kommt die Verklemmungsgefahr: Wer später eine andere Zeile sperrt und *danach* die Nutzerzeile, schließt den Zyklus — dagegen steht jetzt die Reihenfolgeregel in Abschnitt 7 der Repository-Regeln und `pnpm check:lock-order` (E-143), nicht mehr nur dieser Absatz. Schließlich ist die Sperre der erste lesende Zugriff im Repository überhaupt: Sie liest eine andere Tabelle als die, die gleich geschrieben wird, und entscheidet nichts über deren Zeile, aber sie muss jedem erklärt werden, der die Datei mit S-RACE-2 im Kopf öffnet.

**E-260 — Der Token trägt eine Marke, und die Umwandlung prüft nichts.**
*Kontext:* `redeem({ token: userId })` übersetzte, weil Nutzerkennung und Token beide `string` sind. S-RAND-6 verlangt, dass ein Datenbankschlüssel nicht ohne ausdrückliche Umwandlung als Token verwendbar ist, und T-RAND-6 verlangt, dass der Negativfall nicht übersetzt statt in einer Prüfnotiz zu stehen.
*Verworfen:* `toSecretToken` die Form prüfen zu lassen — 43 Zeichen, base64url —, weil eine Umwandlung, die alles annimmt, wie eine Attrappe aussieht.
*Grund:* Eine Formprüfung wäre eine zweite Antwort neben „keine Zeile". Ein Token mit falscher Länge würde früher und anders abgelehnt als ein wohlgeformter, der nie ausgestellt wurde — messbar an der Laufzeit und sichtbar an der Fehlerstelle. S-REPLAY-3 verlangt eine einzige Antwort; die Marke ist deshalb ausdrücklich nominal und nicht validierend. Was sie leistet, ist genau das, was verlangt war: Der Übergang von einer beliebigen Zeichenkette zu einem Token steht als Aufruf im Quelltext und ist in der Durchsicht sichtbar.
*Preis:* Die zweite Richtung fehlt. Ein `SecretToken` ist weiterhin dort zulässig, wo eine Nutzerkennung erwartet wird, weil es den Typ `EntityId` aus S-RAND-6 im Kern noch nicht gibt und er nicht in `core/token/` gehört. Von den zwei Negativfällen, die T-RAND-6 fordert, ist einer erfüllt.

**E-261 — Auch der Fehler, den niemand erreichen sollte, trägt einen Code.**
*Kontext:* Das Repository warf ein blankes `Error`, wenn das `INSERT … RETURNING` keine Zeile meldet. Das ist ein Bruch einer Invariante und im Betrieb nicht erreichbar; die Regel aus Abschnitt 3 kennt aber keine Ausnahme für unerreichbare Fehler.
*Verworfen:* Den Zweig zu entfernen und die Zeile mit einer Nicht-Null-Behauptung zu lesen.
*Grund:* Die Behauptung wäre eine Typlüge über eine Antwort, die von einem fremden Treiber kommt — genau die Stelle, an der eine Bibliothek nichts behaupten sollte. Ein `OneTimeTokenNotWrittenError` mit `code = "one_time_token_not_written"` kostet acht Zeilen und macht den Fall unterscheidbar, wenn ihn doch einmal jemand sieht, etwa mit einem selbstgeschriebenen Treiber, der Zeilen verschluckt.
*Preis:* Eine Fehlerklasse mehr, die in keiner Fehlerabbildung auftaucht — sie ist kein sichtbarer Code aus 3.13, sondern ein innerer. Wer sie über HTTP zu sehen bekommt, sieht `internal_error`, und das ist richtig so.

**E-262 — Die Verbindungsgrenze der Nebenläufigkeitsdateien wird nicht hier entschieden.**
*Kontext:* Der Preis aus E-258 ist eingetreten: Die Datei dieses Features hält fünfzig Verbindungen für ihre gesamte Laufzeit, Vitest führt Testdateien parallel aus, und ein PostgreSQL mit `max_connections = 100` reicht dafür nicht mehr, sobald eine zweite Nebenläufigkeitsdatei dazukommt. In der Durchsicht sind dadurch eine fremde `db`-Testdatei und eine Prüfdatei mit „too many clients" gestorben.
*Verworfen:* (a) Die eigene Datei auf zwölf Verbindungen zu verkleinern, wie es die Prüfdatei getan hat. (b) `vitest.config.ts` um ein sequenzielles Projekt für Nebenläufigkeitsdateien zu erweitern.
*Grund:* (a) unterschreitet die Schwelle, die Abschnitt 6 für T-RACE-1 festlegt — fünfzig gleichzeitige Einlösungen —, und eine Prüfung unter ihre eigene Schwelle zu drücken, um Verbindungen zu sparen, ist der falsche Tausch. (b) ist die richtige Form, betrifft aber eine Datei, die diesem Feature nicht gehört, und eine Entscheidung, die für alle Nebenläufigkeitsdateien gilt und nicht für eine. Gemessen wurde hier; entschieden wird eine Ebene höher.
*Preis:* Der Vorschlag wurde angenommen und liegt als eigenes, sequenzielles Vitest-Projekt für Nebenläufigkeitsdateien auf `main`. Damit ist die Reihenfolge der Testdateien nicht mehr der entscheidende Faktor, aber eng bleibt es: Ein vollständiger Lauf erreichte danach gemessen 89 von 100 Verbindungen, weil die Dateien des `unit`-Projekts weiter parallel dazu laufen. Die Wartschleife, die die Prüfdateien beim Verbindungsaufbau eingebaut haben, ist also noch nicht überflüssig.

**E-263 — Eine Fehlerklasse mit einem Code, und zwei Wächter vor dem Treiber (ersetzt die Klasse aus E-261).**
*Kontext:* E-261 gab dem unerreichbaren Invariantenbruch eine eigene Klasse. Das Haupttor fand zwei Eingaben, die erreichbar sind und keinen Code hatten: Ein Nutzer, der zwischen Auflösung und Ausstellung gelöscht wird, erzeugt eine Fremdschlüsselverletzung, und ein Zweck außerhalb der vier lässt `make_interval` mit NULL rechnen und schlägt an `expires_at NOT NULL` fehl. Beide Male trägt die Meldung des Treibers Tabellen- und Bedingungsnamen aus der Bibliothek heraus. Nachgemessen: ohne die Wächter kommen genau diese beiden `PostgresServerError` zurück.
*Verworfen:* (a) Zwei weitere Fehlerklassen neben `OneTimeTokenNotWrittenError`. (b) Die Treiberfehler abfangen und anhand ihres `SQLSTATE` übersetzen.
*Grund:* (a) hätte drei Klassen für dieselbe Fehlerart ergeben; die Schlüsselverwaltung hat dieselbe Frage anders beantwortet und ist gut damit gefahren — eine Klasse, ein Code darauf, feste Meldung je Code. (b) hätte die Bibliothek an eine Treibereigenschaft gebunden, die die Schnittstelle `Driver` gar nicht anbietet: Sie gibt Zeilen zurück, keine Fehlercodes. Beide Fälle lassen sich stattdessen *verhindern*: Der Zweck wird gegen die Aufzählung geprüft, bevor irgendeine Anweisung läuft, und der Nutzer steht in der Sperrabfrage, die ohnehin schon läuft — null Zeilen heißt, es gibt ihn nicht.
*Preis:* Der Klassenname aus E-261 ist weg; wer ihn zitiert, findet ihn nicht mehr. Und die Zweckprüfung ist eine Laufzeitprüfung für etwas, das der Typ bereits ausschließt — sie steht dort ausschließlich für Aufrufer ohne Typprüfung und ist für alle anderen toter Zweig.

**E-264 — T-RAND-Verteilung läuft mit der Schwelle aus Abschnitt 6, und deshalb nicht vor einem Merge.**
*Kontext:* Die Verteilungsprüfung stand mit N = 20 000, ohne Runs-Test und im blockierenden Pfad. Abschnitt 6 legt N = 100 000, Monobit **und** Runs, und den nächtlichen Lauf fest. Das Haupttor hat sie an Position 36 scheitern sehen; nachgemessen scheitert sie mit einem einwandfreien Generator in etwa jedem zwölften bis fünfundzwanzigsten Lauf.
*Verworfen:* (a) Die Schwelle bei 20 000 lassen und den Ausreißer als Rauschen abtun. (b) Das kritische Chi-Quadrat je Position anheben, bis die Familie von 42 Tests zusammen bei p = 0,001 landet.
*Grund:* (a) ist genau das, was 6.20 verbietet — eine Schwelle wird nicht gesenkt, damit ein Test grün wird, und eine entschärfte Prüfung ist schlechter als eine abgeschaltete, weil sie weiterhin nach Beweis aussieht. (b) klingt nach Statistik und ist eine Absenkung: Ein größerer kritischer Wert macht jede einzelne Position leichter bestehbar, und Abschnitt 6 schreibt p > 0,001 **je Position** vor, nicht für die Familie. Der Fehler lag nie bei N — 42 unabhängige Tests bei p = 0,001 verwerfen rund vier von hundert Läufen, bei jedem N. Genau darum steht die Zeile in Abschnitt 6 im nächtlichen Lauf: Ein Ausreißer gehört vor Augen, die ihn einordnen können, und nicht vor eine Zusammenführung.
*Preis:* Der Lauf hängt an einer Umgebungsvariablen (`VELVE_NIGHTLY=1`) statt an einem eigenen Vitest-Projekt, weil dafür `vitest.config.ts` und `package.json` hätten geändert werden müssen und beide diesem Feature nicht gehören. Die Übergabe ist inzwischen angenommen: `pnpm test:nightly` setzt die Variable, und `.github/workflows/nightly.yml` ruft es nach einem Zeitplan auf — die Prüfung läuft also. Die Verpflichtung je Commit deckt weiterhin T-RAND-4 mit seiner eigenen Schwelle von 1000 Werten ab. Offen bleibt T-RAND-Kollision: eine Million Werte in acht Arbeitern, nicht geschrieben.

**E-265 — Der Zweck steht in einem eigenen Feld des Fehlers, nicht in seiner Meldung.**
*Kontext:* E-263 hat die Meldungen je Code festgeschrieben, damit nichts, was der Aufrufer übergeben hat, in eine Fehlerzeichenkette gerät. Damit verschwand aber auch der Zweck aus der Meldung — und der Prüftest zur Auskunftsfreudigkeit verlangt ausdrücklich, dass ein gescheitertes Ausstellen noch sagt, worum es ging. Ohne diese positive Behauptung würde ein Fehler, der überhaupt nichts enthält, alle „enthält nicht"-Prüfungen desselben Tests bestehen.
*Verworfen:* (a) Den Zweck wieder in die Meldung schreiben. (b) Die positive Behauptung des Prüftests durch eine schwächere ersetzen.
*Grund:* (a) hätte bei genau dem Code, der wegen eines unbekannten Zwecks feuert, eine beliebige fremde Zeichenkette in die Meldung und damit in jedes Protokoll gespült. (b) hätte einen Prüftest entschärft, um eine eigene Entscheidung zu retten. Abschnitt 3.15 F.1 hat dieselbe Frage schon einmal beantwortet: E-129 legte die Ausnahme in ein eigenes Protokollfeld statt in den Grund. Der Fehler trägt den Zweck deshalb als `purpose` neben `code` — typisiert, also nur einer der vier, und `null` bei dem einen Code, dessen Auslöser gerade keiner ist.
*Preis:* Der Fehler hat jetzt zwei Felder, die zusammengelesen werden müssen, und eines davon ist manchmal `null`. Wer nur die Meldung ins Protokoll schreibt, verliert die Auskunft wieder.

**E-266 — Die Markierung ist ein Blockkommentar, und eine Prüfung faltet jede Anweisung auf eine Zeile.**
*Kontext:* Die Ausnahme aus E-142 stand als `-- no owner predicate: S-TOKEN-4` in einer eigenen Zeile über dem `WHERE` der Einlöseanweisung. Ein Zeilenkommentar reicht bis zum Zeilenende — fällt der Zeilenumbruch weg, was jeder Logger, jeder Formatierer und jeder vorgelagerte Proxy tun darf, lautet die Anweisung `DELETE FROM velve.one_time_token`. Ohne Bedingung. Jeder Einmal-Token der Tabelle. Die Prüfung wäre grün geblieben, weil auch die gefaltete Zeile eine gültige Markierung enthält.
*Verworfen:* (a) Die Markierung ans Ende der Anweisung schieben, wo hinter ihr nichts mehr steht. (b) Auf die Markierung verzichten und zur Ausnahmeliste zurückkehren.
*Grund:* (a) hätte den Einzelfall entschärft und die Form stehen lassen: Der Nächste schreibt sie wieder in die Mitte, und dann ist es eine andere Tabelle. (b) hätte das Problem aus E-142 zurückgeholt. Ein Blockkommentar ist gegen jede Normalisierung von Leerraum unempfindlich, weil sein Ende im Text steht und nicht im Zeilenumbruch. Dazu kommt die Prüfung, die den Fehler überhaupt hätte finden können: Jede Anweisung des Repositorys wird auf eine Zeile gefaltet, und das Entfernen der Kommentare muss vorher wie nachher dieselbe Anweisung ergeben. Gepflanzt wird dieselbe Markierung in beiden Kommentarformen — die Zeilenform scheitert, die Blockform besteht —, damit ein grüner Lauf belegt, dass die Prüfung die beiden unterscheidet und nicht alles durchlässt.
*Preis:* Die Anweisung stimmt nicht mehr Zeichen für Zeichen mit dem SQL-Block aus 3.7 überein; der Vergleich in `test/token-static-scan.test.ts` entfernt vorher die Kommentare und musste dafür auch Blockkommentare kennen. Und die Faltprüfung ist eine Prüfung über eine Eigenschaft, die keine Anforderung dieses Berichts nennt — sie steht hier, weil der Fehler hier passiert ist.

**E-267 — Korrektur zu E-250: `core/keys/` und `core/token/` hängen wechselseitig voneinander ab, und ein neutraler Ort wird zurückgestellt.**
*Kontext:* E-250 hielt fest, die Richtung stimme — „Schlüssel brauchen Zufall, nicht umgekehrt". Das war beim Schreiben wahr und ist es seit E-257 nicht mehr. Heute gilt beides zugleich: `core/keys/aes-gcm.ts` und `core/keys/envelope.ts` holen `randomBytes` aus `../token/random.js`, und `core/token/secret-token.ts` holt `encodeBase64Url` aus `../keys/base64url.js`. Auf Verzeichnisebene ist das ein Zyklus. Auf Modulebene ist es keiner — beide Blattdateien importieren nichts —, also meldet ihn kein Werkzeug, und die Kante von `keys` nach `token` verlangt T-RAND-5 zusammen mit 3.1 ausdrücklich. Falsch ist nicht der Umzug, falsch ist der Satz im Protokoll.
*Verworfen:* Ein neutrales Modul, das keinem der beiden Features gehört — etwa `core/bytes/` — mit `randomBytes` und `encodeBase64Url` darin. Beides sind kontextfreie Grundfunktionen ohne eigene Importe und ohne Fachwissen, und beide liegen heute in dem Feature, das sie *weniger* braucht.
*Grund:* **Zurückgestellt, nicht abgelehnt.** Abschnitt 3.1 nennt für die Erzeugung von Geheimnissen den Modulschnitt `core/token/`, und T-RAND-5 wird in Abschnitt 6 an genau diesem Pfad gemessen; die Architektur schlägt das lokale Urteil, also kann `randomBytes` hier nicht umziehen, so gut das Argument auch ist. Ein Umzug nur für `encodeBase64Url` löste die Hälfte und ließe den Zyklus stehen. Ein neutraler Ort für beide ist deshalb eine Änderung an 3.1 und an der Prüfzeile T-RAND-5 und gehört an die Stelle, die beide ändern darf — nicht in einen Feature-Zweig, der die eine Hälfte davon besitzt.
*Preis:* Bis dahin bleibt der Zyklus stehen, und er ist unsichtbar: Kein `knip`, kein Bündler und keine Prüfung dieses Berichts meldet ihn, weil auf Dateiebene keiner existiert. Wer später eines der beiden Verzeichnisse für sich allein ausschneiden will — ein eigenes Paket, ein Testdoppel, eine Abhängigkeitsgrenze —, findet die Kante erst dabei. Und E-250 bleibt wie geschrieben stehen, mit einem Satz, der heute falsch ist; die Reihenfolge der Einträge zeigt, was wann geglaubt wurde, und das ist mehr wert als ein nachträglich geglätteter Eintrag.

**E-268 — Die Ausnahme der Migrationsmodule fällt weg: sie war aus einer Eigenschaft begründet, die der Code nicht hat.**
*Kontext:* Die Faltprüfung aus E-266 nahm `src/core/db/migrations/` aus, mit der Begründung, dort stünden ganze Skripte und der Läufer zerlege sie ohnehin an `;`, bevor irgendetwas den Treiber erreicht. Das Haupttor hat `splitStatements` gelesen: Die Funktion **entfernt keine Kommentare**. Sie erkennt einen `--`-Bereich, hängt ihn wörtlich an (`current += region.text`), und der abschließende Zeilenumbruch liegt *innerhalb* des Bereichs, weil `endOfLineComment` `newline + 1` zurückgibt. Jede Anweisung, die der Läufer an `tx.query()` reicht, trägt ihre Zeilenkommentare also weiterhin und hängt weiterhin an Zeilenumbrüchen. Über die 34 Anweisungen der ersten Migration gelaufen, meldete dieselbe Eigenschaft vier Treffer, und keiner davon verliert nur eine Klausel — es bleibt jeweils **nichts** übrig: die `CREATE TABLE` des Migrationsprotokolls, `velve.password_credential`, `velve.recovery_code` und `CREATE FUNCTION velve.reject_session_owner_update()`, also ausgerechnet der Trigger, der E-23 und S-FIX-2 durchsetzt. Weil `coreMigrations` zur öffentlichen Oberfläche gehört, ist `migration.sql` außerdem eine Zeichenkette, die Anwendungen protokollieren, ausgeben oder in ein Werkzeug einfügen — genau der Weg, für den die Prüfung überhaupt existiert.
*Verworfen:* (a) Die Ausnahme behalten und den Zähler ehrlicher machen, also Anweisungen statt Module zählen. (b) Die Ausnahme behalten und die vier Kommentare zusätzlich reparieren.
*Grund:* (a) hätte die Zahl korrigiert und das Loch gelassen; ein sichtbarer Zähler neben einer ungeprüften Stelle ist kein Ausgleich, sondern eine Beruhigung. (b) hätte die Reparatur an eine Ausnahme geheftet, die den nächsten Zeilenkommentar an derselben Stelle wieder durchlässt. Die vier Kommentare sind jetzt Blockkommentare, in `src/core/db/migrations/initial-schema.ts` und in der ausgelieferten `migrations/0001_initial_schema.sql`, und die Ausnahme ist ersatzlos weg. Die Prüfung zerlegt Skripte an `;` außerhalb von Zeichenketten, Kommentaren und Dollar-Anführung — dieselben Bereiche, die auch `boundaryAt` in `schema-rewrite.ts` kennt — und misst jede Anweisung einzeln, also genau die Einheit, die ein Treiber erhält.
*Preis:* Der Text der ersten Migration ändert sich, also ändert sich ihre Prüfsumme (`958cda8e…` zu `75d3e849…`), und der Läufer weist eine Migration ab, deren Prüfsumme von der eingetragenen abweicht. Für eine Datenbank, in der Migration 1 bereits gelaufen wäre, ist das ein Bruch; das Paket steht bei 0.0.0 und ist nicht veröffentlicht, also trifft es niemanden — aber es ist der Grund, warum genau diese Reparatur später nicht mehr billig gewesen wäre. Und der eigentliche Preis liegt davor: Die Begründung der Ausnahme war von Anfang an nachprüfbar. `splitStatements` steht in diesem Repository, dreiundzwanzig Zeilen lang, und die Behauptung „der Läufer zerlegt vorher" wurde aufgeschrieben, ohne sie zu lesen. Die vier Kommentare sind älter als dieser Zweig; die Ausnahme, die sie verdeckt und dabei behauptet, sie sichtbar zu halten, ist es nicht. Derselbe Fehler noch einmal, eine Nummer kleiner: Der Satz „dieselben Bereiche, die auch `boundaryAt` kennt“ war geprüft an der *Menge* der Bereichsarten und nicht an ihren Zweigen. Drei wichen ab — verschachtelte Blockkommentare (PostgreSQL zählt die Tiefe, die Prüfung nahm das erste schließende Zeichenpaar), Rückwärtsschrägstriche in `E'…'`, und eine nicht geschlossene Dollar-Anführung, deren Ende aus `indexOf` mit `-1` *hinter* dem Öffner lag, sodass der Läufer rückwärts sprang und nie endete. Keiner der drei war erreichbar, und die neuen Prüfungen deckten jede erweiterte Eigenschaft ab und keine der drei. Sie sind jetzt Zweig für Zweig nachgebildet und werden nicht behauptet, sondern gegen `splitStatements` selbst gemessen — an acht gegnerischen Eingaben und an jedem SQL-Literal, das dieses Paket ausliefert. Und ein drittes Mal, wieder eine Nummer kleiner: Der Zähler für verschachtelte Blockkommentare war für SQL richtig und wurde für TypeScript weiterverwendet, wo Blockkommentare nicht verschachteln — dieselbe Funktion, eine Sprache weiter, und ihre zentrale Annahme dort falsch. Was daraus folgt, steht in E-269, weil es eine eigene Entscheidung ist und nicht nur derselbe Befund noch einmal.

**E-269 — Die Prüfung bekommt eine Prüfung darüber, ob sie überhaupt gelesen hat.**
*Kontext:* Eigener Eintrag und nicht ein Anhang zu E-268, weil es um etwas anderes geht: E-268 betrifft eine Ausnahme, die aus einer falschen Eigenschaft begründet war; hier geht es um eine Prüfung, die still weniger liest, als sie meldet. Der Auslöser war ein TypeScript-Blockkommentar, in dessen Text die zwei Zeichen `/*` vorkommen. Der Läufer sucht dann — mit dem für SQL richtigen Tiefenzähler — nach einem zweiten Abschluss und überspringt alles bis dorthin oder bis zum Dateiende. Das dahinterstehende Literal wurde nie gelesen, `literalsIn` gab `[]` zurück, und die Prüfung meldete eine plausible Zahl und beendete sich mit 0. Die vorhandene Korpusprüfung konnte das nicht sehen, weil **beide** Seiten des Vergleichs durch `literalsIn` gehen: Sie verlieren dieselben Literale gemeinsam und sind sich einig über Quelltext, den keine von beiden gelesen hat. Und `statementsScanned === 0` schlägt nur bei Totalverlust an, nie bei Teilverlust.
*Verworfen:* (a) Nur den Läufer reparieren und sich auf den benannten Testfall verlassen. (b) Die beiden Seiten des Korpusvergleichs durch zwei verschiedene Literal-Extraktoren schicken.
*Grund:* (a) prüft genau den einen Quelltext, den jemand als Testfall aufgeschrieben hat, und die nächste Blindstelle sieht anders aus. (b) hätte einen zweiten Extraktor gebraucht, also einen zweiten Ort mit eigenen Fehlern, und der Vergleich hätte gemeldet, dass zwei Werkzeuge sich uneinig sind, ohne zu sagen, welches recht hat. Stattdessen prüft die Prüfung eine Eigenschaft ihres eigenen Durchlaufs: Ein TypeScript-Blockkommentar endet an seinem ersten Abschluss, also enthält ein korrekt erkannter niemals einen weiteren in sich. Tut er es doch, ist der Läufer über das Ende hinausgelaufen — und alles, worüber er dabei hinweggegangen ist, wurde ungelesen gezählt. Dazu kommt eine zweite Zählung, die mit dem Läufer nichts teilt als die Bedeutung von `//`: Eine Datei, deren Backticks nicht alle in Zeilenkommentaren stehen, enthält ein Template-Literal, und wer dort keines findet, hat eines übersprungen. Beide laufen über `src/`, `test/` und `tools/`. Die zwei Blockkommentar-Läufer bleiben getrennt, mit einem Satz an der Trennstelle, weil die nächste Leserin die Verdopplung sonst für ein Versehen hält und sie zusammenlegt.
*Preis:* Die Selbstprüfung ist bei korrektem Läufer eine Tautologie — sie kann nur anschlagen, wenn der Läufer falsch ist, und sie schlägt auch dann erst an, wenn irgendwo im Baum eine Quelle steht, die den Fehler auslöst. Gemessen: Mit dem wieder eingebauten Fehler und ohne solche Quelle bleibt die Prüfung grün; mit dem Fehler und einem verschachtelten `/*` in einer echten Datei weist sie ab und nennt Datei und Kommentar. Das ist ehrlicher, als es klingt, aber es heißt auch: Diese Prüfung findet den Fehler nicht am Tag, an dem er eingebaut wird, sondern am Tag, an dem ihn jemand auslöst. Und der wahrscheinlichste Auslöser ist, wer dieses Werkzeug dokumentiert — in genau diesem Zweig ist ein `*/` in einem Blockkommentar schon einmal aus Versehen entstanden.

### An exemption a merged decision depends on, removed by a sibling who was right to remove it
`E-300` · password · tooling, frozen

**Context.** E-180 brought the literal `import("hash-wasm")` back into the accelerator loader on the strength of one line in `knip.json`, and recorded that the exemption has to stay there because no feature owns that file. It did not stay. PR #15 removed it, together with the two `@noble` entries, and #15 was not wrong to: with this branch unmerged nothing in `src/` referenced `hash-wasm`, so knip reported the exemption as redundant and removing it was the correct response to what the tool said. Merging this branch reinstates the reference, and the gate fails with "Referenced optional peerDependencies". The coupling — one branch's code, another branch's configuration line — was visible to nothing until the two met.
**Rejected.** (a) Assembling the specifier again, as E-170 did, so that the module needs no exemption at all. (b) Asking for the exemption to be restored centrally and waiting.
**Reason.** (a) would undo E-180 for the second time and reintroduce the cost it named: no dependency scanner, no bundler and no advisory would see that a finding against `hash-wasm` reaches this line. That price was paid once knowingly and is not worth paying again to avoid one line of configuration. (b) is the same edit made by someone else a day later. The line is restored here, and `bcryptjs` moves the opposite way in the same file for the mirror-image reason: it was exempt while no source imported it, and `src/core/password/verifiers/bcrypt.ts` imports it directly now, so knip reported *that* exemption as the stale kind E-180 warns about. One file, two entries, opposite directions, each following what the tool can now see.
**Price.** Two changes to a shared file in one commit, which reads as carelessness unless the commit message says which way each went and why — so it does. And the real cost is not the line, it is what the episode shows: E-180's price named the wrong trigger. It warned whoever removes `hash-wasm` from `package.json`, and the actual trigger was a sibling tidying an exemption that looked stale precisely because the branch needing it had not landed. A price paragraph that names a specific trigger invites the reader to watch that one; the failure came in through the door it did not name. The same shape applies to `src/core/password/limits.ts`, folded in here rather than given its own number: `test/sql-collapse.test.ts` asserts that a file whose backticks are not all inside line comments holds a template literal, which ignores block comments entirely. Thirteen files in the tree have backticks only in block comments and twelve satisfy the assertion by accident, through a string literal that is usually just an import specifier. `limits.ts` is the only file in the repository with no string literal of any kind, so it was the first to fail — the defect is in the check, the workaround is one reworded comment here, and the check is reported rather than edited because it is not this feature's file.

### The rules gain a second shared file, and the partition is cut before the wave rather than argued after it
`E-149` · gate and infrastructure · rule change, frozen

**Context.** §5 says no two writers share a file and names `CASE-STUDY.md` as the single exception. Item 3 of the same section's definition of done requires every feature to document itself in `DOCUMENTATION.md`. The two cannot both hold, and every wave so far has resolved it by editing the file anyway — all four wave-2 features did, and none of them was wrong to. Wave 3 runs four features in parallel again, so the contradiction was going to be resolved the same way a fifth, sixth, seventh and eighth time.
**Rejected.** (a) Drop item 3 and let a central pass document each feature after its merge. (b) Leave the rule as it is and keep resolving it by practice, on the evidence that four wave-2 merges came out clean.
**Reason.** (a) breaks the rule that matters more — documentation written while building, by whoever built it. A central pass writes the reference from the code, which is exactly the reconstruction §6 forbids for the decision log and would be no better here. (b) is the argument this entry exists to refuse: the four clean merges were luck, not construction. Appending at end of file puts four branches on the same line, and git resolves that by asking a human who was not there. The exception is granted, and it is granted the same way `CASE-STUDY.md`'s is — the file is partitioned *before* the writers start, and each of them writes inside its own part. For the log the partition is a reserved range of numbers; here it is the chapter, and the chapters are cut as empty stubs in this branch so that no wave-3 writer ever inserts a heading.
**Price.** The rule now has two exceptions instead of one, and the shape of the second is weaker than the first. A number outside a reserved range fails in `test/decision-log.test.ts` on the feature's own branch; a paragraph written into a neighbour's chapter fails nowhere. Nothing reads `DOCUMENTATION.md`'s structure. The partition is enforced by the reviewer noticing, which is the same enforcement E-147 called insufficient for the lock marker, and the honest description of what was bought here is a merge property, not a check. Writing that check — chapter ownership declared in one place and a test that the diff of a feature branch touches only its own chapter — is the obvious next move and is deliberately not made in this branch, because the wave starts before it would be ready and a half-written check that passes for the absence of a chapter is worse than none.

### The stubs go where the architecture puts the chapter, not at the end of the file
`E-150` · gate and infrastructure · file layout, frozen

**Context.** Four stubs had to be cut into `DOCUMENTATION.md`, and the file's existing order is not obvious: it opens with the chapters that are foundations — entry points, schema, migrations, driver, repositories, keys, HTTP — and then runs Passwords (3.3), Identity (3.4), One-time artefacts (3.7), Sessions (3.5). Read as architecture numbering that last sequence is out of order. Read as wave-2 merge order it is exactly the merge order, which is what it actually is.
**Rejected.** (a) Append the four stubs at the end of the file, in the order the wave-3 features are listed. (b) Reorder the whole file into architecture numbering first, then insert into it.
**Reason.** (a) is the arrangement that produced the problem in E-149 in the first place; four stubs at the end are four stubs on adjacent lines, which merges no better than four appends. (b) is a large diff over four features' chapters in a branch that owns none of them, in exactly the week they start writing into those chapters. What is left is to place each stub where a reader who has read the chapters above it can understand it: **Rate limiting** goes directly behind HTTP, because HTTP already documents the `RateLimiter` seam and this chapter is what fills it; **TOTP and recovery codes** goes after Sessions, because it needs the pending state, the `token-pepper` HMAC from Key management, the one-time artefact consumption pattern, and it ends by issuing a session; **WebAuthn** follows it, in the order architecture 3.6 introduces the two; **The instance** goes last, because it is the assembly point and is what the Passwords and Sessions chapters already defer to in writing.
**Price.** The file's order is now neither architecture numbering nor merge order but a third thing — dependency order — and nothing writes that down except this entry and the sentences in the stubs themselves. The next feature to be given a chapter has to work the rule out again from where the existing ones sit. And placing `The instance` last is a bet that no chapter arriving later belongs behind it; OAuth and plugins both do not, so a later wave inserts before it rather than appending, and whoever does that will find the end of the file is not where new chapters go.

### `## Contents` listed three of twelve chapters, and this branch repairs it instead of reporting it
`E-151` · gate and infrastructure · defect repair, frozen

**Context.** The index near the top of `DOCUMENTATION.md` listed Package entry points, Schema and HTTP. Migrations, the driver interface, Repositories, Key management, Passwords, Identity, One-time artefacts and Sessions were all missing — eight chapters written across two waves, none of them reachable from the file's own table of contents. This is a defect on `main` and it predates this branch.
**Rejected.** Report it and leave it, which is what §5 tells a feature to do about a file it does not own.
**Reason.** The rule that says report-do-not-edit exists to stop two writers colliding, and this branch owns `DOCUMENTATION.md` outright for exactly as long as it takes to cut the stubs — it is the only branch that will touch the index before wave 3 starts. Reporting it would file the repair behind the four features that are about to append to the same file, which is the collision the rule is trying to prevent, not the one it is preventing. Every chapter is listed now, the four stubs included.
**Price.** Nothing checks that the index matches the headings, so it rotted once and will rot again the first time a feature adds a chapter without its line — and E-149 has just made the index a region no feature owns, so the writer who needs a line in it has to stop and ask. That is the correct behaviour under the rule and it is also friction, arriving at the end of a feature. The cheap check is a test that the `##` headings and the `## Contents` links are the same list in the same order; it is not written here, for the same reason as in E-149, and it is the smaller of the two.

### Wave 3's ranges are sized from what wave 2 spent, and what wave 2 spent was corrections
`E-152` · gate and infrastructure · numbering, frozen

**Context.** Thirty numbers per feature was a guess, and it has now been measured. `password` used all thirty and needed a second range. `session` used all thirty and has a second range reserved. `identity` used twenty-three, `token` twenty. Three of the nine ranges in the table end exactly on their last number — which from outside is indistinguishable from a range that ran out. The pattern behind the exhaustion is the part that was not obvious: the tail of each exhausted range did not go to decisions about the feature. `session` spent its last three numbers correcting three of its own earlier entries after its gate had run, `token` needed five corrections of its own, and `password` spent its last number on the log's format migration.
**Rejected.** (a) Keep thirty for every feature and let whoever runs out ask for a second range, which the rules already allow. (b) Give every wave-3 feature the same larger number, forty-five or sixty, and stop measuring.
**Reason.** (a) is what happened twice in wave 2, and the timing is the objection: corrections arrive *after* the writer believes the feature is finished, so the request for numbers arrives at the moment the branch is least able to absorb a stop. (b) throws away the only measurement there is. The working ratio is roughly twenty decisions plus ten corrections per thirty, and wave 3's features are visibly unequal against it: `auth-core` gets sixty because it is the assembly point — configuration, startup errors, the flow layer, the route table, the package entry point, the API snapshot — and inherits twelve explicit hand-offs from waves 1 and 2, entries that say in so many words that a requirement is currently unfulfilled and invisible; `factor-webauthn` gets forty-five because the authenticator simulator, the backup-eligible and backup-state policy, `signCount` regression and a documented deviation from WebAuthn Level 3 §7.2 each generate decisions with no requirement number to anchor them, which is the kind that has to be argued in the log rather than cited; `factor-totp` gets forty-five because of E-153; `rate` gets twenty-five because it is one statement, three counters and a seam that already exists. The gate block gets a second block of twenty because its first has eleven numbers left, there are already thirty-eight broken-check findings in the log at roughly four per feature, and wave 3 runs four features at once.
**Price.** The numbering gets much sparser, and a reader who assumes the log is dense will read the gaps as lost entries; §6 already says gaps are fine, and this makes them large enough that somebody will ask anyway. The sizing is also a forecast dressed as a measurement — four data points, one wave, and the twenty-plus-ten ratio is derived from features that had no idea they were being measured. If `auth-core` needs eighty this is wrong in the direction that costs nothing extra, and if `rate` needs forty it is wrong in the direction wave 2 already demonstrated.

### `factor-totp` takes recovery codes, because the alternative is shipping a lockout
`E-153` · gate and infrastructure · scope, frozen

**Context.** Recovery codes were in no wave at all. A planning pass for wave 3 found the reason that matters: architecture 5.17's `S-DEFAULT-4` makes `identity: "username"` without recovery codes a **start error**, and that requirement has zero implementation and zero test. Nothing in the repository fails because of it, which is precisely why it survived two waves unnoticed.
**Rejected.** (a) Give recovery codes their own feature and their own range in wave 3, which would make it five features and break the four-agent limit in §5. (b) Defer them to wave 4, as every wave so far has.
**Reason.** (b) is refused first because of what wave 3 is: it ships a second factor. A wave that puts a second factor in front of the password and leaves the only path around it unbuilt has shipped a lockout, and it has shipped it to precisely the users who lost their authenticator. (a) is refused because recovery codes are not separable from TOTP by anything except the name: they share the pending-authentication state, they share the `token-pepper` HMAC, they share `DELETE … RETURNING` consumption, and they are one of exactly four routes accepting the `__Host-velve_pending` cookie (architecture 3.6). Two writers in one state machine is the collision §5 exists to prevent. `factor-totp` owns both, and its range is sized for both.
**Price.** `factor-totp` is now the largest feature of the wave by scope while carrying the same forty-five numbers as `factor-webauthn`, which is a smaller feature with more unanchored decisions — two different reasons for the same figure, and the figure will therefore be wrong for at least one of them. The name is also now a lie: the feature is called `factor-totp` and owns something that is not TOTP, in a repository whose §3 says a name that needs a comment is the wrong name. Renaming it would mean renaming the branch, the worktree and a range that is already reserved, so the name stays and this entry is the comment.

### The rules file gains a check it has been running since wave 2
`E-154` · gate and infrastructure · rules, frozen

**Context.** `check:sql-collapse` exists, runs in `pnpm gate` and runs in CI. It appears in neither of the two lists in `CLAUDE.md` that tell a writer what the gate will do to them — not in §5's gate list, not in §9's command list. Both were written before it and neither was updated when E-266 added it.
**Rejected.** Add it to §9 only, which is where the omission was reported.
**Reason.** §9 is the command reference and §5 is the gate's own list, and the second is the one a writer reads to find out what blocks a merge. A check missing from the gate list is a check nobody knows will stop them; a check missing from the command list is a check nobody knows how to run before it does. The omission is the same omission twice and is fixed in both places. This is also the fourth documented instance in this repository of a check that exists and is not known — E-147 found one that was never wired into CI at all while two files claimed it was enforced — so the failure mode is established rather than hypothetical.
**Price.** Two lists still have to be kept in step with `package.json` by hand, and nothing compares them. The check that would close this is small — the scripts named in `pnpm gate` appear in both lists — and is not written here, which makes three checks this branch names and does not write. That is the honest total: this branch fixes the documentation of a gate whose documentation has drifted three times, and adds no mechanism that would notice the fourth.

### The second count asks for a template literal, and asks only where no comment encloses the backtick
`E-155` · gate · sql-collapse

**Context.** E-269 added a second, independent count to the collapse check: a file whose backticks are not all inside line comments holds a template literal, and a walk that reported none stepped over one. Both halves of that sentence are wrong. It ignores block comments, so a file whose backticks all sit inside one is asked for a literal it has no reason to hold; and `literalsIn` returns every literal, so any string at all answers for a backtick — usually an import specifier. Measured over `main` and the then-open `password` branch, fifteen files carry a backtick and no template literal, and every one of them passes on a plain string: between two and twenty-eight strings each, zero templates. `src/core/password/limits.ts` is the only file in the tree with no string literal of any kind, so it was the first to trip the false alarm, and the `password` writer reworded a comment in their own file rather than edit this one.

**Rejected.** (a) Strip block comments as well and change nothing else — that removes the false alarm and keeps the accident, so the next real blind spot is still answered by an import specifier. (b) Run the two sides of the comparison through two different literal extractors, which E-269 already rejected: two tools disagreeing, with nothing to say which of them is right.

**Reason.** The count now strips both comment forms and asks for a **template** literal, because a template literal is the only thing that accounts for a backtick. Asking for that named a blind spot the old form could not see, on its first run: `test/db-documented-imports.test.ts` holds `/import\s*\{([^}]*)\}\s*from\s*"(@velve\/auth[^"]*)"/g`, the walk had no notion of a regular expression, it read the first `"` inside that pattern as a string opener, and every quote in the file after it was out of phase — twenty-two plausible-looking strings came back and the template literal on line 31 did not. So the walk now steps over a regular expression as a token of its own. Planted both ways round. A literal-free file whose backticks sit in a block comment, holding one exported number and nothing else, fails the old assertion by name and passes the new one. With the regular-expression branch switched off, the new assertion fails and names `db-documented-imports.test.ts`, which the old one passed. Counted a third way against the TypeScript compiler's own parser over all 148 walked files: before, the walk missed an outermost template literal in five of them; after, in none. `pnpm check:sql-collapse` examines the same statements in all 67 files of `src/` as before, so what the gate enforces did not move.

**Price.** The walk carries a third sub-lexer now, and telling a regular expression from a division is a heuristic and not a parse: a slash divides only after an identifier, a number, `)` or `]`, unless a keyword stands in front of it, and a slash whose pattern would run past a newline is put back as a division. That is right on every file in this repository and it is not right in general. The new premise brings a false alarm of its own, narrower than the one it replaces — a file whose only backtick sits inside a plain string would be asked for a template literal it does not hold. None exists today, and it would fail loudly and name the file rather than pass quietly. And the second count still shares the two comment forms with the walk, so a fault in how both of them read `/*` stays invisible to it; that is what the self-check from E-269 is for, and it stays.

### The concurrency files run in a group of their own, because the budget is connections and not file order
`E-156` · gate · vitest

**Context.** E-262 handed this decision up. The sequential project on `main` orders the concurrency files against each other, and the comment above it in `vitest.config.ts` says that "bounds the peak by construction". It does not: the `unit` project runs in parallel alongside them, so the peak is what they hold plus what ninety other files hold. E-262 measured 89 of 100 connections after that project landed and called it tight. Measured again here, on fifteen cores against a PostgreSQL with `max_connections = 100` and `superuser_reserved_connections = 3`, sampling `pg_stat_activity` continuously for the length of each run: the peak lands anywhere between 76 and 99 depending on how Vitest happens to schedule the files that day, and two of 57 full runs died with `sorry, too many clients already` — both of them at 99. On an idle machine that is one run in thirty; with the machine loaded, three of ten runs failed.

**Rejected.** (a) Reword the comment to say what the configuration actually does. That is honest and it leaves a gate that fails intermittently, which is a gate people learn to re-run rather than read. (b) Cap the worker count of the `unit` project. Vitest lists `maxWorkers` among its non-project options, so it can only be set for the whole run — slowing every file in order to bound two. (c) Move `test/token-review-atomicity.test.ts` into the group as well, because it failed three times while this was being measured. Tried and measured over 25 runs: it fails in the sequential group too, and taking it out of the `unit` project shifted that project's scheduling enough to raise the peak from 71 to 82. Reverted, and the file's own tolerance — a planted race must be caught in at least 19 rounds of 20 — is reported to whoever owns it rather than worked around here.

**Reason.** The constraint is the total held at once, so the fix has to be about what runs beside these files and not about their order among themselves. `sequence.groupOrder` puts the concurrency project in a group of its own; Vitest runs groups from lowest to highest, so every other file has finished before the first concurrency file starts, and `fileParallelism: false` keeps them one at a time inside that group. The ceiling is the larger of the two halves now instead of their sum, and the comment above the configuration describes what the configuration does. Measured the same way afterwards, from a settled connection count: peak 70 or 71 in every sampled run — the same number every time rather than a number somewhere between 76 and 99 — and 0 of 58 full runs died of connections, against 2 of 57 before. With the machine loaded, the ten runs that made three of the old configuration's runs fail made none of the new one's fail.

**Price.** The suite takes about forty per cent longer: median 7.7 s before and 10.9 s after, measured by alternating the two configurations run for run on the same machine so that drift falls on both. The first attempt at this number ran the two sets back to back instead and reported roughly double; that was the machine drifting, not the change, and interleaving is the only reason it did not go into this entry as a fact. The two halves no longer overlap and there is no way to overlap them and keep the bound. CI never hit the original fault: the runner has fewer cores and each job brings its own container and its own PostgreSQL, so the peak there never approaches the ceiling — which is why it survived; the branch that measured it in E-262 was green in CI while failing on a developer's machine. That does not make it not a defect: a gate that fails one run in three locally is a gate people learn to re-run rather than read. **And the bound is not complete.** The concurrency group's own peak is not bounded by anything here: measured on a heavily loaded machine, twelve runs of that group alone peaked at 70 in nine of them and at 97, 98 and 99 in three, two of which died of connections. Nothing in a Vitest configuration can fix that, because it is one file's own demand plus the connections a finished file has not closed yet; the remedy is in the files, which belong to their features. What this change removed is the sum of two projects. What is left is the larger of them, and it is still close to the ceiling. **And the trade is not free, which was measured after this was already committed and is written here rather than folded back into the paragraph above.** Over 53 pairs of runs alternating the two configurations on the same machine, the old one failed four times — twice on connections, twice on `test/token-review-atomicity.test.ts` — and the new one failed six times, none of them on connections and all six on that same file. Its assertion needs a planted read-before-write to be caught in at least 19 rounds of 20, and it needs contention to catch it; giving the `unit` project the machine to itself removes contention, so the count comes back 18. It fails under both configurations and about three times more often under this one. That is a bad bargain to leave unstated: a connection failure that fires one run in twenty has been exchanged for a threshold failure that fires about one in nine, and the second is no more pleasant to re-run than the first. It is left alone because the tolerance belongs to the file's owner and because this branch is out of reserved numbers, not because it is acceptable — it is reported, and it is the first thing to fix after this lands.

### Two checks that were green because of where they ran, not because of what they declared
`E-157` · gate · scripts, token

**Context.** One decision because it is one fault twice. `pnpm test` builds first through `pretest: tsdown`, because `test/db-package-reach.test.ts`, `test/db-documented-imports.test.ts`, `test/api-surface.test.ts` and `test/session-review-gate.test.ts` import from `dist/`. `pnpm test:nightly` called Vitest directly and declared no such hook; it was green only because `.github/workflows/nightly.yml` runs `pnpm build` as a step of its own beforehand. Reproduced: remove `dist/`, run `pnpm test:nightly`, and four files and seven tests fail with `Cannot find module …/dist/schema.mjs`. Separately, `test/token-review-leakage.test.ts` flattens a thrown value — message, stack, cause, own properties — and refuses a 43-character base64url run in it, because that is a token's shape. A stack names the files it ran through, so the text contains the checkout's absolute path, and a directory name may be 43 characters of `[A-Za-z0-9_-]`. Reproduced by checking the same commit out into a directory named exactly that way: it fails there and passes here, with nothing else different, and it cost the `password` gate a wasted re-run first.

**Rejected.** For the script: writing the build inline as `tsdown && VELVE_NIGHTLY=1 vitest run`, which states the same fact in a second shape so the next script gets to choose again — `pretest` and `precheck:session-owner` already use the hook form. Also rejected: letting the four files build on demand or skip when `dist/` is missing, which would let a test that cannot find the built package report success, and finding it is the whole reason those four exist. For the leak assertion: dropping the stack from the flattened text, which is in there deliberately because a stack is one of the ways a value leaves a library; and requiring word boundaries around the run, as the sibling assertion over the shipped tree does, which changes *which* paths trip it rather than *whether* paths trip it — a 43-character segment between two slashes has boundaries on both sides.

**Reason.** Both are the same shape of fault: something outside the check was supplying what the check itself did not declare, so the result said as much about the environment as about the code. `pretest:nightly: tsdown` makes the nightly tier state its own precondition; with `dist/` removed it now builds and passes 975 tests in 93 files. The leak assertion removes the checkout's own location from the text before looking for the shape, and removes nothing else — message, cause, own properties and every function name in the stack are still read. Proved in both directions and in both checkouts: with a 43-character base64url word planted in the error the library actually throws, the assertion fails at the ordinary path and at the 43-character path; with the plant removed it passes at both. A second case pins the strip itself, because the cheap way to silence a false alarm here is to strip more than the path, and the assertion would then go quiet without saying so.

**Price.** The nightly run pays a build it usually does not need, measured at 0.35 s, which is nothing; `pnpm build` in the nightly workflow is redundant now and is left alone because that file belongs to no one on this branch. The coupling itself has not moved: four test files depend on a build declared in `package.json`, and nothing checks that the next script to run Vitest declares it too — a third one will fail the same way and, like this one, only off CI. The leak assertion now knows one thing about its own environment, that `import.meta.url` locates the repository, and if the checkout is ever reached through a symlink whose resolved form differs, the strip misses and the false alarm returns — narrower than the fault it replaces, and loud rather than quiet. It also remains a shape check and not an identity check: the failing call never returns a token to compare against.

### The indistinguishability case waits for the place to be taken instead of assuming it
`E-158` · gate · password

**Context.** `test/password-flood.test.ts` gives the semaphore one place, dispatches a caller meant to occupy it, and then dispatches an existing and a missing identifier expecting both to be refused identically. Every caller runs one `crypto.subtle.decrypt` on the stored credential *before* it reaches the semaphore, and those complete in libuv threadpool order, not in call order. Measured here by dispatching three decryptions and recording which finished first: the first-dispatched was not the first to finish in 13 of 4000 rounds (0.33 %) on the default pool, and in 0 of 2000 with `UV_THREADPOOL_SIZE=1`, where the pool serialises them. The gate that raised it measured 2.80 % and 5.3 % end to end at load average 90. CI then produced the strongest form of the evidence available: commit `5e0c388beff9` passed on its push run and timed out at 120 s on its pull-request run — same tree, same job, two outcomes. When a caller other than the intended holder wins the place it never returns, because the harness holds the derivation open, so `Promise.all` runs to the full timeout while the intended holder rejects unhandled at `semaphore.ts:68`.

**Rejected.** (a) Widen the 100 ms wait limit. The caller that breaks never queues at all, so the limit is not what fails; this buys silence and leaves the race. (b) Set `UV_THREADPOOL_SIZE=1` for the run, which removes the symptom by serialising every asynchronous cryptographic call in the process — changing how the whole suite executes to fix one ordering assumption in one file.

**Reason.** The hook was already there and inert: `Harness` declared `hold: () => Promise<void>` and returned `Promise.resolve()`, called from nowhere. It now resolves the moment a caller has entered the semaphore's critical section, and the case awaits it before creating the other two callers, so those two do not exist until the place is taken. The ordering is structural after that, not probable. The case also asserts `inFlight === 1` at that point, so the precondition is stated instead of assumed. Reproduced deterministically beforehand by inverting the three dispatches: the case hangs for its full 120 s, which is the reported failure exactly. And it can still fail for the right reason — with the sequencing in place, breaking the uniformity it protects makes it red in about 170 ms rather than timing out: routing the missing identifier around the semaphore fails on the error's class, and giving that identifier's refusal one extra own property while keeping the class and message identical fails on the property comparison.

**Price.** The case is two phases now where it was one, and a reader has to see why the `await` is load-bearing — hence the only comment in it. The hook resolves on *any* caller entering rather than specifically the first, which is exact here because nothing else has been dispatched yet and would quietly stop being exact if a caller were added above it. The honest gap is in the measurement: this machine could not reproduce the end-to-end failure at all. Eighty repeats of the case before the fix and eighty after, interleaved, at load average 42 to 395, failed zero times in both arms; a probe that dispatches the three callers and records which one takes the place found the first-dispatched winning in 400 of 400 rounds quiet and 400 of 400 under load. At the 0.33 % reordering rate measured here those counts were never going to separate the two versions. The deterministic inversion, the threadpool measurement and CI's own two verdicts on one commit are the evidence; the repeat counts are not, and it would have been easy to present them as if they were.

### The range test asks who owns the number, not only whether some range holds it
`E-159` · gate · decision-log

**Context.** CLAUDE.md §6 reserves a range per feature and says the mechanism exists so that "a feature quietly taking a number it does not own fails on its own branch rather than at the merge". The test only asked whether *some* declared range contains the number. Two paragraphs further on, the same section lists what the test catches — a number used twice, an entry missing one of its four parts, a citation resolving to nothing — and ownership is not on that list, so §6 promises an enforcement it elsewhere describes correctly as absent. This stopped being hypothetical during this branch. The `E-140 … E-159` block was handed to three branches at once, and two of them wrote into it: one took 149 through 154 and another took 149 through 153 — written without the `E-` prefix here because those numbers do not exist yet and a citation to one that does not exist is itself a finding — for entirely unrelated decisions. **Five duplicated numbers, both branches green, found by a person reading two reports side by side.** No check saw it, and nothing would have seen it until the merge, where it arrives as a duplicate — or never, leaving an entry attributed to the wrong feature for good. Verified on the mechanism itself: `E-300` sits in `password`'s second range and, renumbered to 295, in `session`'s, still headed `· password ·`, and the old test passed both ways round.

**Rejected.** (a) Delete the promise from §6 and leave the test as it is. Cheaper, and it deletes the one sentence that says why the ranges are worth the trouble. (b) Write a map from feature name to range inside the test, which would be a third place the ranges are recorded and the first one to go stale.

**Reason.** Nothing new had to be written down. The entry format from PR #17 already names the owner — `` `E-159` · gate · decision-log `` — and the table's owner column already names the same feature in backticks, so the check reads both and compares. A row declares the backticked feature where it has one; where it has none, it declares the name it opens with, up to the first comma, and the leading word-runs of that name. The first version of this took every individual word of the row instead, and a sibling writer ran it against all three live branches before it merged: the six entries of the branch that writes the owner as `gate and infrastructure` — the row's actual name — were all reported as misattributed, while `gate`, one word, passed. **A check meant to catch a number taken from the wrong owner fired first on the branch that had written the owner's real name.** That is a false positive on correct input, and under the forced merge order it would have turned that branch's CI red the moment this one landed. Fixed in the check rather than by renaming the row, because the row is written for people and the next clause like `which belongs to no wave` would break the same way. Proved on the real data rather than a fixture: with the range table that branch installs, all sixteen gate-block entries across the three branches attribute cleanly, `gate` and `gate and infrastructure` both resolving to the same row. Planted in both directions: `E-300` renumbered to 295 fails the new assertion while the membership one goes on passing, and one of this branch's own numbers moved into `password`'s second range with its owner left as `gate` is reported by name. Then the trap this repository keeps walking into — 167 entries are in the old German form and name no owner at all, so a check that steps over them reports success for two thirds of the log. It counts instead: attributed plus unattributable must equal the number of entries parsed, and the unattributable set is pinned at 167, a closed set that only shrinks as entries are rewritten. Planted: one new entry appended in the German form fails that assertion at 168 rather than joining a set nothing looks at.

**Price.** The pinned 167 has to be lowered by hand each time a German entry is rewritten in English, and whoever does that first will read it as an obstacle rather than as the point. The parse is exact where the table is exact and approximate where the table is prose: a row without a backticked feature accepts the words its name begins with, so `wave 0: the scaffold, the banner and the positioning line` accepts `wave` but would reject `scaffold`, which is the word a person would actually write. Wave 0 is closed and every one of its entries is German, so nothing hits it today; the next prose row that does not open with its own subject will produce the same false positive this entry was already corrected for once. The check compares an entry against the table and knows nothing about whether either is right — an owner token wrong on both sides passes, exactly as E-147 said of the lock marker: it makes someone answer the question, not answer it correctly. It also cannot catch the collision above at the moment it is made, only once both branches are in one tree; what stops that one is the allocation, and this check is the backstop that says so out loud when it happens. Last, CLAUDE.md is not edited here. Enforcing the promise is what removes the contradiction, and the leftover — §6's backstop paragraph listing three jobs where there are now four — is a sentence in the rules file, which this branch does not rewrite on its own authority. It is flagged rather than fixed, and the branch that adds the second gate range to that table is the one already touching it.

### The list of what the gate runs was edited to complete it, and left two commands short
`E-495` · gate and infrastructure · correction to E-154, frozen

**Context.** This branch's whole subject is lists that drifted out of step with what actually runs. It added `check:sql-collapse` to §5's gate list and to §9's command list, and E-154 recorded that "the omission is the same omission twice and is fixed in both places". That is false about §5. `pnpm gate` is eleven commands; §5's list named nine of them. `pnpm publint` and `pnpm attw` were absent, and both are not only in the script but separate named steps in CI — "Package exports" and "Type resolution". §9 was complete. The script is a single line in `package.json`, and it was not read while the list that mirrors it was being edited.
**Rejected.** (a) Edit E-154 to say nine of eleven instead of claiming the omission was fixed in both places. (b) Write the check E-154's own price names — that the scripts in `pnpm gate` appear in both lists — as part of this correction.
**Reason.** (a) is forbidden by §6: new information about an old decision belongs in a new entry citing the old one, never in the old entry's text. E-154 stands with a claim that was wrong the moment it was written, which is what the log is for. (b) is the right instrument and is not this branch's to build: it belongs in `test/`, `ci/gate-defects` is live in that directory, and §5 says a feature needing a change outside its area stops and reports it. Both lists were instead verified by reading them against the script, command by command, all eleven — which is a thing a person did once and not a thing that repeats.
**Price.** Two lists and one script are still kept in step by hand, and this branch is now the second consecutive demonstration that the hand is not reliable: E-154 named the instrument, declined to build it, and failed the exact property the instrument would have checked, in the same commit that declined it. Declining to write a check is defensible; not reading an eleven-command script once, while editing the list it is supposed to mirror, is not. Whoever owns `test/` next should write it — it is a few lines against `package.json`. Until then the honest statement is narrow: §5's gate list is correct as of this commit, and nothing stops the next command added to `pnpm gate` from being missing again.

### Two figures were measured at the branch point and not re-taken after the merge
`E-496` · gate and infrastructure · correction to E-152, frozen

**Context.** The sizing section added to §6 carried two present-tense numbers. Both were right at the branch point `0bafef9`, and neither was re-measured when `main` was merged in and brought E-155 … E-159 with it. "Its first block has eleven numbers left" is now zero: this branch's E-149 … E-154 and main's E-155 … E-159 together consume all twenty of the gate block. The count of ranges ending exactly on their last number moved too, because the gate block now ends on its own. A third figure was wrong from the start and not by staleness — "three of the nine ranges" was carried over from the brief that commissioned the work and was never counted against the table. Counted now: five rows end on their last number, two of which were sized after their contents were known and are evidence of nothing.
**Rejected.** Correct the figures inside E-152, where the sizing they support is recorded.
**Reason.** §6 again, and the sizing itself is untouched: the wave-3 ranges were cut from the twenty-decisions-plus-ten-corrections ratio, not from either of these two numbers, so E-152's reasoning survives its evidence going stale. Only §6's prose states them in the present tense, so only §6's prose is corrected in place — five rows, three of them meaningful, and a gate block that is full. The second figure is the one that mattered: the rules file was telling four incoming writers there was spare room below E-160 when there was none. It also understated this branch's own case. The second gate block is not a precaution against future demand; it is already the only source of gate numbers there is, and this entry and its four neighbours are drawn from it because the first block had nothing left to give.
**Price.** The corrected figures are exactly as perishable as the ones they replace. Any branch that merges `main` can move them, and nothing re-measures them — these two are on their second reading in a single day. Stating the rule without its evidence would be worse, because the sizing argument only persuades with the numbers in it, so the perishability stays and the mitigation is that it is written down here that they perish. There is also a smaller admission owed: one of the three figures was never measured at all, only repeated from the brief, on a branch whose subject is statements that do not match the tree.

### The premise of E-150 was invented, and the history it was invented over says something better
`E-497` · gate and infrastructure · correction to E-150, frozen

**Context.** E-150's context claims `DOCUMENTATION.md`'s chapter order "is exactly the merge order, which is what it actually is". Reconstructed from first-parent history, it is not. Wave 2 merged identity, then token, then session, then password — an order that would have left *Identity, One-time artefacts, Sessions, Passwords*. The file reads *Passwords, Identity, One-time artefacts, Sessions*, because password merged **last** and inserted its chapter ahead of Identity, at the position architecture 3.3 gives it. What the file actually follows is architecture numbering with one dependency-driven transposition: One-time artefacts (3.7) pulled ahead of Sessions (3.5), because the Sessions chapter documents `revokeEverySessionOfUser` as taking "the `Actor` its redeemed one-time token produced" — a real dependency the file already honours.
**Rejected.** (a) Edit E-150's context to the reconstructed order. (b) Re-place the four stub chapters against the corrected premise.
**Reason.** (a) is the same §6 rule as E-496 and it binds harder here, because what would be edited away is a fabrication rather than a stale number. E-150 argued past a premise it never checked, on a branch about statements that do not match the tree, and removing the evidence of that is precisely the retroactive rationalisation §6 exists to forbid. (b) proved unnecessary, which is the uncomfortable half. Each placement was re-checked against the corrected premise and none moves: Rate limiting joins the infrastructure prefix beside Key management, where 3.8 already sits ahead of the 3.3-to-3.7 feature sequence; apply the transposition to that sequence and it reads 3.3, 3.4, 3.7, 3.5, 3.6, so TOTP and then WebAuthn land exactly where numbering puts them; The instance closes the file as the assembly point every other chapter defers to. A wrong premise produced four right answers, and it did so because the placements were argued from what each chapter needs to have been read first — which is the same thing the file's real order encodes.
**Price.** E-150 stands with a false context and a false price: its closing claim that the file's order "is now neither architecture numbering nor merge order but a third thing" is wrong twice over, because the file was architecture numbering before this branch and still is after it. A reader of E-150 alone is misinformed and only this entry corrects that, which is the cost §6 accepts in exchange for a log that records what was believed rather than what turned out true. The narrow lesson is the one to carry: the merge-order premise was plausible, cost one `git show` per merge to check, and was written without that check.

### E-151's heading counts the index as a chapter
`E-498` · gate and infrastructure · correction to E-151, frozen

**Context.** E-151's heading says `## Contents` listed "three of twelve chapters". Its own body enumerates three listed and eight missing, which is eleven, and the commit that made the change says eleven. The twelfth `##` heading in the file is `## Contents` itself, which is not a chapter but the index of them.
**Rejected.** Edit the heading, which is one word and would leave no trace.
**Reason.** The §6 rule does not carve out an exception for slips small enough to be embarrassing, and this one is worth leaving visible: counting the container as one of the things it contains is the same arithmetic that lets an index look complete when it is not. The correct figure is three of eleven, and it is stated here and in the commit that made the change.
**Price.** An entry whose heading contradicts its own body is read heading-first by most people, so the wrong number is the one that travels. That is a real cost for one uncorrected word, and it is accepted rather than argued away.

### The rules say which of the two exceptions is checked, and the index stops belonging to nobody
`E-499` · gate and infrastructure · rule change, frozen

**Context.** E-149 recorded without flinching that the `DOCUMENTATION.md` partition "is enforced by the reviewer noticing" and that "what was bought here is a merge property, not a check". §5 did not say so. It set the two exceptions out as two bullets that look alike, under one sentence claiming both are safe for the same reason, and a wave-3 writer reads §5 and has no reason to open the log. A second finding sits next to it: E-149's own rule made `## Contents` a region no feature owns, so a writer who needs a line in it must stop and ask — and an index only a non-owner may correct is an index that rots again, which is how it reached three of eleven.
**Rejected.** (a) Leave §5 as it stood, on the ground that E-149 already says all of this. (b) Write the index check — that the `##` headings and the `## Contents` links are the same list in the same order — and leave the rule silent.
**Reason.** (a) puts the caveat where the audience is not; the log is not the writers' brief and §5 is. The bullet now names the reviewer as the enforcement in the same position where the `CASE-STUDY.md` bullet names `test/decision-log.test.ts`, so the asymmetry is visible at the point of reading rather than inferable from a document nobody opens. (b) is the cheapest of the three instruments this branch has named, and it still lives in `test/`, which this branch may not touch while `ci/gate-defects` is live there. What goes in instead is structural rather than a check: a chapter and its index line are created together in the pre-wave stub cut, and that is the only moment either changes. No feature ever needs a line in the index, so no feature has to stop and ask, and the index can only fall behind if the pre-wave pass itself skips a chapter.
**Price.** The structural fix removes the need for the check without removing the failure the check would catch: a pre-wave pass that adds a chapter and forgets its line still leaves a stale index, and nothing notices. The target is smaller — one pass per wave instead of every feature, by one person, against a file already open for that reason — but it is the same target, and this branch is exactly the kind of pass that would miss it. The check should still be written by whoever next owns `test/`. That makes three instruments handed off from this branch, and the honest summary of it is that a branch about drifting lists closed one drift by hand, made a second structurally harder, and built none of the three things that would have caught either.
### The address parser leaves `session` for a module that belongs to no feature
`E-500` · gate · module cut, seam

**Context.** `rate` has to implement S-RATE-1: an IPv6 address buckets by its `/64` prefix, an IPv4 address by the full address, and the compressed, expanded, upper-case and IPv4-mapped spellings of one address must give one key. That parser exists — `parseIpAddress` in `src/core/session/ip-address.ts` — and is not exported. What is exported is `canonicalIpAddress` and `truncatedIpAddress`, and the latter cuts IPv4 to `/24`, which is right for session metadata under L-10 and wrong for a rate key by a factor of 254 hosts per bucket. So `rate` would have edited a file `session` owns or written a fourth IP parser. E-267 records the same shape one wave earlier and reached the opposite conclusion, so the first question was whether it applies here.
**Rejected.** (a) Exporting `parseIpAddress` from `core/session/ip-address.ts` and letting `core/limit/` import it. (b) Putting the parser in `core/http/`, which already imports nothing and which everything else already imports, so no new edge could form.
**Reason.** (a) is what E-267 was forced into and describes the cost of: a primitive lives in the feature directory that needed it first, and the directory-level edge it creates is invisible to knip, to the bundler and to every check here, because at file level the leaf imports nothing. E-267 could not move `randomBytes` because §3.1 assigns secret generation to `core/token/` **by name** and T-RAND-5 measures the path `core/token/random.ts`; the architecture beat the local judgement. Address parsing has no such line. §3.1 gives `session/` "creation, resolution, rotation, revocation" and `limit/` "token bucket"; no `S-…` and no `T-…` names a path for parsing an address. The thing that blocked E-267 is absent, so the move it wanted is available. (b) was tempting and is the wrong category: an IP address is the transport peer, not part of HTTP, and putting it in the module described as route declaration, origin check, cookies and error mapping is E-267's mistake in a larger directory. What stops the cycle in `core/net/` is not a rule but a property: the module imports nothing at all, and no wave owns it, so no writer is ever assigned a file there that could grow an import. E-267's two leaf files had that property individually and still cycled, because `keys` and `token` are features with domain logic around them; `core/net/` has no feature around it to grow one.
**Price.** A twelfth name where §3.1 draws eleven, and the precedent for that is thinner than this entry first claimed. It said the tree "already has fourteen on disk" with three placeholders, which counted placeholders as precedent. Counted properly, from `git ls-files`: fifteen directories exist under `src/core/`, and **eight** hold a `.ts` file — `db`, `http`, `identity`, `keys`, `net`, `password`, `session`, `token`. The other seven — `auth/`, `factor/`, `flows/`, `limit/`, `maintenance/`, `oauth/`, `plugin/` — hold a `.gitkeep` and nothing else. Seven of the eight are named by §3.1, so `core/net/` is the eighth directory shipping code and the **only** one the architecture does not name. There is no precedent; this is the first one, and the next person to add a directory should have to argue for it at least this hard. (The main gate reported the figure as nine and tenth, counting `factor/`; it holds three `.gitkeep` markers and no code. §6 wants the number that is true, so: eight and eighth.) Second, `canonicalIpAddress` is now a one-line re-export from `core/session/ip-address.ts`. It is pure mechanism and belongs in `core/net/`, and the re-export exists only so that `src/core/session/metadata.ts` and two session test files — none of them this branch's to edit — keep the import path they have. A pass-through export is a wart, and it will stay until someone who owns those files removes it. Third, this branch spends a decision number on moving code it did not write, which is the sort of change that looks like churn in a diff; the argument for it is entirely in this entry.

### The seam is a prefix length, not a bag of bytes
`E-501` · gate · seam shape

**Context.** Having decided where the parser goes, the question is what it exposes. `rate` needs `{ ipv4: 32, ipv6: 64 }` per 3.9; session needs `{ ipv4: 24, ipv6: 64 }` per L-10. Both then mask and format the same way.
**Rejected.** (a) Exporting `parseIpAddress` itself, so callers get `{ bytes, isIpv4 }` and each does its own masking and formatting. (b) Exporting a ready-made `rateLimitIpKey(text)` with the two prefix lengths baked in.
**Reason.** (a) hands out the primitive the task named and duplicates the mask-and-format arithmetic in two places, which is the second half of the problem this branch exists to remove — `truncatedIpAddress` already had that arithmetic and `rate` would have written it again, differing only in one constant. (b) is `rate` deciding its own key inside a module that is not `rate`; 3.9 fixes `/32` and `/64` and the feature should be the one to write them down. `ipAddressNetwork(text, prefixLengths)` splits it at the joint: the mechanism — parse, fold the spellings, mask, format with the prefix — is shared, and the policy is a two-field constant at each call site. `truncatedIpAddress` is now that constant plus one call, and the `/24` appears exactly once in the repository.
**Price.** The parameter accepts any number, so `{ ipv4: 99 }` masks nothing and prints `/99`. Rejecting that would add a branch no caller can reach, against the 90 % branch threshold §6 sets for `core/`, to guard against a literal constant being typed wrong in a file that will be read by a reviewer. It is not guarded, and this sentence is the whole of the protection. The mask itself is general rather than byte-aligned, which costs nothing and is not used: 24, 32 and 64 are all multiples of eight.

### The existing parser was already right; only its reach and one constant were wrong
`E-502` · gate · finding

**Context.** Before moving anything, the T-RATE-1 vector table was run against the parser as it stood, on the assumption that a parser written for session metadata would fold some spellings and miss others, and that the missing half would be the useful finding. It missed none. All twelve vectors parse correctly — the compressed, expanded and upper-case forms of `2001:db8::1`, `2001:db8:0:0:ffff::9999`, `::ffff:203.0.113.5` against `203.0.113.5`, `::1`, `0.0.0.0`, `::`, and `null` for the empty string, `not-an-ip` and `1.2.3.4, 5.6.7.8`. Ten adversarial spellings beyond the table were then tried and all ten answer correctly: `::FFFF:203.0.113.5`, `::ffff:c000:0205`, `0:0:0:0:0:0:0:1`, surrounding whitespace, `fe80::1%eth0`, `010.0.0.1`, `203.0.113.5/24`, `[2001:db8::1]`, `1::2::3` and `2001:db8::00001`.
**Rejected.** Writing a new parser for `rate` on the assumption that one built for a different requirement would need adjusting for this one.
**Reason.** The measurement said otherwise, and the assumption was worth exactly the ten minutes it took to disprove. What was actually wrong was not correctness but reach and one constant: the parser is not exported, and the only exported function that masks a prefix uses `/24` for IPv4. So this branch moves a working parser and parameterises one number, and adds no parsing logic whatsoever. The table-driven test was then planted against twice — the prefix mask removed, and the IPv4-mapped unfolding removed — and fails on both, in this branch's tests and in the existing session tests alike, so it is known to be able to tell a fault from nothing.
**Price.** The interesting half of the report is empty, which reads like the work was not done. It was: the finding is that the seam is availability and one constant, not correctness, and that is only worth stating because it was measured rather than assumed. The parser keeps one behaviour worth naming out loud: it trims surrounding whitespace, so `" 203.0.113.5 "` and `"203.0.113.5"` are one bucket. That is right for a header value and it is not something S-RATE-1 asks for.

### Four validators for the two nested payloads, and nothing for the seven that might come next
`E-503` · gate · validators, scope

**Context.** `src/core/http/validators.ts` had `string`, `optional` and `object`. `object` already nests, so the gap is not nesting — it is the leaf types inside `RegistrationResponseJSON` and `AuthenticationResponseJSON`: `type: "public-key"`, `authenticatorAttachment?: "platform" | "cross-platform"`, `transports?: AuthenticatorTransportFuture[]`, `publicKeyAlgorithm?: number` and `clientExtensionResults`, whose contents are open-ended by the WebAuthn specification. Every other route in the table 3.15 D.3 takes flat strings.
**Rejected.** (a) A general combinator set — `boolean`, `union`, `record(inner)`, `tuple`, `nullable`, refinements with lengths and patterns — so the next payload is covered in advance. (b) `literal(value)` alongside `oneOf(...values)`.
**Reason.** (a) is a schema library, and §2 says the library answers one question; a combinator with no route behind it is untested surface that the first real caller then bends. Added: `number()`, `oneOf(...values)`, `arrayOf(inner)` and `unknownRecord()` — one per field kind that actually occurs, and `oneOf` covers three of them. Deliberately not added, each because no route input has one: `boolean`, `record` with a checked value type, `tuple`, `nullable`, `union` over validators, and every length, range or pattern refinement. (b) is `oneOf` with one argument and the call site reads the same, so it earns no second name. `unknownRecord()` is the one that needs justifying: 1 D36 says the ceremony is not extensible and the library reads no extension outputs, so the honest validator checks that the field is an object and does not look inside. `number()` rejects `NaN` and `Infinity` because a direct server call passes JavaScript values where a request body could only carry what JSON can spell — that path is not hypothetical, `createServerMethod` runs `input.parse` on it.
**Price.** The forward-compatibility hazard, and this entry first named the wrong door for it. It warned that `object()` rejects any undeclared key, so a browser adding a field to the credential JSON gets `invalid_input` on a payload that is valid WebAuthn. True, but not the likely one. The likely one is a field down: `transports` is pinned by `oneOf(...)` to the seven values of `AuthenticatorTransportFuture`, and a new transport ships in a browser **before** it ships in `@simplewebauthn/server`. Registration then fails for that authenticator over a value that is only a hint — nothing in the ceremony depends on `transports`, it is stored and handed back as a UI affordance — so a device is locked out by an advisory field. E-300 is in this same file and makes exactly this point: a price paragraph that names a specific trigger invites the reader to watch that one, and the failure comes through the door it did not name. So both are named, and the transport case is the one to watch; `factor-webauthn` may reasonably decide `transports` wants `arrayOf(string())` or `optional` leniency where `type` does not. Neither hazard is fixed here: loosening `object()` weakens the contract every other route relies on, and choosing per field is the feature's call. **Correction after the main gate:** the claim that each constructor was planted against was true in count and wrong in one aim. `arrayOf` accepted a **hole** — `Array.prototype.map` skips holes, so the inner validator was never called and `["usb", <hole>, <hole>]` came back typed as validated with every entry after the first reading `undefined`, straight into the ceremony verifier as a `transports` array. Reachable exactly the way `number()`'s `NaN` guard is reachable, which is the argument this entry already made for a different constructor and failed to carry across to this one. It now reads every index by `Object.hasOwn` and offers a hole to `inner` as `undefined`, which rejects it.

### An absent optional field has to be an absent key, and nothing said so until a type refused
`E-504` · gate · validators, correction

**Context.** With the four constructors written, the composed `RegistrationResponseJSON` validator was assigned to the real `@simplewebauthn/server` type as the proof that the set is sufficient. It did not compile. `tsconfig.json` sets `exactOptionalPropertyTypes`, and `object()` returned `{ [Key in keyof Shape]: Parsed<Shape[Key]> }` — every declared key present, an absent optional holding `undefined`. `authenticatorData?: string` does not accept `string | undefined`, so the payload could not be handed to the ceremony verifier without a cast. The seam would have looked open and been closed.
**Rejected.** (a) Leaving it, and letting `factor-webauthn` cast at the boundary. (b) Changing only the type and leaving the runtime setting the key to `undefined`.
**Reason.** (a) puts a cast on the one path where a wrong shape is a failed authentication, and it is the same "edit a file you do not own or work around it" that this branch exists to prevent — one layer down. (b) would type-check and lie: the value would carry an own key holding `undefined` while its type says the key may be absent, which is the exact confusion `exactOptionalPropertyTypes` is switched on to prevent. Both halves changed. The optional keys are derived from the shape — a field whose parsed type admits `undefined` becomes `field?: T` with the `undefined` excluded — and `parse` no longer writes a key whose value came back `undefined`.
**Price.** A behaviour change to the function every route declaration will use, made by a branch that owns no route. It is cheap only because of when it lands: nothing in `src/` calls `object()` yet, wave 2 left no route behind, and wave 3 writes the first ones. A wave later it would have been a change to every handler's input type. It was found by a type error while writing a test, not by design — the four constructors were finished and believed complete before the assignment was attempted, and had the proof been "the validator accepts a valid payload" rather than "the parsed value is assignable to the type the verifier demands", the seam would have shipped broken and looked tested. One existing type assertion moved with it: `test/http-route.test.ts` pinned a server method's input as `{ provider: string; code: string | undefined }` and now reads `{ provider: string } & { code?: string }`. `toEqual` treats a missing key and an `undefined` one alike, so no runtime assertion in the repository noticed the change — the only thing that saw it was the type-level test, which is the argument for having one. **Correction after the main gate:** the contract this entry installs was defeated by the line that implements it. `parse` read `raw[key]`, which walks the prototype chain, so an object built with `Object.create` or a plain object arriving after something wrote to `Object.prototype` produced a **present** key holding a value the caller never sent — the exact inverse of what this entry promises, and reachable on the direct server-call path for the same reason `number()` guards `NaN`. The unknown-key guard could not catch it, because `Object.keys` lists own properties and therefore never sees an inherited one to reject; a JSON body is safe only because `JSON.parse` makes even `__proto__` an own key. Both `object()` and `arrayOf()` now read through `Object.hasOwn`. The instructive part is not the defect but the test that missed it: a prototype probe **was** written — `"toString"` against `oneOf` — and it passes, and it could never have failed, because `oneOf` compares against an array where inheritance has no reach. The right idea aimed at the one constructor that could not suffer from it, while the constructor that could went unprobed. Counting thirty-one malformed inputs said nothing about whether any of them was pointed at a place a fault could live.

**Renumbered.** These five entries are numbered E-500 … E-504. They were written as E-149 … E-153, and those numbers now belong to `docs/wave-3-preparation` — so anything citing them for this branch's decisions resolves to the wrong entries, which is precisely the failure §6 names and the reason this is written down instead of renumbered silently. The gate-and-infrastructure block E-140 … E-159 was handed to three branches in the same hour, and this branch and `docs/wave-3-preparation` both drew from the same block upward for entirely different decisions. No writer took a number it did not own. The coordinator who made the allocation had been told by a gate two hours earlier, in as many words, to close the membership-versus-ownership gap before wave 3, precisely because four parallel writers would hit it; that was not done, and the same allocation then created the first instance of it. Each branch stayed green on its own because `test/decision-log.test.ts` asked whether a number falls inside *some* declared range and never whether it falls inside the range its branch was given — membership is not ownership, and the check tested only the first. §6 calls the reserved range the mechanism and the test the backstop; this is the case where the mechanism failed and the backstop could not see it. That gap is closed on `main` by E-159, which is why this entry can state the rule and point at the check that now enforces it. The reallocation itself moved twice: this branch was first given E-495 … E-499, and by the time it could be applied `docs/wave-3-preparation` had spent those five on its own corrections, so the numbers are E-500 … E-504 — which is the same allocation pressure that caused the collision, one round later and caught before it landed rather than after.

### The intermediate state is built before the assembly, because two features wait on it
`E-320` · auth-core · ordering

**Context.** This feature owns both `src/core/factor/pending/**` and `createVelveAuth`. The assembly is the larger and more interesting piece; the pending module is small. `factor-totp` and `factor-webauthn` cannot write their verify routes without the signatures the pending module publishes, and both were already running.
**Rejected.** Building the assembly first and the pending module afterwards, in the order of importance.
**Reason.** Importance is the wrong sort order when other people are blocked. The barrel was written, tested against a real database, committed and pushed before a single line of `createVelveAuth` existed, and the commit message names the four route names the factor features have to use. The cost of getting the assembly slightly later is borne by one feature; the cost of the barrel arriving late is borne by two, and they cannot even guess at the shape while they wait.
**Price.** The pending module was designed without the assembly that consumes it in front of the author, so its signatures were chosen from 3.6 and B.6 rather than from a call site. `begin` takes `availableFactors` as an argument even though `resolve` computes the same list from the database — a caller could pass a list that disagrees with the row. Nobody noticed until the assembly was written, and by then two features had the signature.

### No method here takes an actor, and the narrower rule is why
`E-321` · auth-core · ownership

**Context.** `velve.pending_authentication` has a `user_id` column, and S-OWNER-1 says every repository method reaching a table with one takes an `Actor`. There is no actor to take: the row is written between the password and the second factor, when there is no session, and every method addresses the row by `token_sha256`.
**Rejected.** (a) Threading an actor through anyway, minted from the user id the password path just resolved. (b) Writing the methods without an actor and without saying anything.
**Reason.** (a) is the hole E-93 walls up — a string in, an actor out, and nothing in the signature says where the string came from. E-242 already found the rule's true form for exactly this case: *every method that reaches rows through their owner demands an actor; whoever reaches them through a secret has already proven it.* Each statement here carries the marker `/* no owner predicate: S-OWNER-2, E-242, … */` that `test/db-static-sql.test.ts` demands, so the exception is a named reason and not an omission.
**Price.** The rule now has two forms in three modules, and only the longer one is true. A reader who arrives with S-OWNER-1 in mind reads four signatures without an actor and has to find E-242 to learn that this is the rule rather than a breach of it. The marker points at the requirement, not at the entry that narrowed it.

### The factors still open are read in the same statement as the row
`E-322` · auth-core · pending

**Context.** `PendingAuthentication.availableFactors` is not a column. It follows from what the account has enrolled: a confirmed TOTP credential, any WebAuthn credential, any recovery code. Those three tables belong to the two factor features.
**Rejected.** (a) An injected `enrolledFactorsOf(userId)` seam the assembly fills. (b) A second query after the row is found.
**Reason.** (a) would have made the module the factor features are blocked on depend on the factor features — they would have had to supply a reader before they could use the barrel. (b) is two round trips where S-CACHE-2 answers the same question for a session in one, and the second one would be a place a cache could later be introduced. Ownership is about files, not tables: three `EXISTS` subqueries in this feature's own SQL touch no file another feature writes.
**Price.** This module now knows what "enrolled" means for three factors it does not own. If `factor-totp` decides that a credential with `confirmed_at` set but a revoked secret is not enrolled, the predicate here is wrong and nothing connects the two definitions. The predicate is one line in one statement, and that is the whole of the mitigation.

### The four route names are one constant, and it lives here
`E-323` · auth-core · S-CACHE-4

**Context.** S-CACHE-4 says exactly four routes carry `caller: "pending"`, and names them. Two of the four will be declared by `factor-totp` and two by `factor-webauthn`; neither can see the other's table, and this feature merges before either.
**Rejected.** (a) Each factor feature naming its own routes and a test counting the total. (b) The test hard-coding the four names.
**Reason.** (a) has no place where the number four is written down, so the failure mode — a fifth route — is invisible until someone counts by hand. (b) puts the list in the test, where a writer adding a route does not look. `PENDING_CALLER_ROUTES` is exported from the module both factor features already import, so the list a route is named from and the list the count is read from are one list, and a fifth entry fails the test that says there are four.
**Price.** A constant naming routes that do not exist yet, in a module that has nothing to do with routing. It reads as misplaced until the two factor features land, and if either names a route differently the mismatch shows up as a route that is silently not in the set rather than as a compile error.

### The attempt count and the deletion are two statements, because one would have been undefined
`E-324` · auth-core · L-8

**Context.** L-8 gives an intermediate state five attempts; the fifth deletes the row. The obvious form is a single statement with two data-modifying CTEs — `UPDATE … RETURNING` feeding a `DELETE` — so that a concurrent request cannot see the count without the deletion.
**Rejected.** The single statement with two modifying CTEs.
**Reason.** PostgreSQL executes the sub-statements of a data-modifying CTE against the same snapshot and does not support two of them touching the same row; the outcome is not merely surprising, it is undefined. It would have looked atomic, tested green on a quiet machine, and been wrong under the concurrency it exists for. Two statements inside `driver.transaction` are atomic for the same reason and are defined.
**Price.** A round trip more on the failing path, which is the path an attacker drives. The transaction also holds a row lock on the pending row for its duration, and this module takes no lock on `velve.user` first — permitted, because it takes no explicit row lock at all, so `pnpm check:lock-order` has nothing to see and the ordering rule of §7 is neither obeyed nor broken here.

### E-119 is not paid, and the reason is that paying it moves a file this feature does not own
`E-325` · auth-core · hand-off, not closed

**Context.** E-119 parked `Session` and `PendingAuthentication` in `core/http/caller.ts` and said they must be merged once `core/session` exists. It does, and this feature is the first that sees both.
**Rejected.** Moving the two interfaces into `core/session` and `core/factor/pending` and re-exporting them from `core/http`.
**Reason.** `core/http/caller.ts` belongs to wave 1 and every consumer of the two types imports it; moving them edits that file, `route.ts`, `pipeline.ts` and every module that reads them — five files across three features, none of them this one's. §5 is not a formality here: two of those files are being edited on other branches this week. The merge is a refactor with no behaviour, and a refactor with no behaviour is the cheapest thing to defer and the most expensive thing to collide on.
**Price.** The entry stays open into a fourth wave, and this feature is the last one that will have a natural reason to close it — after this, `core/http/caller.ts` is simply where those types live and nobody will remember it was meant to be temporary. That is how a parked type becomes a permanent one. Whoever owns `core/http` next should close it as its first act, not its last.

### The deterministic-randomness setter is not built, and a check is the reason
`E-326` · auth-core · 6.19, not delivered

**Context.** 6.19 asks `@velve/auth/testing` for a settable clock and a settable random seed, with three barriers around the second. The clock was straightforward. The seed was not.
**Rejected.** (a) Patching `globalThis.crypto.getRandomValues` from the testing subpath — written, working, and reverted. (b) Adding a module-level settable source to `src/core/token/random.ts`.
**Reason.** (a) was written first and passed its own tests. It then failed `test/token-review-randomness.test.ts`, which scans everything the package ships and requires the string `getRandomValues` to appear in `core/token/random.ts` and nowhere else — a check that wave 2 deliberately widened beyond `src/core` for exactly this class of second caller. Every way of redirecting the generator from this subpath names it here. (b) is the right design and edits a file this feature does not own. The check is not in the way of the work; it is telling the truth about where the work belongs.
**Price.** One of the three requirements of 6.19 is unfulfilled, and the barrier that would have proved it — zero hits for the setter name in the shipped core entry point — has no name to search for. A test that needs a reproducible seed brings its own generator, which is precisely the "every module writes its own loop" state E-63 exists to prevent, one level up. Reported rather than worked around; the temptation to widen the scan by one file was real and would have cost the scan its meaning.

### Barrier three is widened from one name to every name, because the name it was written for does not exist
`E-327` · auth-core · 6.19

**Context.** 6.19's third barrier is "zero hits for the setter name in `dist/index.js`". The setter does not exist (E-326), the package ships `.mjs` (E-04), and `unbundle: true` splits an entry point across files, so `dist/index.mjs` is a re-export and would have said nothing either way.
**Rejected.** (a) Writing the barrier as specified and letting it pass vacuously. (b) Leaving it out until the setter exists.
**Reason.** (a) is the failure §5 warns about in as many words: a scan that reports success because it matched no files. (b) leaves the packaging boundary unchecked while the subpath already exports something. The barrier now reads every name the testing subpath exports and asserts each appears in `dist/testing.mjs` and in no other shipped artefact — stronger than the original, non-vacuous today, and still correct on the day the setter lands.
**Price.** A barrier that no longer matches the words of 6.19, so a reader comparing them finds a discrepancy and has to come here. The count it states — at least nine artefacts, at least two names — is a floor rather than the exact figure, because the exact figure changes with every entry point added.

### The system clock lives in the entry point, one layer above the core
`E-328` · auth-core · E-231, closed

**Context.** E-231 refused a built-in fallback clock in the session service and said the default "comes into being one layer up, where `new Date()` is allowed". `createVelveAuth` is the layer that was meant, and it is in `src/core/auth/`.
**Rejected.** Putting `const SYSTEM_CLOCK = { now: () => new Date() }` in `src/core/auth/instance.ts`, which is where the assembly is.
**Reason.** It was put there first, and `test/keys-static-scan.test.ts` refused it: `new Date(` is forbidden anywhere in `src/core`, without exception, so that no secret grows out of a clock. The rule is blunt — a default clock is not a secret — but the assembly is inside `src/core` and the rule has no carve-out, and inventing one for the first caller that finds it inconvenient is how a scan stops meaning anything. `assembleVelveAuth(config, defaultClock)` takes the clock as a required argument and `src/index.ts` supplies it. That is E-231's price paragraph made literal: if the caller forgets, it is a type error.
**Price.** The public entry point now contains a function body and a constant rather than only re-exports, which is a shape nobody else in this package has. `createVelveAuth` and `assembleVelveAuth` are two names for one thing, and a reader who imports from `core/auth/instance.js` directly — the tests did, until they were changed — gets the one without a default and has to know why.

### The freshness window is read once and derived, not configured twice
`E-329` · auth-core · E-233, closed

**Context.** E-233 recorded that freshness is checked in two places with two configuration fields — `HttpEnvironment.freshnessWindowInSeconds` for the route gate and `SessionSettings.freshnessWindowMs` for the actor mint — and that whoever assembles the instance has to derive one from the other or two windows apply.
**Rejected.** Exposing both fields in `VelveAuthConfig` so an operator could set them independently.
**Reason.** Two fields for one window is two answers to one question, and the failure is silent: a route that admits a request the actor mint then refuses, or the reverse. The configuration has one field, `session.freshnessWindow`, and the assembly computes the seconds from the milliseconds the session settings resolved. A test reads both numbers off a built instance and compares them.
**Price.** The two checks still differ in two ways the assembly cannot reconcile. The pipeline compares the **process** clock against a `created_at` the **database** wrote, and it uses `>=` where `isSessionFresh` uses `<`. A clock skew of a second between application and database now shows up as a route refusing a session the service would have called fresh, and the boundary instant belongs to different sides of the two comparisons. Deriving the window removed one of three disagreements; the other two are in files this feature does not own.

### The key-ring report runs in `migrate`, because the surface is synchronous
`E-330` · auth-core · E-179, closed as far as it can be

**Context.** E-179 moved the "a stored key version has left the ring" report off the sign-in path and onto assembly, "loud, with the missing versions in the error", and recorded that until assembly calls it the operator error is silent. `assertStoredKeyVersionsAreKnown` has been exported and uncalled since wave 2.
**Rejected.** (a) Calling it from `createVelveAuth` as a floating promise and logging the rejection. (b) Adding an `await auth.start()` to the surface.
**Reason.** `createVelveAuth` is synchronous — 3.15 B declares it so — and the check is a query. (a) is an unhandled rejection in every application that has not migrated yet, because the table does not exist, and a loud report that fires spuriously stops being read. (b) adds a method to a surface 3.15 B fixes. `migrate()` is already asynchronous, already the step an operator runs at startup, and already the only place where the table is guaranteed to exist.
**Price.** An application that never calls `migrate` — one that applies the shipped SQL by hand, which the schema subpath exists to support — never runs the check, and for that operator E-179's silence is unchanged. The check is also now ordered after the migrations rather than before the first request, so it reports at deploy time and not at the moment the ring actually changes.

### `SECURITY_OPTIONS` covers every option, not only the security-relevant ones
`E-331` · auth-core · S-DEFAULT-1

**Context.** T-DEFAULT-1 asks for a constant holding "all security-relevant keys" of the option type, with the default of each as a fixture, and adds that the test must fail if the option type carries a key that is not in the constant.
**Rejected.** Listing only the keys that are plausibly security-relevant — `sessionMetadata`, `trustedProxies`, `rateLimit`, `webauthn`, `session`.
**Reason.** The two halves of the requirement contradict each other unless the list is total: a partial list cannot also be the list every key must appear in. And the judgement "this option is not security-relevant" is exactly the judgement that produced `revokeSessionsOnPasswordReset` — a field declared, never set, and read as `undefined` on the reset path. Every key stands in the list, and the ones nothing can weaken say so in a sentence rather than by being absent.
**Price.** Sixteen rows of which eight say "nothing weakens it", which reads as padding until you notice that adding an option without a row fails a test. The `safeDefault` column is prose, not a value, so it documents the default rather than checking it — a default that drifts from its row is caught by no assertion here.

### The rate counters are in memory, and the operator is told the same way as for any other weakening
`E-332` · auth-core · rate limiting

**Context.** `HttpEnvironment` requires a `RateLimiter`; 3.9 puts the buckets in `velve.rate_bucket`; `src/core/limit/` belongs to the `rate` feature of this same wave and was empty at this branch point. Without a limiter there is no instance.
**Rejected.** (a) Taking the limiter from the configuration, so the application supplies one. (b) Declaring the seam and shipping an assembly that cannot be constructed until `rate` merges. (c) A limiter that always allows.
**Reason.** (a) is `disableRateLimit` with a better name — S-DEFAULT-3 forbids the option, and "pass a limiter that says yes" is that option. (c) is the same thing without the honesty. (b) would have meant this feature could not test anything it built. The assembly holds the same token-bucket arithmetic in memory and reports it at start as a weakening, in the same line format as every other weakening, because a counter per worker is a counter an attacker divides by the number of workers.
**Price.** Roughly forty lines that duplicate a sibling feature's work and are meant to be deleted, and a weakening every installation carries until they are. Worse, it is a weakening that cannot be turned off by configuration, so the S-DEFAULT-1 line appears in every start-up log and will be the line operators learn to ignore — which is what makes the next one invisible. Replacing it is one import. **Correction after the main gate:** `rate` merged while this branch was in review, and the replacement was one import, as promised. `createInProcessRateLimiter` is gone; the assembly calls `createRateLimiter` from `core/limit` with the driver, the key provider, the schema and the clock, and the standing weakening line is gone with it — a default configuration now logs nothing at all, which is what S-DEFAULT-1 always meant. The only thing the placeholder cost that could not be refunded is the two tests that asserted the standing line and had to be changed back; the forty lines were deleted unread. It is worth recording that the prediction held exactly, because the argument for writing throwaway code is usually that prediction, and it is usually wrong.

### `log` has no default sink, and the reference says so where a reader will meet it
`E-333` · auth-core · S-ENUM-6

**Context.** S-ENUM-6 requires the true reason behind every refused sign-in to be written server-side. The pipeline already writes it, through `HttpEnvironment.log`. The assembly has to give that field a value.
**Rejected.** (a) A default sink writing to `console`. (b) Making `log` a required configuration field.
**Reason.** (a) cannot be written: `console` is forbidden in `src/core` by the style rules, and the assembly is in `src/core`. Putting the default in `src/index.ts` beside the clock was possible and was rejected for a different reason — a library that prints to standard output by default is a library that prints to standard output in production. (b) is defensible and was close; it was not taken because 3.15 A.2 does not list `log` among the required fields and this feature is not the place to add a required field to a published option table.
**Price.** S-ENUM-6 is unfulfilled by default. An installation that configures nothing gets a sink that drops everything, and the requirement's promise — that the true reason is always recorded — holds only for installations that opted in. The reference names this explicitly as the one place a default is not the safe choice made for the reader, because nothing else in the package would tell them.

### The resolution is remembered for one request, and the key is the object that request produced
`E-334` · auth-core · S-CACHE-1

**Context.** The pipeline hands a handler a `Session`. Minting an actor needs the whole `SessionResolution`, including the database instant freshness is judged against. A handler that resolves again makes two queries per request, and T-CACHE-1 fixes the ratio at exactly one.
**Rejected.** (a) Resolving a second time in the handler. (b) Keeping a map from session id to resolution.
**Reason.** (a) breaks the ratio the requirement states. (b) is a session cache, which is the single thing 3.5 forbids most emphatically and the cause of the comparison system's worst published flaw. What is stored is a `WeakMap` keyed by the `Session` **object** the resolver just built — a fresh object on every request, unreachable from any later one, and collected with it. It cannot answer a second request because a second request has a different key.
**Price.** A `WeakMap` in the assembly that a reader scanning for cache structures will find, and it will look exactly like the thing that is forbidden. The comment beside it is the only thing separating the two, and a comment is what §3 says a design should not need. The alternative was worse; this one at least fails closed — a handler that receives a session the resolver did not produce gets `internal_error` rather than an unowned actor.

### The two `pending` routes of D.3 are not declared, because the layer below ties reading the cookie to accepting it
`E-335` · auth-core · S-CACHE-4, hand-off

**Context.** D.3 lists `GET /pending` and `POST /pending/cancel`. Both need the value of `__Host-velve_pending`. `core/http/web-handler.ts` decides which routes see that cookie by `route.caller === "pending"`, and S-CACHE-4 says exactly four routes carry that value — and these two are not among them.
**Rejected.** (a) Declaring them with `caller: "pending"`, making six. (b) Taking the token in the request body.
**Reason.** (a) breaks the requirement this feature owns and is measured on, and the requirement is right: `caller: "pending"` means the intermediate state *authorises* the call, which is true of the four verify routes and false of reading the state or cancelling it. (b) puts a `__Host-` cookie's value in a body, which is the shape 3.5 exists to prevent. The two methods exist on the surface and take the token directly; only their routes are missing.
**Price.** Two routes of the published table are absent, and a browser client cannot read or cancel a pending state without the application forwarding the cookie itself. Closing it needs either a third caller kind or a separate gate for cookie visibility in `core/http/web-handler.ts` — a file this feature does not own, and a change that touches the one function every route's response passes through.

### Four expectations outside this feature's files were changed, and each is named
`E-336` · auth-core · §5, breached deliberately

**Context.** The assembly gave callers to modules that had none, shipped a repository that was not shipped before, and named tables and codes that were previously named in one file. Four tests in other features' files pinned the old facts and went red: `session-review-surface`, `session-review-gate`, `session-review-resolution` and `token-static-scan`.
**Rejected.** (a) Leaving them red and reporting them, which §5 prescribes. (b) Arranging the assembly to avoid tripping them.
**Reason.** (a) fails the main gate, so nothing merges and the four features behind this one wait on a report. (b) is worse than it sounds: avoiding `session-review-surface` means not calling `createSessionService`, and avoiding `token-static-scan` means the sweep does not name the table it sweeps. Three of the four were anticipated in writing — E-245 says in as many words that `createVelveAuth` is the caller that will shorten its list. What was changed is one expectation per file, each with the reason written beside it, and no source file outside this feature's set.
**Price.** §5 says stop and report, and this did not stop. The justification — that a test expectation is a record of a fact rather than a piece of another feature's design — is a distinction §5 does not draw, and a reviewer is entitled to reject it. It is written here rather than buried in four diffs so that the rejection is possible.

### S-REST-1 measures twenty-one searches, not seventy-two, and the number is stated
`E-337` · auth-core · S-REST-1

**Context.** T-REST-1 counts 24 secret values in three encodings — 72 searches, 0 hits. Sixteen of the twenty-four are produced by modules other wave-3 features build: the TOTP secret, ten recovery codes, the WebAuthn challenge, the OAuth `state`, the PKCE verifier and two foreign provider tokens.
**Rejected.** (a) Reporting 72 searches by counting the values that cannot be created as trivially absent. (b) Skipping the test until the artefacts exist.
**Reason.** (a) is a green number that means nothing — a value never written is a value never found, and 48 of the 72 searches would have been searches for nothing. (b) leaves the requirement unmeasured for a wave. Seven values are created for real — the password, the pending token, four one-time tokens and a session token — and the assertion states `7 × 3 = 21` in the test name and in the expectation, and separately asserts the four tables hold exactly seven rows so that the search is not searching an empty schema.
**Price.** A requirement reported at 29 per cent of its threshold, and the sixteen remaining values need whoever builds them to extend this test rather than write their own — which nothing forces them to do. The count in the test name will be wrong the moment they do, which is the point: it has to be edited to stay true.

### The dump is taken with the instrument the requirement names, and by another where the binary is absent
`E-338` · auth-core · S-REST-1

**Context.** S-REST-1 says `pg_dump`. The CI runner has a PostgreSQL service container but no guarantee of the client binary, and a test that silently skips is the failure §5 names.
**Rejected.** (a) `pg_dump` only, failing the suite where the binary is missing. (b) Rendering every column to text only, ignoring what the requirement says.
**Reason.** (a) makes the requirement's coverage depend on the runner image. (b) drops the instrument the requirement chose, and `pg_dump` emits things a per-row rendering does not — comments, defaults, index definitions — any of which could carry a value. `pg_dump` is used when it runs; every column of every table cast to text is used when it does not; the test asserts which of the two it read, that the text is longer than a thousand characters, and that a value known to be in the schema is found in it.
**Price.** Two instruments, so a secret that only `pg_dump` would expose goes unseen on a runner without it, and the suite cannot tell the difference between "clean" and "clean under the weaker instrument" from the result alone — only from the assertion that names which ran. Both paths were exercised before this was trusted.

### The assembly did not check the password configuration, and the test that says it must is what found out
`E-339` · auth-core · S-DEFAULT-6, correction

**Context.** S-DEFAULT-6 makes Argon2id parameters below `m = 19456, t = 2, p = 1` a start error. `resolvePasswordConfig` has raised `PasswordConfigurationError` for them since wave 2. The start checks were written, the requirement was believed covered, and the test for it was written afterwards to confirm.
**Rejected.** Nothing — this is a defect, not a choice.
**Reason.** `createVelveAuth` never called `resolvePasswordConfig`. It read `config.session`, `config.identity`, `config.keys` and `config.origins`, and passed `config.password` to nobody, because no route this feature declares hashes a password. A configuration naming 1024 KiB of memory started cleanly and would have hashed at that cost the moment a password route was added by another feature. The fix is one call at start; the resolved configuration is now carried on the services object where the flows will need it.
**Price.** The requirement was written down as covered before it was, and would have shipped that way if the test had been written to match the implementation instead of to match the requirement. The order matters and this is the evidence: the test was written from S-DEFAULT-6, not from the code, and that is the only reason it failed.

### Three Base64 implementations were two, and neither of them is redundant
`E-340` · auth-core · correction to a brief

**Context.** The brief for this feature stated that three Base64 implementations exist in `src/core` and that E-221's own copy is redundant now that `keys/` has an encoder, and that the removal was due and belonged to nobody.
**Rejected.** Removing `src/core/password/base64.ts`, which was the candidate the brief pointed at.
**Reason.** The count was taken before E-221's own addendum was applied and is false at this branch point. The third copy — the private encoder in `session/token.ts` — was already removed; that file imports `encodeBase64Url` from `keys/base64url.ts`. Two remain, and they are not duplicates: `keys/base64url.ts` encodes the URL alphabet (`-_`) and `password/base64.ts` the standard one (`+/`), which PHC strings require. Removing either breaks the other's callers.
**Price.** Time spent verifying a figure rather than acting on it, and the general lesson costs more than this instance: a counted figure in a brief is a measurement taken at some earlier moment, and this one was two commits stale. The rule that follows — re-take any counted figure after every merge — is why this was checked at all.

### The actor for the reset path is not built here either
`E-341` · auth-core · E-234, not closed

**Context.** E-234 recorded that `revokeEverySessionOfUser` demands an `Actor`, that the only lawful producer is session resolution, and that the reset path — which has no session — needs a second producer with the provenance "redeemed one-time token", to be built by the feature that redeems them.
**Rejected.** (a) A producer in `src/core/flows/` casting a redemption result to `Actor`. (b) Adding the producer to `src/core/db/actor.ts` beside its sibling.
**Reason.** (b) is right and edits a file this feature does not own. (a) is possible — `Actor` is exported and a cast compiles — and is exactly the hole E-93 walls up: the brand exists so that minting an actor is visible in review, and a second cast in a second file makes it two places to look instead of one. The deciding argument is that no password-reset flow ships in this feature, so the producer would have had no caller, and an unused escape hatch is the worst kind.
**Price.** E-234 stays open a wave longer, and the requirement it carries — S-FIX-6 for the reset path — remains half satisfiable. Whoever builds `password.redeemReset` will meet it, and the right move then is still the one E-234 named: put the producer in `actor.ts`, next to the one that already exists, and let the brand keep meaning what it means. **Correction after the main gate:** the reason above is written as though no producer were *possible* from inside this feature, and that is false. This compiles today, in this feature's own area, with no cast and without tripping the scan that pins minting to `db/actor.ts`:

```ts
const issued = await sessions.issue({ userId, factors: ["password"], observed });
const resolved = await sessions.resolve(issued.token);
return resolved === null ? null : actorOfResolvedSession(resolved);
```

`issue` takes a bare `userId: string`, so an arbitrary string out of a request becomes a branded `Actor` in two awaits — the E-93 hole, reachable now, and reachable by anyone, not only by a feature that wanted an actor. It was not taken here, and the deciding argument was the second one this entry already gives: no reset flow ships in this feature, so the producer would have had no caller. That argument stands on its own. What does not stand is the claim that the brand made the alternative impossible; it made it *visible*, which is a weaker and more honest thing, and the laundering path belongs written down where the next reader looks for it.

### The route table is the set this feature declares, named rather than counted
`E-342` · auth-core · S-CSRF-1

**Context.** D.3 has 46 routes in `username_email`. This feature can declare seven: the namespaces behind the rest are built by other features of this wave or are out of scope. The whole-table requirements — origin check, GET classification, cookie set, content type — have to be measured over something.
**Rejected.** (a) A threshold: "at least eight routes carry `originCheck: checked`". (b) Measuring over the 46 names of D.3 and marking 39 as pending.
**Reason.** (a) is the shape §5 warns about — it passes on an empty table for the wrong reason, and the first version of these tests said "at least eight" and passed at seven until the floor was raised and the count was checked. (b) asserts against routes that do not exist, which is a fixture pretending to be a measurement. The tests name the seven exactly, so a route added, lost or renamed shows up as a name.
**Price.** Every one of these tests has to be edited when another feature adds a route, and the edit is in this feature's file. That is a merge conflict waiting for four branches, and the alternative — a number — is the thing that passed at seven when it was meant to pass at eight.

### The user reader lives in the assembly, not in the repository directory
`E-343` · auth-core · file ownership

**Context.** `session.resolve` returns `{ session, user }`, and nothing in the package could produce a `User`. `core/identity/resolution.ts` looks up by identifier, not by id; `core/db/repositories/` has no user repository.
**Rejected.** Adding `src/core/db/repositories/user.ts` beside the session and token repositories, which is where it belongs.
**Reason.** That directory belongs to the `db` feature of wave 1 and to nobody in wave 3. `auth.user.*` is the assembly's own namespace by 3.15 B.3 — the surface an application calls in its own process after its own authorization decision — so the reader sitting in `core/auth/user.ts` is defensible on its own terms and not only as a workaround.
**Price.** A repository outside the repository directory, with its own row decoding and its own `toDate` helper duplicating the one in `db/repositories/session.ts`. Two copies of a three-line function that must agree about what a driver is allowed to hand back. If the driver contract changes, one of them will be updated.

### There is no release tier, and three test cases have nowhere to run
`E-344` · auth-core · 6, reported

**Context.** Section 6 assigns tests to three tiers: every commit, nightly, and **before every release**. The last tier holds T-KEY-5 (a root-key rotation survived across two restarts), T-DEFAULT-7 (`hash-wasm` present and absent produce byte-identical hashes) and the 6.19 packaging test. `package.json` has `test` and `test:nightly` and nothing else.
**Rejected.** (a) Adding a `test:release` script and a third vitest project. (b) Moving the three into the blocking tier.
**Reason.** (a) edits `package.json` and `vitest.config.ts`, both shared and unowned this wave, and a tier with no schedule attached to it is a script nobody runs — the nightly tier only became real when E-155 gave it a workflow. (b) puts a test that restarts a process and one that manipulates an optional dependency on every commit, which is how a blocking tier becomes a tier people skip. This is a gap in the repository's infrastructure, not in this feature, and §6's own rule is that a decision is recorded rather than filled silently.
**Price.** Two of the three cases remain unrun anywhere. The packaging half is covered here in a different form (E-327), so the practical exposure is T-KEY-5 and T-DEFAULT-7 — a rotation path and an accelerator-equivalence path, both of which fail in ways that look like data loss.

### Two words were reworded rather than excused
`E-345` · auth-core · scans

**Context.** Two existing scans went red on strings in the assembly: `keys-static-scan` forbids the word `process` anywhere in `src/core` code, and `session-review-resolution` allows the code `account_disabled` to be *named* in two files. The assembly had "counters held in this process" in a log field, and names the code in its route contract.
**Rejected.** Adding an exclusion to either scan.
**Reason.** For the first, the fix is one word — "in memory" says the same thing and the scan keeps its meaning. §4 already fixes this rule for the AI-attribution check: text that would trip a check gets reworded rather than excused, and the same reasoning applies to any check. The second could not be reworded: D.3 requires every route with caller `session` to declare `account_disabled` among its errors, and the instance publishes the code list. That expectation was widened, and the entry above records it.
**Price.** A scan on a common English word now shapes the prose of every file in `src/core`, and the next author will hit it on a sentence about operating systems or background work and will not know why. The check does not say.

### A test claimed a run that sets a cookie, and set none
`E-346` · auth-core · S-COOKIE-6, correction

**Context.** The S-COOKIE-6 test was written as "sets no name outside the enumerated two, over a run that sets at least one", by analogy with the non-empty guards on the other whole-table tests.
**Rejected.** Leaving the title and adding a route that sets a cookie so the claim becomes true.
**Reason.** The title was false and the test did not check it: no route this feature declares sets a cookie, because the routes that issue a session or a pending state belong to other features. Writing a route to make a test name accurate is the tail wagging the dog. The name now says what happens, and the test asserts the observed set is empty — a fact, and one that becomes a failure the moment a route here starts setting cookies without the enumeration being extended.
**Price.** S-COOKIE-6's own threshold — "0 never-set entries", meaning both enumerated names are actually used somewhere in the suite — is not met and cannot be met from this feature. The half that is met is the half that matters more: no unenumerated name can be set, and `assertCookieNamesAreEnumerated` turns an attempt into a 500.

### `fast-check`, `ts-morph` and `simple-statistics` were not added, because nothing here needed them
`E-347` · auth-core · dependencies

**Context.** The brief allowed this feature to add devDependencies — `@fast-check/vitest` for T-CSRF-Parser's two thousand generated hostnames, `ts-morph` for the static halves of T-CSRF-1, T-OWNER-6 and T-ENUM-7 — and asked that the addition be said loudly, `package.json` being shared and unowned.
**Rejected.** Adding all three so that the property test and the AST rules could be written.
**Reason.** The static halves were written without an AST at all. T-CSRF-1's static half is "count the routes with `originCheck: exempt`", and the route table is a runtime array — reading it is one filter, and `ts-morph` would have parsed the source to learn something the built object states directly. T-ENUM-7 is the same shape. T-CSRF-Parser genuinely needs `fast-check`; it also tests `core/http/origin.ts`, which this feature does not own and whose behaviour it does not change, and it is a nightly test. Adding a dependency for a test aimed at another feature's file is the wrong trade against a shared `package.json`.
**Price.** T-CSRF-Parser is unwritten, so S-CSRF-2 and S-CSRF-3 keep only their unit coverage — three cases and eight variants against two thousand generated ones. Whoever writes it adds the dependency, and the argument for adding it will be weaker then than it is now, because it will be one test.

### `close()` does nothing, and that is the contract
`E-348` · auth-core · surface

**Context.** 3.15 B lists `close(): Promise<void>` on the instance. The `Driver` interface has no close, and the connection is created by the application and handed in.
**Rejected.** (a) Leaving the method off. (b) Requiring the driver to grow a `close`.
**Reason.** (a) removes a published method. (b) changes an interface three driver adapters implement, in files this feature does not own, to add a capability the library never needs — it opened nothing. The method resolves and the reference says why in one sentence.
**Price.** A method that looks like a resource release and is not, which is precisely the shape that gets called in a `finally` and trusted. An application that expects `close()` to end its pool will leak it and get no warning.


### The mode was not inferrable, so the requirement it carries never bit
`E-349` · auth-core · S-DEFAULT-4, correction

**Context.** `RecoveryCodesRequirement<M>` was written, exported, documented and reported as closing E-207. The gate wrote four lines of ordinary configuration — `username` mode, no `recoveryCodes` — and they compiled clean.
**Rejected.** Nothing. This is a defect, and it shipped.
**Reason.** `M` had exactly one candidate inference site, `identity: IdentityConfig<M>`, and `IdentityConfig` was a conditional type. A conditional type is not an inference position, so `M` never got a candidate, fell back to its constraint `IdentityMode`, and `RecoveryCodesRequirement<IdentityMode>` distributed into a union whose optional branch accepts everything. The type was correct and could not fire. `IdentityConfig<M>` is now `IdentityConfigurationInput & { readonly mode: M }` — reusing the lookup table `core/identity` already keeps, with `M` in a plain property position, which is the shape `IdentityFieldsByMode` beside it had used all along.
**Price.** Two collateral failures rode along, and both were reported as working. The `username` namespace was pruned in the one mode that has it, because `ModeHasUsername<IdentityMode>` is not `true` — so 3.15 A.1's design B, chosen precisely so the error names the mode, named the union instead. And the reference stated twice, in this feature's own chapter, that the mode is inferred and that the omission is a compile error. Both false as shipped, both now true, and the reference now says which detail they depend on, because the natural way to write that type is the way that breaks them.

### A cast made the test say the same thing whether the type worked or not
`E-350` · auth-core · S-DEFAULT-4, correction

**Context.** The test for S-DEFAULT-4 wrote `createVelveAuth(withoutCodes as never)` for the failing case and the same cast for the passing one, and asserted on the runtime throw.
**Rejected.** Keeping the cast and adding a separate type test beside it.
**Reason.** `as never` is assignable to every parameter, so the call compiles whatever the parameter type says — the assertion could not observe the type half at all, and reported success for as long as the type was broken. §3 asks for `@ts-expect-error` next to a failing-by-design case, and the repository uses it thirteen times elsewhere; this was the one place that needed it and did not have it. The casts are gone and the directive is there, so `pnpm typecheck` fails with `Unused '@ts-expect-error' directive` the moment the type stops biting.
**Price.** The lesson is not "use the directive"; it is that a test written *around* an inconvenience reports on something other than what it names. The cast went in to make the fixture type-check quickly, and from that moment the test measured the runtime check twice and the type check never — while its name promised both. The planted regression that proves it now fires produced exactly the error above, and produced nothing at all before.

### The one value that proves the encryption ran was the one left out
`E-351` · auth-core · S-REST-1, correction

**Context.** E-337 recorded the S-REST-1 measurement as seven values in three encodings, twenty-one searches. T-REST-1 decomposes to twenty-four values; sixteen belong to modules other features build; twenty-four minus sixteen is eight.
**Rejected.** Treating the difference as a rounding of an already-stated shortfall.
**Reason.** The missing value is the PHC string, which T-REST-1 names separately from the password, and the separation is the whole point: Argon2id keeps the plaintext out of a dump whether or not `password-enc` encrypted anything, so searching for the plaintext proves nothing about the envelope. The PHC string is the only one of the eight that fails if the envelope silently no-ops. The test already held the key ring and had already fetched the credential row; adding the value was one `openPhc` call. The count is now eight values, twenty-four searches, and the tree agreed with itself in three places only after all three were corrected — the comment said eight while the assertion and the entry said seven.
**Price.** The figure was reported to a coordinator and written into an entry before the decomposition it claimed to follow had been done arithmetic on. A stated count is only worth what its derivation is worth, and this one was derived from what the test happened to create rather than from the requirement. The planted fault that now proves it — the PHC written into a text column — reports `password hash (PHC) as $argon2id$v=…`, which is what a no-op envelope would have looked like.

### Eight of eleven whole-table assertions passed on an empty table
`E-352` · auth-core · S-CSRF-1, correction

**Context.** E-342 rejected a threshold in favour of naming the seven routes, and said in as many words that a number "passes on an empty table for the wrong reason". The naming was applied to three assertions. The other eight iterated `routes` and asserted over the result.
**Rejected.** A shared non-empty guard in `beforeAll`, which would have satisfied the letter.
**Reason.** `expect(codes).toStrictEqual(routes.map(() => "403 origin_not_allowed"))` compares an empty list with an empty list, and reports that every route refuses a foreign origin having tested none. The same shape carried S-CACHE-4's pending-cookie sweep and S-CSRF-4's row-count sweep — the two assertions carrying the actual security claims of this feature. Each expectation now counts against `DECLARED_ROUTES` rather than against the list it just iterated, so the count and the thing counted have different sources. A guard in `beforeAll` would have been one assertion protecting eight; putting the count in each is what makes each one able to fail alone.
**Price.** The entry that argued for naming over counting was written by the same author who then wrote eight assertions that counted, in the same file, in the same sitting. Knowing the failure shape is not the same as recognising it, and nothing in a green run distinguishes them — the empty-list plant does, and it is the only thing that did. Three failed before it; eight fail now, and the three that still pass are the three that never read the table.

### Admitting a file to a scan's list is not the same as scanning it
`E-353` · auth-core · S-TOKEN-1, correction

**Context.** The L-11 sweep names `one_time_token`, so `test/token-static-scan.test.ts` went red on a list of the files allowed to name the table, and the list was widened to admit `auth/maintenance.ts`.
**Rejected.** Leaving the widening as it stood.
**Reason.** Every other assertion in that file reads the token repository's source alone. Widening the path list therefore moved the sweep into the file's scope and into none of its checks: S-TOKEN-1's requirement that every predicate against the table names `purpose` no longer saw the one statement that has none. The widening was not dishonest but it was empty, and an exemption that is granted without being bounded is the shape a scan dies of. What the sweep may do is now pinned — one statement, a DELETE, a deadline predicate, no `purpose`, no `user_id`, its own marker — and a planted `AND user_id IS NOT NULL` fails it.
**Price.** Two things had to be looked at that the widening had passed over. The neighbouring comment still called that repository's DELETE "the one row-removing statement in the library without an owner predicate"; there are seven such markers across five files, and the sentence is now a counted assertion rather than prose, so the next one to be added has to move a number. And the sweep names the table in a list of tables while building its SQL from the configured schema, so the name and the statement never meet in one literal — the path scan matched a data structure, not a query, which is precisely why matching it proved nothing.

### The pending row and the session it becomes are one transaction
`E-354` · auth-core · S-FIX-1, S-RACE-5

**Context.** Nothing in the repository consumed a pending row and inserted a session together. `factor-totp` and `factor-webauthn` each reached the gap from their own side; neither can close it, because the pending service is in one module and the session service in another and each feature owns one.
**Rejected.** (a) Leaving it to whichever factor feature writes its verify route first. (b) Putting the operation in the assembly, where the composition belongs.
**Reason.** (a) leaves two features to solve the same problem twice and to disagree; it is also the failure mode S-FIX-1 exists for — a spent intermediate state with no session behind it, which locks a user out of a sign-in they completed. (b) is where it belongs conceptually and is not where the callers are: both features import the pending barrel and neither imports the assembly, so a function there would have been a function they could not reach. It sits beside the pending module and binds both services to the same transaction.
**Price.** `core/factor/pending` now imports `core/session`, which is a dependency the module did not have and does not need for anything else it does. The concurrency property it looks like it provides, it does not: fifty racers still yield exactly one session because `consume` is a single `DELETE … RETURNING`, and removing the transaction leaves that test green. What the transaction buys is the rollback, and only the rollback test sees it — which is why both are written and why the non-transactional plant fails exactly one of them.

### What the eight trust-level events share is the new token, not a deleted row
`E-355` · auth-core · S-FIX-1, correction

**Context.** `TRUST_LEVEL_EVENTS` is documented as "the eight events after which the previous session row is gone and a new token has been issued".
**Rejected.** Narrowing the list to the events that really do replace a session row.
**Reason.** The first half of that sentence is false for three of the eight. A passkey sign-in and a password sign-in from no session replace nothing, because there is nothing; a second factor replaces a pending row, which is not a session. Narrowing the list would have been worse than the wrong sentence — the events are on it because each is a change of trust level that must hand back a new token, and that is the invariant T-FIX-1 reads them for. The comment now says which row goes in which case, and that the shared invariant is the token.
**Price.** A comment that was three sentences and is now six, on a constant of eight strings. It earns them: the sentence it replaced was the kind that reads as a specification and is quoted as one, and the first reader to build the passkey path would have gone looking for a session row to delete.

### Two floors the specification's SQL does not have
`E-380` · rate · deviation from 3.9, frozen

**Context.** Architecture 3.9 prints the statement verbatim, and its update clause is `LEAST(capacity, tokens + elapsed × refill) − 1`. Written that way a refused request decrements the stored level like an accepted one, so a bucket that has taken a million refusals stands at −1,000,000 and needs a million tokens' worth of refilling before anyone gets in. At the account counter's `refillPerSecond: 0.01` that is three years.

**Rejected.** (a) The statement exactly as printed. (b) A separate `CASE WHEN` that decrements only on success, which is the textbook token bucket.

**Reason.** (a) contradicts the last sentence of S-RATE-7 in the same document: an account must stay reachable for its rightful owner "after arbitrarily many failed attempts by third parties". Unbounded negative drift is a lockout, and a lockout is what that requirement exists to forbid. The architecture disagrees with itself here and CLAUDE.md's tie-breaker does not help, because both sides are the architecture; the requirement is prose about intent and the SQL is a sketch of mechanism, so the requirement wins. (b) is the better-known shape and was rejected only because it changes the statement more than necessary: one `GREATEST(0, …)` around the refilled level keeps the unconditional `− 1` the specification wrote and bounds the stored level at −1, which is enough. A second `GREATEST(0, …)` around the elapsed term followed from E-381 and guards a clock that moved backwards. So the shipped statement is 3.9 plus two function calls.

**Price.** A refused bucket rests at −1 rather than 0, so a caller who arrives after a flood waits for two tokens rather than one — one extra refill period, silently, and nothing in the interface says so. That was the accepted cost of not restructuring the statement, and it is a worse deal than it looked when it was taken: the `CASE WHEN` in (b) would have cost one line and removed the surprise. It is not changed now because the tests are written against the shipped shape and the difference is one refill period, but the next person to touch this statement should take (b). The honest order of events is also worth writing down: this was not found by reading S-RATE-7. It was found while working out what T-RATE-7's "advance the clock by the refill time" could possibly mean for a bucket at −1,000,000, and only then did reading the requirement confirm it.

### The instant comes from the process, not from `now()`
`E-381` · rate · time source, revisit if instances disagree

**Context.** 3.9's SQL calls `now()` four times: the level is refilled from `now() − updated_at`, and `updated_at` and `expires_at` are written from it. The brief for this feature listed `clock` among the constructor's parameters.

**Rejected.** Keeping `now()` and giving the limiter no clock at all.

**Reason.** The deciding reason was that the parameter list handed me a `clock` and a limiter that never reads it would be an unused constructor field. That is the actual reason and it is a bad one. The two supporting arguments were found afterwards, and they do hold: T-RATE-7 is specified as an integration test with a *controlled clock*, and a bucket whose refill is measured by the database cannot be advanced by a test; and `HttpEnvironment` already carries a `Clock` that everything else in the request path reads, so a second, invisible time source in the one component that measures elapsed time is a thing nobody would guess at.

**Price.** The database was the one clock every instance agreed on, and this gives that up. Two processes whose clocks differ by a minute now write `updated_at` values that differ by a minute, and the one that is behind would compute a negative elapsed time and *subtract* tokens — which is why E-380's second floor exists. With the floor, skew can only make a bucket refill faster or slower than intended, bounded by the skew; without it, skew could empty a bucket. Nothing detects the skew and nothing reports it. `now()` would have been the stronger choice for a deployment of several instances, and this branch traded that for a test it could write.

### The alarm counts address checks, and a route that declares no address bucket is invisible to it
`E-382` · rate · alarm scope, open

**Context.** S-RATE-8 wants a counter "per route and per instance" that only raises an alarm. The `RateLimiter` seam has exactly one method, `consume`, and the pipeline calls it once for the address bucket and once more, from inside the handler, for the account bucket. A counter that observes every call therefore counts a sign-in twice and a route without an account bucket once, so a threshold in "requests" would mean two different things on two routes.

**Rejected.** (a) Observing every `consume` and documenting that the unit is checks, not requests. (b) Adding a second method to the limiter for the observation, so the pipeline could call it once per request.

**Reason.** (b) is out because the seam is fixed and E-115 put it there specifically so that the counter arriving in a later wave would not touch the HTTP files; adding a method is touching them. Between (a) and observing only the address-scope call, the address call is the one the pipeline makes for every arriving request before it parses anything, which is as close to "a request arrived" as this side of the seam can see. Every route that can be flooded from outside declares an address bucket, so in practice one observation is one request.

**Price.** "In practice" is doing real work in that sentence. A route configured with `perIpAddress: "none"` and an account bucket is counted zero times and cannot raise the alarm however hard it is hit, and nothing warns that the alarm has a blind spot on that route — the pipeline already warns about an unconsumed account bucket, and there is no equivalent here. The field is named `addressChecksObserved` so that the number cannot be read as a request count, which is a name doing the job a check should do. This stays open: if wave 3's route table turns out to hold a route with an account bucket and no address bucket, this decision is wrong for that route and needs revisiting rather than renaming.

### The alarm has no timer, and fires on the way in rather than every time past it
`E-383` · rate · alarm mechanics, frozen

**Context.** A per-route counter needs a window. The obvious shape is a counter reset by an interval timer.

**Rejected.** (a) A window reset by `setInterval` or a trailing `setTimeout`. (b) Calling `onAlert` on every request once the allowance is spent.

**Reason.** (a) is inert exactly when it is needed. E-186 measured 800 concurrent sign-ins producing no timer callback at all in 14.7 seconds with `hash-wasm` installed; a counter whose window only resets from a timer would, under that load, either never reset or reset in one late burst, and the alarm that exists to notice a flood would be the thing the flood switched off. The counter is a token bucket refilled from `clock.now()` on each observation instead, so it has no scheduling at all and its state advances only when something is happening. (b) turns one flood into one alert per request, which is a second flood pointed at the alert sink; the alarm fires on the transition from "had allowance" to "spent", and again only after the allowance has recovered.

**Price.** A sustained flood produces one alert and then silence, so an operator watching alert *volume* sees nothing after the first, and a flood that stops and restarts within the recovery time produces no second alert. `addressChecksObserved` is in the payload so a receiver can tell a long flood from a short one, but it is a running total since the process started, not a rate — deriving a rate from two alerts is left to whatever receives them. An `onAlert` that throws is swallowed, on the same argument the pipeline uses for a `log` that throws, which means an alert sink that is down looks exactly like a service that is quiet.

### An address the parser rejects is counted, on one bucket per route
`E-384` · rate · S-RATE-4, frozen

**Context.** S-RATE-4 is about a request with no determinable client address. `ipAddressNetwork` also returns `null` for text that is not one address — a zone identifier, `host:port`, a bracketed address, two addresses in one header value — and the requirement does not say what those are.

**Rejected.** (a) Giving unparseable text its own bucket, keyed by the raw string. (b) Letting the check pass when the address cannot be parsed.

**Reason.** (b) is the failure S-RATE-4 is written against and needs no argument. (a) is the interesting one and it is worse than it looks: the raw string comes from whatever the adapter passed in, which for a proxied deployment is a header value, so an attacker who can make the parser fail gets a fresh bucket per spelling — `not-an-ip-1`, `not-an-ip-2` — which is CVE-2026-45364 with extra steps and an unbounded key space in a table with a primary key on it. Everything the parser rejects lands in one bucket per route, named `unresolved`, together with a genuinely absent address.

**Price.** Callers that have nothing to do with each other share a bucket, so one broken client behind a proxy that mangles the header can exhaust the shared allowance and refuse every other caller whose address also failed to parse. That is a denial of service against a set of callers, and it is the deliberate choice, because the alternative is a free lane any caller can enter on demand. It also means a deployment whose adapter is wired up wrongly — passing a header value straight through, say — shows up as everyone sharing one bucket rather than as an error, and nothing says so out loud.

### The bucket lifetime is computed, not configured
`E-385` · rate · configuration, frozen

**Context.** `velve.rate_bucket` has `expires_at` and a sweep index on it. Something has to decide how long a row lives, and a row swept before its bucket has refilled hands the remaining deficit back to the caller for free.

**Rejected.** (a) A `bucketLifetimeInSeconds` option. (b) One fixed lifetime for every bucket.

**Reason.** The correct answer is derivable — a bucket has to outlive the time it takes to fill from empty, which is `capacity / refillPerSecond` — and an option whose only correct value is computable from two other options is an option that will be set wrong. (b) is wrong in both directions at once, because the rules in one route table differ by three orders of magnitude in refill rate. The computed value is floored at 60 seconds, so a fast bucket does not produce rows that expire almost immediately, and capped at one day.

**Price.** The one-day cap is a policy decision hidden inside an arithmetic one. A rule whose full refill takes longer than a day gets a row that may be swept before it has refilled, which quietly returns tokens to a caller who should not have them. The defence is that such a rule is a lockout wearing a rate limiter's name and S-RATE-7 rules it out anyway — but nothing rejects the configuration, so a rule like that is accepted, silently behaves differently from what it says, and the only place this is written down is the documentation and this entry.

### A guard that could not fail, found by a plant that proved nothing
`E-386` · rate · check quality, correction

**Context.** `resolveClientAddress` began with two guards: return the connection address when `trustedProxies` is empty, then return it again when the connection is not from a trusted proxy. The first was written to make S-RATE-3's "only when `trustedProxies` is configured" clause visible in the code. The first plant against the function removed exactly that guard, and every test still passed.

**Rejected.** Treating the passing plant as evidence that the tests were weak, and writing more tests.

**Reason.** The plant had not made the function wrong. With an empty list `trustedProxies.some(…)` is `false`, so the second guard already returns the connection address; the first guard was a redundant short circuit and removing it changed nothing an observer could see. The tests were not weak, the plant was aimed at a place the fault could not live — the exact failure CLAUDE.md §5 warns about, met on the first attempt. The guard came out and S-RATE-3 is now carried by the one condition that decides it, so a plant against that condition changes behaviour; re-planted, it failed five tests.

**Price.** The requirement is now expressed by an absence — the header is not read because the trust check did not pass — rather than by a line that names it, which is harder to see when reading the function. A comment above it says so, which is the weakest of the available guarantees. And the general lesson is bought at the price of admitting the specific one: a redundant guard is not just dead weight, it is a place where a planted fault silently passes and buys false confidence in the tests that let it through.

### The option-shape check missed a planted lockout, and its self-test proved the wrong thing
`E-387` · rate · check quality, correction

**Context.** T-RATE-7 requires a static check that no option type carries a key for a delay or a lock. The first form scanned every declared member of the module against `/\b(delay|lock|block|…)/i`, and it had a self-test asserting that the pattern reports `lockoutSeconds` and does not report `refillPerSecond`. Both passed. Planting `readonly accountLockoutSeconds?: number` on `RateLimiterConfig` did not fail it.

**Rejected.** Dropping the `\b` anchor and matching the stem anywhere in the name.

**Reason.** `\b` never falls inside `accountLockoutSeconds`, because `t` and `L` are both word characters. The self-test could not catch that, because the one name it tried has the stem at position 0, where the anchor does match — the probe was aimed at the single spelling the fault cannot take, and it passed for that reason and no other. Dropping the anchor was rejected because `clock` is a member of `RateLimiterOptions` and contains `lock`, so an unanchored scan reports this module's own constructor. The name is split on its case changes first and each word is tested against the stems, so `accountLockoutSeconds` becomes `account lockout seconds` and `clock` stays one word that starts with no stem.

**Price.** A member named `lockoutseconds`, all lower case, is one word that starts with `lock` and is caught, but a name that hides a stem in the middle of a word with no case change would not be. The check is a vocabulary filter and can be walked around by anyone who wants to; it exists to catch the option somebody adds in good faith, not the one somebody hides. This is the second entry in a row about a check that looked green — both were found in the same afternoon, both by planting, and neither by reading the check. **Correction after the main gate:** that price paragraph names the wrong gap and is far too comfortable. The gate planted twelve names and six got through — `minimumResponseTime`, `waitMs`, `pauseBeforeAnswerMs`, `holdForMs`, `slowResponseFloorMs`, `jitterMs` — and every one of them splits cleanly on its case changes, so not one is the mid-word case this paragraph excuses. They were missed because they are not in the twelve-stem vocabulary, which is the ordinary way a denylist fails and not an edge of it. Worse, the sentence "it exists to catch the option somebody adds in good faith" is exactly the claim the plant disproves: `minimumResponseTime` **is** the good-faith name for a response-time floor, which is the artificial delay S-RATE-7 forbids. The fix is a change of shape rather than more stems; see E-394.

### Fifty connections for a two-hundred-way race
`E-388` · rate · test cost, overturned by E-392

**Context.** T-RATE-6 fixes 200 simultaneous requests, capacity 20, 50 repetitions, tolerance 0. E-262 records that a full test run already reaches 89 of the 100 local PostgreSQL connections.

**Rejected.** (a) One connection per request, which is what "200 simultaneous" reads like. (b) One connection for all of them, which is what the test connection's own queue would make of a `Promise.all`.

**Reason.** (a) asks for twice the server's whole grant. (b) is not a race at all: the test connection serialises its statements, so 200 promises on one socket run one after another and the test would pass against an implementation with no atomicity whatsoever. Fifty connections is the width `test/token-race.test.ts` already holds, the concurrency project runs one file at a time after every other file has finished (E-156), and 200 requests spread over 50 sockets still puts 50 statements in flight at once.

**Price.** The measured concurrency is 50, not 200, and the threshold says 200. What the run actually demonstrates is that fifty writers conflicting on one row leave exactly twenty winners, fifty times over; that four of the two hundred queue behind each other is invisible to the result and would hide a fault that only appears above fifty-way conflict, if such a fault exists. The planted read-then-write failed all fifty runs at this width, which is the evidence that the width is enough to separate the two implementations — not evidence that it is enough to separate every pair. **Correction after the first full nightly run:** fifty does not fit, and the reasoning above is wrong in the one place it was most confident. `test/token-race.test.ts` holding fifty was read as proof that fifty is affordable; it is proof that fifty is affordable *when nothing else holds fifty*. The two files ran at the same time — `fileParallelism: false` on the concurrency project did not serialise them — and the server answered `sorry, too many clients already` to both, so this branch did not merely fail its own test, it broke a passing test on `main`. E-262 said in as many words to budget for it, and the budget was computed against the wrong baseline. The width is now twenty. See E-392.

### Twenty connections, because the file that already held fifty is still holding them
`E-392` · rate · test cost, correction

**Context.** E-388 sized the T-RATE-6 race at fifty connections. The first full `pnpm test:nightly` run failed two files with `sorry, too many clients already`: this one and `test/token-race.test.ts`, which opens fifty of its own. The local server allows a hundred and nine are held before any test runs.

**Rejected.** (a) Raising `max_connections` locally. (b) Making the file retry a refused connection until one frees up. (c) Fixing `fileParallelism: false` so the two files cannot overlap.

**Reason.** (a) fixes this machine and not CI, which runs `postgres:16-alpine` with its own limit, and the test would fail there instead. (b) turns a resource collision into a slower test that passes, which hides the collision from whoever adds the *next* concurrency file. (c) is the real fix and is out of reach: `vitest.config.ts` is nobody's file this wave, and the setting is already there — it is set on the project rather than at the root, and on this version it does not serialise the files. Twenty is what fits beside token-race's fifty with the nine already held, and the race still puts twenty writers in conflict on one row.

**Price.** The measured width drops from fifty to twenty against a threshold that says two hundred, so the gap between what is specified and what is demonstrated widens. Twenty-way conflict still separates the shipped statement from the planted read-then-write — that plant failed all fifty runs — but the file is now sized against another file's appetite rather than against the requirement, and it will need resizing again the moment somebody changes `test/token-race.test.ts` or adds a third file that wants connections. Nothing links the two numbers except this entry. The setting that would make all of this unnecessary is present and ineffective, and this branch reports it rather than fixing it.

### The account bucket is per route
`E-389` · rate · key shape, frozen

**Context.** 3.9 describes the account counter as "one bucket with a slowly refilling rate". S-RATE-5 says the key contains the resolved route name. Read together it is not obvious whether one account has one bucket or one per route, and the seam decides nothing: `consume` receives a route name for both scopes.

**Rejected.** One bucket per account across all routes, keyed by the digest alone.

**Reason.** S-RATE-5 is written about "the rate key" without qualifying which counter, and the pipeline passes the route name for the account scope as well, which reads as the interface expecting it to be used. The per-route key is also the one that composes: two routes with different costs can carry different capacities, which a shared bucket makes meaningless.

**Price.** An attacker who can reach several routes that all take the same identifier gets a full capacity on each, so the total number of attempts against one account is the sum over the routes rather than one budget. Whether that matters depends on a route table this branch cannot see — if wave 3 ships several routes that each accept a password attempt, this decision is the wrong one and the fix is a shared key, not a smaller capacity. Nothing here detects that; it needs someone reading the finished route table.

### The identifier is normalised by the route, not by the limiter
`E-390` · rate · boundary, frozen

**Context.** S-RATE-7 keys the account counter on the "normalised identifier". Normalisation belongs to `identity`, which owns folding, case and the email rules, and this module owns no file there.

**Rejected.** Lower-casing and trimming the identifier inside `accountBucketKey`, as a safety net.

**Reason.** A second, simpler normaliser next to the real one is the way two normalisers drift apart: the moment `identity` folds something this one does not, two spellings of one identifier get two buckets and the counter is quietly halved. One normaliser, applied by the caller, is the only shape with no drift in it. `context.enforceAccountRateLimit` takes what the route hands it.

**Price.** A route that forgets to normalise gets a working rate limiter that counts spellings instead of accounts, and nothing detects it — not this module, which cannot tell a normalised string from an unnormalised one, and not the seam, which has no opinion. The test in `limit-account.test.ts` that shows three spellings on one bucket is a test of the fixture route's normalisation as much as of anything here, and it would keep passing if this module started normalising too. The only real defence is that the routes are written once, in one place, by whoever owns them.

### No migration, no table, no sweep
`E-391` · rate · scope, frozen

**Context.** `velve.rate_bucket` already exists in migration 1 with the columns 3.9 needs and a sweep index on `expires_at`. Expired rows have to be removed by something.

**Rejected.** (a) A migration adding an index on `bucket_key`'s prefix, so the three counters could be swept separately. (b) A sweep inside this module, run from `consume`.

**Reason.** (a) would edit a file this feature does not own and move migration 1's checksum, which the migration runner treats as a schema that has been tampered with — every existing database would refuse to start. Whatever it bought was not worth that, and it buys little: the primary key covers the only lookup made. (b) is `maintenance`'s job; a sweep triggered from the request path is a request that occasionally takes a full table scan, and the deletion of expired rows is not urgent enough to pay for that.

**Price.** Until something sweeps, `velve.rate_bucket` grows by one row per active bucket and shrinks by none. Every row's `expires_at` is set correctly on every write, so the sweep will work when it exists; there is simply nothing running it in this branch, and a deployment that never sweeps accumulates one row per address prefix per route indefinitely. That is a real hand-off and not a rounding error: the address counter's key space is the internet.

### The nightly tier is not reproducible, and this branch found that out by dispatching it
`E-393` · rate · finding, reported not fixed

**Context.** CI's `gate` job runs `pnpm test`, which excludes the nightly tier, so T-RATE-6 — the one case of this feature with a threshold of "50 of 50 runs, tolerance 0" — is not covered by anything the pull request reports. The nightly workflow accepts `workflow_dispatch`, so it was dispatched on this branch to find out whether the case passes on `postgres:16-alpine` rather than on the local 18.3.

**Rejected.** Trusting the local `pnpm test:nightly` and the green `gh pr checks`, which is what the two of them together look like they cover.

**Reason.** They do not cover it. T-RATE-6 ran on CI, passed, and took 5.25 seconds against 1.5 locally, and its fifty connections beside `test/token-race.test.ts`'s fifty did not exhaust the CI server — none of which was knowable from a green `gh pr checks`, because the job that would have said so does not run there. The run also failed, on `test/token-review-randomness.test.ts`: a chi-square across many character positions at p = 0.001, `position 13: expected 105.23776 to be less than 103.442`. Re-running the failed job — and it is a re-run, not a second clean run — passed. So the nightly tier rejects a sound generator often enough to fail a run, which is exactly what the workflow's own header says about this family of tests, written as the reason they are not in the blocking gate.

**Price.** Nothing is done about it here. `token` owns that test and the gate owns the workflow, and a branch adding a rate limiter is not the place to change either — but the consequence is worth stating plainly rather than leaving in a report: the nightly tier is the only thing that runs T-RATE-6, and it is a tier that goes red on its own roughly often enough that a red nightly will be read as noise and closed unread. The first genuine T-RATE-6 failure will arrive in that inbox. Whoever owns the nightly workflow should either seed the generator under test or move the family behind a threshold that does not reject a sound generator, and until then a red nightly has to be opened rather than dismissed.

### A check that recognises forbidden names cannot say what a check has to say
`E-394` · rate · check shape, corrects E-387

**Context.** E-387 rewrote the option-shape check once already, after a denylist of stems missed `accountLockoutSeconds`. The rewrite split names on their case changes and kept the denylist. The main gate then planted twelve names against the real `RateLimiterConfig`. Six were caught. Six were not: `minimumResponseTime`, `waitMs`, `pauseBeforeAnswerMs`, `holdForMs`, `slowResponseFloorMs`, `jitterMs`. Every one of them splits cleanly on case, so none is the mid-word case E-387's price paragraph had excused; they are simply not in the vocabulary. `minimumResponseTime` is the one that matters, because it is the most natural name a person acting in good faith would give a response-time floor, and a response-time floor is the artificial delay S-RATE-7 forbids.

**Rejected.** (a) Adding the six stems, and `pause`, `hold`, `jitter`, `slow`, `minimum` behind them. (b) Leaving the check and weakening the documentation to say what it actually covers.

**Reason.** (a) is what was done last time and it is the same move that failed twice; a denylist can only ever answer "no stem I know of matched", and the next writer's name is by definition one nobody thought of. §5 asks a check to be able to tell *found nothing* from *found a fault*, and this shape cannot: both outcomes look identical from the outside. (b) makes the documentation honest and leaves the hole. The check is now an allowlist: every member name declared anywhere under `src/core/limit/` is listed with one line saying what it is, and a name that is not on the list fails the build. It answers "every name here is one somebody read", which is a statement about the module rather than about the checker's vocabulary. A second assertion fails on an allowlist entry the module no longer declares, so the list cannot rot into a set of slots waiting for a name — it caught an invented entry within a minute of being written. Membership is tested with `Object.hasOwn`, so a member called `toString` is unreviewed like any other rather than inherited from the prototype and silently allowed.

**Price.** Every new member of every interface in this module now fails the build until somebody adds it to a list in a test file, which is friction on ordinary work and will be read as bureaucracy the first time it fires on `bucketKeyPrefix`. That friction is the entire mechanism: the moment of adding the name is the moment somebody has to say what it does. It is also a check that can be satisfied without being obeyed — a writer who adds `minimumResponseTime` to the allowlist with a plausible sentence beside it passes, exactly as E-147 said of the lock marker: it makes someone answer the question, not answer it correctly. And the documentation had been claiming this guarantee outright — "no option here names either, and `test/limit-option-shape.test.ts` fails the build if one ever does" — while the check would have passed the most likely offending name. That sentence is the real damage of the two failed attempts, because a future writer reads it, adds the option in good faith, and ships the forbidden delay believing something would have stopped them. It is rewritten to say what the check now is.

### The elapsed floor needed a test, and the number that justified it was smaller than claimed
`E-395` · rate · deviation from 3.9, corrects E-380

**Context.** E-380 added two floors to the statement in 3.9. The token floor is anchored — removing it fails two tests. The elapsed floor was held by a comment: the main gate removed `GREATEST(0, EXTRACT(EPOCH FROM …))` and all twelve rate tests stayed green. Its own measurement put the unfloored bucket at −10002 and called it a multi-day lockout.

**Rejected.** (a) Removing the floor, since nothing tested it. (b) Writing the test and repeating the gate's figure.

**Reason.** (a) is wrong for the reason E-381 makes the case reachable in the first place: choosing the process clock over `now()` is what allows one corrected clock, or one container started from a wrong time, to write an `updated_at` that the next check measures a negative interval from. A deviation nothing tests is a deviation the next reader deletes. (b) was the plan until the figure was re-measured against the shipped statement, and it does not hold: with a rewind of 10⁶ seconds the refill term is indeed −10,000 tokens, but E-380's token floor clamps the sum at zero, so the level lands at **−1**, `retryAfterSeconds` comes back as **200**, and the recovery is 200 seconds rather than days. The two floors overlap, and the gate's number appears to have been taken with only one of them in place. What the elapsed floor actually buys is narrower and still worth the function call: without it the caller loses the **entire remaining bucket in one step** — 19 of 20 tokens, measured — and is refused until the 200 seconds pass, and a clock that is wrong repeatedly pins the bucket at −1 indefinitely. Three tests now cover it, and removing the floor fails two of them: `expected false to be true`, and `expected +0 to be 19`.

**Price.** Two floors that overlap, so neither one's failure is fully visible in the other's presence, and the entry that introduced them did not notice they overlapped — E-380 argues them as two independent guards against two independent faults, and they are not independent. That is why the magnitude was overstated by a gate reading the arithmetic rather than running it, and it would have been overstated here too had the figure been copied instead of taken. The rule about re-taking a counted figure is usually about a stale branch; this is the other case, where the number arrives from somebody else with a report attached and is just as easy to pass on unmeasured.

### A second nightly test went red on its own, and it is a different one
`E-396` · rate · finding, extends E-393

**Context.** E-393 recorded `test/token-review-randomness.test.ts` failing a nightly run on CI and passing on re-run, and argued it was a property of the tier rather than of that test. The nightly run after this branch's gate fixes failed too, on a different file: `test/token-review-atomicity.test.ts`, "the harness has teeth", `expected 18 to be greater than or equal to 19` — a self-test that deliberately breaks the redemption and asserts the broken version produces many winners. Run on its own three times afterwards it passed three times.

**Rejected.** Reading the second failure as noise of the same kind and leaving E-393 to speak for both.

**Reason.** One flaky test is a flaky test; two different files failing two consecutive full runs, both passing in isolation, is a property of running the tier. The first is a chi-square that can reject a sound generator by design. The second is not statistical at all — it is a race whose "teeth" assertion needs enough real interleaving to produce nineteen winners, and under a fully loaded run it got eighteen. So the tier holds at least two tests whose thresholds are calibrated against an unloaded machine, and both are in `token`, and neither is reachable from anything this branch changed.

**Price.** Nothing is fixed here, for the same reason as E-393: `token` owns both files. What this entry adds is the evidence that the remedy E-393 proposed — seed the generator — would have fixed one of the two and left the other, so whoever picks this up should expect to calibrate a race threshold as well as a statistical one. Two consecutive red nightlies from a branch that did not touch either file is also the concrete form of E-393's price: T-RATE-6 rides in that tier, and the habit of dismissing a red nightly is being trained right now.

### The global counter is a threshold in one module and a bucket in the other
`E-356` · auth-core · rate limiting, after the merge

**Context.** 3.15 A.6 states the global per-route counter as `alertThresholdPerMinute` with an `onAlert`, and this feature published that type. `core/limit` takes a `BucketRule` and reports `addressChecksObserved` (E-380 froze that deviation), so the two vocabularies had to meet at the assembly.
**Rejected.** (a) Changing `RateLimitConfig.globalPerRoute` to the bucket form. (b) Passing the alert through untranslated.
**Reason.** (a) would deviate the published option table from 3.15 A.6, which this feature owns and the other does not. (b) does not type-check, and would not have been better if it did: the caller's field is named `requestsInLastMinute`. A threshold of N a minute is a bucket of capacity N refilling at N/60 a second, so the translation is exact in the direction that matters — when the alert fires, the bucket has drained, and draining that bucket means N checks.
**Price.** The number handed to the callback is not quite what its name says. `addressChecksObserved` counts the checks that drained the bucket, and refilling continues while they arrive, so the figure is the threshold to within one refill rather than a count over a sliding minute. Nobody will notice, and that is the problem with recording it only in a comment; it is here because the field name makes a promise the two modules keep to different precisions.

### One counted figure moved under the branch, and the rule caught it
`E-357` · auth-core · counting, after the merge

**Context.** E-353 replaced the prose "the one row-removing statement in the library without an owner predicate" with a counted assertion: seven markers across five files. `rate` merged an hour later with a marker of its own in `token-bucket-store.ts`.
**Rejected.** Nothing — the assertion did exactly what it was for.
**Reason.** The count is now eight across six, and the change arrived as a red test rather than as a sentence nobody re-read. That is the whole argument for turning a figure into an assertion, and this is the first evidence in this branch that it works: the prose form had been wrong for however long it took anyone to notice, and the assertion form was wrong for one merge.
**Price.** Every feature that adds a lawful exemption now edits a number in a test file it does not own, which is a small merge conflict on a shared file — the cost E-342 accepted for naming rather than counting, paid here in the other direction. The alternative is a sentence that drifts, and this entry exists because the branch has now seen both.

### The connection budget is shared, and the file that pays is whichever runs last
`E-358` · auth-core · concurrency, measured

**Context.** The completion race wants simultaneity, and the S-RACE family fixes fifty. This branch added the seventh file to the concurrency project; `token-race.test.ts` legitimately holds fifty of this server's hundred connections for the whole of its file.
**Rejected.** (a) Fifty, matching the requirement family. (b) Twenty-four, which was the first attempt and looked safe at under a quarter of the budget.
**Reason.** Both were measured and both turned the nightly run red — and not in this file. `token-race` failed with `sorry, too many clients already`, while `main` without this branch was green, and `token-race` alone was green. The budget is cumulative across files even though the project runs them one at a time, because a closed socket is not a reaped backend, and the file that pays is whichever runs last rather than whichever was greedy. Eight connections, opened inside the one test that needs them and closed before it returns, prove the same statement — exactly one completion gets through — and is what `token-review-reissue-concurrency` already uses.
**Price.** A concurrency threshold below the number its requirement family names, which a reader will take for carelessness unless they read this. And the real cost is not this file: three concurrency files now want roughly half the budget each, the project has no mechanism for bounding the total, and the next one added will turn some fourth file red at a distance. E-156 named this hazard for the peak within a run; this is the same hazard across runs, and it belongs to whoever owns `vitest.config.ts` — a shared, unowned file — not to the branch that happened to trip it.

### Two citations moved because an entry was inserted in front of them
`E-359` · auth-core · citation, correction

**Context.** Two in-code comments cited E-349 and E-350; their subjects are verbatim E-350 and E-351. Both were written while the correction block was being drafted, each naming the number the entry was going to have, and each then had a new entry inserted ahead of it before the block was appended.
**Rejected.** Renumbering the block so the citations come true.
**Reason.** That is the failure §6 removes by never renumbering, and it would have been the second instance of it on this branch. The citations move instead. Both were found by reading, not by a check: neither dangles, so `test/decision-log.test.ts` passes, and §6 says exactly this case out loud — *"a citation left behind does not dangle, it resolves to the wrong decision. Nothing detects that."*
**Price.** The reserved-range mechanism is aimed at renumbering, and this arrived by **insertion**, which it does not cover: a range removes the pressure to move existing numbers and does nothing about a comment that names a number before the entry exists. Two of the six citations this branch added were wrong, which is a rate, not an accident. The habit that produces it is writing the citation while drafting; the habit that would prevent it is citing only numbers already written down, and nothing enforces either. Both branches queued behind this one import the pending barrel and will read these comments, which is why this is a correction rather than a note.

### The second factor is a service, and the two routes that carry it are not written here
`E-405` · factor-totp · scope, hand-off

**Context.** The brief said to build the `enroll` and management routes first and to pick up `verify` when `auth-core` publishes its barrel. Reading `src/` first showed that no feature has ever called `defineRoute`: `session` and `token` of wave 2 both stop at a service, and `src/core/auth/` is still a `.gitkeep`. So the instruction to build routes described something the repository has no precedent for.
**Rejected.** (a) Writing the four session-caller routes anyway, since `RequestContext.session` carries a `userId` and they would compile. (b) Writing the two pending-caller routes with an invented way of getting the account out of the pending state.
**Reason.** (b) is impossible without inventing: `PendingAuthentication` in `core/http/caller.ts` is the public shape of `GET /pending` and deliberately holds no account. (a) is possible and was still dropped, because the route table, its filtering by identity mode and the API snapshot are `auth-core`'s, and a route declared here would be the first one in the repository — it would set the convention rather than follow it. What is built instead is the shape wave 2 built: `createTotpService` and `createRecoveryCodeService`, each taking an `Actor` where the caller is a session and a resolved pending state where it is not.
**Price.** Six of the seven routes in the table row for this feature exist as service methods and as nothing an HTTP client can reach, so `T-COOKIE-3`, `T-FIX-4` and the status codes in the route table cannot be exercised end to end on this branch. The three status codes that could be checked were checked by mapping the thrown value through `toVisibleFailure`, which is the same function the handler will use — that is a weaker test than a request, and it is the strongest one available here.

### The primary-key conflict is caught in SQL rather than raised as an error the driver has to name
`E-406` · factor-totp · S-REPLAY-4, storage

**Context.** S-REPLAY-4 says the check *is* an `INSERT` into `velve.totp_used_step` whose failure on the primary key is the refusal. Written literally, that means letting PostgreSQL raise SQLSTATE 23505 and catching it.
**Rejected.** Letting the insert raise and reading the driver's error for `23505`.
**Reason.** `Driver` in `core/db/driver.ts` is three lines and promises nothing about what `query` throws. `pg`, `postgres.js` and the neon driver each surface the SQLSTATE differently, and the library ships an adapter for all three; a refusal that depends on reading one of them is a refusal that changes with the driver. `ON CONFLICT (user_id, time_step) DO NOTHING RETURNING time_step` leaves the primary key as the sole arbiter — the fifty writers still serialise on the key, and the loser gets no row instead of an exception. The empty result is the refusal.
**Price.** The statement no longer reads the way the requirement is worded, and a reviewer checking the letter of S-REPLAY-4 will find `DO NOTHING` where the requirement says the insert fails. It does fail; it just fails quietly. Written here because the next reader will have the same objection.

### T-REPLAY-4's prose and its threshold do not describe the same five submissions
`E-407` · factor-totp · test plan, deviation

**Context.** T-REPLAY-4 gives the sequence as: fix the clock, compute a code, submit twice; advance thirty seconds, submit a new code; submit the previous step's code; submit the step-before-that's code. The threshold is `200, 401, 200, 200, 401`. The fourth submission cannot be both "the previous step's code" and a 200: that step was spent by the first submission, so the guard refuses it. The two halves of the cell contradict each other.
**Rejected.** (a) Implementing the prose and asserting `200, 401, 200, 401, 401`. (b) Asking for the plan to be corrected before writing the test.
**Reason.** The threshold is what the requirement is about. S-REPLAY-4's second clause — "eingetragen wird der tatsächlich passende Zeitschritt, nicht der aktuelle" — needs a submission that matches a step the clock is **not** in, and the only such step that is still unspent at that point in the sequence is the one **after** the current one, which the tolerance of ±1 accepts. That reading produces `200, 401, 200, 200, 401` exactly and exercises the clause the prose never mentions. (b) would have cost a round trip to change a cell whose numbers are already right.
**Price.** A test whose fourth step is not the step the plan names, defended by an argument rather than by the plan. The case the prose describes is asserted as well, in its own `it`, and it answers 401 — so if the plan meant what it says, this branch has recorded both the answer it gives and the disagreement.

### The five-attempt counter is a port here and an implementation nowhere
`E-408` · factor-totp · L-8, hand-off

**Context.** L-8 caps a pending state at five attempts and then deletes the row. The brief assigned the requirement and the test to this feature and the counter itself to `auth-core`, which had published nothing. Both cannot be satisfied by writing the counter.
**Rejected.** (a) Writing a second `pending_authentication` repository under `src/core/factor/totp/`. (b) Leaving L-8 entirely to `auth-core` and testing nothing.
**Reason.** (a) is the duplicate the brief forbids by name, and two writers of the same table is how a state machine ends up with two answers. (b) leaves a limit nobody checks. What is here instead is `PendingFactorAttempt` — `userId`, `spendAttempt()` returning the new count or null, `discard()` — and `spendPendingAttemptOn`, which holds the whole policy: spend first, run the verification, and on failure at the fifth spend delete the state and answer `too_many_factor_attempts` instead of `invalid_factor_code`. `auth-core` supplies the implementation; the test supplies one over the real table so the policy is exercised against PostgreSQL and `auth-core` has the statement to copy.
**Price.** The `UPDATE … RETURNING` that raises the counter lives in `test/totp-fixtures.ts` and in no shipped file, so a reader looking for L-8 in `src/` finds a policy over an interface and no SQL. If `auth-core` implements the port differently — a row lock, a read-then-write, a counter held in the cookie — nothing here notices. That is the same class of hand-off as E-243, and it is recorded so it is a decision rather than a gap.

### Where the 429 sits: the fifth wrong code answers it, the sixth request finds nothing
`E-409` · factor-totp · L-8, reading

**Context.** L-8 says at most five attempts and then the row is deleted. The route table lists `429 too_many_factor_attempts` on `/factor/totp/verify` and `/factor/recovery/verify`. Read strictly, deleting the row *after* the fifth attempt makes the sixth request answer `invalid_pending_authentication`, and the 429 is unreachable.
**Rejected.** Deleting the row after the fifth attempt and letting the sixth request answer `invalid_pending_authentication`.
**Reason.** A status code in the route table that no input can produce is a documented lie. Attempts one to four answer `invalid_factor_code`; the fifth wrong code deletes the state and answers `too_many_factor_attempts`. Five attempts are allowed, the row is gone afterwards, and the 429 is the attempt that spends the budget.
**Price.** A caller that submits the correct code on its fifth attempt succeeds, and a caller that submits a wrong one gets a different code than on the four before it — so the 429 tells an attacker that the budget is spent. That is information the specification asks to be given.

### Completing the second factor cannot call `reissue`, and this branch does not fix it
`E-410` · factor-totp · S-FIX-1, hand-off

**Context.** The brief cites E-243: second-factor completion calls `reissue`, not `reissueAfterCredentialChange`. `SessionService.reissue` takes a `previousToken` and goes through `replaceSession`, which deletes a row from `velve.session` by token hash and throws `PreviousSessionMissingError` when there is none. S-FIX-4 says the state before the second factor is **not** a session row. So there is no previous session to replace, and the call E-243 prescribes throws `session_not_found` on the first user who ever completes a second factor.
**Rejected.** (a) Calling `issue` here and treating E-243 as superseded. (b) Adding a variant to `SessionService` that replaces a pending row with a session row.
**Reason.** Neither is this feature's to make: (b) is a change to `core/session/`, which belongs to no wave-3 feature, and (a) would decide the S-FIX-1 question for the second factor from the wrong side of the seam. S-FIX-1 demands the new session row and the deletion of the previous artefact in **one** transaction, and the previous artefact here is the `pending_authentication` row — so the operation `auth-core` needs is "delete this pending row and insert this session in one transaction", which exists nowhere. The verification returns void; whoever issues the session owns that transaction.
**Price.** S-FIX-1 is unfulfilled for two of its eight trust-level events until `auth-core` writes that transaction, and `T-FIX-1` will fail on those two rows when someone writes it. E-243 stands in the log saying the second factor is "the most frequent caller of `reissue`", which is a claim about a method that cannot serve it; this entry does not correct E-243, because correcting it would mean rewriting an argument its author actually made.

### `fileParallelism` inside a project block is accepted and does nothing
`E-411` · factor-totp · gate defect, out of area

**Context.** E-156 put `fileParallelism: false` in the `concurrency` project so its files would run one at a time and no two would hold fifty PostgreSQL connections at once. Adding a second fifty-connection file to that project made every one of them fail with `sorry, too many clients already`, including `test/token-race.test.ts`, which has been green since wave 2. Vitest reads `fileParallelism` only at the root of the configuration; inside a project it is accepted and ignored. Measured: `--project concurrency` fails three files, `--project concurrency --no-file-parallelism` passes all seven. Project-level `maxWorkers: 1` and a single-fork pool were tried and change nothing.
**Rejected.** (a) Reporting it and leaving `pnpm test` red. (b) Yielding from inside the two new files — an advisory lock, a retry on `too many clients`, a wait for headroom in `pg_stat_activity`.
**Reason.** (b) was worked through and does not close: with three files wanting fifty connections out of a hundred, any scheme where the new files yield lets the pre-existing file lose the race instead, and a scheme where nobody yields deadlocks. There is no fix inside the files this feature owns. (a) leaves the definition of done unmet by a branch that caused the breakage. `vitest.config.ts` belongs to gate and infrastructure and not to this feature; the change made is one line moved to the root, with the constant named for what it does and the old comment left standing.
**Price.** A file edited outside this feature's ownership set, which §5 says to report rather than edit — this reports it *and* edits it, and the reviewer should treat the edit as gate-and-infrastructure's to keep or replace. It also costs the unit project its file parallelism: the blocking tier goes from roughly fifteen seconds to forty-two on this machine, because the root setting serialises all 117 files and not only the seven that need it. A narrower fix — a second `vitest` invocation for the concurrency project — is a change to `package.json`, which is further outside the set, so the wider and cheaper-to-review one was taken. E-156's own comment says the files run "one file at a time"; it has said that since wave 2 and it was not true when it was written.

### The settable clock stays in the test file, and `clock` stops being optional
`E-412` · factor-totp · testing seam, hand-off

**Context.** Architecture 6.19 requires a settable `Clock` in `@velve/auth/testing`. `src/testing/index.ts` is `export {};`. Both wave-3 factor features need one.
**Rejected.** (a) Writing the settable clock into `src/testing/index.ts`. (b) Giving `TotpServiceOptions.clock` a default of `{ now: () => new Date() }` so tests could omit it.
**Reason.** (a) is a file no wave-3 feature owns and two features needing it is a decision rather than a coincidence, so it is reported instead. (b) was written first and then removed, because `test/keys-static-scan.test.ts` forbids `new Date(` anywhere in `src/core/` — a rule this branch did not know about and would not have found by reading, since the scan lives in another feature's test file. The rule is right: 6.19 says the core reads the time only through the configured clock, and a default is a second source. `clock` is now required.
**Price.** Every construction of `createTotpService` has to supply a clock, including the ones `auth-core` will write, and the settable clock lives in `test/totp-fixtures.ts` where `factor-webauthn` cannot import it without reaching into this feature's test fixtures. The duplication is the price of not writing a fifth party's file.

### A recovery code is Crockford's base32, and the reader normalises before it hashes
`E-413` · factor-totp · S-RAND-3, encoding

**Context.** S-RAND-3 fixes 160 bit, ten codes, pairwise distinct, shown in groups. It fixes no alphabet. Whatever is chosen is what a locked-out user retypes from paper, possibly over the phone.
**Rejected.** (a) base64url, as the session token uses. (b) Hex. (c) RFC 4648 base32, as the TOTP secret uses.
**Reason.** (a) is case-sensitive and contains both `l` and `I`; a code read aloud is unrecoverable. (b) doubles the length to forty characters. (c) contains `I`, `L`, `O` and `U`. Crockford's alphabet drops exactly those four, 160 bit lands on thirty-two characters with no padding, and the reader maps `I` and `L` to `1` and `O` to `0`, upper-cases, and strips anything that is not a digit or a letter — so the stored HMAC is taken over one canonical form no matter how the code was retyped or grouped.
**Price.** Two encodings in one feature: the TOTP secret is RFC 4648 base32 because that is what authenticator apps read, and the recovery code is Crockford's because a human reads it. A reader who sees `base32` twice will assume one function serves both.

### The pepper version is read before the delete, and the delete still decides alone
`E-414` · factor-totp · L-3, S-RACE-2

**Context.** L-3 puts `key_version` on `velve.recovery_code` so a rotation of `token-pepper` does not void the codes. The consequence is that the HMAC of a submitted code cannot be computed without knowing which version the row was written under, and the row cannot be found without the HMAC. `KeyProvider` offers `current` and `byVersion` and no way to enumerate the ring.
**Rejected.** (a) Computing the HMAC under every version of the ring — there is no way to ask for them. (b) Encoding the version in the code the user holds.
**Reason.** (b) spends characters of a code someone retypes on a number that is not a secret and tells an attacker when the pepper was rotated. What is done instead is a `SELECT DISTINCT key_version FROM recovery_code WHERE user_id = $1`, one HMAC per version found, and then the `DELETE … RETURNING`. S-RACE-2 forbids a read of the row before its consumption; this reads only which key versions exist for the account and nothing that decides validity, and the whole validity predicate still sits in the `WHERE` of the statement that removes the row. The two live in different repository methods, which is also what keeps them out of T-RACE-2's static rule.
**Price.** A read on the path S-RACE-2 is about, defended by what it does not read. The statement that removes the row is unaffected and the fifty-way race still resolves one-to-one, which is measured; the argument is nonetheless that a rule was satisfied in spirit, and a reviewer is entitled to disagree.

### One statement per candidate version, because a `bytea[]` parameter is spelled differently by every driver
`E-415` · factor-totp · driver portability

**Context.** With several candidate HMACs to try, the obvious statement is `DELETE … WHERE user_id = $1 AND code_hmac = ANY($2::bytea[])`, one round trip whatever the ring holds.
**Rejected.** The array parameter, which was written first and then removed.
**Reason.** `Driver.query` takes `unknown[]`. `pg` turns a `Buffer[]` into a `bytea[]`; the test connection in `test/db-postgres-connection.ts` throws on any array, and building the literal by hand means writing `{"\\x…"}` with the escaping each driver expects. That is a portability bug hiding in a parameter. One `bytea` per statement is spelled the same everywhere, and in practice the ring holds one version, so it is one statement.
**Price.** A rotation that leaves two versions live costs two round trips on a wrong code, and the number of statements is now visible to anyone timing the endpoint — it says how many pepper versions the account's codes span, which is a fact about the operator and not about the account.

### An identifier forty-three characters long is a token
`E-416` · factor-totp · gate finding

**Context.** `test/token-review-leakage.test.ts` fails on any forty-three-character run of base64url characters anywhere under `src/`, because that is exactly a 32-byte token. `MAXIMUM_ATTEMPTS_PER_PENDING_AUTHENTICATION` is forty-three characters.
**Rejected.** Widening the scan's pattern.
**Reason.** The scan is another feature's and it is right: a committed token is unrecoverable once it ships, and the cost of the rule is that long identifiers are occasionally illegal. The constant is now `MAXIMUM_FACTOR_ATTEMPTS_PER_PENDING_STATE`, forty-one characters, and it reads better.
**Price.** Nothing, this time. It is written down because the failure message says "no plaintext token is committed" and points at a constant, and the next person to hit it will spend the same ten minutes looking for a secret that is not there.

### Removing the factor takes its replay ledger with it
`E-417` · factor-totp · S-REPLAY-4, consequence

**Context.** `totp_used_step` is keyed by `(user_id, time_step)` and not by the credential. Nothing in the schema removes those rows when the credential goes, and nothing in the architecture says to.
**Rejected.** Leaving them to `auth.maintenance.sweep()`, which L-11 has deleting expired rows anyway.
**Reason.** The sweep is a named operation nobody is obliged to run, and the retention is minutes, so in practice the rows would be gone. In the minutes they survive, a user who removes the factor and immediately enrols a new one is refused the first code of the new secret if it lands on a step the old one spent — a failure at exactly the moment someone is proving the new factor works, with no message that explains it. `removeCredential` deletes both in one transaction.
**Price.** A second statement in the removal path and a rule that has to hold for any future writer of `totp_used_step`: the ledger belongs to the credential even though the key does not say so.

### The verification path cannot say the factor is missing
`E-418` · factor-totp · error surface

**Context.** `factor_not_enrolled` is a declared error of `enroll.finish` and `remove`, both of which are reached with a session. `/factor/totp/verify` is reached with a pending state and its declared errors are `invalid_pending_authentication`, `invalid_factor_code` and `too_many_factor_attempts` — `factor_not_enrolled` is not among them. The first draft raised it from a shared helper used by all three.
**Rejected.** Adding `factor_not_enrolled` to the verify route's error list.
**Reason.** The pending state proves a password, and the account it names is one an attacker may have chosen. Answering "this account has no TOTP" there is an oracle over which accounts carry a second factor. On the verify path a missing credential, an unconfirmed one and a wrong code all raise a `ConcealedError` that `error-map.ts` turns into `invalid_factor_code`; the three differ only in the logged reason, which is S-ENUM-6's shape.
**Price.** A user whose factor was removed in another session while a pending state was open is told the code is wrong. That is the correct answer to give and the wrong one to read.

### Confirming an enrolment spends the step it was confirmed with
`E-419` · factor-totp · S-REPLAY-4, scope

**Context.** `enroll.finish` verifies a code to prove the authenticator holds the secret. Whether that code should also be written into `totp_used_step` is not stated anywhere: the guard is described in 3.6 under verification, not under enrolment.
**Rejected.** Verifying the enrolment code without claiming its step.
**Reason.** RFC 6238 §5.2 asks that an accepted code be refused for the rest of its step, and it does not distinguish why it was accepted. Without the claim, the code the user types to finish enrolment stays valid as a second factor for up to sixty seconds — over a phishing proxy that is one code that works twice.
**Price.** A test that enrols and immediately verifies at the same instant is refused, which cost this branch three failing tests before the reason was remembered, and will cost the next writer the same. It also means `totp_used_step` holds one row per account from the moment of enrolment, which the race test had to work around by writing the confirmed credential directly rather than through `enroll.finish`.

### The two race tests run in the blocking tier, though the plan schedules them nightly
`E-420` · factor-totp · test tiering

**Context.** T-RACE-3 and T-RACE-4 are both marked "CI nächtlich" in section 6. `pnpm test` is the blocking tier and `pnpm test:nightly` adds the statistical cases.
**Rejected.** Gating both behind `VELVE_NIGHTLY=1`.
**Reason.** `test/token-race.test.ts` runs T-RACE-1 and T-RACE-2 unconditionally, and both carry the same nightly marking; following the sibling costs less surprise than following the plan. The measured cost is under a second per file for twenty rounds of fifty, because the fifty run in parallel over fifty connections and a round is one round trip, not fifty. CLAUDE.md also asks that a skipped test state its reason in the code, and "the plan says nightly" is a poor one for a check that takes a second.
**Price.** The blocking tier now holds three files that each want fifty connections, which is what surfaced E-411. Had these two been gated behind `VELVE_NIGHTLY=1` the configuration defect would have shipped invisible until the nightly run, so the decision made for a scheduling reason paid off for an unrelated one.

### The pending seam landed and the port was deleted rather than adapted
`E-421` · factor-totp · L-8, correction to E-408

**Context.** E-408 built `PendingFactorAttempt` and `spendPendingAttemptOn` because the pending state did not exist yet. It exists now, on `feature/auth-core`, and its shape is not the port's: `resolve(token)` yields the account, `registerFailedAttempt(token)` is called **only after a failure** and answers `attempts_remain` or `exhausted`, and `consume(token)` removes the row.
**Rejected.** (a) Keeping the port and writing an adapter from the real service to it. (b) Keeping `MAXIMUM_FACTOR_ATTEMPTS_PER_PENDING_STATE` as a local constant beside `MAXIMUM_PENDING_ATTEMPTS`.
**Reason.** (a) would leave two vocabularies for one state machine, and the port's "spend before verifying" is not what the real service does — the real one charges nothing for a correct code, which is better and is not what E-408 designed. (b) is two sources of truth for a number L-8 fixes once; the constant is gone and nothing in this feature spells the five. What remains is `verifyUnderPendingAttemptLimit`, which resolves, verifies, and on failure maps `exhausted` to `too_many_factor_attempts`.
**Price.** E-408's argument for the port was sound and its design was wrong in one respect that only the real implementation revealed: charging an attempt before the verification means a correct code costs one, which is visible to anyone reading `attempts` and would have made the fifth *successful* sign-in fail. The test written against the port asserted that behaviour and passed. A test can only be as right as the interface it was written against.

### `createTestClock` replaced the clock this branch wrote for itself
`E-422` · factor-totp · testing seam, correction to E-412

**Context.** E-412 kept a settable clock inside `test/totp-fixtures.ts` because `src/testing/index.ts` was `export {};` and belonged to no wave-3 feature. It is now `createTestClock` on `feature/auth-core`.
**Rejected.** Keeping the local one and passing it where a `Clock` is wanted, which would have compiled.
**Reason.** Two settable clocks in one repository is the thing 6.19 asks for one of, and the local one had `advanceSeconds` where the shared one has `advanceBy(milliseconds)` — a difference small enough to survive a review and produce a test that advances a thousand times too far. Every test file here now imports `createTestClock`; `settableClock` is deleted, not deprecated.
**Price.** E-412 also recorded that `clock` became a required option because `test/keys-static-scan.test.ts` forbids `new Date(` in `src/core/`. That half stands and is the more useful half: the rule was found by a failing scan and not by reading, and it is the reason this feature has no default clock to fall back to.

### The API snapshot was updated for a surface this feature does not own
`E-423` · factor-totp · gate finding, out of area

**Context.** Merging `origin/feature/auth-core` to compile against the pending module turned `test/api-surface.test.ts` red: that branch exports `TestClock` and `createTestClock` from `@velve/auth/testing` and left `test/__snapshots__/api-surface.md` saying `export { };`. The check CLAUDE.md describes as "the public surface has not changed unannounced" is failing on their branch for exactly the change it exists to catch, and it fails here because the merge brought it along.
**Rejected.** (a) Leaving `pnpm test` red and reporting only. (b) Silently regenerating the snapshot as part of another commit.
**Reason.** (b) is the failure mode itself — the snapshot's whole value is that a surface change is announced by someone. (a) leaves a branch that cannot pass its own gate for a reason it did not cause. The snapshot is regenerated in a commit of its own whose message says whose surface it is, so the change is announced even though the wrong feature announced it.
**Price.** A file outside this feature's set, changed for the second time on this branch after `vitest.config.ts` — and this one is a file `auth-core` will very likely also change, so the merge conflicts. It resolves to whichever side has the correct generated content, which is cheap, but it is a conflict this wave's file partition was designed to make impossible. The finding stands whatever happens to the snapshot: `feature/auth-core` shipped an export without the snapshot line that announces it.

### A planted fault that passed, and the test that was missing under it
`E-424` · factor-totp · review method

**Context.** Twelve faults were planted to prove the checks fail on them. Eleven did. The twelfth — raising `factor_not_enrolled` from the helper the verifying path uses, where the route declares only three codes and that is not one of them — passed every test in the suite. Nothing in this feature ever verified against an account with no credential row at all: every test that reached `verify` had enrolled first.
**Rejected.** Recording the plant as inconclusive and moving on.
**Reason.** A plant that passes is a finding about the tests, not about the plant. `test/totp-concealment.test.ts` now asks the question the plant was aiming at: a missing credential, an unconfirmed one, a wrong code and an already-spent step answer with the same code, the same status and the same message, and differ only in the logged reason. Re-planted, the fault fails two of its three cases.
**Price.** The gap existed because the fixtures made enrolment the easy path and a bare account the awkward one, so no test took the awkward one. That is a general hazard of a helper that sets up the happy case, and nothing here fixes it beyond this one instance.

### A citation in a comment resolved to the wrong entry, and only reading it caught that
`E-425` · factor-totp · decision log

**Context.** The comment added to `vitest.config.ts` cited `E-410` for the `fileParallelism` finding. That finding is `E-411`; `E-410` is the entry about the second factor not being able to call `reissue`. The two were written minutes apart and the numbers were assigned by counting. `test/decision-log.test.ts` was green throughout, because `E-410` exists.
**Rejected.** Nothing — there was no alternative to fix, only a mistake to record.
**Reason.** §6 says in as many words that the check catches a citation resolving to *no* entry and cannot catch one resolving to the *wrong* entry, and names reserved ranges as the mechanism that removes the renumber. Reserved ranges remove the renumber; they do not remove a writer miscounting inside their own range. This one was found by reading the diff before pushing, which is not a mechanism.
**Price.** Every `E-` citation this branch writes is worth what a reader's attention is worth. Five were checked by hand after this one was found; all five were right, and that is a sample of six, not a proof.

### The barrels were unused until the tests were made to consume them
`E-426` · factor-totp · knip

**Context.** `src/core/factor/totp/index.ts` and `src/core/factor/recovery/index.ts` were written as the import point the instance will use, and the tests imported the concrete modules directly. `knip` reported both barrels as unused files and eleven exports as unused, because nothing at all imported them.
**Rejected.** (a) Deleting the barrels until a caller in `src/` exists. (b) Adding the barrels to `knip.json` as entry points.
**Reason.** (a) is E-245's argument in reverse and loses: the barrel is the module's interface upwards, and upwards there is nothing yet. (b) edits a file this feature was told to leave alone, and would suppress a real finding rather than answer it. The tests now import from the barrels, which is what the pending module already does and what makes the barrel a thing that is exercised rather than declared. Two re-exports with no caller anywhere were dropped instead — `pepperRecoveryCodeUnder` and `totpEnrollment` are used inside their own modules and by nothing else.
**Price.** The tests now depend on the barrel's contents, so removing a name from a barrel breaks test files that have nothing to do with it. That is the cost of using `knip`'s definition of "used", and it is cheaper than a barrel nobody imports.

### The test that named S-KEY-4 asserted a different branch, and that is why the defect above was invisible
`E-427` · factor-totp · S-KEY-4, correction to the test

**Context.** `test/totp-enrolment.test.ts` carried an `it` called *"refuses to decrypt a secret whose key version has left the ring (S-KEY-4)"*. It built its second provider with `testKeyProvider(2)`, which is `testKeyRing(2).providerAt(2)` with `availableVersions` left undefined — so the ring still held versions 1 **and** 2, and version 1 had not left it. What it actually asserted was `authentication_failed`: an AES-GCM tag mismatch against fresh root material, which is a different branch of `decryptWithPurposeKey` from the `key_version_unknown` one S-KEY-4 is about. Green, named after a requirement, and never touching it.
**Rejected.** Adding the missing `[2]` and leaving the test otherwise as it was.
**Reason.** That alone fixes the label and would have turned the test red, which is the point — but it would have left the two branches conflated in one assertion. There are now two: one drives a secret written under version 1 through a ring holding only version 2 and asserts `key_version_unknown`; the other drives it through a ring holding version 1 under other material and asserts `authentication_failed`. Both go at the envelope directly, so the branch under test is named rather than inferred.
**Price.** The recovery side got this right on the first try — `providerAt(2, [2])`, asserted in `test/recovery-codes.test.ts` — and the TOTP side, written by the same hand on the same day, did not. The difference is that the recovery test was written to answer "what happens after a rotation" and the TOTP one to answer "does S-KEY-4 have a test". The second question is answerable without reaching the thing it names, and that is the whole hazard §5 describes.

### A secret the server cannot read answers as a factor nobody can hold
`E-428` · factor-totp · S-KEY-4, error surface, and a fourth hand-off

**Context.** `decryptSecret` let `KeyError` out. `KeyError` is neither `VelveError` nor `ConcealedError`, so `toVisibleFailure` mapped it to `internal_error`, 500, `unhandled_exception`. Measured on the verify path: `code=internal_error status=500 logged=unhandled_exception`, against 401 for every other failure there. §3.15 D.3 declares 200, 401 and 429 for that route. So an account whose TOTP secret predates a key rotation was distinguishable from every other account by status code, and S-KEY-4's carefully named error was raised at the throw site and thrown away at the boundary.
**Rejected.** (a) Leaving it and naming only the assembly-time check that would prevent it. (b) Adding a `totp_secret_unreadable` reason to `ConcealedReason`.
**Reason.** (a) leaves a live oracle in the request path against a hazard that only a future feature removes. (b) is the honest reason to log and it means editing `src/core/http/error-map.ts`, which decides what the outside learns and belongs to no wave-3 feature — so it is reported instead of taken. Of the three reasons that already exist on this path, `totp_not_confirmed` is the one whose class actually contains this case: a secret the server cannot read is a credential that cannot serve as a factor, exactly like one that was never confirmed. The `KeyError` is caught at the single place the secret is decrypted, so all three paths that decrypt answer alike.
**Price.** Two, and both are real. The operator now sees `totp_not_confirmed` where the true cause is a dropped key version, which is a worse diagnostic than the 500 it replaces — the 500 at least carried the `KeyError` message as the failure's `diagnostic` field. That is the cost of not owning `error-map.ts`, and it is why the second half of this matters: **`auth-core` should hold every distinct `totp_credential.key_version` against the ring at assembly time and refuse to start on one that has left it**, so the operator is told once, at the moment they drop the version, rather than never. That is E-179's shape, it is the fourth hand-off this feature owes and the first one it did not name in advance, and until it exists the only signal a dropped version produces is users who cannot sign in.

### E-410 says the verification returns void, and it returns the resolution
`E-429` · factor-totp · correction to E-410

**Context.** E-410's closing sentence reads "The verification returns void; whoever issues the session owns that transaction." The first half was true when it was written and stopped being true two commits later, when `verify` began returning the `PendingResolution` so the caller does not resolve the pending state twice. The comments in `service.ts` that cite E-410 say it correctly; only the entry does not.
**Rejected.** Editing the sentence in E-410.
**Reason.** §6: new information about an old decision belongs in a new entry that cites the old one, never in the old entry's text. The argument E-410 makes is unaffected — the point was that this feature issues no session and consumes no pending row, and that is still what it does.
**Price.** A reader of E-410 alone gets the return type wrong. That is the cost of the rule, and it is cheaper than a log whose entries are quietly kept current.

### This branch made a knip exemption stale and did not say so
`E-430` · factor-totp · knip, report

**Context.** `knip.json` lists `otpauth` in `ignoreDependencies`. This is the first feature to import it, so the exemption is now stale: on `main` knip emits one configuration hint, on this branch two. `knip` still exits 0, and the file is correctly outside this feature's set. E-426 discusses knip at length and does not mention it.
**Rejected.** Removing the entry from `knip.json`, which the brief for this feature forbids by name.
**Reason.** §5 says a feature that needs a change outside its area stops **and reports it**. The stopping happened; the reporting did not, and an unreported finding that produces a hint instead of a failure is exactly the kind that stays unreported for a wave. `@simplewebauthn/server` is in the same line and will go stale the same way when `factor-webauthn` lands; both belong to one central cleanup.
**Price.** Nothing operational — a hint is a hint. The entry exists because the omission was found by a reviewer reading the diff and not by this writer noticing a number change from one to two.

### T-REST-3's third leg was not asserted
`E-431` · factor-totp · test plan coverage

**Context.** T-REST-3's threshold is "3/3: success, refusal, success". The suite asserted the first two — a code is accepted, the same code is then refused — and never redeemed a second, different code afterwards. The behaviour was correct; the assertion was absent.
**Rejected.** Treating the existing "spends the code that was used and leaves the other nine" as the third leg.
**Reason.** That test counts rows, and a count is not a redemption: a set could hold nine rows none of which can be spent, and it would pass. The third leg is now its own case — accepted, `invalid_recovery_code`, accepted, with eight left. A planted fault that makes a partly-spent set unreadable turns it red at exactly that assertion.
**Price.** The gap came from writing the tests around the storage rule rather than around the threshold's three words, and nothing but reading the threshold catches that.
### The challenge is the token
`E-450` · factor-webauthn · challenge, frozen

**Context.** Architecture 3.15 C gives a ceremony two values: `publicKeyOptions.challenge`, which the authenticator signs, and `challengeToken`, which the client returns so the server can find the row. Nothing says whether they are two values or one.
**Rejected.** Two independent values — 32 random bytes for the challenge, a separate secret token for the row pointer.
**Reason.** Two values means two places to get the binding right, and the failure mode of getting it wrong is silent: a server that looks up row A and hands `expectedChallenge` from row B still verifies a signature, just not the one it issued. One 32-byte value from `core/token` is base64url-encoded once; that string is the WebAuthn challenge, the row pointer, and the `expectedChallenge` handed to the verifier. `sha256` of it is the primary key. The verifier compares the challenge inside the signed client data against the same string the row was found by, so the binding is not a rule anybody has to maintain — it is the same variable.
**Price.** The challenge and the lookup key are now the same secret, so a log line that prints `challengeToken` for debugging prints the value an attacker needs. Nothing prints it, and 3.15 C.2 already forbids `challenge_sha256` leaving the process, but the value with the wider blast radius is the one in the response body rather than the one in the column.

### Three rejections, one statement, one logged reason
`E-451` · factor-webauthn · S-REPLAY-5

**Context.** `error-map.ts` declares three concealed reasons for a challenge — `challenge_not_found`, `challenge_expired`, `challenge_purpose_mismatch` — and S-ENUM-6 wants the true reason logged. S-REPLAY-5 wants one visible answer for all three.
**Rejected.** Deleting by primary key alone and inspecting the returned `purpose` and `expires_at` to log which of the three it was.
**Reason.** The rejected form reads the row and then decides in TypeScript, which is the shape 5.10 names as the one that gets lost in a refactor; the accepted form puts purpose, subject and deadline in the `WHERE` of a single `DELETE … RETURNING`, so the requirement is in the statement and an empty result set is the whole answer. It also matches `one_time_token`'s consume statement word for word in structure, which is worth more than a finer log line.
**Price.** Two of the three declared reasons are unreachable from this feature, and `challenge_not_found` is logged where the cause was an expiry or a wrong ceremony. That is a real loss for an operator reading logs, and it is reported rather than fixed here, because the fix is in a file this feature does not own.

### A native application's origin is not a URL
`E-452` · factor-webauthn · configuration

**Context.** `webauthn.origins` is an array because a relying party legitimately has a web origin and a native one (3.15 A.8). The obvious validation is `new URL(origin)`.
**Rejected.** (a) Requiring every entry to parse as a URL. (b) Validating nothing beyond non-emptiness.
**Reason.** (a) rejects `android:apk-key-hash:…`, which is the reason the field is an array at all. (b) lets `https://example.com/` through, and a trailing slash never equals the origin a browser sends — every ceremony then fails, at the one moment nobody is reading the configuration. So only the `http`/`https` spellings are held to a shape, and they must equal their own origin.
**Price.** A misspelled native origin is accepted and fails at the first ceremony. There is no list of legal schemes for a native origin to check against, and inventing one would be this library deciding what platforms exist.

### `transports` is a hint, and a hint may not lock a device out
`E-453` · factor-webauthn · E-503 answered

**Context.** E-503 handed this feature the per-field call and named the hazard: `oneOf(...)` pins `transports` to the seven values `AuthenticatorTransportFuture` has today, and a new transport ships in a browser before it ships in `@simplewebauthn/server`. Registration would then fail for that authenticator over a field nothing in the ceremony depends on.
**Rejected.** (a) `oneOf(...)` for `transports`, as for `type`. (b) Accepting any string and storing it verbatim, narrowing only where the verifier's type demands it.
**Reason.** (a) is the lockout E-503 describes, and it is the wrong trade for a value that is a UI affordance. (b) was the first decision here and is written down because it was reversed: storing a transport the verifier cannot type means the column holds a value that can never be put back into `allowCredentials`, so the two representations diverge for a gain that is display fidelity alone. The parser therefore accepts any string, filters to what the verifier can type, and stores what it forwards. What matters — that no registration is refused over the field — holds in both, and one representation is cheaper than two.
**Price.** A transport a browser ships before `@simplewebauthn/server` does is dropped and never recorded, so when the verifier catches up the credentials registered in between still do not have it. `type` keeps its `oneOf`, because that field decides something.

### A field the specification adds fails the build, not the request
`E-454` · factor-webauthn · payload

**Context.** The payload validators are hand-written against `RegistrationResponseJSON` and `AuthenticationResponseJSON`. A field added to either by a future `@simplewebauthn/server` would simply not be declared, and the parser would drop it in silence.
**Rejected.** Trusting the assignment of the parsed value to the library's type to catch it.
**Reason.** It does not: an added *optional* field leaves the parsed value still assignable, so the type check stays green while the parser quietly stops carrying a field the verifier may have begun to read. Each shape is therefore declared `satisfies Record<keyof Shape, unknown>`, which fails to compile when a key is missing and when one is spare.
**Price.** A dependency upgrade that adds a field breaks the build rather than the tests, which is a worse message to read and a better moment to read it.

### The browser's payload is parsed openly, the caller's input strictly
`E-455` · factor-webauthn · payload

**Context.** `object()` rejects any undeclared key. That is right for the route's own input, which the caller writes. The credential JSON inside it is written by `navigator.credentials.create()` against a living specification.
**Rejected.** Loosening `object()`, or declaring the credential JSON strictly and accepting that a browser adding an informational field breaks registration until the library ships a release.
**Reason.** Loosening `object()` is a change to a file this feature does not own and weakens the contract every other route relies on. So the two shapes are parsed differently on purpose: a ten-line wrapper trims the raw value to the declared fields before handing it to `object()`, exactly as `route.ts` already does for a GET query string, and only the browser-authored shapes use it. The route's own input keeps every strictness `object()` has.
**Price.** A second object validator exists in the repository, and if `http` ever grows an open variant this one should be deleted rather than kept as the local dialect. A typo in a nested field name is now ignored instead of reported, which for a payload no human types is the right way round and is still a loss.

### A value the browser wrote inherits nothing
`E-456` · factor-webauthn · security, found by a plant

**Context.** A prototype-pollution probe was written because the brief said the class was live: `object()` and `arrayOf` had both been reading inherited properties as if sent, and this feature indexes caller-supplied data in three more places. The probe went red.
**Rejected.** Reading each optional field through `Object.hasOwn` at the point it is destructured.
**Reason.** The defect was real. `object()` builds its result on `{}`, so destructuring `transports` out of a parsed attestation resolved through `Object.prototype` when the browser had sent none — and the value that reached the stored column was the polluted one. Per-field `hasOwn` fixes the fields anyone thought of; setting the parsed object's prototype to null fixes the ones nobody has written yet, at the one boundary where browser-authored data enters.
**Price.** Two things, and the second is the uncomfortable one. `Object.setPrototypeOf` deoptimises the object it touches; at two or three objects per ceremony that is not worth measuring, and it would be at request-body scale. And the probe that found this was itself wrong: it asserted on `parsed.response.transports`, read off the ordinary literal the parser returns, which answers from the polluted prototype however well the parser behaved. So it stayed red after the fix, and the fix was nearly applied twice before the test was read properly. It now asks `Object.hasOwn` of what the parser produced. A probe that cannot distinguish the fault it hunts from an artefact of how it looks is the same defect as a probe planted where the fault cannot live, seen from the other side.

### The verifier's cause is prose, and prose is not a dependency
`E-457` · factor-webauthn · error handling

**Context.** `verifyAuthenticationResponse` throws for a wrong origin, a wrong relying party, a missing user-verification flag, a bad signature and several more — and reports which by the English text of the `Error`. `error-map.ts` declares a concealed reason for four of those.
**Rejected.** (a) Matching on the message to log the precise reason. (b) Mapping everything the verifier throws to `signature_invalid`.
**Reason.** (a) is a dependency on a string that moves without a major version. (b) logs `signature_invalid` for a misconfigured origin, which is the failure an operator is most likely to be staring at and least able to diagnose. So origin, relying-party hash and the user-verification flag are checked here, before the verifier, purely to decide the logged reason; the verifier still decides acceptance and re-checks all three. Everything else it throws is one reason.
**Price.** Three checks now exist twice, and the copies can disagree. The dangerous direction is named: if the verifier ever *loosens* one of them, this feature keeps rejecting, because its check runs first and throws. That is the safe direction to be wrong in and it is still being wrong. A first attempt inspected the caught value with `instanceof ConcealedError` to let its own reasons through; `test/http-enumeration.test.ts` refused it, correctly — what the outside learns is decided in one file — and the fix was to wrap only the verifier's own call, so nothing of this feature's is ever in flight to be inspected.

### The verifier is told there is no counter
`E-458` · factor-webauthn · L-9

**Context.** L-9 says a regressed `sign_count` is reported as `signCountRegressed`, not rejected. `verifyAuthenticationResponse` throws when the reported counter is not greater than the stored one.
**Rejected.** Catching that particular throw and continuing.
**Reason.** Catching it means recognising it, and recognising it means matching on the message (E-457). Passing `counter: 0` makes the verifier's rule vacuous, and the comparison is made here, where the outcome is a field. Nothing is lost: the verifier's counter check is exactly the comparison being moved.
**Price.** The library now depends on `counter: 0` continuing to mean "do not check", which is a behaviour of the verifier and not a documented contract. If a future version treats a zero counter as an assertion that the counter is zero, this reads as a regression on every sign-in rather than none. There is no test that would notice, because the simulator and the verifier would agree.

### Whom a credential belongs to, proved in one of two ways
`E-459` · factor-webauthn · S-OWNER-1, correction

**Context.** `list`, `rename`, `remove` and registration take an `Actor` — the brand only session resolution mints. The second factor reaches the same rows and has no session: its subject is the intermediate state.
**Rejected.** (a) Taking `userId: string` for the second factor. (b) Demanding an `Actor` and handing `auth-core` the job of minting one from the pending row.
**Reason.** (a) opens the door S-OWNER-7 exists to close — a bare string is what a request body carries. (b) was the decision this branch actually made and it was wrong, which is worth writing plainly: `auth-core` then published `PendingResolution` with a comment saying it mints no `Actor` **on purpose**, so that the intermediate state has no path into an owner-scoped repository method. The hand-off would have pushed a cast into a file this feature does not own, to defeat a rule that file states deliberately. The owner parameter is now a union of the two proofs this library recognises, discriminated by `typeof`, and a bare string satisfies neither.
**Price.** `S-OWNER-1` says every method on a table with a `user_id` column takes an `actor`; two of these take an owner that is sometimes not one. The predicate is still in the SQL and the parameter still cannot be a string from a body, but the requirement's wording no longer matches the code, and that gap is named here rather than papered over. Had `auth-core` published a day later, the wrong version would have been merged and the cast would have been someone else's problem to explain.

### There is one deletion path for a sign-in method, and this feature does not add a second
`E-460` · factor-webauthn · S-OWNER-3, L-13

**Context.** `removeSignInMethod` already existed in `src/core/identity/sign-in-methods.ts`, already counted what would be left, and already took the `velve.user` lock first.
**Rejected.** A `deleteOwnedCredential` on this feature's own repository, with the last-way-in count called beside it.
**Reason.** Two deletion paths means the count is a rule someone has to remember to call, and L-13's failure mode is a locked-out account. It also means two places taking the user row lock, which is how a lock-ordering cycle gets built by accident. The existing function is used unchanged.
**Price.** This feature's repository has no delete method at all, which reads like an omission until you find the call. And `remove` therefore holds a row lock on `velve.user` for the duration of a count over three tables — wider than it looks, as §7 says.

### Not a uuid, not yours, not there: one answer
`E-461` · factor-webauthn · S-OWNER-8

**Context.** `remove` takes a `credentialId` that goes into a `uuid` predicate. A malformed value makes PostgreSQL raise, which would surface as `internal_error` — a third answer beside the two S-OWNER-8 requires to be identical. The route table gives `/factor/webauthn/remove` the statuses 204, 401, 403 and 409, and no 400 at all.
**Rejected.** Rejecting a malformed identifier with `invalid_input`.
**Reason.** There is no 400 on that route to reject it with, and inventing one would be a fourth answer. A value that is not a uuid can name no row, which is the same fact as a row that is not the caller's, so it takes the same exit: nothing happens, 204. `rename` does declare a 400, and there both the malformed and the unknown identifier answer `invalid_input`, which is uniform for the same reason.
**Price.** `remove` with a malformed identifier does not touch the database, so it answers faster than one that does. That is a timing channel between "malformed" and "well-formed but not yours", which is not the distinction S-OWNER-8 protects — it says nothing about whether a credential exists — but it is a difference an attacker can measure and this entry is where it is admitted rather than discovered.

### The counter that is stored is the one that was reported
`E-462` · factor-webauthn · L-9

**Context.** After a regression, the stored `sign_count` can be the value the authenticator just reported or the higher value it had before.
**Rejected.** Keeping the maximum, so the counter only ever ratchets upward.
**Reason.** The ratchet reports a regression on every subsequent sign-in, because every later value stays below the high-water mark until the authenticator catches up. An application that gets `signCountRegressed: true` forever learns to ignore the field, and a field everyone ignores is worse than no field. Storing the reported value reports the fall once, at the moment it happened, which is the event L-9 asks to be told about.
**Price.** A cloned authenticator that is used once and then never again produces exactly one report, and if the application does nothing with it the clone is invisible afterwards. That is the trade L-9 already made when it chose reporting over rejection; this makes it slightly cheaper for the attacker and much cheaper for the legitimate user whose authenticator was reset.

### User verification is required at both verification points and is not an option
`E-463` · factor-webauthn · 3.6, 3.15 A.8

**Context.** `WebAuthnConfig.userVerification` is `"required" | "preferred"`. 3.15 A.8 says `"discouraged"` is absent because a second factor without user verification is not one, and that discoverable passkey sign-in is always `"required"`.
**Rejected.** Letting the configured value govern the assertion as well as the registration.
**Reason.** Better Auth sets `requireUserVerification: false` at both of its verification points, which is why a passkey there is not a second factor and bypasses enforced 2FA (1 D33, N3-32/33). The configured value therefore governs registration only — what the authenticator is asked for, and what `user_verified_at_registration` records — while both assertion paths request and enforce `"required"` unconditionally.
**Price.** An application that sets `"preferred"` can register a credential that then cannot be used, because every sign-in demands verification the authenticator was not asked to be capable of. That is a configuration that produces a dead credential, and nothing warns about it at start-up.

### The simulator encodes with Node's primitives, not with the library's
`E-464` · factor-webauthn · test infrastructure

**Context.** The simulator needs base64url and CBOR. Both exist in the tree — `src/core/keys/base64url.ts`, and `@levischuck/tiny-cbor` under `@simplewebauthn/server`.
**Rejected.** Reusing the library's encoders.
**Reason.** An instrument that shares an encoder with the thing it measures agrees with it about a shared mistake, and the agreement looks like a passing test. `Buffer.toString("base64url")` and a hand-written canonical CBOR encoder are independent of both.
**Price.** Roughly sixty lines of CBOR that exist only in the test tree and have to be right. They are canonical by RFC 8949 §4.2.1 ordering because `tiny-cbor` re-encodes what it decodes and moves its pointer by the length, so a non-canonical map would be a parse failure rather than a wrong value — which is at least a loud way to be wrong.

### A simulator that cannot sign wrongly tests the happy path
`E-465` · factor-webauthn · test infrastructure

**Context.** Architecture 6.19 requires the simulator to be able to sign incorrectly, "otherwise the rejection is never tested".
**Rejected.** One way of signing wrongly.
**Reason.** One way tests one code path in the verifier. There are four: a second key pair that was never registered, a signature with its last byte flipped, an empty signature, and a signature over the authenticator data without the client-data hash — which is the one that fails only if the message the authenticator signs is assembled correctly. Each is checked twice: against `@simplewebauthn/server` directly, with nothing of this library in between, and through the sign-in path.
**Price.** The four faults are enumerated by hand, and the enumeration is a guess at what a broken authenticator does. Nothing here produces a malformed DER signature, a valid signature over a different challenge, or a signature made with the right key and the wrong algorithm.

### Registration prefers a discoverable credential and does not demand one
`E-466` · factor-webauthn · registration

**Context.** Passkey sign-in needs a discoverable credential. `authenticatorSelection.residentKey` decides whether the authenticator is asked to make one.
**Rejected.** `"required"`.
**Reason.** A security key has a small fixed number of discoverable slots and refuses when they are full. `"required"` therefore turns a hardware key into an authenticator this library cannot register, and hardware keys are precisely the second-factor case 3.6 describes. `"preferred"` gets a discoverable credential wherever one is possible.
**Price.** A user who registers on a full security key gets a credential that works as a second factor and never appears in passkey sign-in, with nothing in the surface saying which kind they got. `WebAuthnCredential` reports the backup flags, not discoverability.

### An authenticator registered twice has no concealed reason
`E-467` · factor-webauthn · reported

**Context.** `webauthn_credential.credential_id` is globally unique. `excludeCredentials` normally stops a second registration in the browser; when it does not, the insert raises a unique violation.
**Rejected.** Letting the driver's error escape as `internal_error`.
**Reason.** The route declares `webauthn_credential_rejected`, and that is the honest answer: the credential was not accepted. The repository raises its own named error and the service maps it, in the same shape `OneTimeTokenError` uses.
**Price.** The logged reason is the visible code rather than the cause, because `ConcealedReason` in `error-map.ts` has no entry meaning "this authenticator is already registered" and this feature does not own that file. Reported rather than added.

### No barrel for this module
`E-468` · factor-webauthn · knip

**Context.** `core/token`, `core/keys` and `core/factor/pending` each have an `index.ts`. This feature wrote one and `knip` called the file unused, because nothing in `src/` imports this module yet.
**Rejected.** Keeping the barrel and importing it from the tests to make it used.
**Reason.** That satisfies the check without the barrel doing anything, and re-exported types then fail the unused-export rule one at a time. `core/session` and `core/password` have no barrel for the same reason and are the closer precedent: a barrel is written when something upward imports it, and upward is `auth-core`.
**Price.** `auth-core` will import six paths instead of one, and whoever adds the barrel later has to decide again what belongs in it.

### The settable clock is not used here, and that is not an oversight
`E-469` · factor-webauthn · 6.19, reported

**Context.** `auth-core` published `createTestClock` in `@velve/auth/testing`, and this feature was told its challenge-expiry test needs it.
**Rejected.** Taking a `Clock` in `WebAuthnServiceOptions` and passing it to the challenge repository.
**Reason.** Nothing in this feature reads a JavaScript clock. `expires_at` is computed as `now() + make_interval(…)` in PostgreSQL and compared against `now()` in the same statement, which is what E-238 already established for sessions and what 6.19 itself prescribes for the database side — expiry timestamps are written directly in the test rather than the server's time being moved. Accepting a clock and ignoring it is exactly the defect E-247 records, where three tests passed for the wrong reason.
**Price.** The expired-challenge case of T-REPLAY-5 is set up by writing `expires_at` into the past, which is a test that knows the column name. If the lifetime ever moves into JavaScript, that test keeps passing and stops meaning anything.

### Who issues the session after a WebAuthn sign-in
`E-470` · factor-webauthn · S-FIX-1 hand-off

**Context.** S-FIX-1 counts passkey sign-in and second-factor completion among the eight trust-level events, and E-243 fixes which method each caller must name. This feature's `passkey.finish` and `authenticate.finish` return a verified assertion and issue nothing.
**Rejected.** Taking a `SessionService` and issuing the session here.
**Reason.** No feature module in `src/` imports another feature's service; `password` does not, `session` does not, and the assembly is where they meet. More concretely, `reissue` demands a `previousToken` naming an existing session row, and neither of these paths has one — a passkey sign-in begins anonymous, and the intermediate state is not a session (S-FIX-4). So the call cannot be made correctly from here even if it were allowed.
**Price.** S-FIX-1 is unfulfilled for both WebAuthn paths and nothing on this branch would notice. The rule this entry hands over: **passkey sign-in and second-factor completion both call `issue`, not `reissue`, unless the request carried a session token, and neither ever calls `reissueAfterCredentialChange`.** That contradicts the brief this feature was given, which said both call `reissue`; the contradiction is with `reissue`'s signature, not with E-243's intent, and it is written here so the assembly resolves it deliberately.

### L-8's five attempts are counted by the flow, not by this factor
`E-471` · factor-webauthn · L-8 hand-off

**Context.** `/factor/webauthn/authenticate/finish` declares `too_many_factor_attempts`, and `MAXIMUM_PENDING_ATTEMPTS` with `registerFailedAttempt` live in `core/factor/pending`.
**Rejected.** Calling `registerFailedAttempt` from this feature's `authenticate.finish`.
**Reason.** The five attempts are per intermediate state, not per factor: a user may try TOTP twice and WebAuthn three times, and the count that matters is the sum. A factor that counts its own failures either double-counts or misses the ones its neighbour caused. The state belongs to whoever owns the state.
**Price.** Until the flow calls it, a WebAuthn second factor can be attempted without limit inside a five-minute window, bounded only by the per-IP rate limit. That is the gap, and it is this entry rather than a test.

### The routes cannot be declared here
`E-472` · factor-webauthn · reported

**Context.** The nine routes of 3.15 D.3 are this feature's, and `defineRoute` exists.
**Rejected.** Declaring them anyway and reading the subject from somewhere else.
**Reason.** `RequestContext.pending` is a `PendingAuthentication` — `factorsCompleted`, `availableFactors`, `attemptsRemaining`, `expiresAt` — and carries no user id. The two routes with `caller: "pending"` therefore cannot reach the account whose credentials they need, and the alternative is reading an identifier out of the request, which is the confused deputy S-OWNER-6 and S-OWNER-7 exist to forbid. Every wave-2 feature stopped at the service layer for the same shape of reason.
**Price.** Reported to `auth-core`, whose `RequestContext` it is: a `caller: "pending"` route needs the resolution, not the presentation. Until then the nine routes exist as a service surface and a table nobody has typed.

### Transports travel as JSON, not through a delimiter
`E-473` · factor-webauthn · storage

**Context.** `session.factors` is read back with `array_to_string(factors, ',')`, and the obvious thing was to copy it for `transports`.
**Rejected.** Copying it.
**Reason.** `factors` is a closed set of five words that contain no comma. `transports` is whatever the browser called it (E-453), so `["a,b"]` and `["a","b"]` would arrive back identical. `to_jsonb(...)::text` on the way out and `jsonb_array_elements_text` on the way in have no delimiter to collide with.
**Price.** Two statements in this repository read a `text[]` column in two different ways, and the reason is a property of the data rather than of the type. Anyone copying either into a third place will copy whichever they saw first.

### An imported credential has no label, and the surface promises a string
`E-474` · factor-webauthn · storage

**Context.** `webauthn.register.finish` demands a `label` (3.15 B.6), but `webauthn_credential.label` is nullable because the import module writes rows without one (4.1 e).
**Rejected.** Making the column `NOT NULL`, or typing the surface `label: string | null`.
**Reason.** The column is 3.2's and not this feature's to change. `WebAuthnCredential.label` is `string` in 3.15 C, and the empty string is what "the import knew no name" looks like to a caller that has to render something.
**Price.** A caller cannot tell an imported credential from one somebody deliberately named `""`, and nothing stops the latter — `register.finish` requires the field, not that it be non-empty.

### A planted fault that fails on the parameter count proves nothing
`E-475` · factor-webauthn · method, correction

**Context.** §5 says a check is trusted only after it has been proved to fail on a planted fault. The first two plants against the challenge predicate deleted `AND purpose = $2` and `AND user_id IS NOT DISTINCT FROM $3::uuid` from the SQL.
**Rejected.** Reading the resulting red as confirmation.
**Reason.** Both went red with `could not determine data type of parameter $2` and `bind message supplies 3 parameters, but prepared statement requires 2` — PostgreSQL refusing a malformed statement, in every test that touched it, including the ones that have nothing to do with purpose or subject. The behaviour under test was never reached. The plants were rewritten to keep the parameter bound and make the predicate vacuous — `(purpose = $2 OR true)` — and then exactly the intended cases went red and nothing else did.
**Price.** This is the same mistake as the one recorded in E-504, seen from a different angle and made one week later by someone who had read that entry that morning. The lesson that transfers is not "check where the fault lives" but something narrower: **a plant that changes the shape of a statement is testing the parser, and a plant that changes its meaning is testing the check.** Nine plants were made on this branch; two of them had to be made twice.

### A search for a value that could not fit
`E-476` · factor-webauthn · method, correction

**Context.** One case asserts that the challenge itself never appears in `webauthn_challenge`, by searching the row for the token.
**Rejected.** Leaving it, since it was green.
**Reason.** It was green for the wrong reason. The token is 43 characters and the column is 32 bytes, so the search could not match however the bytes had been written — the test passed for the impossibility of the search rather than the correctness of the hash. It was found by planting the storage of the token in place of its hash and watching this test stay green while four others went red. It now searches for a 16-character prefix, in three encodings, and goes red on that plant.
**Price.** The class is wider than this instance and nothing systematic catches it: a search whose needle cannot fit its haystack looks exactly like a search that found nothing. Every other assertion of this shape in this feature's tests was re-read by hand, which is not a mechanism.

### The instrument advanced the counter the case was about
`E-477` · factor-webauthn · method, correction

**Context.** One case asserts that an authenticator keeping no counter — reporting zero on every assertion — is not reported as regressed.
**Rejected.** Adjusting the assertion when it failed.
**Reason.** It failed because the shared `enrol` helper registers through the simulator's default path, which increments the counter, so the credential was stored with `sign_count = 1` and a subsequent zero was a genuine fall. The behaviour was right and the fixture was wrong: a counterless authenticator reports zero at registration too. The case now registers explicitly at zero. Adjusting the assertion would have written down that a counterless authenticator is reported as regressed, which is false and would have been believed.
**Price.** The shared fixture is convenient exactly until a case is about the thing the fixture decides for you, and there is no signal that says which cases those are.

### The only failing test on this branch belongs to another
`E-478` · factor-webauthn · reported

**Context.** This feature imports `PendingResolution` from `core/factor/pending`, which is on `origin/feature/auth-core` and not on `main`. That branch was merged in to compile against it.
**Rejected.** (a) Not merging, and defining a local shape with the same fields. (b) Regenerating `test/__snapshots__/api-surface.md`, which the merge makes stale.
**Reason.** (a) is two declarations of one type across two branches, which is the divergence the merge exists to prevent. (b) is a file this feature does not own, and `auth-core`'s own commit says in as many words that the snapshot is regenerated once, at the end, and is the only failing test on its branch. Regenerating it here would take that decision away from them and hide whatever else has moved.
**Price.** `pnpm test` on this branch fails one case — `public API surface > matches the committed snapshot` — and it fails for a change this feature did not make. Every counted figure in this feature's report was taken after that merge and has to be taken again when `main` moves.

### The snapshot cleared itself, and the report that named it was stale before it was read
`E-479` · factor-webauthn · E-478 answered

**Context.** E-478 recorded that the one failing case on this branch — `public API surface > matches the committed snapshot` — came from merging `auth-core` and belonged to `auth-core` to fix, and that this branch would not regenerate a file it does not own. `auth-core` regenerated it in `1f2c281`, two commits after the one this branch had merged.
**Rejected.** Nothing. The decision E-478 took was to wait, and waiting was what closed it.
**Reason.** Re-merging `auth-core` at its current head takes the regenerated snapshot with it and the case passes. The full suite is green: **1367 passed, 11 skipped, 0 failed**, twice in a row. Worth recording that the *waiting* was the right call for a reason E-478 did not give: the regenerated snapshot moved by `auth-core`'s exports and this feature adds none, so had this branch regenerated it first, the two branches would have produced two versions of one generated file and conflicted in it — and a conflict in a generated file is resolved by whoever is least equipped to read it.
**Price.** Every counted figure in this feature's report was taken twice: once after the first merge and once after the second, and the second is the one that stands. The report that carried the first set was read by a reviewer after the snapshot had already been fixed, and it said the branch was red when it was not — a figure with a timestamp on it and no way for the reader to see the timestamp. The merge of `CASE-STUDY.md` conflicted, as §5 predicts for four writers appending at end of file; both ranges were kept whole, `auth-core`'s block before this one, and neither side's text was touched.

### A list that can be emptied deletes cases instead of failing them
`E-480` · factor-webauthn · method

**Context.** A gate finding against a sibling branch: eight of eleven route-table assertions passed when the route list was replaced with `[]`, including the two carrying the actual security claims. The same shape was looked for here.
**Rejected.** Treating it as somebody else's finding, on the grounds that this feature's assertions are mostly on values rather than on lists.
**Reason.** One instance was found and it was the worst kind. `it.each(FAULTS)` drives the four ways the simulator signs wrongly, in two files. Emptied, `it.each` produces **no cases at all** — the run goes from 8 tests to 5 and from 22 to 19, all green, and the four assertions that prove a rejection is reachable simply stop existing. That is worse than a vacuous pass, because a vacuous pass at least leaves a name in the output to be counted. Both files now assert the length of the list before it is used, and the pin of this feature's two pending-taking operations now states its own count instead of comparing two derived lists that could both be empty.
**Price.** Three literal counts — 4, 4 and 2 — now have to be changed by hand when the lists change, which is the cost every count-stating assertion has. The alternative found nothing for a week and would have kept finding nothing.

### The null prototype was applied to what entered and discarded on what left
`E-481` · factor-webauthn · E-456 corrected, security

**Context.** E-456 nulled the prototype of what `object().parse` returns and called the class closed. It was not. `registrationResponse()` then does `const { transports, ...rest } = parsed.response` and returns `{ ...rest, transports: known }` — and **object rest destructuring and every object literal build on `Object.prototype`**. The null prototype existed for the length of one statement and was thrown away by the next. `service.ts` read `response.response.transports ?? []` straight back through the chain, and the polluted array reached the stored column: `Object.prototype.transports = ["usb","POLLUTED"]` came out of `credential.transports` as `["POLLUTED"]`, traced end to end against a real database.
**Rejected.** (a) Fixing only the parser. (b) Fixing only the consumer.
**Reason.** Either alone closes it today and neither says so at the seam. Both ends changed: `withoutInheritance` is now applied to what the module **returns**, not only to what it parses, and the service asks `Object.hasOwn` before reading the hint. Planted separately, each guard is green while the other stands — which is what defence in depth is, and it is stated that way rather than claimed as two independent pins. Planted together, both probes redden, including the end-to-end one, with exactly the value above.
**Price.** The harder half is not the defect, it is the probe. E-456 already convicted its first version for measuring the pollution instead of the parser — and the correction, `Object.hasOwn(parsed.response, "transports")`, made it ask **the wrong object**: the parser's own-property set genuinely said "absent" while the consumer's read said `["usb"]`, and the probe reported the half that was right. A probe has to read the field **the way the consumer reads it**, and neither version of that probe did until now. It hid this long because the one seam it lives on is the one nothing crosses: the two validators are called only from tests, the routes are undeclared (E-472), and the fixtures hand the simulator's raw object to the service. There is now a case that parses the way the route will and then reads the column. And a third instance of E-475 was collected while fixing it — two plants silently failed to apply because `biome` had collapsed the lines they matched, and a plant that does not apply is indistinguishable from a plant that proved the code right. Every plant now asserts that it applied.

### Two identical wrong answers satisfy an equality
`E-482` · factor-webauthn · T-OWNER-3, correction

**Context.** T-OWNER-3's case asserted that the two rejections answer alike, that A's count was 2 before and after, and that B's was 2. Every one of those is satisfied by a `remove` that does nothing at all. Planted twice — refusing unconditionally, and returning before reaching `removeSignInMethod` — the case stayed green both times while three neighbours reddened under the second.
**Rejected.** Leaving it and relying on the neighbours, which do catch a no-op.
**Reason.** The neighbours catch it by accident of arrangement, and the requirement is asserted here. Equality was never the whole claim: S-OWNER-3 says the two answers are identical **and** that they are the answer the route declares. So the case now anchors on the literal 204 rather than on `answers[0] === answers[1]`, and ends by removing a credential B does own — so a `remove` that never deletes fails inside the case that is about deleting. Both of the gate's plants now redden it. The behaviour was correct throughout; only the test could not show it.
**Price.** The anchor is a literal that has to move if the route's status ever does, which is the cost of anchoring. The general shape has no mechanical detector: an assertion that two answers agree is exactly as green when both are wrong, and the only tell is that plants aimed at the subject do not redden it.

### D37 is a fixed value and this is the passkey path's registration
`E-483` · factor-webauthn · E-466 reversed, architecture

**Context.** E-466 chose `residentKey: "preferred"`, reasoning that `"required"` makes a full security key unregistrable and that hardware keys are the second-factor case 3.6 describes. Architecture 1 D37 says the opposite in as many words: *"Feste Vorgaben statt Optionen: `residentKey: "required"` … für den Passkey-Weg"*, and *"`preferred` heißt in der Praxis „meistens nicht""*.
**Rejected.** (a) Keeping `"preferred"` on E-466's reasoning. (b) Splitting registration into a passkey ceremony and a second-factor ceremony, so D37 governs only the first.
**Reason.** (a) is a local decision on a line §7 says is not open to one, and E-466 argued the trade without citing the row that had already decided it — which is the failure mode of reasoning from first principles next to a specification. (b) is the reading that would save it, and it does not survive: the route table in 3.15 D.3 has exactly one registration route, so the credential the passkey path signs in with can only have been enrolled by this line. It **is** the passkey path's registration, whatever else it also serves, and adding a second registration route to a fixed table is not this feature's call either. D37's `userVerification` half is a different matter and is superseded: 3.15 A.8 declares that one as an option with two values, and both verification points enforce `"required"` regardless, which is what D37 was protecting.
**Price.** Named plainly rather than argued away, because it is the thing E-466 got right: **a security key whose discoverable slots are full now refuses registration, and cannot be enrolled as a second factor either**, because there is one route for both. That is a consequence of D37 as written, not of this branch, and it is reported upward as an observation for the architecture's owner rather than decided here. The documentation says it in the place a reader meets it.

### A fifth way of signing wrongly, and the first one that isolates only the binding
`E-484` · factor-webauthn · test infrastructure

**Context.** The simulator had four wrong-signing modes. The gate reproduced the whole check against `@simplewebauthn/server` alone, confirmed all four reject, and proposed a fifth: sign correctly, then transmit a `clientDataJSON` differing only in `crossOrigin`.
**Rejected.** Nothing — the argument for it was better than the reason it was missing.
**Reason.** The four existing modes each break something the verifier checks *before* it checks the signature, or break the signature so badly that several checks could account for the refusal. This one leaves challenge, origin, relying-party hash and the user-verification flag all correct, and `crossOrigin` is a field the verifier does not read — so the **only** thing that can refuse it is the signature's binding to the bytes actually transmitted. `signed-without-the-client-data` tests that property obliquely; this tests it alone, and a case pins the concealed reason to `signature_invalid` rather than merely to a rejection.
**Price.** The simulator needed one parameter and no other change, which is the good news and also the uncomfortable part: the mode was buildable from the start and the enumeration of four was a guess that stopped where it stopped. E-465 already said so — *"the enumeration is a guess at what a broken authenticator does"* — and naming the limitation did not make anyone go back and close it.

### The licence moves to Apache 2.0
`E-505` · gate · licensing, frozen

**Context.** The commission fixed MIT, and MIT shipped through wave 3. Two gaps
in it are specific to a company publishing a security dependency rather than to
an individual publishing a utility: MIT says nothing about patents, so a
contributor may assert one later over their own contribution against the
project and against everyone depending on it; and MIT does not keep the name
out of the grant, so a fork may continue to call itself Velve Auth.

**Rejected.** (a) Staying on MIT, on the strength of it being the string every
developer recognises and every competitor uses — Better Auth and Lucia are MIT,
and Auth.js is ISC, which is MIT with two clauses removed and no more
protective. (b) A copyleft or source-available licence. (c) Dual licensing.

**Reason.** (b) fails on what this package is: a dependency that runs inside
someone else's process. A licence that reaches the calling application makes
the library unusable in the procurement of the firms it is aimed at, and it
contradicts the positioning — the argument of this project is that the security
work can be read and checked, which requires that it can be read, forked and
vendored. (c) has nothing to sell separately. (a) is the real alternative and
it loses on exactly two clauses. Apache 2.0 is equally permissive and closes
both gaps. It is not obligation-free where MIT is: §4(b) requires modified
files to be marked as modified and §4(d) requires a NOTICE's attributions to
be carried forward, neither of which MIT asks. Both attach on redistribution
rather than on use, so they cost a consumer nothing and a redistributor two
lines — but the first draft of this entry claimed Apache imposed nothing
further at all, which was false and is corrected here rather than left.
Enterprise legal review frequently prefers it for the patent clause.
The timing decided it as much as the substance: relicensing requires every
contributor's consent, and today the contributor set is one person. That is the
cheapest this change will ever be.

**Price.** The file is 11,358 bytes where MIT's was 1,062, and a developer
scanning a package page reads "Apache-2.0" a beat slower than "MIT". Two places
outside the licence itself asserted MIT and had to move with it: `CLAUDE.md` §1
and `README.md`. A third, E-47's *Kontext*, states MIT as the fact it was when
that entry was written; it is left alone and carries an addendum instead. The
in-place edit was authorised and then withdrawn once the argument for it — that
the sentence states a fact rather than a reason — was shown to dissolve the
rule rather than carve an exception in it, since a *Kontext* is by construction
a statement of fact about the world at the time. Every such statement is a
second place the licence is written down, and nothing checks that they agree
with `package.json`. This entry first counted three and missed the two the same
commit created — `NOTICE`, which states the licence in prose rather than as an
SPDX token and is therefore the form a future grep is least likely to catch,
and this paragraph. Undercounting the hazard while warning about it is the
hazard.

### The four route seams are cut before the four features that fill them
`E-515` · gate · route table, seam

**Context.** Wave 4 runs `oauth`, `email-flows`, `plugin` and `client` in parallel, and every one of them adds rows to the table of 3.15 D.3. `core/auth/instance.ts` composed that table from two sources, both its own, and belongs to no wave-4 feature — so four writers would have edited one file, in one function, in the same argument list.
**Rejected.** (a) Letting each feature add its own composition line and resolving the conflict at the merge. (b) A registry a feature pushes routes into at import time.
**Reason.** (a) is a three-way conflict in an array literal, which merges cleanly by luck and silently drops a line when it does not. (b) makes the table depend on import order, which is the one property a route table must not have — the same set of routes composed in a different order is a different `assertRouteTableIsUnambiguous` outcome and a different API snapshot. Three empty modules composed in a fixed order is the boring version, and the assembly reads the same before and after any of them fills up.
**Price.** Each of the three takes a `RouteServices`, which is declared in `core/auth/routes.ts`. A feature that needs a service the assembly does not build yet has to add a field to that type — one shared file again, one field each rather than one line each. That is a smaller collision surface, not none, and it is written down here rather than discovered in wave 4.

### A route may read the pending cookie without being authorised by it
`E-516` · gate · S-CACHE-4, E-335 answered

**Context.** E-335 left `GET /pending` and `POST /pending/cancel` undeclared. `core/http/web-handler.ts` decided which routes saw `__Host-velve_pending` by `route.caller === "pending"`, and S-CACHE-4 fixes that set at four. Reading the state and being authorised by it were one field.
**Rejected.** (a) A fifth `CallerRequirement`, which E-335 named as one of the two ways out. (b) Leaving it and letting the application forward the cookie itself.
**Reason.** 3.15 D.1 writes `CallerRequirement` out as four literals. A fifth value edits a type the specification fixes, and it would also make "how many routes accept the pending state" a question with two answers rather than one. A separate `pendingCookie: "hidden" | "readable"` is additive: `caller` keeps meaning authority, the count of four is still readable off `caller`, and the default is the safe one because absent means hidden. `caller: "pending"` implies readable and a declaration that contradicts it is refused at definition, so the two fields cannot disagree.
**Price.** A ninth field on a declaration that 3.15 D.1 lists with eight, and the specification does not have it. It is optional, so no existing declaration changed, but the route type is now wider than the document it implements — which is a deviation, recorded here, and not a licence for a tenth.

### The pending caller gets the resolution, and the presentation stays a presentation
`E-517` · gate · E-405 and E-472 answered

**Context.** E-472 and E-405 both stopped at a service layer and said why: `RequestContext.pending` was a `PendingAuthentication`, which carries `factorsCompleted`, `availableFactors`, `attemptsRemaining` and `expiresAt` and deliberately no account. `CallerResolver.resolvePending` already had the `PendingResolution` — `userId`, the record, and the database's clock — and threw it away one line after reading it. Sixteen routes were blocked on it, seven of TOTP and recovery and nine of WebAuthn.
**Rejected.** (a) A second resolver call inside the handler. (b) Reading the account out of the request, which is what both entries said they would not do.
**Reason.** (a) doubles the query count on the one path where T-CACHE-1 counts queries, and the second answer could differ from the first. (b) is the confused deputy S-OWNER-6 and S-OWNER-7 exist to forbid. The type moved to `core/http/caller.ts`, where the layer that resolves callers can name it, and `core/factor/pending` keeps `PendingResolution` as an alias — one definition, in the layer that hands it out.
**Price.** `RequestContext.pending` is no longer the type 3.15 D.1 names for that field. The document says `PendingAuthentication | null`; the field is now the resolution that carries one. A reader comparing the two will find a difference and has this entry to find. The four routes that read the cookie were unchanged by it, and a planted fifth entry in `PENDING_CALLER_ROUTES` still reddens four tests in four files, which is how that was checked rather than assumed.

### The third cookie, and the enumeration stops being restated
`E-518` · gate · S-COOKIE-6

**Context.** 3.10 puts the OAuth `state` server-side in `velve.oauth_flow` and the pointer in a cookie. `DEFAULT_COOKIE_NAMES` enumerated two names, and `assertCookieNamesAreEnumerated` restated the same two beside it as a literal set.
**Rejected.** Adding the third name to the constant and to the restated set, keeping both lists.
**Reason.** Two lists that must agree are one list and a bug waiting for the third entry — which is exactly what this change was. The check now reads `Object.values(DEFAULT_COOKIE_NAMES)`, so the constant is the enumeration and there is nothing to fall behind. `readCookies` reads the same way.
**Price.** A name added to the constant is now permitted automatically rather than in two places. That is the intended reading — the constant *is* S-COOKIE-6's enumeration — but it removes a second pair of eyes that had, until now, been the thing that noticed.

### `SameSite: "strict"` stays legal, and the state pointer does not take it
`E-519` · gate · S-COOKIE-2, S-CSRF, decided

**Context.** `session.cookie.sameSite` may be `"strict"`, and `createCookieCollector` applied the chosen attribute set to every cookie it wrote. A `Strict` cookie is not sent on a cross-site top-level `GET`, and 5.9 (a) says in as many words that the OAuth callback is one by protocol. So a `Strict` state pointer is missing at the single request that reads it, and every callback in that installation answers `oauth_flow_invalid`.
**Rejected.** (a) A start error when `oauth` is configured and `sameSite` is `"strict"`. (b) Documenting it as the caller's problem.
**Reason.** (b) is not a caller's problem in any useful sense: the failure is a silently broken sign-in path, not a weakened default the operator chose knowingly. (a) is the shape this repository prefers — `origins: []` and `username` without recovery codes are both start errors — and it is the option this cut cannot take: it needs to read `config.oauth`, and that key does not exist in `BaseConfig` yet because the `oauth` feature owns it. What is left, and what is also the better answer, is that the pointer keeps `SameSite=Lax` whatever the session cookie is set to. Its security does not rest on the attribute; it rests on the server-side `state` row and PKCE (3.10), and on the pointer being a random value that names one row.
**Price.** An operator who configured `strict` now has one cookie that is not, and nothing at runtime says so — the divergence is in the documentation and in a constant named for it, not in a log line or a start warning. If the `oauth` feature decides the operator must be told, the start error is theirs to add once `config.oauth` exists, and this entry is where the reasoning it would be overturning lives.

### The pointer outlives the row it points at
`E-520` · gate · cookie lifetime

**Context.** The state cookie needs a `Max-Age` and nothing in the architecture fixes one. `velve.oauth_flow.expires_at` is set by the feature that writes the row, which does not exist yet.
**Rejected.** Matching the five minutes of `__Host-velve_pending` and the WebAuthn challenge, which is the library's other one-time-artefact window.
**Reason.** The two deadlines are not symmetric in their failure. If the cookie outlives the row, the callback finds no row and answers `oauth_flow_invalid` — which is the correct answer for an expired flow. If the row outlives the cookie, the callback finds no pointer and answers `oauth_flow_invalid` for a flow that was still valid. Only one of those is a bug, so the cookie is given the longer of the two: ten minutes, against a row whose deadline the OAuth feature sets and which it must not set above ten.
**Price.** A number chosen by this cut for a table another feature owns, and a constraint on that feature stated only here and in the documentation. Nothing checks it. Five minutes at the provider is also not obviously enough — a user who has to sign in and pass a second factor there can exceed it — and ten was picked as the common practice rather than from a measurement.

### `EntityId` lives beside `Actor`, not beside the token it is contrasted with
`E-521` · gate · S-RAND-6, E-260 answered

**Context.** E-260 recorded that `SecretToken` closes one direction of S-RAND-6 and that the other has no type: a token was still assignable where an account identifier belongs, because `EntityId` did not exist and did not belong in `core/token/`. One of T-RAND-6's two negative cases had been unwritten since wave 2, and wave 4 makes it worse — `identityId`, `credentialId`, `targetSessionId` and `provider` all cross the wire as bare strings.
**Rejected.** (a) A single `EntityId` without a table parameter. (b) Making `toEntityId` check the `uuid` shape.
**Reason.** (a) would stop a token but not a `targetSessionId` arriving where a `userId` belongs, which is the confusion S-OWNER-6 is about and the one wave 4 will have most of. `EntityId<Entity>` gives one alias per table and no two are assignable. (b) is refused for E-260's reason exactly: a rejected shape is a second answer beside "no row", measurable in the runtime and visible at a different call site. `ProviderId` is in the set although it is not a `uuid` column — it is the other half of 3.10's `(provider, subject)` key, and a provider name arriving where a credential identifier belongs is the same class of mistake.
**Price.** `toEntityId` accepts any string, so the type is a review aid and not a validation — the same honest limit `toSecretToken` has. Five aliases are on the public surface with one consumer between them today; four of the five are there for wave 4 to use and will look unused until it does.

### The actor gets its second and third provenance, and each is minted where the row was removed
`E-522` · gate · E-234 answered

**Context.** E-234 recorded that a password reset has to revoke every session and has no session to prove ownership with, that the only lawful `Actor` producer was session resolution, and that the wave owning `one_time_token` had to build a second. E-341 carried it forward and named the third: a consumed OAuth flow. Both wave-4 features need it and neither owns `core/db/actor.ts`.
**Rejected.** (a) One producer taking a `userId: string` with a `reason`. (b) Producers in the features that call them.
**Reason.** (a) is the hole E-93 walls up — a string in, an actor out, and nothing in the signature saying where the string came from. (b) turns one place to look into three. So each producer takes its own nominal evidence type, and the brand on that evidence is asserted only in the repository that consumed the artefact: `RedeemedOneTimeToken` in `db/repositories/token.ts`, where the `DELETE … RETURNING` removed the row. `ConsumedOAuthFlow` has no producer at all yet, which is not an oversight — it is the shape E-93 itself used, declaring `ResolvedSession` a wave before anything could produce one, and the feature that consumes a flow asserts it where it removes the row.
**Price.** Three things. `StoredOneTimeToken` changed shape, so S-TOKEN-4's "a row that names no account answers like no row" moved one layer down into the repository, where it is now a condition in a return rather than a check in `core/token`. `Actor`'s brand string no longer says "resolved session", because it no longer means that. And a producer with no lawful caller is an escape hatch that compiles: `actorOfConsumedOAuthFlow` is on the public surface, takes a type nothing can build, and will stay that way until wave 4 — visible, unusable, and easier to misread than to misuse.

### The laundering path E-341 found is still open, and this is what closing it would cost
`E-523` · gate · E-341, still not closed

**Context.** E-341's correction records that `issue → resolve → actorOfResolvedSession` mints a branded `Actor` from a request-supplied string in two awaits, with no cast and without tripping the scan that pins minting to `db/actor.ts`. This cut adds two more producers and had the chance to close it.
**Rejected.** Typing `SessionService.issue`'s `userId` as the `UserId` of E-521, which would make the first step of the path an explicit `toEntityId` call.
**Reason.** It would not close anything. `toEntityId` accepts any string by design, so the laundering path would gain one visible line and lose nothing. The real answer is that the path is not a hole in the brand at all: a caller who can issue a session for an arbitrary account already has more authority than the actor would carry, so the actor is the smaller of the two problems and the brand was never what stood between them. Changing `issue`'s signature is also a change to `core/session/service.ts`, which this cut does not own, for no gain.
**Price.** The path stays reachable and is now reachable next to three producers rather than one, which makes the brand look stronger than it is. E-341 says the brand makes minting *visible* rather than impossible; that remains the honest description, and nothing in this cut improved it.

### `trustedProxies` reached nothing, and the documentation said so as if it were the design
`E-524` · gate · S-RATE-3

**Context.** `resolveClientAddress(connectionAddress, forwardedFor, trustedProxies)` was written, tested against T-RATE-3 and documented. `BaseConfig.trustedProxies` was declared, classified in `SECURITY_OPTIONS`, and reported as a weakening when set. Nothing passed one to the other: `toWebHandler`'s address reader defaulted to `() => null`, so in a real installation every request shared one bucket per route, and `DOCUMENTATION.md` stated flatly that `X-Forwarded-For` is never read by the library.
**Rejected.** (a) Leaving the join to the adapter and keeping the sentence. (b) Reading `X-Forwarded-For` whenever the header is present.
**Reason.** (b) is the vulnerability the requirement is about. (a) is what the code already did, and the measure of it is that three features shipped over a rate limiter that could not tell two clients apart and none of them noticed, because the documentation described the gap as a decision. The environment carries `trustedProxies`, the handler resolves the address it counts, and with the default empty list the behaviour is byte-identical to before.
**Price.** `WebHandlerOptions.clientAddress` is renamed `connectionAddress`, which is a public surface change with no deprecation, in a package at version 0.0.0. The old name was also a lie in the other direction — it asked for the client address and got used as the connection address — so keeping it would have preserved the confusion that produced the gap.

### The route table's tests assert properties, and the count is what an empty table fails
`E-525` · gate · E-342 answered

**Context.** E-342 chose to name the seven routes exactly rather than count them, because the first version of those tests said "at least eight" and passed at seven. The entry called the file a merge conflict waiting for four branches, and wave 4 is those four branches.
**Rejected.** (a) Keeping the names and letting each wave-4 feature extend the list. (b) Counting to the 46 of 3.15 D.3.
**Reason.** (a) is four writers in one array in one file, which is what this whole cut exists to remove. (b) asserts against routes that do not exist. What replaces both is a property over whatever the table holds — exempt equals permitted-and-declared, `caller: "pending"` equals named-and-declared, every `GET` classified, no duplicate name and no duplicate folded path — plus a floor in every case, because the property alone is vacuously true of nothing. The floor carries no meaning; it exists so the assertion fails on an empty list, which is precisely the failure E-342 warned about and which a wave-3 gate then found in eight of eleven assertions in this file.
**Price.** Three of the fourteen cases still pass on an empty table, and they are the three that never read the table: two name `/session/revoke` and `/session/list` by hand for S-OWNER-6, and one calls a server method directly. They are not table-wide claims and were left as they are rather than given a floor that would be decoration. The number is stated here so that "eleven of fourteen redden" is a measurement and not an impression.

### The release tier exists, and its first case is what leaves the door rather than what the build wrote
`E-526` · gate · E-344 answered

**Context.** E-344 recorded that section 6's third tier has no home: T-KEY-5, T-DEFAULT-7 and 6.19's packaging assertion run nowhere, `package.json` has two test scripts, and a tier without a schedule is a script nobody runs. Three waves left it unbuilt.
**Rejected.** (a) Adding the script and no workflow. (b) Putting the three cases in the blocking tier.
**Reason.** (a) is what E-344 predicted would be useless, and the nightly tier only became real when a workflow ran it. (b) puts a process restart and an optional-dependency removal on every commit. So: a third vitest project, `pnpm test:release`, and a workflow on a version tag. `pnpm test` and `pnpm test:nightly` now name the two projects they always ran, so the release files cannot leak into a blocking gate and cannot be silently skipped either — an empty include fails the run.
**Price.** Two of the three cases are still unwritten. T-KEY-5 belongs to `keys` and T-DEFAULT-7 to `password`, and neither is this cut's to write, so the tier ships with one case in it. That case is 6.19's delivery test, and it is deliberately not the one `auth-testing-barriers.test.ts` already runs: that one reads `dist/`, and this one reads `npm pack`, because what the build wrote and what `files` lets out of the door are two claims and only the second reaches a user.

### Six plants, six predictions, and what each of them actually reddened
`E-527` · gate · plants, report

**Context.** §5 requires a check to be proved against a planted fault before its passing is trusted, and two earlier agents had plants that silently did nothing — one against lines a formatter had already collapsed, one verified with a pattern that could not match. Every plant here was applied by a script that asserts its own match and then greps for the result, and every one was run after a commit so a bad revert could not eat uncommitted work.
**Rejected.** Running the plants at the end, over the finished branch.
**Reason.** A plant run at the end proves the final state and says nothing about the intermediate ones, and the two failures it is guarding against were both failures of application rather than of judgement. Each plant ran immediately after the commit that introduced the thing it tests, against the smallest set of files that could answer, and each had its outcome predicted before it ran. A fifth name in `PENDING_CALLER_ROUTES` reddened four cases in four files, which is how the invariant was shown to survive E-517. Removing the pending-cookie visibility gate reddened one case, the one that says a hidden route answers as if the cookie were absent. Dropping `emailFlowRoutes` from the assembly reddened two, including the one that reads a probe route back over HTTP. Passing `null` where the `X-Forwarded-For` header is read reddened two of five. Adding `src` to `package.json`'s `files` reddened one. An empty route table reddened ten of thirteen.
**Price.** The plant that matters most is the emptiness one, and it is the only one whose result is a ratio rather than a pass: three cases survive it and are named in E-525. A ratio is also the honest form for the others — each says which cases redden, not that "the tests catch it", because in four of the six most cases stayed green and that is the number a reader needs. Six plants were not enough: the gate found a seventh this set had no case for, and E-530 records it. Every plant here was aimed at something a test already claimed, which is the failure mode — a plant confirms a claim and cannot find a claim nobody made.

### Five files this cut owns nothing of were edited, and each one is named
`E-528` · gate · §5, breached deliberately

**Context.** §5 fixes the set of files a piece of work may touch. This cut is a seam, so its changes reach into types other features' tests pin. Five test files outside anything this cut could be said to own went red and were changed: `http-cookies.test.ts` and `http-cookie-policy.test.ts` (a third `CookieNames` field their hostile fixtures must now carry), `auth-cookie-content.test.ts` (the `CookieWriter` method list, four to six), `http-fixtures.ts` and `limit-fixtures.ts` (a `resolvePending` returning the resolution, and a `trustedProxies` field), plus the four test files that pass `clientAddress` to `toWebHandler`.
**Rejected.** Leaving them red and reporting them, which is what §5 prescribes for a feature.
**Reason.** The same argument E-336 made and for a stronger reason: this cut exists so four features can start, and it blocks the gate if it leaves red tests. Every change is a fixture keeping up with a type, not an expectation being weakened — no assertion was loosened, and the two that changed value (`enumerated.size` two to three, the writer's method list) changed because the thing they measure changed.
**Price.** Nine files, and the rule is that a breach is named rather than counted. The list above is the naming. What it does not have is a mechanism: nothing distinguishes "a fixture followed a type" from "an expectation was lowered" except a reader comparing the diff, which is the same gap E-336's price described and the same one nobody has closed.

### What wave 4 still has no seam for
`E-529` · gate · reported

**Context.** The nine changes this cut was given are done. Reading the four wave-4 briefs against the result leaves three things that will be met by a writer and are nobody's yet.
**Rejected.** Building them here on the argument that a seam is a seam.
**Reason.** Each is a decision this cut was not given, and §9 of the working rules says an item needing an undelegated decision is reported rather than chosen. `BaseConfig` has no `oauth` key and no `plugins` key, so both features begin by editing `core/auth/config.ts`, `security-options.ts` and the two tests that read every option key — which is the collision this cut removed from `instance.ts` and did not remove from the configuration. `GET /pending` and `POST /pending/cancel` are declarable now and are still undeclared, because they belong to `auth-core`, which finished. `RouteServices` is one type four features will each want a field in, as E-515 says. And the start error E-519 deferred is `oauth`'s: a configuration that names a provider and sets `session.cookie.sameSite` to `"strict"` is one the `oauth` feature may refuse at start, and it is the only feature that can, because the check must read a `config.oauth` that only it will add.
**Price.** Four known collisions carried into a wave that was cut to have none, and the first two are in the same file. Whoever assigns wave 4 has this entry; nothing else will surface it, because nothing fails until two branches meet. The second item was closed after this entry was written — E-531 declares both routes — and the fourth was added to the list rather than appended as a correction, which E-536 argues for and records as a deviation.

### S-CACHE-4 counts readers, and the new axis had nothing counting it
`E-530` · gate · E-516's price corrected, finding

**Context.** E-516 split cookie visibility from caller authority and argued that the count of four stays readable off `caller`. That is true and it is not what the requirement says. S-CACHE-4 reads *"genau die vier Routen mit `caller: "pending"` … werten das Zwischenzustandscookie aus, jede andere Route ignoriert es vollständig"*, and T-CACHE-4's threshold is *"Genau 4 Routen verhalten sich anders"* — both count **readers**. Before this branch `caller` was the only gate on `__Host-velve_pending` and `PENDING_CALLER_ROUTES` pinned that set across four test files, so bounding the authorities bounded the readers for free. The new axis is independent and nothing bounded it: the gate added `pendingCookie: "readable"` to `session.list`, a `caller: "session"` core route, and got a clean typecheck and 1572 passing tests. A fifth reader of the intermediate-state cookie was a legal, silent, untested declaration.
**Rejected.** (a) Deriving the reader set from `readsPendingCookie` and asserting it against itself. (b) Reverting to one axis and leaving `GET /pending` undeclared again.
**Reason.** (a) is what the rewritten behavioural case already did — `routes.filter((route) => !readsPendingCookie(route))` asserts that routes not declaring the cookie readable behave as if it were absent, which is true by construction of the predicate. It replaced a case that was keyed on `caller` and did bound the set, so the rewrite traded a free bound for none, which is the finding. (b) gives up what E-516 bought. What holds it instead is a named set, `ROUTES_THAT_MAY_READ_THE_PENDING_COOKIE`, of six: the four of 3.6 plus the two `/pending` routes E-531 declares. The reader set must equal the named-and-declared set, with a floor of two so it cannot pass over an empty table, and the behavioural case is keyed on the names rather than on the predicate for the same reason.
**Price.** A second list that has to be extended when a route legitimately becomes a reader, where before there was one. The two lists cannot be merged: `PENDING_CALLER_ROUTES` is a source constant the factor modules read and the reader set is a test constant, and putting the two `/pending` routes into the first would make S-CACHE-4's four into six in every file that counts them. E-517's price offered the `PENDING_CALLER_ROUTES` plant as evidence the invariant survived; it is not that evidence, and never was — that plant verifies the authority set, which was never the thing at risk.

### The two `/pending` routes are declared here, because they belong to nobody
`E-531` · gate · 3.15 D.3, scope

**Context.** E-335 left `GET /pending` and `POST /pending/cancel` undeclared for want of a way to read the cookie without accepting it. E-516 built that way and E-529 then listed the two routes as an open collision: they belong to `auth-core`, which has finished, so in a four-way parallel wave whichever writer trips over them first edits `core/auth/routes.ts` mid-wave.
**Rejected.** Leaving them to wave 4 as reported, which is what E-529 did.
**Reason.** They are not a decision. 3.15 D.3 fixes path, method, input, output, status and rate limit for both; S-CSRF-4 classifies `/pending` as reading; B.7 fixes what the answer carries. The only missing piece was a `pending` field on `RouteServices`, a type this cut already owns and already reshaped. Declaring them also closes E-530 rather than deferring it, because the reader set is then written against six names that exist instead of four names and a promise.
**Price.** Two routes on the table whose server methods are not on the surface: `auth.pending.resolve` and `auth.pending.cancel` keep the signatures B.7 gives them, taking a `PendingToken` directly, so the route and the method are two ways in with two shapes. Every other route in the table has a `createServerMethod` twin. That asymmetry is deliberate — the cookie is the only sensible source for a browser and the token the only sensible one for a server — and it is the first place in the package where reading the table does not tell you what the instance offers. It is also not only a difference of shape: 3.11 puts the origin check and the rate limiter in front of every call, *"auch bei direkten Serveraufrufen"*, and `auth.pending.cancel` reaches the same operation as `POST /pending/cancel` with neither in front of it while the route declares a per-IP bucket — two ways in, two sets of checks. The exposure is a trusted server-side caller that has no browser origin to check, and S-CSRF-1's clause is scoped to the method *derived from* a route declaration, so this is inherited from B.7 rather than created here. It is the first divergence of its kind in the package, and wave 4 meets the same fork every time B.7 and D.3 describe one operation twice.

### The API snapshot cannot see a renamed option, and passed one
`E-532` · gate · check, finding, not fixed here

**Context.** The main gate's last item is *"the public surface has not changed unannounced (API snapshot comparison)"*. This branch renamed `WebHandlerOptions.clientAddress` to `connectionAddress` — a public option — and changed `Actor`'s brand string. `test/__snapshots__/api-surface.md` showed no diff for either.
**Rejected.** Fixing the snapshot here.
**Reason.** The cause is structural rather than accidental: `dist/http.d.mts` is two re-export lines, because `tsdown` runs with `unbundle: true` and the interface members live in an internal chunk under `dist/core/`. The snapshot reads only the top-level `.d.mts` files, so it compares the *names* a subpath exports and never the *shapes*. It caught the seven names E-521 and E-522 added, and could not have caught either of the two changes that alter what an existing caller compiles against. Fixing it means either bundling the declarations or walking the chunks, and both are changes to the build this cut has no mandate for and no test coverage of.
**Price.** The rename is announced — in E-524's price, in `DOCUMENTATION.md` and in the pull request — so nothing shipped unannounced. What is wrong is that the announcement was voluntary: the check the gate relies on would have passed silently either way, and neither E-524 nor E-528 noticed that. A reader of those two entries would conclude the snapshot vouched for the change. It did not.

### T-COOKIE-6 has two halves and one of them is unbuilt
`E-533` · gate · reported, widened by one

**Context.** T-COOKIE-6's threshold is two claims: *"Gesammelte Menge gleich `ALL_COOKIES`; 0 unbekannte Namen, 0 nie gesetzte Einträge"*. The first half is implemented — `assertCookieNamesAreEnumerated` makes an unenumerated name a 500, and the route-table case asserts no route sets one. The second is not implemented anywhere. E-518 added a third name to the enumeration.
**Rejected.** Building the reflective half here.
**Reason.** *0 never-set entries* is a claim over the whole integration suite: every `Set-Cookie` name any test ever observes, collected and compared with the constant. It cannot be asserted from one file, because the session cookie is set by flows this branch does not build and the state pointer by a feature that does not exist. Asserting it now would fail on three names, and weakening it to the two that can be set would be the same test with a smaller lie in it.
**Price.** The gap goes from two never-set entries to three, which is the honest way to say that this branch made an unmeasured claim larger. Nothing detects a cookie name that is enumerated and never written, so a name added and then abandoned stays in the constant and reads as shipped behaviour.

### What the counterfactual to E-523 actually costs, and where E-341's hole is anchored
`E-534` · gate · E-523 corrected

**Context.** E-523 rejected typing `SessionService.issue`'s `userId` as `UserId` and gave two reasons in that order: that the added line is a no-op, and that a caller who can issue a session already has more authority than the actor carries. The gate wrote the counterfactual and measured it.
**Rejected.** Leaving E-523 as the record, on the argument that its conclusion was upheld.
**Reason.** The conclusion was upheld and two of its statements were not. "One visible line" is one production line plus five test call sites that would each need the conversion, so the cost is five times what the entry implies. And no scan pins `toEntityId` call sites the way `test/db-entity-id.test.ts` pins `as Actor` and `as RedeemedOneTimeToken`, so the added line would be unscanned as well as semantically empty — which strengthens the conclusion and was not the argument given. The ordering is also wrong: the authority argument is the one that survives scrutiny and it was written second, behind the one that turned out to be imprecise.
**Price.** The mechanical root of E-341 sits outside anything this cut owns and is recorded here so wave 4 does not rediscover it: `src/core/session/service.ts` mints a `SessionResolution` with `as SessionResolution`, an assertion in a file the `as Actor` scan does not look at, and `test/session-review-surface.test.ts` pins that assertion to exactly that file. So the brand chain is anchored in two files and only one of them is scanned for what it produces. That is not a defect of either scan; it is what "the brand makes minting visible rather than impossible" means in the code.

### The release tier fires on a tag, which is after the merge that could break it
`E-535` · gate · E-526's price corrected

**Context.** E-526 built the tier and called it real. Its workflow triggers on `push: tags: ["v*"]` and on demand, and neither `pnpm gate` nor `ci.yml` runs it, so its first automatic run is at the first version tag — pushed after the merge that could have broken it.
**Rejected.** (a) Adding `pnpm test:release` to `pnpm gate`. (b) Leaving it on the tag alone.
**Reason.** (a) is what E-526 rejected for the right reason and the reason has not changed: the tier holds a process restart and an optional-dependency removal, and putting those on every commit is how a blocking tier becomes one people skip. (b) leaves a tier whose feedback arrives after the thing it would have caught has already merged. A nightly `schedule:` alongside the tag trigger costs one line, gives the tier a run before the tag rather than at it, and keeps it out of the blocking path.
**Price.** A second scheduled workflow doing a superset of nothing today — one case, which the nightly and blocking tiers do not run but which is cheap. When T-KEY-5 and T-DEFAULT-7 arrive the schedule will cost real minutes for cases section 6 deliberately did not put on a schedule, and whoever adds them should decide then whether nightly is still the right cadence.

### E-529 gained a fourth item rather than a correction, and that is itself a decision
`E-536` · gate · §6, deviation

**Context.** E-529 lists what wave 4 has no seam for and is the entry a briefer reads. The `oauth` start error for `sameSite: "strict"` — deferred by E-519 because it must read a `config.oauth` that does not exist — lived only in E-519's price. The `oauth` writer arrives holding a brief about providers, PKCE and JWKS and nothing walks them past E-519.
**Rejected.** Recording the hand-off in this entry alone, which is what §6 prescribes: new information about an old decision goes in a new entry citing the old one, never in the old entry's text.
**Reason.** §6's rule exists so that a reason is not rewritten after the fact. What was added to E-529 is a fourth item on a list of reported collisions — a fact that was true when the entry was written and was omitted — and none of its four parts changed. E-529 is also on this branch and unmerged, so nothing had read it as a record. That is the argument, and it is a licence a reader should not extend: two of the three other things the gate asked for here, the E-523 corrections and E-526's schedule, are corrections of reasons and are new entries because of it.
**Price.** The rule now has an exception with a judgement call in it — "a fact omitted from a list" against "a reason rewritten" — and the boundary is not mechanical. `test/decision-log.test.ts` cannot see the difference and never will. The cheaper alternative was one more entry and a briefer who has to find it, and that was traded away for discoverability.

### The delivery test would have reported success for a tarball that had lost the file it exists to pin
`E-537` · gate · E-526's case corrected, finding

**Context.** E-526 put 6.19's delivery test in the release tier, over `npm pack` rather than over `dist/`, and it names the documents that must ship: `README.md`, `DOCUMENTATION.md`, `CASE-STUDY.md`, `LICENSE`. The relicensing to Apache 2.0 added `NOTICE` to `package.json`'s `files`, and the test did not know about it. A tarball missing `NOTICE` would have passed — which is not hypothetical, because that is the exact state the relicensing branch was in at its first gate. The check that should catch the recurrence was blind to it.
**Rejected.** Deriving the list from `package.json`'s `files` so that it can never fall behind again.
**Reason.** That fix is appealing and it removes the test. Reading the list from `files` and then asserting that `npm pack` packed it confirms only that npm does what `files` says, which npm does; it would stop catching the one way this regresses, which is a name being dropped from `files`. The written-out list has value precisely because it is a **second, independent statement of intent** — its whole job is to disagree with `files` when `files` is wrong.
**Price.** The uncomfortable half is that an independent statement is only worth what the person maintaining it remembers, and nobody remembered: the list was written on this branch, `NOTICE` was added on another, and neither noticed the other. That is the shape §5 already records three times — a check that is structurally sound and still fails to cover the thing it exists for, because the coverage step is a human one. Both instances of it on this pair of branches were found by a reader and not by a check, and no mechanism proposed here changes that.

### Zero deleted lines is a property the log's diff can carry, and it cannot see an entry's own branch
`E-538` · gate · the log, check

**Context.** The relicensing branch ended up modifying no existing line of `CASE-STUDY.md` — `git diff main...HEAD --numstat` reported `56 0` — and that was offered as a machine-checkable property of a well-behaved change to the log: §6 says an entry is appended and never rewritten, and zero deletions is that rule stated in a way a script can read. Measured on this branch after the merge, it reports zero deletions.
**Rejected.** Reading the number as evidence that this branch appended only.
**Reason.** It did not. Three entries were edited in place after they were written: E-529 gained a fourth item, and E-525 and E-527 had their measurements restated when the route-table file went from thirteen cases to fourteen and the plants from six to seven. The branch's own history shows it — `58 2` and `2 2` across two commits. The three-dot diff cannot: it compares the merge base with the tip, and at the merge base none of those entries existed, so an edit to an entry the same branch introduced nets out to an addition. The property therefore checks exactly the case §6 cares about — an entry that predates the branch being rewritten — and is silent about the case E-536 argued over. That is a good check with a boundary, not a weak one, and the boundary happens to be where the argument was.
**Price.** A reader who takes the number as "this branch appended only" reads it wrongly, and this entry is the only thing that says so. The alternative this entry first named does not exist. It said the two-dot form would have flagged all three edits; it would not have. `A..B` and `A...B` differ only where `A` holds commits `B` does not, and this branch merged `origin/main`, so the base **is** `origin/main` and both forms answer `192 0`. What shows the three edits is the per-commit walk this entry already cites — `58 2` and `2 2` — and nothing else does. Two-dot is not a stricter version of the property but a wrong one: on a branch that has not merged a moved base it counts deletions `main`'s own commits made as though the branch had made them, so it is either identical to three-dot or it is reporting somebody else's work. Three-dot is the form, and the rule it enforces is settled: **on a writer's own branch, before merge, a measurement may be restated in place and a reason may not; an entry that existed at the merge base is never edited, and `git diff <base>...HEAD --numstat -- CASE-STUDY.md` must report zero deletions.** §6 protects a reason from being rewritten after it has been read, and an entry on an unmerged branch has been read by nobody — forbidding the in-branch correction would force a writer to publish `ten of thirteen` knowing it is wrong and aim a second entry at it, which makes the wrong number permanent. E-525 and E-527 are that good case. The sharp edge is the one E-536 named, and this correction is an instance of it: the sentence being fixed above was a wrong reason and not a stale measurement, and it was fixed in place anyway, because the entry's whole subject is a boundary stated precisely and a second entry correcting the first would have left the wrong one standing. No diff of any form separates the two. The rule and its gate step are being written into §6 on their own branch, so that this entry points at them rather than reconstructing them.

### The fourth gate range is thirty-five, because twenty-five is one number wider than the largest cut
`E-700` · gate · wave-4 ranges, sizing

**Context.** Wave 4 runs `oauth`, `email-flows`, `plugin` and `client` in parallel, and every one of them needs a reserved block before its writer starts. The gate needs one too: its third block has a single number left, E-538 being the last taken, so this branch cannot write its own entries without cutting a new block first. The brief proposed fifty-five, forty, thirty-five and thirty for the four features and twenty-five for the gate.
**Rejected.** (a) Twenty-five for the gate, as proposed. (b) Continuing inside the second gate block, which has nine unused numbers behind its last entry.
**Reason.** The four feature figures survive the measurement — wave 3's ranges came in at 40/60, 17/25, 27/45 and 35/45, so a band of thirty to fifty-five with the same shape has room in it, and `oauth` at fifty-five is the only one that could plausibly fill. (a) does not. The gate's first block is exhausted at twenty of twenty and its third stopped one short at twenty-four of twenty-five, and twenty-five against a measured twenty-four is the exact shape §6 already names as a range that ran out: a block that ends on its last number is not a snug fit, it is what running out looks like from outside. Thirty-five is one step above the largest cut observed. (b) is what §6 forbids by construction — the second block's remainder is a gap left when the seam cut had to take a disjoint range beside it, and reaching into it now would put this branch's numbers inside a block whose row says `second range`, where a reader looking for the fourth cut's decisions would not find them.
**Price.** One number of the third block and nine of the second are permanently unreachable, and this branch adds a fourth block that will probably not fill either — three gaps in the gate's numbering against one avoided mid-branch stop. §6 already says contiguity is worth nothing here, and this is the entry that spends that licence rather than assuming it.

### Two of the six wave-3 figures in the brief were stale, and one of them was never true
`E-701` · gate · measurement, finding

**Context.** The brief carried measured wave-3 consumption to size wave 4 against: `auth-core` 39 of 60, `rate` 17, `factor-totp` 27, `factor-webauthn` 35, the gate's second range 10 of 20 and its third 24 of 25. It also said to count them again rather than trust them, because an earlier rules change shipped two stale counts and a third that had never been measured.
**Rejected.** Taking the six figures as given, which would have cost one script and produced a sizing argument off by two.
**Reason.** Counting the entry headings of `CASE-STUDY.md` on `main` with the same two patterns `test/decision-log.test.ts` parses gives 40, 17, 27, 35, 11 and 24. Four agree. The gate's second range was 10 until the relicensing branch added E-505 and has been 11 since; that figure is stale rather than wrong, and it is the same failure E-496 recorded — a number measured at a branch point and not re-taken when the base moved. `auth-core` is the one that was never true: it has held 40 at every merge since wave 3 landed, so 39 was not measured at any point in the history and was not a stale reading of anything.
**Price.** Neither correction changes a range. Both figures are inside the band the four feature reservations were argued from, so the sizing would have come out identical had the count never been re-taken — which is the uncomfortable half, because it means the discipline that caught them was not load-bearing this time and there is nothing to show a reader why it should be kept.

### The four wave-4 chapters were re-argued from the file's rule, and none of them moved
`E-702` · gate · the reference, partition

**Context.** §5 sanctions `DOCUMENTATION.md` as a shared file only because it is partitioned by chapter, and the partition has to exist before the wave. E-497 established that the file's order is neither merge order nor plain architecture numbering but dependency order — everything a chapter uses stands above it — with architecture numbering as the tie-break and, where two chapters neither uses the other, the wider of them read second. The brief proposed Email flows and then OAuth after WebAuthn, Plugins after The instance, and The client last.
**Rejected.** Accepting the four positions on the brief's argument, which for Email flows was only that it must precede OAuth.
**Reason.** That argument fixes Email flows below OAuth and says nothing about where the pair sits relative to the two factor chapters, and on dependency alone the pair could have gone directly after Sessions. What holds it below WebAuthn is two dependencies the brief did not name and the architecture does: whether deleting a password credential leaves an account with no way in is decided by a count that includes every WebAuthn credential (3.15 B.7), and `password.redeemResetWithRecoveryCode` (3.15 B.4) is a reset that consumes a recovery code rather than a mailed token, so the reset family cannot be read whole before the chapter that owns recovery codes. Plugins and The client hold as proposed: 3.11's four contributions are contributed *to* the assembly and the collision that refuses them is a start error, and 3.15 E's client is built by iterating a route table the assembly composes and a plugin extends. All four positions survive; the argument for one of them is not the one that was handed over.
**Price.** The rule now has three tests in it — dependency, then architecture numbering, then width — and the second and third were not needed for any of these four, which means they are still untested by anything but E-497's re-check. The next chapter that genuinely turns on a tie-break will be the first to exercise them, and this entry is the second in a row to report that the rule produced the right answers without the reader learning which clause did the work.

### The sentence this cut was sent to correct was not in the file, and the one that was is different
`E-703` · gate · the reference, finding

**Context.** Moving `## The instance` off the end was expected to falsify its stub sentence, *"It stands last because it is the assembly point"*, and the correction of that sentence was handed to this cut as work `auth-core` had finished with. The sentence is not in `DOCUMENTATION.md`. It was in the wave-3 stub, and the stub told its writer that removing the paragraph was the first thing the feature does; `auth-core` did exactly that.
**Rejected.** Reporting the sentence as already absent and changing nothing, which is what a literal reading of the assignment permits.
**Reason.** A different sentence in the same paragraph is false for the same reason, and it is the sentence a reader actually meets: the chapter says the instance "builds the modules the chapters above describe". Plugins now stands below it and the plugin registry is a module the assembly builds and freezes, so *above* was the wrong word the moment the stubs were cut. It reads as `other`, and the two chapters that stand below are named with the reason they do — a plugin is refused at start, and the client is derived from the finished table — because a reader who has just been told the file runs in dependency order needs to know why two chapters break the pattern.
**Price.** Finding it cost a search for a sentence that was not there, and what the search turned up is that the stub sentences are the only place the ordering rule is written and the first writer to touch a chapter deletes them — four went that way in wave 3, three more will in the wave that fills these. So the rule is now stated once above the index, where nothing removes it, and the price of *that* is a rule about how this file is arranged sitting in a file shipped to people who did not arrange it. It earns its place by being useful to a reader as well: it says why the chapter they want may be further down than they expect. The stubs keep their own sentences anyway, which is a second statement of the same rule and will disagree with the first the day someone changes one of them.

### The rule two entries had to reconstruct is now stated where a writer reads it
`E-704` · gate · §6, rule

**Context.** E-536 argued that a fact omitted from a list may be added to an unmerged entry, and E-538 argued that a measurement may be restated in it, each from first principles and each on the branch that needed the licence. Neither could cite a rule, because §6 states only the strong form — the log is written during the build so that the reasons are the actual ones — and a reader applying that strong form to an unpublished entry gets the opposite of what it wants.
**Rejected.** (a) Leaving it in the two entries, since both are in the log and both are findable. (b) Writing only the permission, without the edge.
**Reason.** (a) puts the rule in the one document that is a record rather than a brief. A writer reads §6; nobody reads E-538 before deciding whether to fix a number in their own draft, and the two who needed the rule had to derive it. (b) is the version that would be abused. The permission and the thing it does not cover are one sentence apart — a measurement may be restated, a reason may not — and no diff separates them, so the paragraph that grants the licence is also the only place the limit can live. E-538's own price is the worked example: it corrected a wrong *reason* in place, said so, and that is the shape of a disclosed exception rather than a precedent.
**Price.** The rule is unenforceable in exactly the half that matters most. The gate step behind it sees only whether a line that predates the branch survived; a reason quietly improved on the branch that wrote it passes every check this repository has and every one it could have. What has been bought is that a writer who does it now knows they are doing it, which converts an ambiguity into a choice and nothing more.

### The mechanical half of §6's rule is one number, and the check refuses rather than reports it as zero
`E-705` · gate · the log, check

**Context.** E-538 named the property and left it unbuilt: `git diff <merge-base>...HEAD --numstat -- CASE-STUDY.md` must report zero deletions, which is §6's "an entry that existed at the merge base is never edited" in a form a script can read. Nothing enforced it, and §5's gate list asked a human to read three files instead.
**Rejected.** (a) A `git log -p` walk per commit, which is what actually showed the three in-branch edits E-538 found. (b) Letting the check pass when `origin/main` is absent, which is the state a shallow CI checkout is in.
**Reason.** (a) answers a different question. The per-commit walk sees every edit including the ones the branch made to its own entries, and §6 permits those — a check built on it would fail the case the rule allows and would have to carry a list of exceptions no diff can compute. The merge-base form is blind to exactly the permitted case and to nothing else. (b) is the failure this repository has now recorded six times: a check that computes nothing and reports success. So the base is resolved first, the merge base is computed first, and either one missing exits non-zero with the reason — the CI job that runs it was given `fetch-depth: 0` because of that refusal rather than the refusal being softened to fit the job.
**Price.** The check is one `git diff` and it is worth exactly the base it is given. `VELVE_LOG_BASE` exists so a branch cut from a dev branch can name its own base, and a writer who points it at their own tip gets a green check that proves nothing. That is the same hole every base-relative check has, and nothing here closes it; what the refusal buys is only that the hole has to be opened deliberately.

### The check's claim is about deletions, and the branch that never opens the log satisfies it perfectly
`E-706` · gate · the log, check

**Context.** The question asked of every new check here is what it claims and whether something near it is claimed by nothing. This one claims that no line the log held at the merge base was deleted or rewritten. A branch that never touches `CASE-STUDY.md` at all satisfies that with zero deletions and zero additions, and §5's gate list wants the opposite of that branch — the log extended for the feature.
**Rejected.** (a) Leaving the second property to the gate list, where it is a human reading three filenames. (b) Requiring an addition unconditionally.
**Reason.** (a) is what has been in place for four waves, and §5 already records three times that a coverage step performed by a person is worth what the person remembered. The addition count is in the same `--numstat` output the deletion count comes from, so the second claim costs one comparison. (b) would fail on `main` itself, where HEAD is the merge base and there are no commits to have written an entry in — so the condition is commits ahead of the merge base, not additions alone, and a run with nothing ahead says so rather than passing silently.
**Price.** The two claims are now one script, and they answer to different rules — §6 for the deletions, §5's definition of done for the additions. A branch that legitimately has nothing to record, if one ever exists, has no way past this except an entry saying it had nothing to record, which is not the worst outcome but is a rule invented by a check rather than by §5. The check also cannot tell an entry from a line: a branch that adds one word to the log passes the second claim.

### Three plants, three predictions, and the one that had to pass
`E-707` · gate · the log, check, evidence

**Context.** §5 says a check is not trusted passing until it has been shown failing on a planted fault, and E-527 added the harder half — a plant confirms a claim and cannot find one nobody made. `check:log-append` makes two claims and has one deliberate blind spot, so all three were planted rather than only the first.
**Rejected.** Planting only the deletion, which is the fault the check exists for.
**Reason.** The blind spot is the part a reader is most likely to mistake for a bug, so it was planted to be seen passing rather than argued from the diff algebra. Removing `**Rejected.**` from E-538, an entry that predates this branch, and committing it: the check printed the line back and exited 1. Restating a measurement inside E-701, which this branch introduced, and committing it: the check printed `+56 -0` and exited 0, while a diff over the branch's own last two commits printed `17 1` — the edit is real, the merge-base form cannot see it, and §6 permits it. A branch cut from `main` with one commit that never opens the log: `CASE-STUDY.md gained no line across 1 commit`, exit 1, which is the claim §5's gate list had been making by hand. A fourth run with `VELVE_LOG_BASE` naming a ref that does not exist refuses instead of passing.
**Price.** The second plant proves the blind spot exists and proves nothing about whether it is the right blind spot; that argument is E-538's and this entry only carries it. And the whole set is aimed at properties that were stated before the plants were written, so it inherits exactly the limit E-527 named — if a fourth property of this check is unclaimed, three green plants and one red one are the reason nobody looked for it.

### The two command lists are asserted against the script now, not read against it
`E-708` · gate · the rules, check

**Context.** §5's gate list and §9's command list both name what `pnpm gate` runs, and both have fallen behind it three times: `check:sql-collapse` was in neither, `publint` and `attw` were missing from §5, and E-495 recorded the second of those as the defect the commit fixing the first had walked past. E-495 named the check that would end it — the scripts in `pnpm gate` appear in both lists — and handed it off, because `test/` was owned by another branch at the time.
**Rejected.** (a) Reading the lists against the script again, which is what every previous pass did. (b) Deriving one list from the other, or from `package.json`.
**Reason.** (a) has now failed three times in a row and failed once inside the commit that was fixing it, which is as clear a measurement as this repository has of what a careful reading is worth. (b) is what E-537 rejected for the packaging list and the argument carries: a list generated from the script asserts that the generator ran, and stops being a second statement of intent that can disagree. What is written instead is six assertions over the three sets — §5 must equal the script both ways round, §9 must contain it and name nothing beyond four declared exceptions, every name in either list must resolve to a real script, every `check:` script must resolve to a file that exists, and every gate step must appear in `ci.yml`. The last one is not about the lists at all: a step in the script and absent from the workflow runs only for whoever runs the gate locally.
**Price.** The four exceptions in §9 are a hand-maintained constant in a test written to end hand-maintained lists, and adding a script that the gate deliberately does not run means editing it. That is the right trade only as long as the set stays small; if it grows the constant becomes the list that drifts, one level further from where anybody reads.

### §9 keeps four commands the gate does not run, and the test says which four
`E-709` · gate · the rules, scope

**Context.** The instruction for this cut was that both lists name every command `pnpm gate` runs, verified in both directions, and that neither list names anything the gate does not run. §5's list satisfies that literally: twelve steps, twelve bullets, no surplus. §9's does not and should not — it names `format`, `test:nightly`, `test:release` and `gate` itself, and its own heading is `Commands`, not `The main gate`.
**Rejected.** (a) Cutting the four from §9 to satisfy the second direction as written. (b) Adding `pnpm test:release` to the gate so that naming it in both lists becomes consistent.
**Reason.** (a) removes the only place a writer is told how to run the formatter and the two tiers section 6 puts on a schedule; §9 is the reference a writer opens before starting, and a reference that lists only blocking steps is a worse document for a rule about drift. (b) is what E-535 rejected on grounds that have not changed — the release tier restarts a process and removes an optional dependency, and putting that on every commit is how a blocking tier becomes one people learn to skip. So the second direction is enforced where it is true, §5, and §9 is held to a bounded form instead: the gate's steps plus exactly four names, listed in the test with the reason each is out.
**Price.** The rule is now different in the two lists, and a reader of §9 cannot tell a blocking step from a scheduled one by looking at it — the four are not marked in the file, only in the test. Marking them would put a second statement of the same fact in the document, which is the drift this cut was sent to close; leaving them unmarked means the distinction lives in `test/gate-commands.test.ts`, which is not where anyone looks for it.

### E-702's reason asserts a guard on `S-LINK-4` that the specification does not have and must not have
`E-710` · gate · E-702 corrected, security

**Context.** E-702 argued that Email flows stands below WebAuthn because "whether deleting a password credential leaves an account with no way in is decided by a count that the Identity and WebAuthn chapters state between them", and the stub said the same. The count is L-13, and 3.15 B.7 and 3.16 put it on exactly two operations — `factor.webauthn.remove` and `identity.unlink`, which are the two rows carrying `last_sign_in_method` in the precondition table. `S-LINK-4` deletes a password credential and is not one of them. 3.16's L-12 states the deletion unconditionally and says why: nothing is lost but an access nobody ever proved.
**Rejected.** (a) Editing E-702's reason, which is what was asked for and what §6 forbids on this branch — a reason may not be restated in place, only a measurement. (b) Deleting the sentence from the stub and leaving the log alone.
**Reason.** (a) is E-497's situation exactly. That entry found E-150's premise invented, refused to edit it, and wrote the correction as a new entry because removing the evidence that a placement was argued from a false premise is the retroactive rationalisation §6 exists to forbid. The same reasoning binds harder here, on the branch that wrote the rule. (b) leaves the dangerous claim in the file `email-flows`' writer is briefed from indirectly. So: the stub is rewritten, and this entry is why. L-12's attack is a pre-account whose only credential is the attacker's password, so a flow that declined to delete it for leaving no way in fails closed on precisely the account shape GHSA-qq9h-g4jm-xgf3 targets, and CVE-2026-53516 comes back. The guard is not merely unspecified, it is specified against: `T-LINK-4` fixes `password_credential` at **0 rows** on the attacker path as a threshold running on every commit, so the check would turn a blocking test red rather than fail quietly. The reference states L-13 correctly in two other places already; E-702 introduced a third that disagreed with both. And B.7's actual clause about email flows is the opposite of the one cited: a confirmed address is **excluded** from the count, although a magic link works with one.
**Price.** The placement does not move and the correct reason was found by neither the writer nor the briefer: `signIn.magicLink.redeem` returns `SignInResult`, whose `second_factor_required` branch carries `availableFactors` over `"totp"`, `"webauthn"` and `"recovery"` (3.15 C.1), so a magic link can end in the pending state offering a factor the two chapters above define. Two wrong arguments produced the right position twice in a row, which is the second time this cut has recorded that and is not reassuring. E-702's reason stands in the log as written, so a reader who stops there reads a security claim that is false; only this entry says so.

### The CI assertion was a substring search and passed two faults it exists to catch
`E-711` · gate · E-708 corrected, check

**Context.** E-708 claimed six assertions over the command lists, the sixth being that every gate step appears in `ci.yml`. It was written as `workflow.includes("run: pnpm " + name)` — a raw search over the file's text — and had been planted against only in the form that removes the line entirely.
**Rejected.** Parsing the workflow with a YAML library, which would be a seventh dependency and a decision of its own.
**Reason.** Two shapes defeated the search and both were planted after the fact. Commenting a step out leaves `#   run: pnpm knip` in the file, the substring is still present, all six assertions pass and CI no longer runs it. Replacing `run: pnpm test` with `run: pnpm test:release` leaves `"run: pnpm test"` a substring of the longer line, all six pass, and the blocking test tier is gone from CI — `test` is the one gate step with a longer sibling, which makes it the most consequential one to shadow and the only one where this shape is reachable. What replaces it reads the script name off an anchored `run:` scalar and compares the whole set against the gate script plus `install`, so a step that is commented out is missing, a shadowed one shows the sibling and not the step, and a step rewritten as a bare `node` call is missing too.
**Price.** Set equality means a legitimate CI-only `pnpm` step has to be added to a constant in the test, which is the same hand-maintained list E-708's own price already flagged, now two lists long. And the anchor is a regular expression over YAML, not YAML: a step nested where the workflow does not run it would still read as present. The honest summary is that E-708 asserted the property and did not plant against it, which is exactly what §5 says makes a green check untrustworthy, and it took an outside reader to run the plant.

### What `check:log-append` actually prevents is a conflict resolved badly, not the case that motivated it
`E-712` · gate · E-705 extended, motive

**Context.** E-705 and the branch that carries it justify the step from E-538 — an entry rewritten on its own branch — and the step is structurally blind to precisely that case. Stated that way the check reads as protection against something it cannot see.
**Rejected.** Leaving the motive where it was, since the property the step checks is the same either way.
**Reason.** The realistic loss is a merge, not an edit. Four features append to `CASE-STUDY.md` in every wave, `main` advances while a branch is open, the branch merges it, and the conflict in the log is resolved by keeping one's own side. The sibling's entries are gone, the branch is green, and the sibling merged days ago — there is no other detector for that, and it is a routine mistake rather than a disciplinary one. Simulated against this branch it names the dropped lines and exits 1. That argument now sits in §6 beside the rule rather than only in the log, because it is the reason a writer should care about the step.
**Price.** The motive changed and the check did not, which means the check was built for the weaker of its two reasons and happens to serve the stronger one. Nothing about that was designed, and if the two had pointed at different properties the step would be aimed at the wrong one.

### Eleven gate steps read the working tree and the twelfth reads committed history
`E-713` · gate · the log, check, reading

**Context.** Every other step of `pnpm gate` reads the files on disk. `check:log-append` reads `git diff`, so a line deleted from `CASE-STUDY.md` and not yet committed is invisible to it: `git diff` reports `0 1` and the check reports `+80 -0` and exits 0.
**Rejected.** (a) Diffing the working tree as well, so the check answers for both. (b) Saying nothing, since CI runs on a pushed commit and nothing uncommitted can reach `main`.
**Reason.** (b) is true about `main` and false about the writer. §5 puts `pnpm gate` in front of a writer as the definition of done, and a writer watching eleven checks report on their working tree has no signal that the twelfth does not — the failure is a wrong belief, not a wrong merge. (a) would make the check report on a state that is not what merges, and a check that answers about two different things at once is how a green run stops meaning anything. So the reading is stated instead: §9's entry says it reads committed history, and the success line says `committed` where the number is.
**Price.** A clause in a command list and one word in an output line against a property nothing enforces. A writer who deletes a line and does not commit still gets a green gate, and the only thing standing between that and a bad merge is that committing is what they do next.

### `measurement` was the load-bearing word in a new rule and had no definition
`E-714` · gate · §6, rule

**Context.** The rule this cut wrote into §6 turns on the difference between a measurement, which may be restated in place before merge, and a reason, which may not. Neither word was defined. The distinction had already needed adjudicating once — E-538's writer had to decide whether a sentence was a stale measurement or a wrong reason and concluded it was the second — and four writers are about to apply the rule unsupervised.
**Rejected.** (a) Leaving it to judgement, on the argument that the entry itself says no diff separates the two cases. (b) Enumerating the permitted edits.
**Reason.** (a) confuses two things. That no *check* can separate them does not mean no *writer* can, and the writer is the enforcement — leaving the term undefined removes the only enforcement there is. (b) cannot be written: the set is open. What is written is the narrow side, because the narrow side is the exception: a measurement is a number or a count the entry states about the work, and everything else is a reason. The clause that matters most is the one naming what looks like a measurement and is not — a statement about what the specification says is checkable and is still a reason, which is the case E-710 turned on the same day.
**Price.** A definition narrow enough to be usable is narrow enough to be wrong at the edges, and the first entry that wants to fix a misspelt route name or a wrong file path will find that neither is a number and both are therefore reasons. That is the intended answer and it will read as pedantry.

### The configuration seam was the one PR #28 missed, and it would have put two writers in one file
`E-715` · gate · wave-4 seams, partition

**Context.** `BaseConfig` in `core/auth/config.ts` had no `oauth` field and no `plugins` field. Two of wave 4's three features need one each, so as it stood both writers had to edit the same file — which §5 forbids outright. PR #28 opened the three route seams and this one was not among them.
**Rejected.** (a) Leaving it and letting the two writers coordinate. (b) Declaring the fields as `unknown` placeholders so the types stay the owning feature's to write.
**Reason.** (a) is the failure this whole cut is about. §5 says a feature that needs a change outside its area stops and reports, which is a safeguard when the partition is complete and a stall when it is not — and a four-way wave has no slack to absorb a quarter of it stopping mid-feature. The rule is enforced by the partition existing beforehand, not by any check; nothing would have caught the collision until two branches conflicted. (b) buys nothing: 3.15 A.8 and G write both types out in full, so a placeholder would be replaced by the same declaration a week later and every reference to it rewritten in between. So the real types are declared, in the feature's own file — `core/oauth/config.ts` and `core/plugin/config.ts` — and `core/auth/config.ts` gains two optional fields and nothing else for the rest of the wave.
**Price.** This cut now writes types for two features it does not own, which is the thing §5 exists to stop, and the writers inherit declarations they did not argue. Three deviations from the specification's text ride along and are the writers' to revisit: `storeTokens` is optional rather than required, because 3.10 makes `false` the default and a required field is not a default; G's `any` in `PluginRoute` is `unknown`, which §3 requires and `AnyRoute` already sets as the form; and `plugins` is declared and read by nothing, since `pluginRoutes` is the seam that will consume it.

### The API snapshot passed against a stale `dist/`, and only the build made it fail
`E-716` · gate · the snapshot, finding

**Context.** Adding six exported types to `src/index.ts` should change the public surface, and `test/api-surface.test.ts` compares `dist/*.d.mts` against a committed snapshot. Run directly with `npx vitest`, it passed. The snapshot is real and the surface had changed; what it read was a `dist/` built before the change.
**Rejected.** Taking the green run as evidence and moving on, which is what the run looks like.
**Reason.** The test reads `dist/`, and `package.json` puts the build in front of it as a `pretest` hook — so `pnpm test` rebuilds and `npx vitest run test/api-surface.test.ts` does not. Rebuilding first turned it red with exactly the six names, and the snapshot was then updated deliberately, which is what §5 means by the surface not changing unannounced. The test guards `dist/` being absent and cannot guard `dist/` being old; the freshness lives in a lifecycle hook, one file away from the assertion that depends on it.
**Price.** Nothing here fixes it. A writer who runs a single test file directly — which is the normal way to iterate — gets a green snapshot for a surface they have just changed, and the only thing that reveals it is running the gate. This is E-532's shape a second time: the snapshot compares two things faithfully and one of them is not what the branch has.

### The two new options were unclassified, and the detector list is in a file neither writer owns
`E-717` · gate · S-DEFAULT-1, finding

**Context.** Adding `oauth` and `plugins` to `BaseConfig` turned `test/auth-startup.test.ts` red: E-331 made `SECURITY_OPTIONS` cover every key of the option type rather than only the security-relevant ones, and the test reads the keys out of the type's source. Two rows were missing. That is the check working — the gate was told to keep `startup.ts` in view and did not have to, because the check found it first.
**Rejected.** (a) Classifying the two options and stopping there, which is what turns the test green. (b) Leaving both to their features.
**Reason.** (b) is the collision this seam exists to prevent, one level down: `SECURITY_OPTIONS` and `DETECTORS` are both in `core/auth/security-options.ts`, which belongs to `auth-core` and to neither wave-4 writer, so leaving the rows out would have sent both of them into the same foreign file for the same reason the config field would have. (a) is worse than it looks, because the two lists are not the same list. `SECURITY_OPTIONS` is what an operator can read; `DETECTORS` is what the start-up report actually says about *this* installation. Classifying `oauth` as weakened by a `trustedProviders` entry and writing no detector means an installation that names a trusted provider is classified and not reported. Both rows and both detectors are written, and the detectors read `config.oauth` and `config.plugins` even though the assembly does not consume either yet.
**Price.** Nothing asserts that an option whose `weakenedBy` is not "nothing weakens it" has a detector. The test checks that every key is classified and stops there, so the gap this entry just closed by hand can reopen silently the next time an option is added — which is E-352's shape and the third instrument this branch hands off. Making it mechanical means the row carrying its own detector rather than the two lists sitting side by side, and that is a change to `auth-core`'s file that is larger than the seam this cut was opening.

### The exported provider map could not express the case it exists for
`E-718` · gate · the oauth seam, finding

**Context.** `OAuthConfig.providers` was written as 3.15 A.8 writes it: `Partial<Record<KnownProvider, ProviderCredentials>>` intersected with an index signature over `GenericProviderConfig`. The intersection applies the index signature to the named keys as well, so `{ google: { clientId, clientSecret } }` fails with `TS2322` for three missing endpoint fields. The generic case compiled, the plugin types compiled, and the primary case — a named provider configured with credentials alone — did not.
**Rejected.** (a) Shipping the shape the specification writes, on the grounds that it is the specification's. (b) Two fields, `providers` and `genericProviders`, which would have typed cleanly.
**Reason.** (a) is not available: 3.15 A.8 is pseudo-code stating an intent, this is an exported type on `main`, and §3 requires the public interface to be usable without reading the documentation — a type that cannot be instantiated for its stated purpose fails that on the first line a user writes. (b) changes the surface 3.15 A.8 describes and would have to be argued as a deviation rather than a repair; the intersection is repairable by widening the index signature to `ProviderCredentials | GenericProviderConfig`, which is one token and keeps the shape. What the type then stops enforcing is that an unknown id carries its own endpoints, so that moves to the start: `oauth_provider_incomplete` refuses an id the library has no endpoints for, which is the failure mode 3.11 already prefers for a name it cannot resolve.
**Price.** A constraint moved from compile time to start time, which is later and weaker — a caller learns at the first `createVelveAuth` rather than in the editor. `KNOWN_PROVIDERS` is now a runtime list beside the `KnownProvider` union and the two can disagree; nothing checks that they hold the same fourteen names. And the type still admits a credentials-only entry for an unknown id, so what the reader sees in the editor is wider than what the library accepts.

### Three more files two writers each would have had to edit
`E-719` · gate · wave-4 seams, partition

**Context.** The config seam of E-715 was one level too high. `oauthRoutes`, `emailFlowRoutes` and `pluginRoutes` are called by the assembly and each takes `RouteServices` and nothing else, and that interface carried nine fields — none of them a key provider, a clock, a mail callback, a one-time-token service, the resolved OAuth configuration or the plugin list. `UserRepository` had no `createUser`, which S-LINK-2 requires in so many words, and no address writes. `PluginRoute` was typed against a closed `VelveErrorCode`, so a plugin could not declare the namespaced code 3.11 grants it.
**Rejected.** (a) Leaving each to the feature that first needs it. (b) Widening `RouteServices` to `unknown` fields the features narrow themselves.
**Reason.** (a) is the same collision as E-715 one level down and worse, because it is three files rather than one: `RouteServices` and its literal in `instance.ts`, `UserRepository` and its literal in `user.ts`, and `error-map.ts` — all of them `auth-core`'s, none of them any wave-4 writer's, and each needed by two or three of them for unrelated reasons. (b) makes every use of a field a cast and moves the collision into the casts. So the fields are declared with their real types and populated by the assembly; the three writing methods on `UserRepository` are written and work; and the error union is answered by E-720.
**Price.** This cut has now written the shape of three features' inputs without building any of them, and every one of those shapes is a guess that reads as a decision. `createUser` takes a `usernameKey` the caller normalises, which fixes where normalisation happens for a feature that has not started; `fetch` is optional and nothing defaults it yet; `oneTimeTokens` is constructed for every instance including the ones that never issue a token. The gate found all three of these by reading; nothing in the repository would have found them, and there is no check that says a seam module can reach what it needs.

### A plugin's error codes are resolved, not admitted into the union
`E-720` · gate · error codes, decision

**Context.** 3.11 lets a plugin contribute its own error codes and 3.15 G types them `` `${Id}.${string}` ``. `VelveErrorCode` is a closed literal union and `VelveError`'s constructor indexes two `Record<VelveErrorCode, …>` tables with it, so a namespaced code could not be constructed, could not be given a status and could not be declared on a plugin route. §3 says one file decides what the outside learns, so the fix could not be anywhere but `error-map.ts` — and it had to be settled before the wave, because `plugin` cannot start without it and `oauth` will likely add to the same union.
**Rejected.** (a) Widening `VelveErrorCode` to include `` `${string}.${string}` ``. (b) Letting the plugin registry carry its own table, resolved in the HTTP layer.
**Reason.** (a) destroys the union: every exhaustive `switch` over an error code stops being exhaustive, and the two tables stop being total maps that the compiler checks. (b) puts a second decider next to `error-map.ts`, which is precisely what §3 forbids, and §3's point is that one file decides — not that the union is a closed literal. So the union stays closed, `AnyErrorCode` is the union plus the namespaced form, and a single `resolveErrorCode` answers both: the core code from the two tables, a namespaced one from a registry this file owns. An unregistered namespaced code answers as `internal_error`, so a code that was never declared cannot leak a message.
**Price.** The registry is process-wide, and that is a real limitation rather than a detail: two instances in one process share it. A second registration of the same code with a different answer is refused rather than silently winning, which converts the collision into an error, but two instances that legitimately want different text for the same code cannot both have it. Moving the registry onto the instance means `toErrorBody` and `VelveError.httpStatus` both taking it, which is a change to the response path this cut did not want to make on three features' behalf.

### A test asserted an emptiness three features each have to break
`E-721` · gate · the seam test, finding

**Context.** `test/auth-route-seams.test.ts` asserted that the three seam modules return nothing today. That was true when it was written and it is a cross-feature dependency in disguise: the first of `oauth`, `email-flows` and `plugin` to merge turns it red for the other two, in a file no wave-4 feature owns and may edit.
**Rejected.** Leaving it and letting the first feature to merge delete it, which is what would have happened.
**Reason.** The failure is not a merge conflict — it is a red gate on two branches that changed nothing, caused by a third that did what it was asked. The property the file exists for is that the assembly calls all three seams and includes what they return, and the probe mocks in the same file already test exactly that by making each seam contribute a route and calling it end to end. The emptiness assertion adds nothing to that and costs two features a stop.
**Price.** Nothing now fails if a seam module is deleted and replaced by a function returning `[]` for good; the probes prove the assembly calls what is there, not that anything is there to call. That is the correct trade only while the three features are unbuilt, and the assertion that replaces it — each seam answers with an array — is close to vacuous. It is kept because a seam that returns `undefined` would break the composition and nothing else says so.

### `oauth`'s width was argued from four options that all carry a requirement number
`E-722` · gate · the ranges, finding

**Context.** The sizing paragraph for `oauth` claimed 3.10 and 3.15 A.8 hand it "seven options with no `S-` number behind them", then named four. All four have one: `trustedProviders` is `S-LINK-2`, `storeTokens` is `S-REST-6`, the JWKS allowlist is `S-KEY-7`, `genericOAuth` is `S-REDIR-6`. The count of seven was never enumerated either. It sits in the file four writers read as their brief.
**Rejected.** (a) Cutting the range, since the argument for fifty-five was partly false. (b) Replacing "seven" with "three" and leaving the shape of the argument.
**Reason.** (a) tests the wrong thing: the claim was false and the width is still defensible on what is true. `S-LINK-1` to `S-LINK-7` is checkable — 5.11 lists exactly seven — and so are T-LINK-2's twelve cases and T-REDIR-2's hundred and twenty vectors. (b) keeps the premise that an option with a requirement number needs no entry, and that premise is what produced E-710 on the same branch: `S-LINK-2` has a number and its three conditions are still where a plausible relaxation reintroduces a CVE. So the paragraph now says what is countable, says explicitly that any total across requirement classes is a judgement because the specification draws no feature-to-requirement map, and drops the claim that a requirement number removes the need for a decision.
**Price.** The width now rests on a judgement the paragraph admits is a judgement, which is weaker to read and is the honest state. The same overclaim shape — a number offered where none was counted — is now the third instance on this branch after E-701's two stale figures and E-700's own wrong one, and all three were caught by a reader rather than by anything mechanical.

### E-710 quotes E-702 with a sentence E-702 does not contain
`E-723` · gate · E-710 corrected, finding

**Context.** E-710 opens by quoting E-702 as arguing that "whether deleting a password credential leaves an account with no way in is decided by a count that the Identity and WebAuthn chapters state between them", and says the stub said the same. The quotation is the stub's. E-702 reads "a count that includes every WebAuthn credential (3.15 B.7)". A per-commit walk over `CASE-STUDY.md` shows E-702 was never edited, so the misquotation was wrong when it was written rather than made stale.
**Rejected.** Restating the quotation inside E-710, which is where it sits and where a reader meets it.
**Reason.** E-714 defines a measurement as a number or a count the entry states about the work, and a quotation is neither — so under this branch's own rule it is a reason and may not be restated in place. The substance of E-710 is unaffected: both sentences carry the same false premise, both were corrected, and the security argument was re-verified line by line against 5.11, 3.15 B.7 and 3.16. What is wrong is only which text the correction attributes to which document, and that is exactly the kind of error that later resolves to the wrong reading — a reader checking E-710 against E-702 finds words that are not there and cannot tell whether the entry or the log is wrong.
**Price.** The log now holds a correction whose first sentence misattributes a quotation, and a second entry saying so, which is two entries where an in-place fix would have been one clean one. That is the cost the rule in §6 charges, paid here for the first time on a case where paying it is plainly worse for the reader than not paying it would have been. It is paid anyway, because the alternative is a rule that binds only when it is convenient.

### `client` is not in wave 4, because it cannot be partitioned from the other three
`E-724` · gate · wave 4, scope

**Context.** Wave 4 was cut as four features. 3.15 E requires `@velve/auth/client` to carry the route table as a value so that no server core reaches the browser, and the build runs with `unbundle: true`, so every import in a route module survives into `dist/client.mjs`. A handler-free table is therefore not a re-export.
**Rejected.** (a) Running `client` beside the other three and splitting each route's metadata from its handler. (b) A second, hand-written table in the client entry.
**Reason.** (a) touches every route file the other three writers own, which is the collision the whole cut exists to prevent, and it touches them in the week they are being written. (b) is a table that the first of the three to merge makes stale, with nothing to detect the drift — the client would silently offer a route the server no longer has, or miss one it does. Neither is a partition, and §5's exceptions are sanctioned only because a partition exists. Written after the route surface settles, the client is built once against a near-final table. Wave 4 runs three writers, which is under the cap rather than short of a quota.
**Price.** The package ships another wave without the typed client 3.15 E promises, and `@velve/auth/client` stays an entry point that resolves to almost nothing — which is a worse outside picture than a stale table would have been, for anyone reading the exports rather than using them. The reserved row keeps its numbers and changes only the wave it names, which is the one edit to that table the numbering rule permits precisely because nothing has been written into it yet.

### `README.md` becomes the third partitioned file, and its stale sentence was two waves old
`E-725` · gate · the rules, partition

**Context.** Item 4 of the definition of done points a feature at `README.md` whenever the outside picture changes, and wave 4 changes it three times. The file had no partition and one sentence claiming the second factors and OAuth "are being added by the features behind this one" — written before wave 3 and stale since it merged.
**Rejected.** (a) Fixing the sentence and leaving the file unpartitioned, on the argument that a README changes rarely. (b) Removing item 4, so that no feature touches the file at all.
**Reason.** (a) is the state `DOCUMENTATION.md` was in until wave 3, and the argument that a file changes rarely is what made four wave-2 features edit it at the same line. (b) ships a README that describes a library two waves behind. So the same mechanism: three `###` regions under **What works today**, one per wave-4 feature, cut before the wave, each currently saying plainly that the thing is not built. The sentence above them, which says what works end to end, belongs to no feature and is reported rather than edited — that is the region that would otherwise attract all three.
**Price.** A public README now carries three sections whose content is "not built yet", which is honest and is not what a reader arrives for. `§5` has three exceptions rather than two, and the third is the weakest: a README region is a heading with prose under it, nothing reads its structure, and a feature that writes a paragraph above its own region fails no check — the same enforcement gap the `DOCUMENTATION.md` bullet already admits, now doubled.

### The owner-predicate check caught two of the three new statements, and cannot see the third
`E-726` · gate · S-OWNER-2, finding

**Context.** The three writing methods added to `UserRepository` turned `test/db-static-sql.test.ts` red: `setEmailVerifiedAt` and `updateEmail` write `velve.user` with `WHERE id = $1`, and the check looks for `user_id` or the repository's `ownerColumn` in the predicate. That is the check working — a write on a user-owned table with no owner predicate is what S-OWNER-2 is about, and neither statement announced why it needs none.
**Rejected.** (a) Renaming the parameter or widening the check to accept `id`. (b) Claiming S-OWNER-7 as the two existing writes on this table do.
**Reason.** (a) would make every `WHERE id` look like an owner predicate, including on the tables where it is not one, which is the failure the check exists for. (b) is a different reason: `setDisabledAt` and `deleteUser` carry S-OWNER-7 because the caller is the application in its own process after its own authorization decision, and these two are reached from a flow acting on a user it has just resolved. So each carries the marker with its own reason — `velve.user` is the owned row and `id` is its owner column, which is true here and false one table over.
**Price.** `createUser` is not checked at all, and the reason is a regular expression: `CHANGES_ROWS` matches `DELETE FROM` and `UPDATE` and not `INSERT`. An insert has no prior row to own, so nothing is wrong with the outcome, but the exclusion lives in a pattern rather than in a sentence — the test's name says "every row-changing statement" and an insert changes rows. This is the first insert into `velve.user` outside a migration, so the gap has never been visible before. It is reported rather than closed: the file belongs to `auth-core` and widening the pattern means deciding what an insert must say instead, which is a rule that does not exist yet.

### The marker census was pinned at eight, and two legitimate markers moved it
`E-727` · gate · S-REPLAY-2, census

**Context.** `test/token-static-scan.test.ts` asserts that `no owner predicate` appears exactly eight times across `src/`, in exactly six files, and once in the token repository's own statements. The two markers E-726 added made it ten, and the test refused the branch.
**Rejected.** Loosening the assertion to a lower bound, which is what a count that keeps getting in the way usually becomes.
**Reason.** The exact count is the point of it. A marker is the escape from S-OWNER-2, and an escape that can be added without anyone noticing is not an escape, it is a hole; a lower bound would pass for any number of new ones. So the census moves to ten and the file count stays at six, because both new markers are in `user.ts`, which already carried two. Updating a census is not the same as loosening it: the next writer who adds a marker is stopped in exactly the same way.
**Price.** The number lives in `token`'s test file and counts markers in every feature's source, so every feature that legitimately adds one edits a file it does not own — which is the collision this whole cut is about, in a place the cut did not look. `token` finished two waves ago so nobody is competing for the file today, but two wave-4 writers adding a marker in the same week would meet here. Nothing declares that this file is the census's home, and the writer who trips it finds out by reading a failure in an unrelated feature's test.

### Wave 4 is re-cut to one feature, because three rounds of seam-cutting kept finding what the round before missed
`E-728` · gate · wave 4, scope

**Context.** This branch cut a configuration seam, then a second round found three more shared surfaces, then a third found at least seven: `RequestContext` has no `plugin` field and no OAuth state token though `readCookies` already returns one, the seven hook points of 3.11 have no dispatcher and no ordering behind the security middleware, `signIn.oauth.*` and `signIn.magicLink.*` belong to the one `signIn` namespace 3.15 B.1 declares against a hand-written surface in `instance.ts`, `SignInResult`, `SignUpResult`, `OAuthRedirect` and `OAuthCallbackResult` have no occurrence anywhere in the tree, nothing computes `availableFactors`, `mountAuth` takes no overrides, and `src/index.ts` and the API snapshot belong to no feature.
**Rejected.** (a) Cutting the seven, which is what the two previous rounds did. (b) Letting the three features coordinate on the files they share.
**Reason.** The sequence is the argument: none, then three, then seven. A search that finds more each time it is run has not been converging, and the reason it has not is that the thing being searched for is not a set of seams. Those seven surfaces are one coherent layer — the assembly between the services wave 3 built and the flows wave 4 wanted — and it has requirements of its own: 3.15 B.1's return types, 3.15 D.1's `RequestContext`, 3.11's seven hook points with `S-CSRF-6` fixing their position behind the origin check, 3.6's intermediate state for `availableFactors`. A thing with its own requirements that three features all depend on is a feature. (a) would also have meant guessing seven interfaces for code this cut is not writing, which is what produced E-718 and E-719's price. (b) is what §5 forbids and what the whole branch exists to prevent. So wave 4 is the spine alone, and `oauth`, `email-flows` and `plugin` become wave 5, independent once it exists. Every reserved range keeps its numbers and changes only the wave it names.
**Price.** The wave that was cut to remove a stall now contains one writer where three were planned, and the three wait on it — the schedule cost is real and is the direct consequence of having cut the seams wrongly twice first. Four of this branch's own entries are now about seams the spine will rebuild or replace: `RouteServices` gained seven fields that the spine may reshape, and `E-718`'s widened provider map, `E-720`'s error registry and `E-719`'s repository methods were all argued as pre-cuts for features that no longer start next. They are left standing rather than reverted, because they are correct in themselves and because reverting them would remove the record of how the decomposition was arrived at. The honest summary is that three rounds of a check found what two rounds of a writer did not, and the writer is the same one who wrote the check.

### The seam test kept the cast that made it cross-feature, and the assertion it lost was not the cause
`E-729` · gate · E-721 corrected, finding

**Context.** E-721 removed the emptiness assertion from `test/auth-route-seams.test.ts` and left the block it lived in: three modules called from one array literal with `undefined as unknown as RouteServices`. Filling `oauthRoutes` with a single route that reads `services.rateLimit` — which any real route must, because `defineRoute` takes a rate rule — gives `Cannot read properties of undefined (reading 'rateLimit')` and the block goes red. The first of the three features to merge still reddened it for the other two, which is exactly the failure E-721 claimed to have removed.
**Rejected.** (a) Building a real `RouteServices` for the block. (b) Calling the three lazily, each inside its own `expect(...).not.toThrow()`.
**Reason.** Both keep a test that calls three features' code with a fabricated argument, and the argument gets more fabricated with every field those features start reading — (a) is sixteen fields today and a maintenance burden on a file none of them owns, (b) turns the breakage from an error into a passed assertion that proves nothing. The property worth keeping is not that the seams are callable in isolation but that the assembly composes them, and the probe mocks in the same file already test that end to end: replacing each module with a mock that contributes one route and calling it over HTTP. That half is verified — dropping `pluginRoutes` from the assembly reddens both of its tests — and it stays. The block is deleted.
**Price.** Nothing now calls the three real seam modules at all; if one of them were deleted and the assembly's import left dangling, the failure is a build error rather than a test. That is an acceptable trade only because a missing module does not typecheck, and the entry that reasoned about this last time also thought it had made the right trade.

### The two writes reached from a route took a plain string where an `Actor` was the point
`E-730` · gate · S-OWNER-7, finding

**Context.** `setEmailVerifiedAt` and `updateEmail` were declared with `userId: string`. `src/core/db/actor.ts` exists for this: a brand that only a proof of ownership mints, with `actorOfRedeemedOneTimeToken` already described as the provenance a password reset has instead of a session. Every factor repository takes `actor: Actor`. These are the first writes on `velve.user` intended to be reached from a route, and a plain string is what lets a handler pass an identifier out of a request body — which is the whole of S-OWNER-7.
**Rejected.** Arguing the three as an exception on the grounds that the caller is a flow that has just resolved the user.
**Reason.** That argument is true and is not enough. It describes what the caller does today, and the type is what stops a caller doing otherwise tomorrow; the two existing writes on this table escape the brand by carrying S-OWNER-7 in writing and are reached from no route at all, which is a different case. So both address writes take `Actor`. `createUser` does not, and that is the one real exception: there is no owner yet, so no proof of ownership can exist to mint one, and the parameter that would carry it would have to be forged by the caller.
**Price.** `Actor` is a brand over a string, so the runtime is unchanged and the guarantee is only as good as where the brand is asserted — and it is asserted in three places, one of which, `actorOfConsumedOAuthFlow`, has no repository behind it yet. A wave-5 writer who needs an actor and finds no minter for their path can assert the brand with a cast, and nothing in the gate would see it.

### Five counts were wrong in the branch cut to end wrong counts
`E-731` · gate · measurement, finding

**Context.** A comment in `routes.ts` said "the four seam modules" where there are three, and "the five below" where seven fields were added; E-716 said eighteen exported types where the snapshot moved by six; E-715 said PR #28 opened four route seams where it opened three, and named wave 4's four features after E-724 had made them three; E-703 said four more stubs would be deleted in wave 4. All five are measurements, and all five are restated in place under the rule this branch wrote.
**Rejected.** Treating this as five separate slips.
**Reason.** It is the fifth round in which this repository has found miscounted figures, and the four before it each recorded the instance and not the mechanism — E-496 called it a stale measurement, E-701 called it an unmeasured one, E-722 called it an unenumerated one. The common shape is simpler than any of those: **writing a number and checking a number are two actions, and only the first was being performed.** Every one of these five was produced by a writer who knew roughly how many there were, and none of them was produced by counting. The rule that follows is not "count more carefully" but "a number in prose is a claim, and a claim written without the count that produced it is a guess in the costume of a measurement".
**Price.** Naming the mechanism does not install it. Nothing in the gate counts a number written in prose, nothing could without knowing what is being counted, and the next figure will be produced the same way by whoever is in a hurry. What has changed is only that the fifth instance is on record as a class rather than as a fifth accident.

### E-725 puts the stale README sentence before wave 3, and it was written during it
`E-732` · gate · E-725 corrected, provenance

**Context.** E-725 says the sentence claiming the second factors and OAuth "are being added by the features behind this one" was "written before wave 3 and stale since it merged". `git log -S` puts it in `e0bfc1c`, PR #24 — the assembly point — which merged in the middle of wave 3, after `rate` and before TOTP and WebAuthn.
**Rejected.** Restating the clause inside E-725.
**Reason.** A provenance claim is a reason, not a measurement, under E-714, so it is corrected by a new entry. The correction also makes the finding worse rather than smaller: a sentence written *before* a wave is merely old, while a sentence written *during* it by one of its own features was already inaccurate about its siblings when it was committed, and stayed so through two more merges and a gate that lists `README.md` among the files a feature must extend. What E-725 argued from — that an unpartitioned README attracts stale claims — holds either way, and holds harder on the true history.
**Price.** This is the third correction on this branch aimed at a sentence in this branch's own entries, and the second where the corrected claim was about history rather than about the code. The pattern is that claims about the past are being written from memory of what the repository felt like rather than from `git log`, and only one of the three was caught by anything other than a reader.

### E-726's reason is true of the insert it was written about and not of the class
`E-733` · gate · E-726 corrected, finding

**Context.** E-726 reports that `db-static-sql`'s `CHANGES_ROWS` matches `DELETE FROM` and `UPDATE` and not `INSERT`, and argues the outcome is harmless because "an insert has no prior row to own". That is true of `createUser`, which inserts one row from literal values. It is not true of the class: `INSERT … SELECT` reads rows before writing them, and one that selects another owner's rows with no owner predicate writes them under a new owner and is invisible to the check.
**Rejected.** Widening the pattern here.
**Reason.** The correction is a reason and belongs in a new entry. Widening the check is not this branch's to do for a second reason beyond ownership of the file: the rule for an insert is not the rule for an update. An insert of literal values needs no owner predicate, an `INSERT … SELECT` needs one on its select, and a check that demanded one of both would refuse `createUser` for no reason. Whoever widens it writes that distinction first.
**Price.** The gap stays open and is now described accurately instead of being described as harmless, which is the only thing this entry buys. No `INSERT … SELECT` exists in the tree today, so the blind spot has never been reachable — and that is exactly the condition under which a check's gap survives four waves without anybody noticing.

### Four lists that were written twice, and the one that was already wrong
`E-734` · gate · the seams, finding

**Context.** Four pairs of statements in this cut said the same thing twice with nothing holding them together: `KNOWN_PROVIDERS` against the `KnownProvider` union, `instance.ts`'s `ERROR_CODES` against the twenty-five entries of the error map, `registerPluginErrorCodes` writing as it validated, and `RouteServices.fetch` declared against a `BaseConfig` that had no such field — the last of which was not a duplicate but an unreachable one, so E-719's price understated it: the field could not be supplied at all.
**Rejected.** Recording the four and leaving them, which is what the branch had done with the first three.
**Reason.** Removing a second statement is better than checking it where the second statement earns nothing: `ERROR_CODES` is now the error map's own enumeration, so the twenty-five names exist once. Where the second statement earns something it is checked instead: the provider array is what the start-up refusal reads and the union is what a caller writes, so they are genuinely two things and a `Record<KnownProvider, true>` in the test makes the compiler demand every member while the comparison makes the array match it — removing `"dropbox"` from either side now fails, from the array as a test and from the union as a compile error. `registerPluginErrorCodes` validates the whole batch before writing any of it, so a refused definition leaves nothing registered. `fetch` is a field of `BaseConfig`, populated by the assembly and classified in `SECURITY_OPTIONS`.
**Price.** `forgetPluginErrorCodes` is no longer exported from the package, because a public reset of a process-wide registry is a way for one caller to erase another's codes — which leaves the tests importing it from the module directly, a reach into the core that nothing prevents them repeating for something less harmless. And the provider check lives in a test rather than in the type: `KNOWN_PROVIDERS` could still be widened past the union without a compile error, because an array literal of strings satisfies `readonly KnownProvider[]` only where each element does, and the test is what catches the reverse.

### Two censuses this branch moved live in other features' test files and count this feature's source
`E-795` · gate · the censuses, finding

**Context.** E-734 removed `instance.ts`'s second copy of the twenty-five error codes and had it read the error map's own enumeration. `test/session-review-resolution.test.ts` pins which files name `account_disabled` — `auth/instance.ts` was one of four because it restated the codes — and the file stopped naming it, so the census went to three. That is the second census this branch moved: `test/token-static-scan.test.ts` pins how many `no owner predicate` markers exist across `src/`, and E-727 moved it from eight to ten. Neither was found by anyone looking. Both were found by a check refusing the branch.
**Rejected.** Recording each as a local fact of the change that moved it, which is what E-727 and E-734 did.
**Reason.** Together they are a coupling nobody declared. A census counts a property of the whole source tree and lives in one feature's test file, so **any** feature that legitimately adds a marker or removes a code edits a file it does not own to keep the number true — `token`'s file and `session`'s file, for work in `auth`'s. Wave 4 will not feel it, because a wave of one owns everything it touches. Wave 5 is three writers, and a marker added in the same week by two of them meets in `token`'s test file, which is exactly the collision this whole branch exists to remove and is the one place it did not look. The instrument that would fix it is a census that declares what it counts and where it lives, or a census beside the thing counted; neither is written here, because both are changes to two finished features' test files and this cut has already written more of other people's code than it wanted to.
**Price.** A third instrument handed off, on a branch whose own record of hand-offs is now long enough to be its own finding. And the coupling is worse than it reads: a census is a number, so a writer who trips one is told only that a count is wrong, in a test whose name is about somebody else's requirement, with nothing saying they are permitted to change it.

### The branch that wrote the rule bent it in its own last commit
`E-796` · gate · §6, finding

**Context.** §6's rule from this branch says a measurement may be restated in place before merge and a reason may not, and E-714 defines a measurement as a number or a count the entry already states. The last commit of the previous round added a sentence to E-734's Price recording that a census had moved. That is new material in the part of an entry that carries consequence, and it is not a number the entry stated. It was disclosed in the commit message and in the report, and it was still a violation.
**Rejected.** (a) Letting the disclosure stand in place of compliance. (b) Treating the exhausted range as the reason.
**Reason.** (a) is the distinction E-710 drew four hundred lines above and then this branch failed to apply to itself: E-538 was disclosed *and* argued as an exception, and this was disclosed and not argued at all. Disclosure is what makes a violation findable; it is not what makes it permitted. (b) is the part worth writing down, because it is the mechanism rather than the incident. The gate block was full at E-734, so the compliant move — a new entry — appeared to cost a new range, and a new range appeared to cost more than the rule was worth. It costs one table row. §6 already says in terms that a feature which runs out asks for another range rather than borrowing from a neighbour, and the whole point of making that cheap is that it is never worth evading; a rule that yields the moment obeying it costs a row was never a rule. The material is now E-795, in the fifth range, and E-734's Price reads as it was written.
**Price.** Restoring that Price is itself an in-place edit of an entry on this branch, so the per-commit walk shows the line changed twice and returned — which a reader of `git log -p` has to follow to see that nothing was smuggled. The alternative was leaving the added sentence and correcting it by a third entry, which would have made the log describe a violation that was still standing. What is genuinely unrepaired is that no check saw any of this: `check:log-append` is blind to an in-branch edit by construction, that blindness is correct, and the only reason this was caught is that the same reader who checks the numbers reads the diff.

### Translate the specification, and refuse it the last word
`E-820` · skill · source of truth, frozen

**Context.** §1 makes this repository English, and the specification was the one holdout: 4,938 lines of German that every rule, requirement and test id points at. The agent skill written alongside it (`E-821`) sends a reader straight there, and a reader who cannot read German gets sent to a wall. Seven agents translated disjoint line ranges into one file.

**Rejected.** Making the English binding and keeping the German as an archive, which is what "everything here is English" reads like it demands. Also rejected: no translation at all, on the grounds that two files describing one system will drift.

**Reason.** The drift objection is right, and it is an argument for a check rather than against the file. What makes the German binding is not its language but that every decision in this repository was taken against those words; an English file promoted to source of truth would make a translator's choice into a specification, and the translation reports show how often that choice was real — `Vorgabe` is *default* in one clause and *stipulation* in the next, `Session` and `Sitzung` are Better Auth's concept and ours and collapse into one English word. `test/architecture-translation.test.ts` compares heading sequence, the census of every `S-`, `T-`, `L-`, `E-`, CVE, GHSA and CWE identifier, table count with per-table row counts, fenced-block count, and German prose outside code spans and quotations. Five planted faults, five predicted outcomes, five matches; the row deletion reddened two tests rather than the one predicted, because the row carried identifiers — right behaviour, imprecise prediction, recorded as such.

**Price.** The check compares structure and names, not meaning: a paragraph translated into fluent English that says the opposite of the German passes every assertion. Line numbers are not comparable either — German and English wrap differently, so a two-line bullet becomes one — which removes the cheapest alignment property a reviewer would reach for. And the file is now 553 KB that nothing forces anyone to update when the German changes.

### Fourteen defects the translation found in the specification
`E-822` · skill · specification, reported not repaired

**Context.** Translating a document line by line is the closest reading it has had since it was written. Seven translators, each told to carry a contradiction across as written and report it rather than repair it, found fourteen.

**Rejected.** Fixing them in the German while translating. Rejected outright: the specification is binding, a translator is not its author, and a silent repair would have hidden the finding in the same commit that made it.

**Reason.** They are worth naming because several are the failure class `CLAUDE.md` §6 warns about for decision citations — a reference that does not dangle but resolves to the wrong thing. Section 1's summary line for group A reads `26 · 11 · 12 · 3` against rows that count `23 · 14 · 12 · 3`. `I.2` is headed `(44)` and has 54 rows. 3.15 B.4 says "all three writing methods" of a namespace that has four. The silent Argon2id rehash is cited twice as "section 3.3, step 5" where step 6 is meant, against nine correct citations of step 6. 4.1 c) and 4.4 c) map columns their own source-schema tables do not list. T-RATE-1 enumerates twelve vectors and sets a threshold of `20/20`; T-RATE-3 describes three constellations and sets `6/6`; T-REDIR-2 fixes `120/120` over a corpus its own procedure says grows with every finding. 5.7 calls a `/64` prefix "sixty-two-digit numbers of buckets" two lines above the paragraph that states 2^64. 5.10 and 5.13 each claim a different error class is the most productive. 5.19 says a structurally preventing requirement is "named in parentheses" in a table that uses no parentheses for it. Two markdown faults — an unclosed inline-code backtick at 3774 and nested bold at 3049 — render wrongly in the German today.

**Price.** Fourteen known defects now sit in the binding document with nothing scheduled to fix them, and the English file faithfully reproduces every one. Whoever corrects them must correct both files or the translation check will report the correction as the divergence.

### An agent skill that can say no
`E-821` · skill · agent instructions, frozen

**Context.** `CLAUDE-SKILL.md` and `CODEX-SKILL.md` make a coding agent an expert on this library: read the repository live before answering, never invent an interface, name the decided gaps as decisions, and refuse what §2 refuses. The first draft was reviewed twice — once for facts against the specification, once adversarially, by someone told to break it rather than read it.

**Rejected.** Shipping the documentation inside the skill, which would make it self-contained and stale. Rejected: a stale copy of an authentication library's interface is worse than none, because it is confidently wrong.

**Reason.** The adversarial review found eight ways through, and seven shared one shape: **the rule forbade a description rather than an act.** "Present it as though the library supports it", "describe it as support", "soften the refusal into" — a user who volunteers the honest label satisfies every one of them and still gets the thing built. The fix was to forbid artefacts, and to split the refusal in two: a scope decision is the user's to overrule for their own application, and a security requirement is not, because it protects their users rather than them. The factual review found three errors of mine that would have reached a user: section 4 has no Better Auth migration chapter, only five sources; a hash that cannot be carried across is a silent lockout in identity mode `username`, which 4.0.5 counts as `unrecoverable`; and 3.14 does not itself call its list a promise rather than a backlog — the README and this repository's `CLAUDE.md` do. One more of my own rules had a false reason: I wrote that the extension points forbid a roles plugin, and 3.11 grants a plugin its own tables, routes and a `beforeSignIn` veto, which is exactly enough to build one. A rule whose reason collapses on inspection protects nothing, so it now says what is true — a plugin can, it is the user's code, and the library will never adopt it.

**Price.** The instructions are long, and length is itself a failure mode for a file an agent must hold while working. Two of the eight holes are closed by prose rather than by anything checkable: nothing verifies that an agent actually fetched before answering, and nothing stops it summarising a 553 KB file and citing the summary — the instructions name that failure and tell it to download and grep instead, which is an instruction, not a guarantee. `CODEX-SKILL.md` is generated from `CLAUDE-SKILL.md` so the two cannot drift; nothing in the gate enforces that it was regenerated.

### Six more defects, and two of E-822's own claims corrected
`E-823` · skill · specification, reported not repaired

**Context.** `E-822` said the translation found nineteen contradictions in the specification and then enumerated fourteen. The gate counted the list, and it was right: six were reported by the translators and never made it into the entry, and two of the fourteen that did are described wrongly.

**Rejected.** Adding the missing six to `E-822`'s enumeration, and correcting its two mis-descriptions in place. Rejected because §6 permits a **measurement** to be restated before merge and forbids a **reason**: the count was a measurement and has been corrected there, but adding items to the argument is new material in the paragraph that carries consequence. `E-710` and `E-723` set that shape on the branch that wrote the rule.

**Reason.** The remaining six, and they matter for the same reason as the first fourteen. `C.1` is headed "generic OAuth helpers (11)" while the section's own introduction names ten and lists ten. `5.19`'s evaluation calls `S-LINK-1` the requirement that prevents the class with the highest CVSS values; the LINK advisories are 8.3, 8.3 and 7.7, and the table's highest are 9.9, 9.6 and two at 9.1. `4.6` cites section 4.6 from inside its own reasoning. Every pair of `###` sections in section 5 is separated by a horizontal rule except 5.1 → 5.2. Line 4224 begins `#7,` — a wrapped continuation, not a heading under CommonMark, but it trips every naive `^#` scan, including the one the translation's own structural check would run if it counted `^#` rather than `^#{1,6} `. And the German is internally inconsistent about the CVSS separator, writing `8,3` in E-29 and `9.1` in E-21.

Two corrections to `E-822`. Its fourth claim said the rehash is cited as "step 5" twice and "step 6" three times; step 6 is cited nine times, all correctly, and of the three "step 5" citations two are miscitations — the third cites step 5 for `needsRehash`, which is where `needsRehash` is. Its sixth claim paired `4.1 c)` and `4.4 c)` as though symmetric; `4.1 c)` maps two columns its own source-schema table does not list, while `4.4 c)`'s single unlisted field is documented one subsection earlier under different names. The defect is real in both, the symmetry is not.

**Price.** The specification now carries twenty recorded defects across two entries with nothing scheduled to fix any of them, and a reader must hold both entries to have the list. Correcting a count in `E-822` while writing its corrections here means the log states the same finding in two places at two levels of accuracy, which is what the rule buys and what it costs.

### The C.1 count is right and its label is wrong
`E-824` · skill · specification, correction

**Context.** `E-823` recorded `C.1` as a count contradiction: a heading reading "generic OAuth helpers (11)" against ten helpers named and listed elsewhere. The gate marked that confirmed on a spot check, then re-verified it and reversed itself. `C.1` carries three rows, not two — `C1–C36`, `C37–C46`, and `C47 Beliebiger OAuth2/OIDC-Provider zur Laufzeit` — so it spans 47 items and 36 + 11 = 47. Section C's heading is `(96)`, `C.2` has 49 rows, and the summary table agrees. The eleven is arithmetically required.

**Rejected.** Correcting `E-823`'s sentence in place. Rejected under the rule this branch merged: a measurement may be restated before merge, a reason may not, and a description of what a defect *is* is a reason. `E-823`'s totals and its step-5 figures were counts and have been restated there; this has not.

**Reason.** The description matters more than usual because a reader acts on it. `E-823` as written invites changing the heading to `(10)`, which would break section C's totals and manufacture a summary line disagreeing with the rows beneath it — the exact defect `E-822` records first. **The number must not be changed.** What is wrong is the label: "Generic-OAuth-Helfer" is attached to eleven items when only ten, `C37–C46`, are preconfigured helpers; `C47` is a runtime facility, not a shipped provider. The ten is stated correctly at the chapter-1 preamble, not in a section introduction, and section C has none — so `E-823`'s "the section's own introduction" names a thing that does not exist.

Two smaller things `E-823` got wrong and are corrected here rather than there. It quotes `E-822` as saying the rehash is cited as step 5 twice and step 6 three times; `E-822` was corrected in place before `E-823` was written, so that quotation matches neither entry. And the settling evidence for the miscitation belongs on the record: 4.4 d) writes the sentence with step 6 where 4.1 d) writes the same sentence with step 5, which is what makes the second unambiguous rather than arguable.

**Price.** Three entries now describe one act of counting, and a reader wanting the truth about `C.1` must reach the third. That is what the no-restatement rule costs, and it is the second time on this branch that obeying it produced a chain rather than a correction. The rule is still right — the alternative is a log whose entries quietly become true — but the chain is real, and a fourth link would be a reason to ask whether the entry should be withdrawn rather than corrected again.

### Repair the twenty defects instead of recording them a fourth time
`E-845` · specfix · specification, corrected

**Context.** `E-822`, `E-823` and `E-824` record twenty defects in the binding specification and repair none of them, because a translator is not the author of what they translate. Wave 5 implements `oauth`, `email-flows` and `plugin` from that document. Nineteen of the twenty are corrected here, in the German first and then in the English translation; the twentieth was not corrected but decided, by the project rather than on this branch (`E-848`, `E-850`).

**Rejected.** Correcting the German alone and letting the translation catch up later. Rejected because `test/architecture-translation.test.ts` compares the heading sequence, the identifier census, the table and row counts and the fenced-block count of the two files, so a correction applied to one is reported as the divergence — which is the point of the check. Also rejected: repairing the two markdown faults by running a formatter over the file, which would have reflowed lines nobody had inspected.

**Reason.** Every number that changed was recomputed from the rows it counts, and the derivations belong on the record rather than only in a commit message. Section 1's group A line read `26 · 11 · 12 · 3`; its 52 rows carry 23 adopt, 14 solve differently, 12 omit and 3 surpass, and 2.N's per-section table already stated 23 and 14 — the total of 52 was never wrong, only the split. `I.2` was headed 44 and spans `I6` to `I59`, which is 54, and section I's 71 requires it: 5 + 54 + 10 + 2. 3.15 B.4 said three writing methods where four of the namespace's five return `SetPasswordResult`; the fifth, `requestReset`, returns void. `T-RATE-1` demanded 20/20 over twelve enumerated vectors — four IPv6 spellings of one `/64`, the IPv4-mapped pair, `::1`, `0.0.0.0`, `::`, the empty string, `not-an-ip` and the comma-separated pair — and `T-RATE-3` demanded 6/6 over three constellations, (i) to (iii). 5.7 (a) called a `/64` sixty-two-digit numbers of buckets where 5.7 (b), two lines below, states 2^64, which is twenty digits. Ten CVSS scores were written with a decimal comma against every other score in the file, 5.12 writing 9.1 with a point and 9.9 and 9.6 with commas inside one sentence.

`C.1`'s eleven was left alone, as `E-824` demands: `C1` to `C47` spans 47 items, 36 + 11 = 47, `C.2` has 49 rows and section C is headed 96. The label was the fault, and the label is what changed.

**Price.** Twenty-one corrections in a binding document are twenty-one chances to have changed what a requirement obliges while believing one was fixing a typo. Two thresholds now carry smaller numbers than they did — 12/12 and 3/3 — and a reader who remembers `20/20` will read that as a weakened test rather than as a threshold that was never satisfiable. The check that proves both files moved together proves only that: it compares structure and names, so a correction that changed the meaning of the German and of the English in the same way passes every assertion in it.

### Three repairs the reports left underspecified
`E-846` · specfix · specification, corrected

**Context.** `E-822` and `E-823` name each defect by its symptom. Three of them admit more than one repair, and choosing between the repairs is nearer a decision than a correction.

**Rejected.** Reporting all three instead of repairing them. Rejected because each has a repair that leaves every requirement meaning what it meant, and reporting them would have handed wave 5 the same document with a longer list attached.

**Reason.** The first: 3.15 B.4 says "all three writing methods" and, four sentences later, "`validate` from A.4 runs before hashing in all three methods". The second sentence is a back-reference to the same set, and with the set at four the phrase names no set at all; both now say four. That settles, rather than leaves open, whether `validate` runs on `redeemReset` — A.4 and L-7 say it runs on setting and changing and never on sign-in, and `redeemReset` sets a password. The second: 4.1 c) maps `mfa_factors.updated_at` and `mfa_factors.created_at`, which 4.1 b) does not list. b) gained the row, in the shape its `users.created_at` row already uses; c) is untouched, because deleting a mapping would change what the migration writes. The third: the CVSS separator went to the point, which the 33 rows of 5.19, section 5's prose and `E-21` already use; the ten commas were the outliers. Measurements keep the German decimal comma — factor 1,6, 1,9 GB, the dudect threshold 4,5, the percentage shares in 2.N — because those are decimals in a German sentence and not scores.

**Price.** The first is the one to distrust. The old sentence was wrong in a way that left the reader to guess which three of the four methods were meant, and the new one answers the question the old one raised. If the project ever meant `validate` to skip `redeemReset`, that intent is now written out of the document, and nothing in the wording marks the spot where it was lost.

### Replacing a false claim means writing a true one
`E-847` · specfix · specification, corrected

**Context.** 5.19's evaluation named `S-LINK-1` as the requirement preventing the class with the highest CVSS values. The LINK rows are #16 at 8.3, #17 at 7.7 and #31 at 8.3; the table's highest are #30 at 9.9, #18 at 9.6, and #11 and #20 at 9.1. No reading makes the sentence true — not over the whole table, and not over the fifteen directly transferable advisories, whose highest is #11 at 9.1.

**Rejected.** Striking the clause and leaving `S-LINK-1` in the list with no reason beside it. Also rejected: replacing it with the count alone, "prevents the class with 3 advisories", which is true and reads as an argument against keeping the requirement among the three with the greatest leverage.

**Reason.** The replacement is the short summary's own characterisation of the same class: three advisories on unverified email as proof of identity, an account takeover every time. Using words the document already carries about the class it is describing is the nearest available thing to not writing a new claim at all. It is still a new claim, which is why it is recorded here rather than left in a commit message.

**Price.** This is the only correction in the pass that writes a sentence instead of fixing a number, and a reader comparing the two versions cannot tell from the text that the old superlative was false rather than merely unsupported. The evaluation now offers no CVSS argument for `S-LINK-1` at all, and whether it belongs among the three requirements with the greatest leverage is a question the corrected sentence does not answer.

### `T-REDIR-2` is a decision and not a repair
`E-848` · specfix · test threshold, open

**Context.** `T-REDIR-2` prescribes a vector file with at least 120 malicious inputs, fixes the threshold at 120/120 rejected with 0 false negatives, and says in the same cell that the corpus grows by the vector with every finding. A fixed number and a growing corpus cannot both stand: the first finding makes the corpus 121 and the threshold stale by construction.

**Rejected.** Correcting it in either direction. Pinning the corpus at 120 drops the growth rule, and making the threshold follow the corpus replaces a number fixed in advance with one that is not, which is the property section 6 requires of a threshold. Both change what the test demands, and that is the project's to decide.

**Reason.** The recommendation, offered and not applied: `n/n rejected, 0 false negatives, n ≥ 120`. It keeps the floor of 120, keeps the growth rule, keeps the demand that every vector be rejected, and is the only form of the three that is still true after the first finding is added. It is a recommendation because it is the threshold that changes, and no defect list authorises that.

**Price.** The document goes to wave 5 with one of its twenty recorded defects still in it, and it is the one a reader is most likely to act on wrongly, because `120/120` reads as a decided number rather than an expired one.

### Two contradictions the three reports do not name
`E-849` · specfix · specification, reported not repaired

**Context.** Confirming twenty defects means reading their neighbourhoods, and two more turned up there.

**Rejected.** Repairing either of them on this branch. Rejected because both need a fact this branch does not have, and inventing it is how a repair becomes a decision.

**Reason.** 4.4 a) says the Firebase export file and four hash parameters that are not in it are both needed, and that the four come by hand from the console. Section 6's procedure for obtaining an `$fbscrypt$` test vector says `firebase auth:export` delivers them in the header of its output. One of the two is wrong about the tool, and which one is a question about `firebase-tools` rather than about the document. The second is smaller: 4.2 a) and 4.2 c) call the Clerk field `external_accounts`, while 4.2 b) lists it as `externalAccounts[]` and enumerates its sub-fields. Both spellings exist in Clerk's surface, so the mapping does not dangle the way 4.4 c)'s `hash_config` did, and naming one of them correct requires knowing which surface b) describes.

**Price.** Two more defects are recorded and unrepaired, which is the state the twenty were in before this branch, and this is the fourth entry in a chain about one document's mistakes. The Firebase one is the one that costs: a reader who follows section 6 to build the `$fbscrypt$` test vector and finds no parameters in the export header has no way to tell whether the tool changed or the sentence was always wrong.

### `T-REDIR-2` was decided, and not on this branch
`E-850` · specfix · test threshold, frozen

**Context.** `E-848` left `T-REDIR-2` open: the cell demanded 120/120 over a corpus its own procedure grows with every finding, both directions of repair change what the test demands, and a list of defects does not authorise that. The project took the decision and named the form — `n/n abgelehnt, 0 falsch-negativ`, with `n ≥ 120`, and the English to match — and the reasoning is theirs and belongs on the record as theirs: the cell as written demands two things that cannot both hold, every vector rejected and exactly 120 of them, and the growth rule in the same cell guarantees the second becomes false at the first finding. The form keeps the floor of 120, keeps the growth rule, keeps every vector and none false-negative, and is the only wording that survives the corpus doing what the same cell requires it to do. It changes the number and not the obligation.

**Rejected.** Restating `E-848` in place, so that the log would read as though this branch had decided it. Rejected under the rule this project has recorded as a finding four times: a measurement may be restated before merge and a reason may not, and `E-848`'s reason is the reason the branch did not decide. `E-848`'s Price says the document goes to wave 5 with one of its twenty recorded defects still in it. It does not, and that sentence stands as written.

**Reason.** The distinction deserves its own entry because it is invisible in the diff. The specification now carries a threshold in the shape this branch proposed, and nothing in the file says who chose it. A reader who finds `n/n … n ≥ 120` and traces it to a branch named for fixing defects will read a repair where there was a decision, and whoever later wants to change it will think they are arguing with a typo rather than with the project.

**Price.** Twenty recorded defects are now twenty addressed, which reads as though the list had been uniformly mechanical. It was not: nineteen were errors of fact, of arithmetic or of typography, and this one was a choice between two things the specification could demand. Only the log says which was which, and only the log names who made the choice.

### Which of the two Firebase statements is the one that matters
`E-851` · specfix · specification, reported not repaired

**Context.** `E-849` records that 4.4 a) and section 6 disagree about whether `firebase auth:export` carries the four hash parameters in its output header, and leaves it unrepaired because settling it needs a fact about `firebase-tools` rather than about the document. One thing about that pair was left out: the two statements are not read by the same person, and if only one of them is ever corrected, section 6 is the one that matters.

**Rejected.** Adding that sentence to `E-849`'s Price, which is where it reads most naturally and where a reader of the finding would meet it. Rejected because a measurement may be restated in place before merge and a reason may not, and a sentence telling the reader which of two sites to act on first is new material in the part of an entry that carries consequence. `E-796` records exactly this addition, disclosed in the commit message and still a violation.

**Reason.** 4.4 a) is read by whoever plans a Firebase migration; section 6's procedure is read by whoever builds the `$fbscrypt$` test vector, and 4.4 a) itself makes a passed `verify()` run mandatory before the write run. A migration plan that names the wrong source for four parameters costs an afternoon of looking in the wrong place. A test vector that cannot be built costs the only check that the hash carry-over for the one source with a non-trivial scheme actually works, and it costs it before anybody has noticed.

**Price.** A one-sentence ordering now costs an entry with four parts, and a reader of `E-849` reaches it only by reading forward. That is the shape the no-restatement rule produces, and it is the second chain this branch has produced for that reason in one afternoon.

### The repair made a fresh instance of the defect it repaired
`E-852` · specfix · specification, corrected

**Context.** Correcting 5.13 (b) from "the most productive source of faults" to "the second most productive" was right against 5.10's ten of thirty-three. It was also incomplete: `H25`, in section 1, carried the identical phrase for the same class and named GHSA-36rg-gfq2-3h56, GHSA-vp58-j275-797x and CVE-2025-27143 — three of the five advisories 5.13 (b) lists. Before this branch `H25` and 5.13 agreed and only 5.10 disagreed with them. After the first correction they contradicted each other, which is worse than the state they were in. `H25` now says second, in both files. The gate found it; no entry named it.

**Rejected.** Adding `T-RATE-3` to `E-846`'s enumeration, which would be new material in a reason. Also rejected: correcting `E-29`, whose reason calls the unverified-email class "the most frequent grave class of fault of all" over three advisories — that is a decision's argument, it is qualified by "grave", and rewriting it would change what `E-29` decided rather than what it counts. It is left as found, and named here so the next reader does not have to find it twice.

**Reason.** Three things, and the first is the one worth carrying forward. **A repair's blast radius is the phrase, not the line.** A claim that ranks something turns up wherever the ranking is useful, and correcting one site of a repeated claim turns a document that was uniformly wrong into one that disagrees with itself — the reader can no longer tell which site to trust, and the contradiction is newer than the defect. The scan that catches it is one command over the phrase and its English form, it was not run when the correction was made, and running it now leaves 5.10, `E-29`, and one remark about CI runners in an unrelated domain.

Second: `T-RATE-3` belongs with the repairs in `E-846` and is not in it. Lowering `6/6` to `3/3` was one of two repairs; the other was writing three more constellations so that the enumeration met the number. The judgement was the same one `T-RATE-1` got — the number follows the enumeration and not the other way round — and it is a judgement, not a reading. `E-845`'s Price discloses the consequence, that two thresholds now carry smaller numbers, but as a risk rather than as a choice between two repairs, which is what `E-846` is for.

Third: the pull request claimed that `test/architecture-translation.test.ts` passing is the evidence that every correction landed in both files. The conclusion is true and the inference is not. The gate planted six one-sided reverts of these corrections and four of them passed the test: `headingShapes()` keeps a heading's level and its section number and discards the parenthesised count, so `(54)` put back to `(44)` in one file is invisible to it, and so are `23 · 14`, `12/12` and a deleted horizontal rule. Of the twenty corrections that had to land in both files, exactly one — the row added to 4.1 b) — would have failed the test one-sided, because it is the only one that changes a table's height. What actually verified the pair was the gate's hunk-by-hunk comparison: 23 German hunks against 19 English, the four German-only ones being the CVSS separators the English never needed. The pull request now says that instead.

**Price.** The check keeps a blind spot that this entry describes and does not close: nothing compares the counts in parentheses in the two files' headings, nothing compares a threshold cell, and nothing compares prose. Nineteen of the twenty corrections that touch both files therefore rest on a reader having applied them twice, which is what happened and is not what a check is for. Widening `headingShapes()` to carry the count would close part of it and belongs to whoever owns that test rather than to a branch correcting the document it reads. And this entry is itself the fourth link in a chain about one document's mistakes, which `E-824` said would be the point to ask whether the chain should stop.

### Velve is a product, not a company
`E-870` · notice · attribution, frozen

**Context.** `NOTICE` read "This product is developed by Velve, a Levo Studio company." Velve is not a company. It is a product of Levo Studio, and Velve Auth is built under it — so the line described a corporate structure that does not exist. `NOTICE` is the file Apache 2.0 section 4(d) requires downstream users to reproduce, so it is the sentence that travels furthest of anything in this repository.

**Rejected.** The literal replacement, "This product is developed by Velve, a product by Levo Studio", which repeats *product* twice in eleven words for two different referents — Velve Auth and Velve. Also rejected: moving the relationship into `README.md` and leaving `NOTICE` to the copyright line alone, which would put it in the file nobody is obliged to carry.

**Reason.** The naming was decided when this repository relicensed: the copyright holder is Velve, because Velve Auth is built under Velve rather than directly under Levo Studio. What was wrong was only the word *company*, and correcting it needed the subject named rather than referred to — "Velve Auth is developed by Velve, a product by Levo Studio" says the same thing once each.

**Price.** `NOTICE` is now the only place the relationship is written, and nothing checks it. A second product under Velve would have to copy the sentence rather than reference it, and a change to how Levo Studio names its products would have to be found by reading rather than by a failing test.

### Fill the licence appendix rather than ship its instructions
`E-871` · notice · licence, frozen

**Context.** `LICENSE` carried Apache 2.0's canonical text with its appendix untouched, so line 190 read `Copyright [yyyy] [name of copyright owner]`. That was not a decision recorded anywhere; the relicensing verified the text byte-identical against apache.org and left the appendix as it arrived.

**Rejected.** Leaving it. The argument for leaving it is real — an untouched `LICENSE` can be checked against the canonical text with one hash, and the copyright is already stated in `NOTICE`, which is the file section 4(d) obliges downstream users to reproduce.

**Reason.** The appendix is not licence text. It is the instruction *"attach the following boilerplate notice, with the fields enclosed by brackets replaced with your own identifying information"* — so a bracketed field left in place is not canonical, it is an instruction nobody carried out. A reader opening `LICENSE` to find who holds the copyright finds a placeholder, and a project that ships one has not finished applying the licence it chose. Year 2026, holder Velve, matching `NOTICE` and the decision that the holder is Velve rather than Levo Studio.

**Price.** `LICENSE` is no longer byte-identical to apache.org's text, so the cheap check — one hash against the canonical file — is gone, and what replaces it is reading one line. The two remaining bracket characters at line 182 are part of the instruction's own sentence and not a field; a scan for `[` will find them and be wrong.

### The appendix does not ask what E-871 says it asks
`E-872` · notice · licence, correction

**Context.** `E-871` argued that filling `Copyright [yyyy] [name of copyright owner]` carries out an instruction the appendix gives, so a placeholder left in place is an instruction nobody followed. The gate read the appendix's next sentence — *"The text should be enclosed in the appropriate comment syntax for the file format"* — and the instruction is to attach the boilerplate **to the files of your work**, not to complete the copy inside `LICENSE`. The Apache Software Foundation ships its own releases with the placeholders intact.

**Rejected.** Reverting the change. Also rejected: correcting `E-871` in place, which §6 forbids for a reason before merge.

**Reason.** The decision survives its argument, which is worth separating. Filling the two fields touches no operative clause — the gate diffed the file against apache.org and found exactly one differing line, at 190, eleven lines below the `APPENDIX` heading — and a reader opening `LICENSE` for the copyright holder now finds one instead of a blank. That is the whole benefit and it is real. What is not true is that the appendix demanded it.

And the honest consequence: under the appendix's actual reading, the instruction is **still** uncarried-out. `grep -rl "Licensed under the Apache License" src/` returns nothing and the tree carries no SPDX identifier, so the boilerplate is attached to no source file. Whether it should be is a separate question this entry does not decide.

Two smaller corrections to `E-871`, both the gate's. Its Reason quotes the instruction and drops `"[]"` without an ellipsis — the dropped token being the very thing the entry is about. And `E-870` says `NOTICE` is the sentence that travels furthest of anything here; section 4(a) obliges a copy of the **License** with every redistribution, while 4(d) obliges `NOTICE` only with derivative works, so the licence text travels at least as far. The claim is true of text this project wrote and was stated wider than that.

**Price.** Three entries now describe one two-line change, and the argument a reader meets first is the one that is wrong about the appendix. That is the cost of the rule that a reason is never rewritten, paid here for a correction nobody would have caught without reading the sentence after the one quoted.

### The statement that writes the pending row is the one that reads what the account can offer
`E-735` · spine · the pending state, frozen

**Context.** `PendingAuthenticationService.begin` took `availableFactors` from its caller and stored nothing of it; `resolve` recomputed the same list from `totp_credential`, `webauthn_credential` and `recovery_code`. So the value 3.15 C.1 puts on `PendingAuthentication` was whatever the caller passed at the moment the state began, and the truth at the moment it was read. Nothing in the tree computed the first one, and both wave-5 features reach this state.
**Rejected.** (a) Adding a second service method the caller calls before `begin`. (b) Leaving the parameter and making it optional, computed when absent.
**Reason.** (a) is two round trips and leaves the parameter, so a caller can still pass a list the account does not have. (b) is one call with two meanings, which rule 4 of 3.15 rules out. The insert already returns the row; adding the three `EXISTS` subqueries to it in a CTE — the shape `createUser` already uses — makes the value come from the same query text `resolve` reads it with, so the two cannot disagree. The parameter is removed rather than made optional.
**Price.** Eight call sites in six other test files changed, and one fixture lost a parameter that two of its callers were passing. None of them asserted on the value, so the change was invisible to every assertion — which is another way of saying that the field nothing computed was also the field nothing checked.

### The third cookie is gated by a declaration, because no caller requirement can imply it
`E-736` · spine · the request context, frozen

**Context.** `readCookies` has returned `oauthState` since the seam cut and every reader discarded it: `CallerTokens` carried two tokens and `RequestContext` two fields. The OAuth callback needs the third, and S-CSRF-5 makes it one half of a check whose other half is the row in `velve.oauth_flow`.
**Rejected.** (a) A fourth `CallerRequirement`, `"oauth_state"`, beside `anonymous`, `session`, `pending` and `server_only`. (b) Handing every route the value, since the pointer authorises nothing on its own.
**Reason.** (a) is wrong because `caller` answers "who may call" and the pointer answers nobody — a route gated on it would be a route the pointer authorises, which is exactly what S-CSRF-5 says it must not be. (b) gives every route a value it has no use for and makes "which routes read this cookie" unanswerable from the declaration, which is the property 3.15 D.3 asks for the pending cookie. So it is a per-route field, `oauthStateCookie`, defaulting to hidden, with its own predicate — the same shape E-335 gave `pendingCookie` and independent of it, so widening access to the pointer cannot widen access to the pending state.
**Price.** Two independent booleans on a route declaration where one enumeration would read better, and a sixth reserved name in the server-call envelope. And the honesty of the field rests on the writer of the OAuth callback declaring it; nothing forces a route that reads the pointer to say so, because the pipeline simply hands it `null` if it does not.

### A plugin's repository call names an account and holds no proof of owning it
`E-737` · spine · S-OWNER-7, boundary

**Context.** 3.15 G gives `FrozenRepositories` three methods, each taking a `PluginActor` of `{ pluginId, reason }`. `src/core/db/actor.ts` exists so that a write reaches a row only through an `Actor` minted by a proof of ownership, and E-730 had just tightened the two address writes onto it.
**Rejected.** Minting an `Actor` from a `PluginActor`, as a fourth provenance beside a resolved session, a redeemed token and a consumed OAuth flow.
**Reason.** There is no proof to mint it from. A plugin names a `userId` it chose and a `sessionId` it chose; a brand asserted over those says "an owner some proof named" and no proof named it. The class this call belongs to is `auth.user.*` of 3.15 B.3 — the application acting in its own process after its own authorization decision — and those methods take a plain identifier for the same reason. What the `actor` buys is not authorisation but attribution: both fields are mandatory, both are refused when empty, and both are logged on every call.
**Price.** `revokeSession` deletes a session row by id with no owner predicate at all, which is the eleventh `no owner predicate` marker in the tree and the first one whose justification is "the specification hands the method no owner" rather than "the predicate is the secret itself". A plugin can therefore end any session of any account, which is a real capability and is not bounded by anything except the plugin being in the process already.

### `ownTables.query` is a guardrail and not a sandbox, and says so
`E-738` · spine · the plugin boundary, frozen

**Context.** 3.15 G bounds `ownTables.query` to tables with the plugin's prefix, and 3.11 forbids a plugin writing core tables directly. Enforcing that means deciding what a table reference is in an arbitrary statement.
**Rejected.** (a) A real SQL parser. (b) Nothing at all, on the grounds that a plugin runs in the application's process and can import the driver.
**Reason.** (b) is the honest half of the argument and it is why (a) is not worth its cost: a plugin that wants `velve.user` can have it by other means entirely, so no amount of parsing makes this a boundary against an attacker. What it can do is stop the accident — a join onto the user table that seemed harmless — and for that a scan of the identifier standing after `FROM`, `JOIN`, `INTO` and `UPDATE`, outside comments and quoted text, is enough. A reference it cannot classify is refused rather than allowed, so a statement it does not understand fails loudly.
**Price.** False refusals it cannot distinguish from real ones: `FROM generate_series(…)`, a CTE whose name does not carry the plugin's prefix, and any table function are all refused. And the check is written as a regular expression over stripped text, which is the technique this repository has already been bitten by three times in other scans.

### A core route's plugin context is present and empty rather than absent
`E-739` · spine · 3.15 D.1, frozen

**Context.** 3.15 D.1 declares `readonly plugin: FrozenContext` on `RequestContext` and annotates it "for core routes without ownTables". Every core route gets a context whether or not it has tables.
**Rejected.** Making the field optional for core routes, or `FrozenContext | null`.
**Reason.** The declaration is not optional, and a nullable field is read unchecked eventually — the same argument 3.15 C.1 makes about a `session` field that is sometimes set. So the core context is a real frozen context with the real repositories and an `ownTables` whose `query` rejects: a core route owns no tables of its own, and asking is a mistake rather than an empty result.
**Price.** A method that exists and always fails, which is a shape this repository generally avoids. The alternative was a shape the specification does not have.

### The context a route gets is recorded against the route, not read out of its name
`E-740` · spine · the registry, frozen

**Context.** A plugin route is named `<pluginId>.<rest>` by type, so the plugin owning a route can be recovered from its name. The pipeline needs to hand each handler the right frozen context.
**Rejected.** Splitting the name at the first dot and looking the plugin up.
**Reason.** It would work today and it makes the name load-bearing for something other than the object path. A core route named `session.list` would be looked up as plugin `session`, found absent, and fall through to the core context — correct by accident, and wrong the moment a plugin is called `session`. The registry already holds each route as it builds it, so it records the context against the route object in a `WeakMap` and the name decides nothing.
**Price.** A plugin id equal to a surface namespace is still refused separately, at start, from a list of namespace names written in `instance.ts` — a second statement of 3.15 B's namespaces with nothing holding it to the actual surface. E-734 called that class out on this branch's predecessor and here is another one.

### A plugin contributes route declarations, and the specification's own example does not
`E-741` · spine · contradiction, reported

**Context.** `PluginRoute<Id>` was declared in the seam cut as a `RouteDeclaration` — the object with the handler, before `defineRoute` has run. The registry therefore calls `defineRoute` on each. Architecture 3.15 G.1's worked example writes `routes: [defineRoute({ … })]`, which produces a `Route`, and a `Route` carries no handler by construction (that is what E-335's cut bought: a caller holding a route cannot reach past the checks).
**Rejected.** Accepting either shape, by testing for a `handler` and calling `defineRoute` only when one is present.
**Reason.** Two shapes for one thing is the thing 3.15's rules exist to prevent, and the type is the half a plugin author reads first. The declaration form is kept and G.1's example is reported as a contradiction rather than repaired: it is the specification's, not this branch's, and it is the kind of divergence that a reader of the example finds in ten seconds when it does not compile.
**Price.** The example in the binding specification does not compile against the implementation of the interface it illustrates, and this entry is the only place that says so. A plugin author who copies it gets a type error whose message is about a missing `handler`, which does not point at the answer.

### A `dependsOn` naming a plugin nobody configured is a start error, and 3.11 does not say so
`E-742` · spine · start errors, decided

**Context.** 3.11 says `dependsOn` is sorted topologically and that a cycle is a start error. It says nothing about a dependency on a plugin that is not in the list.
**Rejected.** Ignoring it, which is what a topological sort naturally does — an edge to a node that does not exist constrains nothing.
**Reason.** The plugin declared that it must run after something, and ignoring the edge runs it anyway, in an order nobody chose, against a dependency that is not there. That is a silent misconfiguration of exactly the kind 3.11 turns into start errors elsewhere. It is a decision beyond the text and it is recorded as one rather than presented as following from it.
**Price.** A configuration that works today — a plugin listing an optional dependency it can run without — stops starting. Nothing in 3.11 licenses that, and if the intent was optional dependencies this refusal is wrong and will have to be undone.

### One `signIn` namespace, filled by two features, neither editing the other's file
`E-743` · spine · the surface, frozen

**Context.** 3.15 B.1 puts `signIn.oauth.*` and `signIn.magicLink.*` inside one `signIn` namespace. `instance.ts` builds its surface as a hand-written object literal, so both wave-5 features would have edited the same lines of the same file — the collision this whole wave exists to remove.
**Rejected.** (a) A `signIn` object assembled from per-feature fragments spread into it by `instance.ts`, which still names both features in this file. (b) Each feature declaring its own namespace interface and `instance.ts` intersecting them, which is the same file with the names moved into the type.
**Reason.** 3.15 D.2 already says what the answer is and it had not been implemented: the dotted `name` of a route **is** the object path of its server method. Folding the table into a nested object gives `auth.signIn.oauth.start` from a row declared in `core/oauth/routes.ts` and `auth.signIn.magicLink.redeem` from a row declared in `core/flows/routes.ts`, with neither file naming the other and neither naming this one. The type follows by the same route: each seam returns its table as a tuple and `VelveAuth` intersects `ServerSurface` over them, so an empty seam contributes `unknown` and intersects away.
**Price.** Three of them. The plugin routes are folded into the object but not into the type, because which plugins exist is configuration — so `auth.<pluginId>.<method>` works and does not typecheck. The five hand-written namespaces are spread last and silently win over anything derived with the same key, which is a shadowing rule stated in a comment and enforced by nothing. And `ServerSurface` over an empty tuple is `unknown`, so a seam that returns `readonly AnyRoute[]` instead of a tuple contributes an index signature and poisons the surface without failing anything.

### The barrel is partitioned in three lines; the API snapshot cannot be partitioned at all
`E-744` · spine · the export seam, decided

**Context.** `src/index.ts` is a single list of `export type { … } from` blocks and wave 5 has three writers. The API snapshot in `test/__snapshots__/api-surface.md` is a generated artefact all three regenerate.
**Rejected.** Giving each feature a marked region of `src/index.ts` and relying on git to merge disjoint hunks.
**Reason.** A marked region is a convention; a module is a file. Each feature gets `core/<feature>/index.ts`, `src/index.ts` re-exports it with one `export type *` line, and the lines are written now so no wave-5 writer touches the barrel at all. Type-only, so nothing of them reaches `dist/index.mjs`.
**Price.** The snapshot is not solved and is not solvable this way: it is one file generated from the built types, three features will move it, and the merge conflict is in generated text where "keep both sides" is not a valid resolution. What saves it is that regenerating is a command rather than a judgement. Said plainly rather than left for wave 5 to discover, which is what this entry is for.

### The API snapshot reads the top of `dist/` only, so an internal type change is invisible to it
`E-745` · spine · the gate, finding

**Context.** The gate lists "the public surface has not changed unannounced (API snapshot comparison)". `test/api-surface.test.ts` reads `readdirSync(dist)` and keeps the nine `.d.mts` files at the top level — `index`, `http`, `client`, the three drivers, `import`, `schema`, `testing`. Under `unbundle: true` every module also emits its own `dist/core/**/*.d.mts`, fifty-one of them, and none is read.
**Rejected.** Widening the scan to the whole tree on this branch.
**Reason.** This branch added a field to `RequestContext`, a field to `RouteMetadata`, a sixth member to `ServerCallFields` and two members to `SessionRepository`, and the snapshot moved for none of them — it moved only because the import order in `index.d.mts` changed. Those are internal types, so the outcome is arguably right; what is wrong is that nobody can tell from the check which it is, because the check answers "did the nine barrels change" and is described as answering "did the public surface change". Widening it would put fifty-one files of internal declarations under a snapshot that then moves on every refactor, which is a different check with a different cost, and choosing it is not this feature's call.
**Price.** The gap stays. A change to a type re-exported from a barrel is caught; a change to a type reached through one is not, and the nine-file snapshot will keep passing for it.

### A scan for `.reason` reported this feature's mandatory field as a leak
`E-746` · spine · the gate, finding

**Context.** `test/http-enumeration.test.ts` asserts that only `error-map.ts` decides a visible code from an internal reason, and detects a decider as a file containing `instanceof ConcealedError` **or** `.reason`. 3.15 G's `PluginActor` has a mandatory `reason`, so `context.ts` reads `actor.reason` and the check went red.
**Rejected.** Renaming the destructured value so the substring does not appear.
**Reason.** That is evading a check by editing the code it examines, and it leaves the check just as wrong for the next file. What the requirement is about is reading the reason off a `ConcealedError`; a property called `reason` on an unrelated type is not that. The condition now requires the file to name `ConcealedError` as well. Two faults were planted before trusting it — a file with `instanceof ConcealedError`, and a file naming `ConcealedError` beside a `.reason` — and both reddened it.
**Price.** The residual gap is the one the original had too: a file that catches `unknown` and reads `error["reason"]` without ever naming the class passes both forms. And this is the second census on this branch that moved for a reason unrelated to what it counts, after the marker count E-795 named.

### The refusal inside `ownTables.query` threw where its caller expected a rejection
`E-747` · spine · finding, fixed

**Context.** `query` validated the statement and then called the driver, so a refused statement threw synchronously out of a function whose type is `Promise<Row[]>`. A caller writing `context.plugin.ownTables.query(sql, []).catch(…)` never reached its `catch`.
**Rejected.** Nothing; there was no argument for the throwing form.
**Reason.** It was found by running a scratch route that catches the refusal and asserts on its name — the failure was a 500 with the message in the log, not the value the assertion expected. It was not found by reading the code, and no check in the gate would have found it: the types are satisfied either way. The function is `async`, so both outcomes are rejections.
**Price.** This is the entry that records that the writer's own verification found the only real defect on the branch, and that the verification was a throwaway file the reviewer will now have to write again from the requirements. That is the working method operating as intended; it is also two people writing the same test.

### Three fields of `VelvePlugin` are declared and read by nothing
`E-748` · spine · carried forward, open

**Context.** `VelvePlugin` declares `migrations`, `errorCodes` and `rateLimitRules`. The registry reads none of them.
**Rejected.** Wiring migrations into `runMigrations`, which is a two-line change.
**Reason.** It is a two-line change with a decision inside it. The migration runner keys its ledger on `version` alone, and 3.15 G.1's example plugin numbers its first migration `1` — the same number the core's first migration has. Whether a plugin's versions are namespaced, offset, or refused for colliding is a schema decision with a migration-safety argument behind it, and taking it here would settle it for `plugin` without that feature's writer in the room. `errorCodes` is a list of code strings and `registerPluginErrorCodes` needs a status and a message, so the declaration cannot feed the registry as it stands. `rateLimitRules` is keyed by route name and a plugin route already declares its own `rateLimit`, so which wins is a decision too.
**Price.** A plugin can declare a migration and get no table, declare an error code and get `500 internal_error` for it, and declare a rate limit rule that does nothing — three silent no-ops, none of which fails at start. Refusing them at start was the obvious alternative and it was not taken, because a feature that will read them next wave would then have to remove the refusal first.

### `mountAuth` takes overrides and still fixes the identity mode
`E-749` · spine · the fixtures, decided

**Context.** `mountAuth(prefix)` took no overrides and `configFor` hard-wires `identity: { mode: "email" }` behind an `as` cast. Three wave-5 features need providers, plugins and their own send callback mounted.
**Rejected.** Making `configFor` generic over the identity mode.
**Reason.** `VelveAuthConfig<M>` is `BaseConfig<M> & RecoveryCodesRequirement<M>` and the second half distributes over a generic `M`; E-349 records what happens when that inference site is disturbed, and disturbing it inside a test fixture to buy a mode none of the three features needs is a bad trade. The overrides are applied last, so anything a test does not name stays at the default.
**Price.** A test that wants `"username"` or `"username_email"` still calls `createVelveAuth` itself, and the cast in `configFor` still hides whatever the overrides get wrong.

### The seven hook points have a dispatcher and nothing that calls it
`E-750` · spine · 3.11, finding

**Context.** `createPluginRuntime` builds `hooks`, a dispatcher with one method for each of 3.11's seven points, and puts it on `PluginRuntime`. `RouteServices` carries the runtime, so a route handler can reach it. Nothing does: a search of `src/` for `beforeSignIn`, `afterSignIn`, `beforeSessionCreate`, `afterSessionCreate`, `beforeUserCreate`, `afterUserCreate` and `beforeSessionRevoke` finds them in `plugin/config.ts` and `plugin/registry.ts` and in no third file.
**Rejected.** Reading it as wave 5's work. Six of the seven have no producing flow in the tree — sign-in and sign-up are wave 5's — so for those the dispatcher is genuinely waiting for a caller.
**Reason.** The seventh is not waiting. `beforeSessionRevoke` has four call sites in the table today — `signOut`, `session.revoke`, `session.revokeAllOther`, `session.revokeAll` — and `RevokeReason` names `"sign_out"` and `"revoked_by_user"`, which nothing else in the library produces. A dispatcher no caller reaches is a dispatcher no test can reach either, and `README.md` states in terms that a plugin's "hooks run at the seven enumerated points" while `DOCUMENTATION.md` states that a throwing hook fails the operation closed. Both are claims about behaviour that does not occur. The test that fires a hook through `POST /sign-out` is the one that would have caught it, and it did not exist.
**Price.** The unit tests for the dispatcher pass and prove ordering, the veto and the per-plugin context, which is exactly the shape of a check that measures the part that works. `beforeSessionRevoke` is the only point that can be wired without wave 5, so wiring it is the whole of what this finding asks for; the other six are carried forward and the documentation has to say so rather than the opposite.

### `ownTables.query` lets through every statement whose table it cannot find
`E-751` · spine · 3.15 G, finding

**Context.** `assertEveryTableCarriesThePluginPrefix` strips comments and quoted text, then reads the identifier after `FROM`, `JOIN`, `INTO` or `UPDATE` and refuses any that does not carry the plugin's prefix. E-738 records the design and states that "a reference it cannot classify is refused rather than allowed, so a statement it does not understand fails loudly".
**Rejected.** Nothing. This is a report, not a decision.
**Reason.** The loop refuses references it finds; it has no answer for a statement in which it finds none, and a statement with no references is a statement with nothing to refuse. `SELECT * FROM "velve"."user"` strips to `SELECT * FROM  .  ` and matches nothing. So do `INSERT INTO "velve"."user" …`, `TRUNCATE velve.user`, `DROP TABLE velve.session`, `ALTER TABLE velve.user …` and `COPY velve.password_credential TO STDOUT` — the last five of which write or destroy a core table, which 3.11 forbids in terms. Zero matches reading as a pass is the failure mode `CLAUDE.md` §5 names three times over, and it is here in the guard rather than in a check.
**Price.** The guardrail E-738 argues for is real for the accident it was written against — a bare `JOIN velve.user` is refused — and absent for the accident that quotes an identifier, which is what an author reaching for a reserved word like `user` writes. The entry that describes the boundary describes it as stricter than it is, and that sentence is load-bearing for anyone deciding how much to trust it.

### T-CSRF-6 asks for a start error and the registry answers with silence
`E-752` · spine · S-CSRF-6, finding

**Context.** Architecture 6.9 fixes T-CSRF-6 as a test plugin that tries to register a middleware ahead of the origin check and to replace the checking function, with the expected result "registration leads to a **start error**; the context is frozen (`Object.isFrozen` = true)". `VelvePlugin` enumerates seven fields and has no middleware among them.
**Rejected.** Reading the expected result as satisfied by the type constraint. In TypeScript such a plugin does not compile, and 3.15 G says in terms that the runtime check exists "für Plugins aus JavaScript".
**Reason.** A plugin written in JavaScript can carry any field it likes and the registry reads the seven it knows. A `middleware` array, or an `assertOriginAllowed` beside the seven, is dropped without a word, and the author of that plugin is left believing it runs. That is the same silence E-748 records for `migrations`, `errorCodes` and `rateLimitRules`, and for those three the price is a no-op; for this one the price is that the case the specification writes a test for produces no error at all. The frozen-context half of T-CSRF-6 is satisfied and tested; the start-error half is not.
**Price.** The remedy is a refusal of unknown fields at start, and that refusal is the thing E-748 decided not to build for the three declared-and-unread fields — so the two findings pull the same lever in opposite directions, and whoever takes this one has to settle both together.

### `CookieInstruction` is named in 3.15 C's block and is not exported
`E-753` · spine · the public surface, finding

**Context.** 3.15 C declares `OAuthRedirect { authorizationUrl: string; stateCookie: CookieInstruction }` and `CookieInstruction` immediately beneath it, and says `CookieInstruction` is "the only place server methods mention cookies". `OAuthRedirect` is exported from `src/index.ts`; `CookieInstruction` is not, and does not appear in `dist/index.d.mts`'s export list.
**Rejected.** Nothing.
**Reason.** An application that calls `signIn.oauth.start` is handed a `stateCookie` and has to write it to a response. It can use the value structurally, but it cannot name the type — no annotation, no helper signature, no re-export. The type reaches `dist` through `results.d.mts`'s import, so `attw` and `publint` both pass and the API snapshot does not move, which is why nothing caught it.
**Price.** One line in the barrel, and the question of which module owns it: `CookieInstruction` lives in `core/http/cookies.ts`, which is not the spine's chapter of the export partition. Reported rather than added, because adding an export is a change to the public surface and the writer owns that decision.

### Two registry types entered the public surface that 3.15 G does not name
`E-754` · spine · the public surface, finding

**Context.** `src/core/plugin/index.ts` is the export module E-744 cut for the `plugin` feature, and `src/index.ts` re-exports it whole. Besides the fifteen names 3.15 G declares it exports `PluginHookDispatcher` and `PluginRuntime` from `registry.ts`.
**Rejected.** Nothing.
**Reason.** Neither is in 3.15 G. `PluginRuntime` is the assembly's own handle — it carries `contextOf(route: RouteMetadata)`, and `RouteMetadata` is itself not exported, so a public type refers to one that is not. The snapshot moved and was updated, so the change is not unannounced; what it is, is wider than the interface the specification fixes, and §2's rule about the surface being a promise applies to a type as much as to a method. `SeamSurface` is a third name of the same kind, exported from `instance.ts`.
**Price.** Removing them is a one-line change now and a breaking change after a release. The counter-argument is that `export type *` over a feature's module is exactly what E-744 bought, and pruning what it re-exports puts a per-name list back in the barrel — which is the thing E-744 removed.

### What each of the reviewer's checks was proved against
`E-755` · spine · the gate, method

**Context.** `CLAUDE.md` §5 requires a new check to be shown failing on a planted fault before its passing is trusted, and names three checks in this repository that reported success because they matched no files, tested a pipeline that exits zero on empty input, or verified with a pattern that could not match.
**Rejected.** Trusting the eight red tests as evidence that the seventy-one green ones measure anything. A red test proves only itself.
**Reason.** Thirteen faults were planted in `src/` and reverted — one for each number reported below, so a sentence naming two changes and reporting one number is one plant — and the outcome was predicted before each run. Returning `[...plugins]` instead of `inDependencyOrder(plugins)` reddened five cases: both ordering cases, both cycle cases and the dispatcher's own ordering case. Removing the collision branch and the duplicate-id loop reddened five start-error cases. Disabling the prefix comparison in `assertEveryTableCarriesThePluginPrefix` reddened six. Dropping `Object.freeze` from the context and its repositories reddened four. Replacing the actor's emptiness test with a check for `undefined` reddened the actor case, and renaming the logged message reddened the logging case. Removing the origin check and the address bucket from `runRoute` reddened five, three of them on the direct server-method path. Handing every route the state pointer, and separately dropping it in `web-handler.ts`, each reddened two, and declaring a core route a reader of it reddened a third. Making the dispatcher run no listener reddened four of the five dispatcher cases, the fifth being the one that only counts the points. Weakening the enrolment subqueries and blanking `availableFactors` at `begin` reddened seven and nine. The type assertions were planted twice against `tsc --noEmit`, since `expectTypeOf` is inert at run time and only the typechecker reads it: an optional `sessionToken` on the second-factor branch and a shape for `Identity.profile` both failed the build.
**Price.** One plant failed and looked like a green: rewriting the actor condition's first `||` as `&&` left the two emptiness comparisons standing, so the function still threw and the test still passed. It was replanted rather than recorded as evidence. That is the whole reason the rule says to predict the outcome first — an unexpected green is a broken plant far more often than it is a redundant check, and the difference is not visible from the result.

### `ownTables.query` refuses what it cannot read, which is what E-738 said it did
`E-756` · spine · E-738 corrected, boundary

**Context.** E-751 is right and E-738's sentence — "a reference it cannot classify is refused rather than allowed, so a statement it does not understand fails loudly" — was false against the code it described. The loop refused what it found and had no answer for finding nothing, so five statements that write or destroy a core table went to the driver. Under §6 that sentence is a reason and not a measurement, so it is corrected here rather than rewritten there.
**Rejected.** (a) Leaving the guardrail and weakening E-738's sentence to match it, on the argument E-738 already makes — that a plugin can reach the driver by other means anyway. (b) A real SQL parser.
**Reason.** (a) fails on the one distinction that matters: E-738's argument is about what a *guardrail* is worth against an attacker, and the accident it exists for is precisely an author who quotes `"user"` because it is a reserved word. A boundary that is defeated by the ordinary way of writing the dangerous thing is not a weaker boundary, it is the wrong one. (b) is still not worth its cost. What replaces the strip-and-scan is a character walk that either reads the statement to the end or refuses it: a string literal becomes an empty literal, a comment becomes a space, and a quoted identifier becomes the bare name it stands for, so `"velve"."user"` reads as `velve.user` instead of vanishing. Five refusals follow from not recognising something rather than from recognising something bad — quoting that does not close, a second statement, a dollar sign that is not a parameter placeholder, a statement whose leading keyword is not one of the five the table walk can follow, and a table position holding something that is not a name. On top of that a token carrying the configured schema and not the plugin's prefix is refused wherever it stands, not only in a table position.
**Price.** False refusals it cannot tell from real ones, and the list is longer than the old one's: `EXTRACT(month FROM x)`, `SUBSTRING(x FROM 1)` and `TRIM(BOTH ' ' FROM x)` all put a column where the walk expects a table; a CTE whose name does not carry the plugin's prefix; every DDL statement, including one that alters the plugin's own table; a batch of two statements; and dollar-quoted text. Each fails loudly with the plugin id and the schema in the message, which is the trade this entry chooses, and none of them has a test — the reviewer's cases are the dangerous ones, and the harmless refusals are known only from this entry and the reference.

### Three rules refuse the same statement, so no single plant could redden the check
`E-757` · spine · the gate, method

**Context.** §5 requires a planted fault before a passing check is trusted, and E-755 records the reviewer doing that thirteen times. The new guard was planted three ways, with the outcome predicted first.
**Rejected.** Recording only the plant that worked.
**Reason.** Making `namesAnOwnTable` answer `true` for everything was predicted green and came back green; so was neutering the schema-qualified belt on its own. Both were absorbed, because every foreign statement in the reviewer's cases is schema-qualified and two independent rules refuse those. Only with both disabled did six cases go red. That is worth writing down rather than hiding, because the pair of green plants is the evidence for something the single red one cannot show: for a schema-qualified core table the belt is the refusing rule and the table walk is redundant, and for a bare foreign name — which no test has — the table walk is the only rule there is. The statement-kind allow-list is in the same position: removing it was not run as a plant because the schema belt still refuses every dangerous case the tests carry, and what it is actually load-bearing for is a DDL statement naming the plugin's **own** table, which nothing tests.
**Price.** Two of the three rules are untested on their own, and this entry is the only record of which one refuses what. An unexpected green was predicted here rather than discovered, which is the good case; the bad case is that the same redundancy makes a future regression in one rule invisible.

### `beforeSessionRevoke` is wired, and the other six are named as waiting
`E-758` · spine · 3.11, E-750 answered

**Context.** E-750 found the dispatcher unreachable and the documentation claiming otherwise. `beforeSessionRevoke` is the only one of the seven whose producing operations exist today: `signOut` and the three revocation routes.
**Rejected.** (a) Firing one event per call rather than one per session. (b) Announcing `session.revoke`'s target without checking that the account owns it.
**Reason.** `SessionRevokeEvent` carries a `sessionId`, so one event per call would have to invent one for `revokeAll`. (b) would tell a plugin about a revocation of a session that then does not happen, because S-OWNER-4 makes a foreign target change nothing — so the three routes list the sessions the account owns, filter to the ones about to go, and announce those. The listing costs a statement, so it is skipped where no plugin listens at that point; that is invisible from outside, and it is stated here rather than left as an unexplained conditional. `signOut` needs no listing, because the caller's own session is already resolved. Every announcement runs **before** the delete, so a hook that throws leaves the rows standing, and the cookie is not cleared either.
**Price.** The announcement and the delete are not one transaction: a plugin is told about a revocation that a later failure could still prevent, and for `revokeAllOther` it is told about all of them before any of them goes. Making that atomic means the hook running inside the transaction, which puts foreign code inside a lock the technical constraints already warn about. And a plugin listening at this point turns one statement into two on four routes.

### An unknown field is refused, a declared one nobody reads is announced
`E-759` · spine · S-CSRF-6, E-748 and E-752 settled

**Context.** E-752 asks for T-CSRF-6's start error — a JavaScript plugin carrying `middleware` or a replacement origin check must not start — and notes that it pulls the same lever E-748 declined to pull for `migrations`, `errorCodes` and `rateLimitRules`. Both had to be settled together.
**Rejected.** (a) Refusing all four, which is one rule and reads consistently. (b) Warning on all four, which is the other.
**Reason.** They are not the same case and one rule cannot be right for both. A field the interface does not enumerate is a claim the library never made and can never honour, and 3.11 says the extension points are **enumerated**; leaving it is exactly the silence T-CSRF-6 is written against. A field the interface does enumerate is a promise the implementation owes and has not yet paid — refusing it would make a documented field unusable and would have to be removed again by the feature that pays it. So: an unenumerated field, at the top level or among the hooks, is a start error; a declared-and-unread field writes one line at start naming the plugin and the field. That line goes to the configured sink, which by default drops everything — so for an installation that passes no sink the warning is invisible, and that is the weak half of this decision.
**Price.** `Object.keys` sees own enumerable properties, so a plugin that carries its middleware on a prototype or behind a symbol starts silently; the refusal is a guard against the plain object a JavaScript plugin actually is, not against evasion. And a plugin built by an older version of a helper that adds a field this version does not know now fails to start where it used to run.

### The public surface goes back to what 3.15 names, plus the one name it names and lacked
`E-760` · spine · the public surface, E-753 and E-754 answered

**Context.** E-754 found `PluginRuntime`, `PluginHookDispatcher` and `SeamSurface` exported and named by neither 3.15 G nor B, with `PluginRuntime.contextOf` referring to a `RouteMetadata` that is not exported. E-753 found `CookieInstruction` named in 3.15 C's block, handed to applications through `OAuthRedirect.stateCookie`, and not exported.
**Rejected.** E-754's own counter-argument: that pruning what a feature's export module re-exports puts a per-name list back in the barrel, which is what E-744 removed.
**Reason.** It does not. The pruning happens **inside** `core/plugin/index.ts`, which is that feature's own module; the barrel still carries one line. What E-744 bought was that three writers never meet in `src/index.ts`, and that is untouched. `SeamSurface` stops being exported at all and becomes a local type of `instance.ts`, where its only use is. `CookieInstruction` is exported from the barrel beside the result types, with `CookieAttributes` — which its `attributes` field is typed as, and which would otherwise be the same problem one level down.
**Price.** Two more names on the public surface where E-753 asked for one, and the snapshot moves twice on one branch. `PluginRuntime` remains exported from `core/plugin/registry.ts` because `RouteServices` names it; what changed is only that the package does not re-export it, so a plugin author who wants to type the runtime reaches into the core, which nothing prevents and nothing supports.

### The core tables are read out of the SQL that creates them
`E-761` · spine · the schema, decided

**Context.** The boundary below needs the names of the core tables. Writing them down is a second statement of the schema, which is the class E-731 and E-734 both name — a list that falls behind the thing it describes and fails nowhere.
**Rejected.** A constant array in `core/plugin/`, and a constant array in `core/db/`.
**Reason.** `coreMigrations` already composes the SQL that creates every one of them, so the names can be read out of it with a pattern over `CREATE TABLE`. A table added by a future migration is in the list the moment its migration is, and a table renamed is renamed in one place. The reading is over the library's own shipped text and not over anything a caller supplies. Every identity mode is read rather than the configured one, because a caller asking what the core owns is asking about the schema and not about one configuration of it.
**Price.** A regular expression over SQL, which is the technique this repository keeps being bitten by — here it reads sixteen names out of two migrations and would silently read none if the shape of a `CREATE TABLE` in the shipped SQL changed. Nothing asserts the count, so an empty answer would turn the deny rule below into a no-op without failing.

### The boundary stops depending on finding the table
`E-762` · spine · E-738 and E-756 corrected, boundary

**Context.** Two rounds found the same defect in a different syntactic position. E-756 replaced a strip-and-scan with a walk that refused what it could not read, and the gate then reached `velve.user` twice more: through a comma-separated `FROM` list, which the walk never opened, and through `velve . "user"`, `velve.\nuser` and `velve/*x*/.user`, which the tokeniser saw as three tokens rather than one. E-757 walked up to it — "for a bare foreign name, which no test has, the table walk is the only rule there is" — and stopped.
**Rejected.** (a) Patching the two positions and keeping the structure. (b) A rule over every identifier: refuse anything that is not a keyword, an own table or a declared column. (c) Moving the boundary onto `PluginMigration.createsTables`.
**Reason.** (a) is what the last round did, and the question the gate asks — what makes the third enumeration complete when the first two were not — has no answer. It has none here either. (b) cannot be written: a plugin's columns are not declarable and a bare `note` is indistinguishable from a bare table name without resolving the statement. (c) is attractive and is not enough on its own, because `createsTables` is optional and a plugin may reasonably query a table an earlier version created. So the structure changes instead: **a core table is refused by its name, wherever the name stands**, from the list E-761 reads out of the migrations. That rule does not parse and cannot miss a position. The position walk stays for 3.15 G's "restricted to its own prefix", now understanding comma lists and `USING` — and it is **not** claimed complete. What changed is that its incompleteness no longer reaches a core table.
**Price.** Rule 1 refuses a plugin column named after a core table, `identity` and `session` being the two a plugin might reach for, and that refusal cannot be argued with. Whitespace and comments around a dot are removed before tokenising, so the qualified rules see what PostgreSQL sees; this makes the checker's idea of a statement differ from its text in one more way. And the position walk keeps a keyword list for what ends a `FROM` list, which is a third enumeration of the same kind as the two that failed — kept because 3.15 G asks for the restriction, and no longer load-bearing for anything a core table can be reached through.

### The plants that came back green, and the pair that did not
`E-763` · spine · the gate, method

**Context.** §5 requires a planted fault before a passing check is trusted, and E-757 recorded two absorbed greens on the previous structure. The new structure was planted six ways against a corpus of twenty-four statements, twelve of which must be refused, with the outcome predicted before each run.
**Rejected.** Reporting only the plants that reddened.
**Reason.** Disabling the deny-by-name rule alone: predicted green, green — the walk and the schema belt absorb every case. Disabling the comma continuation alone: predicted **red**, came back **green**, because the deny rule catches the bare `session`. Disabling the dot collapsing alone: predicted **red**, came back **green**, because the comma walk refuses `velve` as a table name in its own right. Disabling the schema belt alone: predicted green, green. Deny rule and comma continuation together: predicted red, **one** case red. All three together: predicted red, **four** cases red, and those four are exactly the statements the gate reported. Two predictions were wrong in the safe direction, and both were wrong because a second rule already covered the case — which is the property the restructure was for, and is not something a single-rule plant can show.
**Price.** No single plant reddens the deny rule, so nothing in the corpus demonstrates the rule the boundary now rests on. Its value is structural — it does not depend on the parse — and structure is what a plant cannot measure. A reviewer wanting to see it work has to disable the other two first, which is what this entry records having done.

### A plugin route cannot declare itself a reader of a core cookie
`E-764` · spine · S-CACHE-4, S-CSRF-5, boundary

**Context.** This branch put plugin routes into the table for the first time. `PluginRoute<Id>` was a plain `RouteDeclaration`, so it carried `pendingCookie`, `oauthStateCookie` and an unrestricted `caller` — and a plugin route could make itself the fourth reader of `__Host-velve_pending` or the only reader of the state pointer. 3.6 says every other route ignores the pending cookie completely.
**Rejected.** Reading `test/auth-route-table.test.ts` as covering it.
**Reason.** That test is byte-identical to `main` and passes, because it mounts without plugins: the rule held in the core table and was broken in the table that ships. So `PluginRoute` is now `RouteDeclaration` minus the two cookie fields, with `caller` narrowed to the three a plugin may have, and the registry refuses a declaration carrying either field or `caller: "pending"` — the type for TypeScript, the start error for the JavaScript plugin 3.15 G says the runtime check exists for.
**Price.** The reviewer's `test/spine-state-pointer-cookie.test.ts` proves the pointer's gating with a plugin route that declares `oauthStateCookie` and casts past the type, and this refusal makes that file fail to mount. It is left failing rather than edited: it asserts a capability that must not exist, and under §5 that is a disagreement for the gate. What it was measuring is real and now has no route in the tree that declares the pointer readable at all — the callback that will is wave 5's — so the mechanism is unexercised end to end until then.

### What a hook is told and what goes were two different sets
`E-765` · spine · E-758 corrected, finding

**Context.** E-758 states that `beforeSessionRevoke` fires "once per session about to go". The announcement listed through `listSessionsOwnedBy`, whose predicate carries `idle_expires_at > now() AND absolute_expires_at > now()`; the deletions carry no deadline at all. So `revokeAll` removed every expired-but-unswept row without announcing it, and counted it in the `revokedCount` the caller got.
**Rejected.** Adding the deadline to the deletion so the two agree. That changes what a revocation does — an expired row that is still in the table is still a row, and leaving it is a change to the sweep's job.
**Reason.** The listing was wrong, not the deletion. `listEverySessionIdOwnedBy` is a second statement with the owner predicate and no deadline, used by the announcement and by nothing else, so the set announced is the set removed. It returns ids rather than sessions, because that is all the event carries.
**Price.** A second listing statement whose only difference from the first is a missing predicate, which is exactly the kind of pair that gets consolidated by someone tidying up. The reference says why it exists; nothing enforces it.

### A plugin's own revocation is announced to nobody
`E-766` · spine · 3.15 G, gap

**Context.** `FrozenRepositories.revokeSession` takes a `RevokeReason` and discarded it, and dispatches no hook. So a revocation a plugin performs is invisible to every other plugin, while the same revocation over HTTP is announced to all of them.
**Rejected.** Dispatching `beforeSessionRevoke` from `revokeSession`.
**Reason.** A hook that revokes a session would re-enter its own hook, and an authentication library that can be made to loop by a plausible plugin is worse than one with an asymmetry. 3.15 G puts the seven points on the library's own operations and does not put them on a plugin's calls into the repository. The `reason` is no longer discarded — it is written to the log beside the actor, which is the only record the call leaves.
**Price.** The asymmetry is real and is not defended by anything except this entry and a paragraph in the reference. A plugin that audits revocations sees the HTTP ones and misses the plugin ones, which is precisely the kind of partial record that is worse than none. A re-entry guard would make the dispatch safe and was not built.

### Eight counts on this branch were written without counting
`E-767` · spine · §6, finding

**Context.** `CASE-STUDY.md` already carries an entry on this exact failure class — a number in prose is a claim, and a claim written without the count that produced it is a guess in the costume of a measurement. It was written on this branch. It then recurred eight times on the same branch.
**Rejected.** Recording them one by one where they sit.
**Reason.** They are restated in place, because §6 permits a measurement to be restated before merge and because a wrong number left standing with a correction beside it is worse to read than a right one. What was wrong: the API snapshot reads **nine** top-level declaration files, not eight, and widening it would cover **fifty-one** nested ones, not a hundred and forty; `VelvePlugin` enumerates **seven** fields, not six; the plugin start errors are **six**, not four; the refusals that come from not recognising something are **five**, not four, and the same fact was carried as six in the reference and three in a comment; `availableFactors` changed **eight** call sites in **six** test files, not four features'; the ordering plant reddens **five** cases, not four; and the dispatcher plant reddened **four of five**, not all five. The last two were re-measured by running the plants again, and the dispatcher one now reddens seven, because E-758 gave the dispatcher three callers it did not have when the number was written.
**Price.** Every one of these was produced by a writer who knew roughly how many there were. Restating them does not install the habit that would have prevented them, and this entry is the second on this branch to say so. What is different is only that the counts now name what they count — nine files, seven fields, six errors — so the next reader can check them without reconstructing what was meant.

### `check:lock-order` reads a row lock named in prose as a row lock
`E-768` · spine · the gate, finding

**Context.** The comment above `opensATableList` explained that a row-locking clause is not a table position, and quoted the clause to say which one. `pnpm check:lock-order` scans every source file for that sequence of words and reported `own-tables.ts` for "a row lock that does not declare what it locks". There is no lock in that file and no SQL in it at all.
**Rejected.** (a) Teaching the scanner to skip comments. (b) Leaving the comment and excusing the file.
**Reason.** (a) is a change to a security-adjacent check in gate infrastructure, and doing it correctly means telling a JavaScript comment from the block comment inside a SQL template that the same check requires a lock to carry — the two are the same syntax and only the surrounding template literal separates them. Weakening that scan to fix a prose annoyance is a bad trade for the feature that hit it. (b) puts an exemption in front of a check that has no exemptions. The comment is reworded to say "a row-locking clause" and the finding is recorded rather than tidied away, which is the same shape as the `.reason` scan of E-746 with the opposite resolution: there the check was narrowed because the false positive was in code the requirement was about, here the check is left alone because the false positive is in prose it is not.
**Price.** Nobody may write the two words together anywhere in `src/`, including in a comment explaining why a statement does not contain them, and nothing says so — the next writer meets the same red with the same confusion. Two of the branch's findings are now false positives from scans that read prose as code, and the pattern is that every one of these checks matches text rather than syntax.

### The assertion that survives the check being deleted
`E-769` · spine · S-CACHE-4, S-CSRF-5, E-764 answered

**Context.** E-764 closed the hole and left `test/spine-state-pointer-cookie.test.ts` failing, because that file proved the pointer's gating with a plugin route that cast past the type. Rewriting it means choosing what the file asserts now, and E-764 is right that no route in the tree declares the pointer readable — the mechanism has no core caller until wave 5 writes the callback.
**Rejected.** (a) Deleting the pointer half and keeping only the refusal. (b) Keeping a plugin route as the declaring route by widening the refusal to allow it in tests.
**Reason.** (a) would leave the mechanism this wave built unexercised end to end until wave 5, and an untested mechanism is what wave 5 would then build on. So the declaring route is a **core** route, contributed through a `vi.mock` of `core/oauth/routes.ts` — the module the callback will actually be written in — the way `test/auth-route-seams.test.ts` already does. (b) is weakening a refusal to suit a test. What the plugin half asserts instead is the refusal, at the type and at the start, for `pendingCookie` and `oauthStateCookie` in either value and for `caller: "pending"`.
**Price.** The first version of the plugin half asserted only the start error, and a plant that deleted the refusal reddened it — but the second assertion, that no plugin route is among the mounted table's readers, did not move, because it was measured with a benign plugin. It is now measured by mounting the attacking plugin and accepting either outcome: refused at start, or present and not a reader. That shape is uglier than a plain assertion and it is the one that survives the refusal being built a different way, which is what E-764 shows is worth having. The probe's output fields are named `pointer` and `pending` rather than after the context fields, because `moveTokensIntoCookies` strips an output field called `pendingToken` before the body is written.

### Each of the three rules now has a statement only it refuses
`E-770` · spine · E-757 and E-763 corrected, the gate

**Context.** E-757's Price says two of the three `ownTables` rules are untested on their own and names why: "for a bare foreign name — which no test has — the table walk is the only rule there is". E-763's Price goes further and says "No single plant reddens the deny rule, so nothing in the corpus demonstrates the rule the boundary now rests on. Its value is structural."
**Rejected.** Accepting that. The claim is about the corpus, not about the rule, and E-757 names the missing statement in so many words.
**Reason.** Three statements were added, one per rule, and each was planted against. `SELECT session.id FROM demo_entry` names a core table bare, in a qualified column reference no table walk visits: disabling the deny-by-name rule lets it through, and so does an empty core-name set — which is the second plant, and the one that matters, because `coreTableNames()` reads the names out of the migration SQL with a regular expression and an expression that stops matching yields a silent allow-all. `SELECT velve.other_plugin_entry.note FROM demo_entry` names another plugin's table in the same position: only the schema belt refuses it, and disabling the belt lets it through. The corpus also gained the four shapes a reviewer was asked to probe — `MERGE`, a lateral subquery, a set-returning function and a CTE shadowing a core name — all refused, three of them by the statement-kind allow-list and the position walk rather than by name.
**Price.** E-763's sentence is wrong as written and the entry stays as written; this one says so. What is still true is the part underneath it: the rules overlap on every schema-qualified statement, so a regression in one of them is invisible for that whole class, and three statements are what stands between the boundary and that being invisible everywhere.

### The announcement set was checked against the deletion set, not against a count
`E-771` · spine · E-765 verified

**Context.** E-765 reports that `beforeSessionRevoke` announced through a listing carrying deadline predicates while the deletions carry none, and that a second statement without the deadline now feeds the announcement. The claim to check is that the two sets are the same, and the case that was wrong is an expired-but-unswept row.
**Rejected.** Asserting the count of events against `revokedCount`. Two sets of the same size can still differ.
**Reason.** The test reads the ids before the call and after it, subtracts, and compares that to the ids the hook was told about — so the property asserted is the identity of the two sets rather than their size, on `revokeAll` and on `revokeAllOther`, each with a fresh session, a second fresh session and one whose idle deadline is an hour in the past. Both hold, and `revokeAllOther` announces neither more nor less than the two rows it removes. Putting the deadline predicate back on `listEverySessionIdOwnedBy` reddens both, which is the exact fault E-765 describes; making `listensTo` answer `false` reddens both and one earlier case besides.
**Price.** The test writes an expired row directly rather than letting one expire, so what it proves is that the statement carries no deadline, not that a row that expires during a request is handled. E-765's own Price — that the two listings are a pair someone will consolidate — is not addressed by this and cannot be: nothing here fails if the second statement is deleted and the first put back, unless the expired row is in the table at that moment, which is what these two cases arrange and nothing else does.

### Seven citations on this branch resolve to the wrong entry
`E-772` · spine · §6, finding

**Context.** §6 says a citation left behind by a renumber "does not dangle, it **resolves to the wrong decision**. Nothing detects that." `test/decision-log.test.ts` passes on this branch, because every number cited exists.
**Rejected.** Repairing them. A finding goes back to the writer under §5, and a reviewer moving a citation is a reviewer deciding which entry the code meant.
**Reason.** Seven citations added this round point one entry below the one whose subject they carry. `src/core/auth/routes.ts` cites `E-757` (three rules refuse the same statement) for skipping the announcement where nobody listens, which is `E-758`. `src/core/plugin/registry.ts` cites `E-758` for the declared-and-unread field warning, which is `E-759`, and `E-763` (the plants that came back green) for the core-cookie refusal, which is `E-764`; `src/core/plugin/config.ts` cites `E-763` for the same thing. `src/core/db/repositories/session.ts` and `src/core/session/service.ts` both cite `E-764` for the deadline-free listing, which is `E-765`. `src/core/plugin/context.ts` cites `E-765` for the reason being the only record a plugin's own revocation leaves, which is `E-766`. Every one of them lands on a real entry about a different subject, which is worse than a dangling number: a reader who follows it gets an answer.
**Price.** No check can find these, and this entry is the only record that they exist — so if they are corrected, the correction is verified by reading, and if a further entry is inserted before the fix lands, the same shift happens again. The one structural remark worth making is that all seven are off by exactly one in the same direction, which is what inserting an entry into a block whose comments were already written looks like, and the reserved-range rule §6 relies on does not prevent it.

### The shift reached two more places, and two of them were the reviewer's own
`E-773` · spine · §6, E-772 extended

**Context.** E-772 lists seven citations added this round that resolve to a real entry about a different subject, all off by one in the same direction. It was written from a scan of `src/` only.
**Rejected.** Editing E-772 to say nine. §6 puts new information about a decision in a new entry that cites the old one, and E-796 records what happens when a branch bends that rule on its own work.
**Reason.** Scanning the whole tree rather than `src/` finds two more in the reference — `DOCUMENTATION.md` cites `E-764` for the deadline-free listing, which is `E-765`, and `E-765` for `revokeSession` dispatching no hook, which is `E-766` — so the count is nine, not seven. It also found two in the reviewer's own test files, written this round: `test/spine-state-pointer-cookie.test.ts` cited `E-763` and `test/plugin-hooks.test.ts` cited `E-764`, both copied out of the source comment the test was written against. Those two are corrected here rather than reported, because they are this reviewer's lines.
**Price.** The correction is the reviewer editing citations after committing them, which is the same in-branch edit E-796 argues about, disclosed here rather than made quietly. And the mechanism is worth naming: a citation copied from a neighbouring comment inherits whatever that comment resolves to, so one shifted number propagates to every later reader who trusts it — which is exactly how two of the nine became four.

### The reserved range removes the renumber and does nothing about the insert
`E-774` · spine · §6, E-772 and E-773 answered

**Context.** All eleven citations E-772 and E-773 name are moved to the entry whose subject they carry — nine of them here, the seven in `src/` and the two in the reference, and the two in the reviewer's own test files by E-773 itself. Each of the nine was verified by reading the line and the entry rather than by trusting the list, and all nine pointed one entry below their subject.
**Rejected.** Treating this as nine slips of the pen.
**Reason.** §6 argues the reserved-range mechanism at length, and every sentence of that argument is about **renumbering**: a range removes the need to renumber, removing the renumber removes the failure class, and a citation left behind by a renumber resolves to the wrong decision with nothing to detect it. The nine here were not produced by a renumber. They were produced by writing the citations first, from a plan of which entries this round would have, and then **inserting** an entry — E-763, the plants — into the middle of that plan while writing. Everything after the insertion point shifted by one, and the comments did not. A reserved range is no defence against that at all: the numbers stayed inside the range the whole time, and the range is what the check reads. The failure class §6 closed and the failure class §6 left open have the same symptom and different causes, and the section describes only the first.
**Price.** Nothing detects the second either, and this entry adds no mechanism — it only says that the one §6 relies on does not cover it. The habit that would: cite nothing until the entry exists, or write the entry first and the citation from it. Both were available and neither was used, twice on this branch, because a citation is written in the flow of writing the code and the entry is written afterwards. And the check that would catch it is not obviously buildable: it would have to know what a line is about.

### The deny rule was plantable after all, and its own input was not guarded
`E-775` · spine · E-763 corrected, boundary

**Context.** E-763's Price says "no single plant reddens the deny rule, so nothing in the corpus demonstrates the rule the boundary now rests on. Its value is structural — it does not depend on the parse — and structure is what a plant cannot measure." That was true of the corpus and false of the rule, and E-757 names the missing case itself: a bare foreign name, which the corpus did not have.
**Rejected.** Restating E-763's Price in place. It is a reason, not a measurement.
**Reason.** `SELECT session.id FROM demo_entry` puts a core table bare, in a qualified column reference no table walk visits, and it reddens when the deny rule alone is disabled. So the rule was demonstrable and the entry claimed otherwise on the strength of a corpus that did not contain the one shape the rule exists for — which is the same error as measuring a check against the cases it already passes. The second plant the review asks for matters more: `coreTableNames()` reads the names out of the migration SQL with a regular expression, so an expression that stops matching returns an empty set and the deny rule permits everything, silently. That is *found nothing means permission* one level down, inside the rule built to remove it, and E-761's Price predicted it in writing and did nothing about it. `createOwnTables` now refuses to be built at all on an empty set. Planted: `coreTableNames()` made to return nothing reddens all seven `ownTables` cases and skips the frozen-context suite, because the start throws.
**Price.** The guard is a floor of one, not a count, so a pattern that matched a single table would pass it, and asserting the exact sixteen would be a second statement of the schema — the thing E-761 exists to avoid. Between a number that drifts and a floor that is nearly free, the floor is chosen and the gap between one and sixteen is left open. And E-763's claim stood in the log for one round as an argument that a rule could not be tested, which is the most expensive kind of wrong entry: it tells the next reader not to try.

### Six shared surfaces cut before wave 5, and the level below them
`E-776` · spine · the partition, decided

**Context.** This wave exists because three rounds of an independent gate found nought, three and then seven files that `oauth`, `email-flows` and `plugin` would each have to edit. A fourth round against the finished tree found five files and one region still shared. The test applied to each is not "would this be nice" but **would two of the three have to touch it** — where only one would, the file is that writer's and is left alone.
**Rejected.** (a) Leaving them for the wave to discover. (b) Cutting everything that three features merely read.
**Reason.** (a) costs three writers when it lands mid-wave and costs an hour now. (b) is how a partition turns into a maze: a file two features read and neither writes is not shared. What was cut, and why each passed the two-writer test:

`instance.ts` twice, which is the file the wave was cut to vacate. `migrate()` ran the core migrations only, so `plugin` had to edit it; `core/plugin/migrations.ts` now contributes and returns nothing, which leaves E-748's decision — that plugin migrations do not run until the ledger's version collision is settled — exactly where it was. `SeamSurface` was not parameterised by the identity mode while `VelveAuth<M>` is, so `email-flows` would have edited it to make `/email/*` conditional; each seam module now declares its own `…Surface<M>` and the assembly intersects the three.

`test/__snapshots__/api-surface.md` carried the whole export list on one physical line of 1968 characters. Three writers each adding a name is one three-way conflict on one line, resolvable only by regenerating and hoping. One name per line makes them disjoint hunks; the longest line in the snapshot is now 291.

`DOCUMENTATION.md`'s list of what is not assembled belonged to nobody and all three had to edit it. It was **already stale** — it named the plugin interface as absent on a branch that had built it, three paragraphs above a rewrite that did not touch the bullet. It is replaced by a table of the four seams, which the assembly owns, and the rule that a feature states its own gaps in its own chapter.

The hook-producer claim stood in two documents and named which points fire. `oauth` and `email-flows` both falsify it — the first sign-in gives `beforeSignIn` a producer, the first sign-up gives `beforeUserCreate` one — so two features would have edited one table. **The cell is now a yes or a no and never a list**, so the first feature to reach a point flips it and the second finds it flipped and edits nothing; a list would have made that an append by both. The README states no producer at all and points at the table.

`test/auth-config-seams.test.ts` held the OAuth seam and the plugin seam in one file and is split in two, twelve cases before and twelve after.

`mountAuth` is hard-wired to `VelveAuth<"email">`, and this one is the honest half-answer: only `email-flows` plausibly needs another mode, so by the test above the file stays shared and the mode-taking fixture is theirs to add. What was done is narrower — `MountedAuth` is generic with `"email"` as its default — because adding a function at the end of a fixture is a disjoint hunk and rewriting an interface in the middle of one is not.
**Price.** One level below these six, four candidates were checked and none passed the test, which is a result and is stated rather than assumed. `RouteServices` was pre-cut by E-719 and carries every field the three need — the identity and token repositories each feature will build come from `driver` and `schema`, which are already there. `error-map.ts` already carries every concealed reason 3.15 F.1 lists for OAuth, so `oauth` widens no union. `test/auth-route-table.test.ts` already names `signIn.oauth.callback` and `identity.list` in the sets a wave-5 route would join, and mounts without plugins. `test/auth-fixtures.ts`'s `requestTo` and the `fetch` override both already carry what `oauth` needs. The closest residual is `test/db-fixtures.ts`: `oauth` will want an identity-row helper and `email-flows` a token-row helper, which is two writers appending to one file — disjoint hunks, and named here rather than cut, because cutting a fixture file into three is a cost paid by every test that imports it. And the deeper price is that four rounds have each found a shared surface one level below the one just cut, so the honest expectation is a fifth, not that this list is the last.

### Thirteen Prices named a risk and stopped; six are closed and seven have an owner
`E-777` · spine · §6, the branch audited

**Context.** A Price that names a risk and stops there is a note, not a mitigation, and this branch has the proof: E-761's Price wrote down in so many words that an empty core-table list would turn the deny rule into a no-op without failing, and did nothing about it. It stayed a sentence until a review asked for the plant. All forty-two Prices this feature wrote were then read against that test — does this name a way the code can go wrong, with no mechanism and no owner — and thirteen of them do.
**Rejected.** (a) Closing all thirteen. (b) Leaving them and saying the audit was done.
**Reason.** (a) is not available: four of them are open because a mechanism would cost more than the risk, and two are open because closing them means deciding something that belongs to a feature that has not been written. (b) is what E-761 did. So each of the thirteen is now either closed or handed to a named owner, and the list is here rather than spread over thirteen entries.

**Closed.** Six. E-740's — a list of surface namespaces in `instance.ts` with nothing holding it to the surface — is closed here: the assembly now refuses to return an instance whose surface carries a namespace neither that list nor a configured plugin id names, so the list cannot fall behind what it describes. Planted by adding a `magicLink` namespace to the surface and not to the list: every start-up case reddens. The other five were closed by work that followed them — E-761's by the floor E-775 added, E-744's snapshot conflict by the one-name-per-line split of E-776, E-764's unexercised pointer by the reviewer mounting the declaring route through a seam mock in E-769, E-765's unenforced pair of listings by the set comparison in E-771, and E-763's claim that the deny rule could not be planted by E-775 showing that it can.

**Open, with an owner.** Seven, and each says who. E-745's — the API snapshot reads nine barrels and is described as reading the public surface — belongs to whoever owns `test/api-surface.test.ts`, because widening it puts fifty-one files of internal declarations under a snapshot. E-746's residual, a file that reads `error["reason"]` without naming `ConcealedError`, is the same shape and the same owner. E-757's, that the three `ownTables` rules overlap so a regression in one is invisible on a schema-qualified statement, is narrowed by E-770 and not removed; it belongs with whoever next changes those rules. E-759's, that `Object.keys` does not see a middleware carried on a prototype, has no fix short of a structural clone and is left as the guard against the plain object a JavaScript plugin is. E-766's missing re-entry guard is **wave 5 `plugin`'s**: dispatching `beforeSessionRevoke` from `revokeSession` is safe only with one, and whether to dispatch at all is that feature's decision. E-768's, that the two words naming a row lock may not appear in `src/` prose and nothing says so, belongs to whoever owns `tools/lock-order.mjs`. E-736's, that nothing forces a route reading the state pointer to declare it, is **wave 5 `oauth`'s**, and is the one where the owner will meet it immediately: the callback is the first route that has to declare it.
**Price.** Naming an owner is not the same as closing anything, and six of the seven owners have not agreed to anything — this entry hands work to features and files whose writers will read it after the fact, which is the weakest form of a hand-off there is. The audit is also a snapshot: it read the Prices as they stand, and an entry written after it is under no obligation to be audited. And the rule this entry exists to apply was already available when every one of the thirteen was written, so what changed is not that the rule is known but that somebody went back and applied it.

### E-777 closed E-740 the wrong way, and the tests said so
`E-778` · spine · E-777 corrected, boundary

**Context.** E-777 reports E-740 closed by an assertion that every namespace on the built surface is named by `RESERVED_SURFACE_NAMESPACES` or by a configured plugin id. That is what was built and it is not what should have been: two test files that mock a seam module to contribute a probe route mount a surface with a namespace no list names, and both went red. A seam contributing a namespace is the seam working.
**Rejected.** Adding the probe namespaces to the list, or exempting the tests.
**Reason.** The red was evidence about the check, not about the tests, and it pointed at the thing E-740 complained of in the first place: a **list**. The risk was never that the surface grows a namespace — it is that a plugin id shadows one — so the collision check now reads `Object.keys` of the surface the assembly has just built and the list is deleted. There is no second statement of 3.15 B's namespaces left to fall behind anything, which is a better close than the one E-777 describes. E-777's account of the mechanism is a reason and not a measurement, so it stands as written and this entry corrects it.
**Price.** Two plants, one predicted wrong. Making the check refuse nothing reddens the reviewer's existing case for a plugin id occupying a surface namespace — predicted red, red. Spreading the plugin namespaces *after* the core ones, so a plugin could shadow, was predicted red and came back **green**: the refusal above it means no colliding id ever reaches the spread, so the ordering is defence behind a door that is already shut and no test can tell the two apart. And the close arrived by breaking two tests rather than by reading, on a branch whose previous round recorded that a check must be planted before it is trusted — this one was planted only after the suite refused it.

### Derive it instead of listing it, and the case where that is exactly wrong
`E-779` · spine · E-778 corrected, boundary

**Context.** E-778 replaced a list of the instance's namespaces with `Object.keys` of the surface the assembly had just built, on the argument that a list is a second statement and falls behind. The argument is right and the conclusion was wrong, and the gate found the hole in the commit that installed it: `coreSurface` folds the **seam** routes, the seams return nothing until wave 5, so `password`, `factor`, `identity`, `email` and `username` stopped being reserved. Mounted in `email` mode, a plugin with any of those five ids starts and takes `auth.<id>`. `username` is worse than released — it is on the surface in `username` and `username_email` mode and absent in `email`, so the same plugin starts or is refused depending on the identity mode. Two more the derived list omitted, `signIn` and `signUp`, are refused only because `assertIdentifier` forbids a capital letter, which is an accident and not the check.
**Rejected.** Keeping the derived form and adding the unbuilt namespaces back to it, which is a list again with an extra step.
**Reason.** The question neither the entry nor the review that endorsed it asked was **behind what**. A list of namespaces can fall behind the surface; that is what E-740 complained of and it is a real failure mode. What replaced it falls behind **the specification** — and 3.15 B is the authority for what the core owns, not the build state. A wave-4 build that has not assembled wave 5's namespaces does not thereby release them to a plugin. So the answer is a list, of 3.15 B's eighteen namespaces, which is a statement of a document that is supposed to be stable rather than of a tree that changes every wave. Where E-740's complaint still bites — the list falling behind the surface — a test asserts every namespace the built instance carries is in it, in two identity modes.
**Price.** The test can only check one direction. That the surface never carries a namespace the list omits is checkable; that the list carries all eighteen of 3.15 B is checkable only by reading it against 3.15 B, because the alternative is a second copy of 3.15 B to compare it with. And "derive it rather than list it" is a rule this branch applied correctly to the core table names, where the SQL that creates them is the authority, and incorrectly here, where the build is not — the rule is sound and says nothing about which source is the authority, which is the whole of what went wrong.

### The check keyed on the plugin's id and the surface is keyed by the route's name
`E-780` · spine · 3.11, second half of E-779

**Context.** The same commit narrowed the namespace check on a second axis nobody noticed: the clause it replaced tested `route.name.split(".")[0]`, and what replaced it tested `plugin.id`. Those are different strings. A plugin with `id: "demo"` and a route named `identity.list` started and owned `auth.identity.list` — the name 3.15 D.3 gives the core's identity listing.
**Rejected.** Testing only the route name, on the argument that a plugin with no routes shadows nothing.
**Reason.** `nestServerMethods` keys the surface by the dotted `name`, so the name is what can collide, and it is now tested. The id is tested beside it because 3.11 states the prohibition about the plugin's namespace and a plugin that claims `session` as its id has claimed it whether it has written the route yet or not. Both halves are planted against the committed suite: dropping the name half reddens **one** case, dropping the id half reddens **one**, and neither absorbs the other.
**Price.** The plant that missed this is the lesson. `test/plugin-registry-start.test.ts` uses `id: "session"` — one of the ids that still worked — so deleting the whole check reddened it and the plant fired while measuring only the surviving half. A plant proves a case, not a rule, and the case a plant is written against is chosen by the same person who wrote the rule. `id: "identity"` separates them in one line and nobody had written it.

### A prototype can carry what `Object.hasOwn` will not see, and here it carried the cookie
`E-781` · spine · S-CACHE-4, E-759 extended

**Context.** `assertNoRouteReadsACoreCookie` tested the two forbidden fields with `Object.hasOwn`, and `defineRoute` reads them by property access. `Object.create({ pendingCookie: "readable" })` therefore passed the refusal and reached `readsPendingCookie`, and its handler was given the real value of `__Host-velve_pending`.
**Rejected.** Pricing it the way E-759 prices the same shape for plugin fields.
**Reason.** E-759's price is sound for what it covers: a field the interface does not read is a field evasion buys nothing from, so seeing own properties only is a guard against the plain object a JavaScript plugin is and not against an attacker. This is not that. The field is read, by property access, and evading the check buys the cookie that carries a half-finished sign-in — the exact value 3.6 gives four routes and no others. The fix is `in` instead of `Object.hasOwn`, one operator, matching how the value is later read.
**Price.** The two checks now disagree on purpose: plugin **fields** are tested with `Object.hasOwn` and route **cookie fields** with `in`, and the reason is in two entries rather than in one rule. A reader who standardises them will make one of the two wrong, and which one depends on which they standardise on.

### The four false refusals that touch nothing, and the one hole in the rule that touches everything
`E-782` · spine · E-762 corrected, boundary

**Context.** Two claims about `ownTables` were wrong in opposite directions. The reference said Rule 1 refuses a core table "in any position" and "does not depend on the parse"; it does depend on one step — text inside a string literal is erased before the names are looked for — so `SELECT query_to_xml('select * from velve.user', …)` passes. And a whole class of refusals went undocumented while a test asserted them under a name that says they are foreign: a `LATERAL` item, a set-returning function and a table function all sit where a table sits, are refused, and reach no core table.
**Rejected.** Refusing every statement whose literals contain SQL-shaped text, which would close the hole.
**Reason.** That refuses ordinary data — a plugin storing a query, a log line, a column of user text — and the boundary is a guardrail against the accident, where refusing the ordinary case to catch the exotic one is the wrong trade. So the hole is disclosed instead: the reference says Rule 1 sees any position **the reader treats as code**, and names the literal case as open. The false refusals are listed as their own class, and the test's array is renamed from `foreign` to `refused`, because what it asserts is true and what it called it was not.
**Price.** A documented hole is still a hole, and this one is reachable by any plugin that can get the database to execute a string — which is a small set of functions and not an empty one. And the false-refusal list is now six items long for a boundary whose whole justification is that it catches accidents; a plugin author who meets three of them in a week will reach for the driver directly, which is the outcome the guardrail cannot prevent and this entry cannot argue away.

### Two fixtures a wave-5 branch could only have widened by appending
`E-783` · spine · the partition, decided

**Context.** A fifth round against the tree found two shared fixtures below the six E-776 cut. `test/db-fixtures.ts`'s `createUser` inserts `(email)` only, so it cannot make a user any `username` mode accepts, and ten test files import it. `configFor` and `mountAuth` are `VelveAuth<"email">`-only. Either gap is closed by a wave-5 branch appending to the file, and two branches appending to the end of one fixture is the wave-2 failure §5 names by name.
**Rejected.** Making `configFor` generic over the mode.
**Reason.** `VelveAuthConfig<M>` is `BaseConfig<M> & RecoveryCodesRequirement<M>` and E-349 records what happens when that inference site is disturbed. `mountAuthInMode` takes the identity configuration as an argument instead, so `M` is given and never inferred, and `configFor`'s defaults are spelled out in it rather than shared with it. `createUser` gains an optional third argument and keeps its two-argument form for all ten importers.
**Price.** `mountAuthInMode` duplicates `configFor`'s five defaults, so a default that changes has to change twice and nothing says so. And it exists because one wave-5 feature might want another mode — the test E-776 sets out says a file only one feature touches is that feature's, and this is a deliberate exception to it, bought because the alternative shape is an append by two.

### The shift recurred while the entry about the shift was being written
`E-784` · spine · §6, E-774 extended

**Context.** E-774 names the mechanism: citations written from a plan, an entry inserted into the middle of that plan, everything after it shifted by one, and no check able to see it because every number cited exists. This round wrote four citations before the entries and then inserted one — and four of the five resolved to the wrong entry, in the same direction, again. `E-780` sat on the prototype-cookie fix that is `E-781`, both fixture comments sat on `E-781` when they are this round's `E-783`, and `E-779` sat on the id-against-name axis that is `E-780`.
**Rejected.** Recording it inside E-774, which is the entry it is about.
**Reason.** E-774 states the habit that prevents it — write the entry first, or cite nothing until it exists — and this round did neither, one round after writing it down. That is worth a separate entry because it is evidence about the habit and not about the mechanism: knowing the failure mode, having just described it in the log, and having been caught by a reviewer for nine instances of it did not stop the tenth through twelfth. What changed the outcome this time is only that the citations were re-read before the commit rather than by a gate afterwards.
**Price.** Four more citations moved by reading, the fourth found only on a second pass over the same four files, and the same absence of any check that could have found any of them. Four counts were also restated this round for the same reason they were restated last round — `E-755`'s plant total against its own enumeration, `E-757`'s reading of it, `E-767`'s fifty against fifty-one, and `E-774`'s nine against the eleven `E-772` and `E-773` name between them — and the entry that restated the last batch is one of the entries that needed restating. The pattern in both is a number or a name written from what the writer remembers of a document they wrote, and the only thing that has ever caught it is somebody reading the two side by side.

### The plants that proved the namespace check measured a file that is not in the tree
`E-785` · spine · E-780 corrected, the gate

**Context.** E-780 reported that dropping the route-name half of the namespace check lets three cases start and dropping the id half lets seven. On the committed tree the gate measured **nought and nought**: dropping either half reddened nothing, and the route-name axis — the one the round before had found broken, where `id: "demo"` with a route named `identity.list` took `auth.identity.list` — had no test at all.
**Rejected.** Nothing. This is a report of how the numbers were produced, and then the repair.
**Reason.** The plants were run against `regress.mjs`, a probe written in the scratchpad, built against `dist/` and never committed. It exercised eleven configurations and its counts are real; they are counts of a harness a reader does not have. So the entry stated as evidence a number nobody could reproduce, for a check whose previous version had shipped broken — and the sentence it stated it in was that a plant proves a case and the case is chosen by whoever wrote the rule. The two cases E-780's own Price named are now in `test/auth-surface-namespaces.test.ts`: five ids the derived form released, `identity` among them, and two route names whose first segment is a core namespace under a plugin called `demo`. Re-planted against the committed suite, predicted first: each half reddens exactly **one** case and neither absorbs the other, which is why E-780's numbers are restated to one and one.
**Price.** The throwaway probe is the reason this happened and it is not a mistake to have written one — it is faster than a test and it found the two-axis regression in the first place. What was wrong is reporting its counts in an entry as if they measured the repository. A number in the log has to name a tree a reader can check out, and this branch has now produced three kinds of unreproducible number: one measured before an edit, one measured against a discarded tier run, and one measured against a file that was never committed.

### What a sweep of the whole tree found, and what that is worth
`E-786` · spine · §6, E-784 extended

**Context.** E-784 records that no check can find a citation resolving to the wrong entry, and that the only thing that has caught one is a reader comparing the two. The gate then swept the whole tree rather than the changed files.
**Rejected.** Leaving the result in a review message, where the next person looking for it would not find it.
**Reason.** **1,050 citation instances against 496 entries. Every one resolves, and none resolves to the wrong entry.** All four faults of the previous round are fixed, the ordinal in `test/plugin-security-order.test.ts` among them, and the gate verified from `git diff` that the four wrong citations E-784 describes were never committed — so that entry's claim to have caught them by re-reading before the commit is borne out by the history rather than merely asserted by its author. For a fault class that has occurred twice on this branch and that no check can see, a confirmed absence over 1,050 instances is worth as much as a find, and it is worth more with the size beside it: the same sweep over the changed files alone would have proved much less.
**Price.** It is a measurement of one moment. Nothing keeps it true, the next inserted entry can break any of the 1,050 without failing anything, and the sweep is a person reading rather than a command anyone can run. Recording the number does not make it a check; it makes it a baseline that the next reader has to re-establish by hand.

### The test command and a file-syncing worktree are in a permanent race
`E-787` · spine · the environment, finding

**Context.** Four lifecycle hooks in `package.json` — `pretest`, `pretest:nightly`, `pretest:release` and `precheck:session-owner` — run `tsdown`, and `tsdown.config.ts` sets `clean: true`. Every one of those commands therefore deletes the whole generated tree and rewrites a hundred and forty-eight files before the first test runs. This worktree lives under `~/Desktop`, where a file-syncing client watches it, and three symptoms followed. Eleven files named `* 2.ts` appeared in `src/` and `test/` during a rebase, untracked, verified against `git ls-files` as never having been tracked. A hundred and seventy-six numbered duplicates — `testing 12.mjs`, `import.d 17.mts` — appeared in `dist/` during a gate run and reddened barrier 3 of `test/auth-testing-barriers.test.ts`. And during a nightly run `dist/core/db/identifier.mjs` and `dist/core/http/error-map.mjs` were absent while `dist/schema.mjs` and `dist/index.mjs` imported them, reddening three cases of `test/db-package-reach.test.ts`; both files were present a minute later and the run passed with nothing changed between them.
**Rejected.** Building a defence in the repository — a pattern that ignores a numbered duplicate, or a retry around the reach test.
**Reason.** The diagnosis fits all three: a sync client racing a delete-and-rewrite restores a file it believes was lost, under a new name, and can have a path unresolved at the moment a test imports it. But a barrier test that goes red because a file appeared beside the one it checks is **not** defective. It fails closed, which is the correct direction for a check whose subject is what the package ships, and the obvious defence is one of the three broken-check shapes §5 names by name — *an exclusion that deleted the text it was meant to examine*. A pattern broad enough to match a sync tool's naming is broad enough to hide a genuinely leaked artefact, and the asymmetry runs the right way: a false red costs a re-run, a filter that hides a real artefact is silent and permanent. So nothing is added to the tree, and the finding is written down instead.
**Price.** This is true of an environment and not of the repository, so nothing in the tree keeps it true and nothing will tell the next person who meets it — they will read a red barrier test as a defect in their own change, which is exactly what it looks like. What bounds the damage is that `dist/` is in `.gitignore` and the eleven source-side duplicates were untracked, so none of the three occurrences could reach a commit; that is a property of the ignore file rather than of anything anyone built for it. And the entry cannot say the race is over, only that it did not reproduce twice in a row.

### The skill's own argument, turned on the skill
`E-880` · skillver · skill content, frozen

**Context.** `CLAUDE-SKILL.md` opens by saying it carries no copy of the library's documentation, deliberately, because a copy goes stale and a stale copy of an authentication library's interface is confidently wrong. It then carried facts in its prose, and those are copies. Architecture 3.14's thirteen exclusions were quoted verbatim as a blockquote; the package being at `0.0.0` and not on npm appeared twice; section 4 was said to cover five sources and 4.6 was said not to be a sixth; the decided gaps were summarised; and the counts thirteen, fourteen, five and seven were stated outright. The one that bites is the blockquote. A native audit log is planned for a later wave, and the skill listed an audit log among the thirteen under the heading *Not coming. No roadmap language.* — so on the day that feature ships, the skill refuses a feature the library has, in the most absolute wording it owns, to a user who is looking straight at it.

**Rejected.** Dating the lists, or marking them *as of wave 4*. Rejected because a reader who reaches a list reads the list; the qualifier is the part that is skipped, and a dated list still has to be updated, which is the cost the whole design was avoiding. Also rejected: keeping the lists and adding a sentence telling the reader to verify them, which is the same thing with an extra step and leaves the confident wording in place.

**Reason.** The rule that replaces them is *state method, never fact about the library*. What made the lists useful was the recognition — that "a column to tell staff from customers" is a roles question and "which sign-ins happened last week" is an audit question — and recognition does not go stale. The verdict does. So the recognition stays and every "the library does not do X" became "find out from the live document whether it does, and answer from that".

**Price.** The skill is slower at exactly the thing it was fastest at. Where it used to refuse in one sentence citing 3.14, it now fetches two lists first and usually arrives at the same refusal. It can no longer refuse anything at all without network access, where before it could refuse thirteen things from memory — and the "cannot read a source" rule, which already said to stop rather than answer, now covers refusals too. That is the intended trade and it is still a loss.

### Section numbers stay, demoted to hints
`E-881` · skillver · skill content, frozen

**Context.** `3.14`, `3.15`, `3.16`, `3.11` and the requirement identifiers are facts by the same definition used above: a renumbering makes them false, and nothing in the skill would notice. But §10 of the skill requires an answer to carry the clause it rests on, and an answer that cites nothing is the hedge the same section forbids. Removing the numbers and keeping the citation duty is not possible.

**Rejected.** Deleting them. Also rejected: keeping them bare, as authority, which is what they were.

**Reason.** The two failures are not the same size. A number that has moved costs the reader a search; a verdict that has changed costs them a wrong answer they act on. So the numbers stay and each one now travels with what the section is called or does — "3.14, the one titled for what the library does not do", "3.16, the one that enumerates `L-1` and onwards" — and the file states once that a number is a hint for the search and not an authority. A reader who finds 3.14 moved can still find *What is deliberately absent*.

**Price.** Nothing enforces the pairing. The next editor adding a citation will add a bare one, and it will read exactly like the paired ones. And a renumbered section still reads as authoritative to anyone who does not reach the sentence in §1 that demotes it. What is left in the file was checked against the specification in the tree before it was left: five section numbers, one sub-address (`3.15 D.3`), six individual identifiers (`S-TOKEN-6`, `S-LINK-2`, `T-CSRF-1`, `L-1`, `L-12`, `E-23`), three requirement classes named without a number, and two external advisories. That check is a one-off; it is not a step in the gate.

### One version number, and it lives in the file's own text
`E-882` · skillver · versioning, frozen

**Context.** The skill has to be able to say which version of itself is running, and it can only know that from something it can read. The owner was explicit that they will not maintain the number in two places.

**Rejected.** The package version in `package.json`, which is the library's and moves for reasons that have nothing to do with the skill — the whole point of the design is that the two move independently. A `VERSION` file, which the skill could not read from inside a conversation. A date alone, which orders fine but says when the file was touched rather than whether its method changed. Repeating the number in `README.md`, which is what the owner refused.

**Reason.** A line directly under the first heading, `**Skill version 1 · 2026-09-09**`, greppable and readable in the same glance. The skill knows its own version because it is in the file it is running from, and the published copy states its version the same way, so the comparison is one fetch and one regex. `README.md` links to the line rather than repeating it.

**Price.** The number is on disk twice, because `CODEX-SKILL.md` states the same line. It is in the source once — the Codex file is generated — but nothing in the gate ran the generator, so the two could drift. `pnpm check:skill-version` now compares the two lines, which catches the drift in the number and not in the prose around it.

### The version tracks the skill, not the library
`E-883` · skillver · versioning, frozen

**Context.** This was not decided while writing the file. It fell out of removing the facts, was left as a property of how the file happened to be written, and was named as a rule only after the owner said, mid-branch, that it was the reason the job existed: a release moves the documentation, the skill reads it live, the number stays put, and no user has to do anything. A skill update becomes a rare event always worth the interruption instead of a tax on every release.

**Rejected.** Leaving it implicit, which is what had already happened once. A property nobody wrote down survives exactly as long as the next editor's assumptions.

**Reason.** A future editor meets a rule at the moment they are about to break it, and the moment here is reaching for the version number. So the rule sits at the version line rather than in a section about policy. Its corollary is the thing that actually keeps the property true and is stated as a rule of its own in §1: adding a fact about the library's features to the skill is a defect, because one such sentence turns every subsequent release into a skill release.

**Price.** The skill now opens with three rules about itself — the file wins where they disagree, it states method and not fact, its version tracks itself — before it says anything about the library it is an expert on. That is a lot of self-reference at the top of a file whose §10 tells the reader not to fill space. And the corollary is a sentence, not a check: nothing detects a fact being added, only a version not being raised when one is.

### The Codex file's differences are confined to its header
`E-884` · skillver · file parity, frozen

**Context.** `CODEX-SKILL.md` is produced from `CLAUDE-SKILL.md`, and the two are required to differ only in the header and the `this skill` → `these instructions` rewordings. The session check breaks that: it has to name which URL to fetch and which file to write, and those genuinely differ — one is installed into a skill directory and needs a restart, the other is `AGENTS.md` in a project and does not.

**Rejected.** A third sanctioned class of difference covering the whole of §0, which would make the parity rule "the two differ in the header, the rewordings, and one section", and a rule with three exceptions is not checked by reading a diff any more. Also rejected: writing §0 abstractly enough to cover both without naming either, which produced sentences that named no file and instructed nobody.

**Reason.** Move the file-specific facts up into the header, which is already the region allowed to differ, and have §0 refer to *the top of this file*. §0 is then byte-identical in both, and the diff of the two files is still one header hunk plus the reworded lines — which is what a reviewer can check by eye, and is how it was checked here.

**Price.** §0 is one indirection away from what it instructs: "install it the way the top of this file describes" reads worse than a `curl` line in place, and a reader who skips the header loses the whole procedure. And the Codex header now carries shared prose — the paragraph about the version tracking the skill — so the region that exists to hold what differs also holds something that does not.

### The version check costs a fetch, and contradicts the skill's own §10
`E-885` · skillver · session behaviour, frozen

**Context.** The check runs before the first answer about Velve Auth in a session and only then. It costs a fetch at the start of every such session, and installing an update writes into the user's own skill directory.

**Rejected.** Checking per answer, which §1 already does for the sources and which for a version would be pure noise. Checking silently and speaking only when out of date, which is cheaper for the reader and leaves them unable to tell a check that found nothing from a check that never ran — the distinction §5 of this repository's rules exists for. Installing without asking, which is the sort of thing that gets a skill uninstalled.

**Reason.** Say the cost in the file rather than let the user discover it; ask, then act, never act and report. Both are written into §0 as text the agent is meant to honour, not as a note to the maintainer.

**Price.** One line of version chatter at the start of every session, in a file whose §10 says: no preamble about what you are about to do. The version line is exactly that preamble. The file now contains that contradiction and does not resolve it — the line is required and §10 still forbids its shape — and the only defence is that it is one line and happens once.

### The description keeps the provider names by opening the list
`E-886` · skillver · skill content, frozen

**Context.** The skill's frontmatter `description` listed the five migration sources by name. That is the same closed list §1 now forbids in the body, and it is also what makes the skill fire when a user's first sentence says "Clerk" rather than "Velve Auth".

**Rejected.** Deleting the names, which is consistent and loses the trigger — a skill that does not activate refuses nothing and cites nothing. Keeping them closed, which is the defect.

**Reason.** "(Supabase, Clerk, Auth0, Firebase, NextAuth and others)" cannot become false whatever the enumeration does, because *and others* is true of every superset of it. The words that make the skill activate survive and the claim does not close.

**Price.** A reader of the description may still take the five as the covered set, and the description is the one part of the file an agent sees without reading further — so the least verifiable sentence in the file is the most read one. The honest statement of this is that the description is a matching hint rather than an instruction, and nothing in the file says so.

### The version bump is checked, and what the check cannot see
`E-887` · skillver · gate, frozen

**Context.** `CLAUDE.md` §6 now names the skill as a fourth file kept current, with the rule that every change to it raises its version. §5 of the same file says what a rule enforced by noticing is worth, and the two `DOCUMENTATION.md` bullets there are the standing example.

**Rejected.** Leaving it to the reviewer. Also rejected: writing the rule as "keep the skill current alongside the documentation", which is how it would naturally be phrased and is the trap — the documentation is kept current by describing the features, the skill by continuing to describe none of them, and a reader who takes the flat phrasing at face value helpfully adds the new feature and destroys the property. §6 states the two meanings side by side and says which one applies.

**Reason.** `pnpm check:skill-version` compares each skill file against the merge base and requires a higher version number where the file changed, requires both files to state the same line, and refuses rather than passes when it cannot look — an unresolvable base, no common ancestor, a skill file absent at `HEAD`, or a version line it cannot read. It reads committed history and not the working tree, like `check:log-append` and unlike every other step, and §9's entry says so, because a writer watching the other steps has no signal that this one differs. A raise without a change is permitted: the rule is that a change raises the version, and refusing a lone raise would refuse the repair of a commit that forgot one.

Nine faults were planted before the check was trusted, each with its outcome predicted first: nothing touched, a skill file edited without a raise, edited and raised, raised alone, the version line deleted, a hand-edit of the generated file alone, the two files stating different versions, an unresolvable base, and a base with no common ancestor. Eight matched the prediction. The ninth — the hand-edit of the generated file — came back green, and the plant was at fault rather than the check: it had been committed on top of an earlier commit that raised the version, so the file had changed *and* risen. Rebuilt in isolation it is red.

**Price.** That mis-built plant is also a real hole, and it is worth stating as one rather than as an accident of testing. A hand-edit of `CODEX-SKILL.md` made in the same branch as any legitimate raise passes, because the file then changed and its version rose and the check asks nothing further. No version-based check can catch that; only regenerating the file and comparing can, and this branch did not commit the generator, so `CODEX-SKILL.md` being the mechanical image of `CLAUDE-SKILL.md` is still what §6 says it is — enforced by the reviewer noticing. The check narrows the window to a branch that touches nothing else, which is the common shape of a drive-by edit and not the dangerous one.

### The Codex file is generated now, not asserted to be
`E-888` · skillver · gate, frozen

**Context.** The Price of `E-887` named a hole and left it there: a hand-edit of `CODEX-SKILL.md` passes `check:skill-version` whenever the branch raises the version for some other reason, because the file then changed and its version rose and the check asks nothing further. It closed by saying the parity was still what §6 said it was, enforced by the reviewer noticing. The owner's rule against that is the one being applied to wave 4 in parallel: a price that names a risk without a mechanism is a note, not a mitigation.

**Rejected.** Leaving it priced. Also rejected: keeping the Codex header's prose in `CODEX-SKILL.md` and regenerating only the body below the shared anchor, which would have been the tidier split — prose stays in a document — and would have left the header unchecked. The header is where the installation path, the fetch URL and the sentence about there being no restart live, which are the sentences a Codex reader acts on, and `E-884` had just finished moving the file-specific facts *into* it. An unchecked header is the wrong half to leave open.

**Reason.** `tools/codex-skill.mjs` now holds the transform — the header template and the eleven reworded passages with the verb agreement each carries — and is therefore the definition of `CODEX-SKILL.md`; `pnpm check:codex-skill` regenerates and compares byte for byte, and `--write` is the only way the file changes. Seven working-tree faults were planted with the outcome predicted first — nothing touched, a hand-edit of the generated file, the skill edited without regenerating, the skill edited and regenerated, the skill unreadable, the generated file absent, and a reworded passage removed so the transform can no longer run — and all seven matched, the last three refusing rather than passing. Two more were planted in committed history. The hand-edit alone, re-run in isolation rather than reasoned about, is red under both checks. The ride-along — a hand-edit committed alongside a legitimate raise — is green under `check:skill-version`, exactly as before, and red under `check:codex-skill`, which is the hole closing.

**Price.** Twelve lines of prose a Codex reader acts on now live in a `.mjs` file and are edited in a script rather than in a document; §6 forbids new markdown in the root and has just pushed some markdown out of it, which is not what that rule was for. The new check reads the working tree, unlike `check:skill-version` and `check:log-append`, so the two skill checks are not the same kind of check and a regeneration that is written but not committed satisfies one and not the other. And the Price of `E-887` is now wrong where it says the parity is reviewer-enforced. It is not edited; this entry is the correction, which is the shape §6 requires and the second such chain this branch has produced.

### The version stays at 1 although the branch changed the skill again
`E-889` · skillver · versioning, frozen

**Context.** Committing the generator changed `CODEX-SKILL.md` — the header sentence saying nothing automated enforced the parity had become false — and §6's new rule says every change to a skill file raises its version, always. The version stayed at 1.

**Rejected.** Raising it to 2, which is what the rule says on a literal reading of "every change".

**Reason.** Version 1 has never been anywhere: the merge base carries no version line at all, and the check measures against the merge base rather than against the previous commit. Raising per commit would publish numbers no reader ever saw and none could compare against — this branch alone would have shipped as version 7. So the unit is the change that merges, and §6 now says so in a sentence of its own rather than leaving the rule to be read literally and worked around in practice.

**Price.** §6's rule was written this afternoon and is amended in the same branch that wrote it, so it never existed in the form the earlier commits were made under. Nothing detects the case the sentence now permits being stretched: a branch that runs for a week and changes the skill's method three times still raises the version once, and whether that is one change is a judgement no check makes.

### The sweep read for lists and missed one wearing a comma
`E-890` · skillver · skill content, correction

**Context.** The gate found four facts still standing after the sweep. The one that matters: the migration advice said *everything the source held that Velve Auth deliberately does not hold — profile fields, roles, organisations — lands in the application's own tables or is dropped on purpose.* Two of those three are right and one is false today. Architecture 3211 maps Supabase's `identity_data` to `velve.identity.profile` unchanged as `jsonb`, 3338 does the same for the whole of Clerk's `external_accounts[i]`, and the column is annotated *raw claims; the application reads them, the library does not.* Only user-record metadata — `raw_user_meta_data`, and the `full_name` and `avatar_url` inside it — has no target. So the passage told a reader to drop data the importer would have carried across, in the one place in the file where being wrong costs data rather than an argument. Earlier in the same file, §3a warns that *profile data* is the exclusion with a line drawn inside it and says to find the line before refusing a request to read a provider's claims; this passage then crossed that line itself. It also contradicts two sentences that say no list of exclusions is reproduced here.

**Rejected.** Correcting the list to two items, which keeps a list and keeps the failure mode intact for whichever item goes stale next. Also rejected: adding the qualification that provider claims are carried across, which is a fact with exactly the expiry date of the list it would replace.

**Reason.** The sweep looked for lists and this was not shaped like one. It is a subordinate clause inside a sentence about where data lands, set off by a dash and a comma, reading as prose about the application rather than as a claim about what the library holds — and that is the shape to search for next time, because the earlier removals were all blockquotes, tables and enumerations that announce themselves. The replacement states the method instead: which of the two a field is comes out of the source's mapping in the migration chapter, field by field, and an exclusion that holds of the user record does not mean the same data has no target anywhere in the schema. Three smaller facts went with it. The plugin passage said *a reader who checks will find that they do not* forbid a roles plugin — the only place in the file where a fact was protected by a rule against contradicting it, so a narrowed 3.11 would have had the agent recommending a plugin the interface no longer permits and instructed not to say otherwise; it is now conditioned on having just read the chapter. The `localStorage` passage said *the cookie the library itself sets*, singular, where the specification names more than one. And the download loop is blind in one direction: a removed source returns 404 and fires the rule, an **added** source announces nothing at all, so the file now says to check that the set is still the set.

**Price.** All four were found by a reader, and nothing measures the rule they break. §1 states that the skill carries no fact about the library and no check reads §1; `check:skill-version` measures whether the version moved and `check:codex-skill` whether the two files agree, and a false sentence satisfies both. The next fact will enter the way this one survived — as a clause in a sentence about something else — and the only defence named here is knowing that shape.

### §3b has an offline answer now, and E-880's Price was written as though it did not
`E-891` · skillver · skill content, correction

**Context.** The Price of `E-880` records that the skill can no longer refuse anything without network access, where before it could refuse thirteen things from memory, and calls that the intended trade. That is true of §3a, whose refusals genuinely depend on reading a document. It was written as though it were true of §3b as well, and §3b is the half the file says is not the user's to overrule. Offline, §1's rule to stop and ask for the sources collides with §3b's rule to name the requirement, and the outcome is *please clone the repository* in answer to *disable the origin check, it's only local development.*

**Rejected.** Leaving it, on the ground that it is pre-existing rather than introduced here — the collision predates the sweep, and the sweep is what made it worse by removing the last thing §3b could say from memory.

**Reason.** A refusal that depends on reading nothing should not wait for a fetch, and *please clone the repository* is not a refusal — it reads as a delay and it will be heard as one, by exactly the user who has already asked twice. So §3b now says to refuse first in one sentence, say that the requirement cannot be reached to be named and will be named as soon as it can, and ask for the sources for the rest of the answer. What is still forbidden offline is citing an identifier that has not been read, which is §2 and holds without exception, and softening the refusal because the lookup failed.

**Price.** `E-880`'s Price is not edited and now reads as a claim about the whole file when it is a claim about §3a. This entry is the correction, and a reader meets the overstatement first. The new rule also asks the agent to judge, offline, whether a request is a §3a question or a §3b one — with none of the documents that would settle a borderline case in front of it.

### The Codex file's own contradiction was fixed in the shared text, not in the transform
`E-892` · skillver · file parity, frozen

**Context.** Step 5 of §0 told the agent to say when the new version takes effect, *"which the same paragraph states, and which is not immediately."* That is a Claude Code fact sitting in the shared body: the Codex header says there is no restart to wait for, because the file is read when it is handed over. So the generated file contradicted its own header, and `E-884`'s claim that §0 is byte-identical in both was true and was the reason the contradiction existed.

**Rejected.** Adding a twelfth rewording to `tools/codex-skill.mjs`, which is the obvious repair now that the transform is the file's definition. Rejected because it widens the sanctioned difference class from *the header and the `this skill` rewordings* to *and one clause of §0*, and that class is what a reviewer checks a diff against by eye — a rule with a third exception is not checked that way any more.

**Reason.** The clause did not need to be file-specific. *"The same paragraph says when"* is true of both files and points at the two paragraphs that already differ, which is what `E-884` moved them up there for. The neutral sentence also survives whatever the outstanding question about the restart resolves to, which the specific one would not have.

**Price.** The shared text is now one degree vaguer at the step where a reader most wants a concrete instruction, and the agent has to have read the header to complete step 5 — a reader who skips it says nothing about when the update takes effect at all. That is the same indirection `E-884` already priced, paid a second time in the same section.

### A fact about the tool, asserted from inference, in the file about not doing that
`E-893` · skillver · skill content, correction

**Context.** The skill's header said *Claude Code must be restarted before a new version takes effect, because skills are loaded at start; until it restarts, the old file is the one running.* `README.md` said the same, and `E-884` wrote it into the log as the thing that makes the two skill files differ. The documentation says otherwise: Claude Code watches the skill directories and picks up an edited `SKILL.md` inside the running session, identically for the personal and the project directory, and there is no reload command for skills because none is needed. There is one exception and it lands on the install case rather than the update case — a **top-level skills directory that did not exist when the session started** is not being watched, so the very first install, the one whose own instructions run `mkdir -p ~/.claude/skills/velve-auth`, does need one restart. So the sentence was wrong for the case it was written for and accidentally right for a case it did not describe.

Nobody read it. It was inferred from *skills load at start*, which is a plausible mechanism, and then written into three files in the wording of a fact. That is the same defect class as the thirteen exclusions of `E-880`, one level out: three self-rules pointed every check at facts about the library, and the false sentence went in as a fact about the tool — in the paragraph a reader has to trust in order to install the file at all. The content rule made this more likely rather than less, because it told everyone where to look.

**Rejected.** Widening §1's rule to forbid facts about the runtime as well. It is the tempting generalisation and it cannot be had: a skill that may state nothing about its own runtime cannot explain its own installation, and installation is the one thing a reader must be able to do by following the file. Also rejected: a fourth self-rule in §1's block. `E-883`'s Price already says three is a lot of self-reference before the file reaches its subject, and the audience for this rule is whoever edits the file, not the agent answering out of it — so it goes in `CLAUDE.md` §6 with the other editor's rule.

**Reason.** The property that separates the two cases is not the subject, it is whether a pointer can replace the fact. The library's documents are fetched at the moment the skill answers, so a fact about the library is always available live and a copy of it is never necessary — which is why §1 can forbid every one of them without losing anything. The tool's documentation is not among the sources the skill reads, so a runtime fact has no live pointer to be replaced by, and the choice is between stating it and not explaining installation. So it is permitted, held to the minimum installation needs, and **stated from the tool's documentation rather than from inference.** The corrected text splits the sentence in two, and both halves are better than what they replaced: an update takes effect on the next invocation with nothing to restart, and a first install that had to create the skills directory needs one restart and never another.

**Price.** The corrected passage has a branch in it where the wrong one had none, and the agent has to know which side it is on. That is answerable — it is the one running the install, so it knows whether the directory had to be created — and the header now says to answer it, which is a third thing §0 step 5 delegates to a paragraph the reader may skip. The Context of `E-884` states the old claim as fact, and is not edited; this entry is its correction. And the rule this produces is the weaker kind: it forbids inference, and nothing detects an inference written confidently — which is exactly how the sentence it is named after got in.

### The commit count under the version rule was too low, which understated its own case
`E-894` · skillver · versioning, correction

**Context.** `E-889` argues that the version stays at 1 because raising it per commit would publish numbers no reader ever saw, and offers as its evidence that this branch alone would have shipped as version 4. Seven commits touch a skill file. `git log origin/main..HEAD -- CLAUDE-SKILL.md CODEX-SKILL.md` lists seven; the number was written when four of them existed and was not revisited when the rest landed.

**Rejected.** Restating it in place, which §6 permits for a measurement on an unmerged branch and which is what happened to the other wrong count on this branch: `E-881` said five individual identifiers where the file carries six — `L-1` was omitted — and that one was corrected where it stood, because it is nothing but a number.

**Reason.** This one is not only a number, because the correction carries an argument. A larger number strengthens `E-889` rather than weakening it: the claim is that per-commit numbering publishes versions nobody ever saw and none could compare against, and a branch that would have shipped as 7 is a better instance of that than one that would have shipped as 4. It is the one kind of correction that carries no risk of retroactive rationalisation — the number moved against the writer's convenience and in favour of an argument the writer already had, which is the exact inverse of what §6 guards against. That is also why it was not optional: a wrong number in support of a right conclusion is how a reader learns to distrust the conclusion.

**Price.** `E-889` keeps the wrong number and a reader meets it before this entry, which is the standing cost of the no-rewrite rule and the fourth such chain this branch has produced. And two wrong counts on one branch were treated differently — one restated in place, one corrected in an entry — on a distinction §6 does not draw: whether the correction is only a number or carries a reason with it. The next writer will have to draw it again from this entry rather than from the rule.

### There is a pointer, and declining to use it is a choice
`E-895` · skillver · skill content, correction

**Context.** `E-893` argues that a fact about the tool is permitted where a fact about the library is not, on the premise that the tool's documentation is not among the sources the skill reads, so a runtime fact has no live pointer to be replaced by and the choice is between stating it and not explaining installation at all. `CLAUDE.md` §6 repeated it in the same absolute form. The premise is false. The tool's documentation is one file at one URL and downloads in a single `curl` — 101,709 bytes, which is exactly the kind of file §1 of the skill already teaches an agent to fetch to disk and `grep`. The six sources are six because someone chose six.

**Rejected.** Leaving it, on the ground that the conclusion does not change. The conclusion does not change, and that is what makes it worth correcting: an impossibility standing in for a choice is a reason stated past what the writer had, which is the failure §6 exists to prevent, and it is harder to catch than a wrong count because nothing contradicts it.

**Reason.** The honest form is that the tool's documentation has **not been made a seventh source**, and the reasons for declining are better than the impossibility they replace: the URL is not this project's to keep stable, its structure is a third party's to change, and a skill that has to reach a site this project does not control in order to explain its own installation has taken on a dependency worse than the copy it was avoiding. `CLAUDE.md` §6 now says that. `E-893` is not rewritten.

Two smaller things in the same entry are weaker than they sound. The rule was put in `CLAUDE.md` rather than in the skill and the reason given was audience — but `CLAUDE.md` is itself one of the six sources, so the answering agent meets the rule anyway and the audience argument does almost no work. The better reason is what the sentence would have done where it was not put: a line in the skill saying *facts about my own runtime are permitted* is read by an agent that has no use for the permission and can take it as licence.

**Price.** The exemption now rests on a judgement — that a third-party URL is not worth the coupling — where it read as a fact, and a judgement invites the next editor to weigh it again and decide the other way. That exposure is larger than the one it replaces and it is the correct one. And this is the second time on this branch that a sentence about not asserting things from inference was itself asserted from inference.

### The transform gets a test; the git plumbing is deferred with an owner
`E-896` · skillver · gate, frozen

**Context.** Two checks and one transform were written today and none of them had a test, where `check:lock-order`, `check:session-owner` and `check:sql-collapse` each have one. Their behaviour rests on planting — nine faults against the version check, seven against the transform, and one more, the ride-along, against both — and a plant establishes behaviour once and leaves nothing that runs on the next commit.

**Rejected.** Testing `check-skill-version.mjs` end to end. It resolves the repository from its own module URL and shells out to `git` there, so testing it needs a throwaway repository and a way to point the script at one. That harness does not exist, `check:log-append` would need it in the same shape, and building it inside a documentation branch would make it the largest thing in the branch and build it for one caller.

**Reason.** The part that decides is pure and needs no harness. `tools/codex-skill.mjs` is a function from text to text, so `test/skill-files.test.ts` asserts that `CODEX-SKILL.md` is byte for byte what it produces, that both files state one version line in the documented form with a date that is a real date, that the rule about the version tracking the file reaches both, that no `this skill` survives into the file that is not one, and — the pair that matters — that the transform **refuses** rather than producing a file when a reworded passage has gone or the version line cannot be read. A transform that quietly skipped a rewording would write a file that compares equal to itself for ever afterwards, and the byte comparison alone would never notice. Four faults were planted against the tests before they were trusted, each predicted first: a hand-edit of the generated file, the two files stating different versions, an impossible date, and the tree restored. All four behaved as predicted. This also moves the byte-identity from a gate step to something that runs on every commit, which is the difference a test makes over a plant.

**Price.** `check:skill-version` is covered by nothing but its plants, and so are the refusal paths of both checks — an unresolvable base, no common ancestor, a skill file absent at `HEAD`. That is deferred, and the owner is whoever next needs the throwaway-repository harness, which is `check:log-append` at least as much as this. Two of the repository's five older checks are in the same position, so the unevenness here is the standard as it already stood; that is an explanation and not a defence.

### The shape E-890 named was searched for, and there was one more
`E-897` · skillver · skill content, correction

**Context.** `E-890` said the exclusion list it removed was missed because it did not look like a list — a subordinate clause set off by dashes, inside a sentence about the user's own application — and named that as the shape to search for next. The search found one. *"Their own mailer behind the mail callback"* is three items in a dash-clause inside a sentence about where a feature belongs, and later in the same file the mail seam is described as not something to quote from memory. Warn in one place, cross in another: the structure of the removed passage exactly.

What makes it worth an entry rather than a line in a commit message is that it is **accurate today** — architecture 110 gives *a single `email.send(message)` callback* and 849 confirms there is no built-in dispatch. A §1 violation that is currently true is invisible to every check this repository has and to a reader spot-checking the facts for correctness. Only the shape gives it away, and only if someone is looking for the shape.

A second correction went in the same commit. The sentence written to repair `E-893`'s inference said *"the one exception"* where the tool's documentation states two — it also excludes bare mode from directory watching. The exposure is nil, because bare mode is headless and nobody there is being asked to approve a write. Claiming a completeness the source contradicts, in the sentence written to stop asserting what the source does not say, is not nil.

**Rejected.** Naming the callback and qualifying it — *"the mail callback, if the configuration still offers only one"* — which keeps the fact and adds a hedge on top of it. §7 of the skill says a hedge is almost always a sentence written instead of a fetch, and it would be one here.

**Reason.** *"Behind whatever the configuration offers for it"* says everything the sentence needed to say about where the user's mailer belongs and says nothing at all about what the library provides, which is §1's rule in one clause. And *"the exception that matters here"* stays true whatever else the tool excepts, which the counting word did not.

**Price.** Both were found by reading for a shape, and the shape is the only detector either of them has. Nothing counts dash-clauses, nothing knows which sentences are claims about the library, and the entry that named the shape is the entire mechanism — which makes it a note, by the standard `E-888` was held to, and the honest thing is to say so rather than to call the search a control.

### The entry that corrected a stale count went stale the same way
`E-898` · skillver · versioning, correction

**Context.** `E-894` corrected `E-889`'s claim that this branch would have shipped as version 4, on the ground that six commits touch a skill file and that the number had been written when four existed and not revisited when two more landed. The commit carrying `E-894` was itself followed by one that edits `CLAUDE-SKILL.md` — the dash-clause `E-897` removes — so the count is seven. `E-894` went stale in exactly the way it was written to describe, on the same afternoon, at the hands of the same writer, and its own number is restated in place to seven for the reason it gave for restating `E-881`'s.

**Rejected.** Writing it as *"at least six"*, or as a range, which is what a writer reaches for after being caught twice. It would be true and it would cost the argument its force: the number is doing work precisely as a size — the gap between what per-commit numbering would have published and the 1 that ships — and a lower bound does not measure a gap.

**Reason.** The recurrence is what needs an entry, because it is not a number. **A count of a branch's own commits cannot be finished until the branch is**, so any entry stating one is stale from the moment it is written unless it happens to be the last commit — and no writer knows which commit is the last one while making it. That is a property of the measurement rather than of anyone's care, and it is the third count on this branch that was written as though the thing it counted had stopped moving.

**Price.** Nothing checks it, and the obvious check cannot exist: a test comparing a number in `CASE-STUDY.md` against `git log` would be red on every branch that mentions its own commit count, right up to the moment it merges, which is a check nobody could keep green. The honest mitigation is smaller and is not applied here — a count of the branch's own commits belongs in the pull request, which is rewritten as the branch moves, rather than in the log, which is not. `E-889` and `E-894` both put one in the log; this entry leaves them there and says why they will not stay true.

### E-898 understated its own mitigation and claimed a little more than it needed
`E-899` · skillver · versioning, correction

**Context.** The Price of `E-898` says the honest mitigation — that a count of a branch's own commits belongs in the pull request, which is rewritten as the branch moves, rather than in the log, which is not — "is not applied here". It is applied. The pull request body states the count and has stated the current one at every tip since it was written, so the mitigation exists in exactly the place the entry prescribes, and what remains in the log is two historical numbers rather than the live one.

Its Reason is also a little wider than it needs to be. *"Any entry stating one is stale from the moment it is written"* covers counts that are perfectly finishable: *"the first four commits removed the facts"* is a count over commits that have already happened and cannot change. What cannot be finished before a branch ends is a count over the branch's **whole** history.

**Rejected.** Restating either in place. `E-894` drew the line this branch has been working to — a bare number is restated where it stands, a correction carrying an argument gets its own entry — and both of these are claims about what was done and how far a rule reaches, which is the second kind. Also rejected: leaving the understatement on the ground that underclaiming is the safe direction to be wrong in. It is the safe direction and it still gives the wrong answer, because a mitigation applied with a residue explained is a different thing from a risk named and left, and `E-888` is the entry that made that distinction load-bearing in this range.

**Reason.** Both corrections move in the direction that strengthens `E-898`, which is the property `E-894` identified as making a correction free of rationalisation risk: they cost the writer nothing to admit and they leave the entry with more than it had. The narrower claim is also the more useful one — it tells a future writer which counts are safe to put in the log, where the wider one told them that none are.

**Price.** Three entries now describe one recurring miscount, and `E-898`'s Price is the one a reader meets first. Three edits went in beside this entry that correct no reason and get no entry of their own, and are recorded here instead. `E-889`'s bare `version 4` is restated to seven, which the distinction above permits — and which leaves `E-894`'s Price wrong where it calls leaving that number the standing cost of the no-rewrite rule, because the rule does not reach a bare number. `E-894`'s own heading read `Six, not four`: a number in the one place §6 says carries a title and nothing else, left standing when its body was restated, and false in both halves by the time anyone read it. And four entries in this range tagged themselves `corrected` where three tagged themselves `correction`; they are one word now, the one the rest of the log mostly uses.

One consequence of restating in place that the rule does not mention, and that shows up here for the first time: the Contexts of `E-894` and `E-898` both describe what `E-889` used to say, so two entries now narrate a sentence the file no longer contains. They are accurate as history and they read as misquotation, and that is what every in-place restatement leaves behind once another entry has already cited the number.

### The check that enforces §4 could not tell a clean tree from a tree it never read
`E-797` · gate · gate, frozen

**Context.** The attribution job's three scans each read their result from `if <pipeline>; then echo ::error; fail=1; fi`. `grep` exits 1 both where it looked and matched nothing and where nothing arrived to look at, and neither the step nor the shell inspected the producer. So a failing `git` — off the PATH, an unresolvable ref, a `git grep` returning its error status rather than its no-match status — made the condition false for the wrong reason and the job printed "No AI attribution found". Reproduced here with a shim in which only `git log` and `git grep` fail: an attribution marker sitting in a tracked file, and the job exits 0.

**Rejected.** Adding `set -e` to the step, which was the first thing tried and is worse than nothing here — the step already runs under the default `bash -e {0}`, so `-e` was on the whole time, and it does not reach inside an `if` condition, which is exactly where all three faults lived. Also rejected: `set -o pipefail` as the fix, which was already set and for the same reason changed nothing.

**Reason.** A scan has three outcomes and the shape used had room for two. Reading the producer's exit status separately from the matcher's is the only way to keep them apart, so each scan now writes its surface to a file — the producer's failure is then a failed redirection and not an empty match — and reads `grep`'s status as a three-way `case`: 0 a hit, 1 nothing found, anything else a scan that could not run and ends the job.

**Price.** The step grew from 79 lines to 172, and three of the four helper functions exist only to make the three states visible. A reader now has to hold `refuse`, `read_surface`, `require_content` and `report` in mind before reading a single scan, where before each scan was one line that could be read in place and was wrong.

### Capture-and-test is the rule here, not this job's local taste
`E-798` · gate · gate, frozen

**Context.** Two of this job's checks — the symlink scan and the `.gitattributes` scan — already captured their output into a variable and tested the variable, with a comment saying why. The three attribution scans, in the same step, did not. §5 of the rules names three shapes of broken check that have already happened in this repository, and this job carried two of the three.

**Rejected.** Fixing only the pipeline exit status and leaving the pattern to the next reader to notice. It would have closed the reported fault and left the job as an example of both shapes side by side, which is how the three scans came to be written this way in the first place: the correct examples were three lines further up and nobody read them as a rule.

**Reason.** The distinction §5 draws — found nothing against could not look — is a property of every check, so the shape that preserves it belongs to the repository and not to whoever wrote a given step. Writing it as four named functions rather than four inline repetitions is what makes it citable: the next check added to this job either calls `read_surface` and `report` or visibly does not.

**Price.** A convention that lives in one workflow step and is enforced by nothing. There is no check for the check, and a fifth scan added below these four can go back to `if <pipeline>` without anything failing. The only thing standing between this and a recurrence is a reviewer reading the step.

### Every scan says how much it read
`E-799` · gate · gate, frozen

**Context.** The second shape §5 names is a scan that reports success because it matched no files. Nothing in the job distinguished "searched 375 files, found nothing" from "searched nothing". The output was `Scanning tree` either way.

**Rejected.** Counting only the tree scan, which is where the failure is easiest to picture. Also rejected: an assertion on an expected number of files, which would be a census — the log already records at `E-795` that a census counting a property of the whole tree, kept in one place and owned by nobody, is a coupling that costs other features a round.

**Reason.** A positive count is a lower bound with no maintenance: it says the surface existed without saying how big it should be. Each scan prints its own unit — commits for the message scan, files for the tree scan, bytes for the diff scan — and a surface that came back empty ends the job rather than adding to `fail`, because an empty surface and a failed producer are the same event seen from different sides.

**Price.** The counts are printed and not asserted, so they detect nothing on their own; they turn a silent zero into a visible one and rely on a person reading the log. A run that scans one file instead of 375 still passes, and prints `Scanning 1 tracked files` to say so.

### Two surfaces are legitimately empty, and the control plant is what found the second
`E-800` · gate · gate, correction

**Context.** The first version of this change refused the run on any empty surface, uniformly. It was written, committed to the working tree, and then run against a control plant — a clean branch carrying only the `ci.yml` commit — which it failed with `the branch diff scan had nothing to search`. The diff scan excludes three paths, `ci.yml` among them, so a branch that changes only `ci.yml` produces a diff of zero bytes with nothing wrong.

**Rejected.** Removing `ci.yml` from the exempt list, which would make the diff non-empty and make the job scan its own patterns and fail on them. Also rejected: dropping the emptiness check on the diff scan without saying why, which is how a rule turns into a special case nobody can date.

**Reason.** Emptiness is an answer for exactly two of these surfaces, and both are named where they are read: a repository with no `.gitattributes` at all is the wanted state, and a branch whose every change is in an exempt path has nothing for the diff scan to see. What proves the diff scan looked is the commit count of its range, which is checked before any scan runs. Every other surface is empty only where the repository could not be read.

**Price.** The diff scan's own emptiness is now unguarded, so the third shape §5 names — an exclusion that deletes the text it was meant to examine — is detectable here only as a printed `0 bytes` that a person has to notice. A fourth entry added to `EXEMPT` that happened to cover the whole branch would read as this same legitimate case. The honest mitigation is a check on what `EXEMPT` contains rather than on what survives it, and it is not written here.

### The empty range is removed rather than reported
`E-801` · gate · gate, frozen

**Context.** The range is `origin/main..HEAD` where `origin/main` resolves and `HEAD` otherwise. On `main` itself `origin/main` resolves and equals `HEAD`, so the range selects no commit: the commit-message scan and the diff scan both read nothing, on every push to `main`, and the job reported clean. That is the same fault as the rest of this entry's neighbours and it was standing in the range choice rather than in a scan.

**Rejected.** Failing the job on an empty range, which is what the brief for this work asked for and what the other surfaces do. It would redden `main` on every merge, permanently, for a state that is not an error.

**Reason.** A range that selects nothing cannot be told from a range that could not be read, so the repair is to stop producing one: `origin/main..HEAD` is taken only where `HEAD` is ahead of it, and the whole history is the surface otherwise. The zero check then remains, and what it now catches is a `git` that failed rather than a branch that is level. On this repository the fallback reads 35 commits and 4,631,745 bytes of diff where it previously read none.

**Price.** A push to `main` now scans the entire history on every run, and that cost grows with the repository while the thing it protects — commits already scanned on their own branch — stays the same. It is also a change to the range choice, which the brief for this work said to preserve; what is preserved is which commits are scanned when there are branch commits to scan, and the case that changed is the one where the old choice scanned nothing at all.

### The statuses are captured with `|| VAR=$?` because `-e` was always on
`E-802` · gate · gate, frozen

**Context.** The step declares `set -uo pipefail` and no `set -e`, which reads as though `errexit` were off. It is not: a `run` step with no `shell` key runs under `bash -e {0}`, so `errexit` has been on since the job was written. The old shape hid this because every `grep` sat inside an `if` condition, where `-e` does not reach.

**Rejected.** `STATUS=$?` on the line after a bare `grep`, which is the readable form and which ends the job at the first scan that matches nothing — that is, on every clean run. This was written first and caught by the control plant, not by reading.

**Reason.** `grep … || VAR=$?` puts the command in a compound the shell does not treat as a failure, and leaves `$?` holding `grep`'s own status. It is three characters of noise for a property of the runner that is not visible in the file, so the reason is stated in the comment above `report` rather than left to be rediscovered.

**Price.** The reason lives in a comment because it cannot be expressed in the code: nothing in the step says which shell it runs under, and a maintainer who moves this body to a script with a different shebang gets a step that is correct for a reason that is no longer true.

### The plants, and what each one was run against
`E-803` · gate · gate, frozen

**Context.** §5 says a check must be proved to fail on a planted fault before its passing is trusted. The step body was extracted from `ci.yml` by parsing the workflow, so the text under test is the text that ships, and run under `bash -e` against a throwaway clone per plant. Every plant was run against both the old step and the new one.

**Rejected.** Testing the new step alone. Half of what needed proving is that the old step passed, and a plant that reddens the new step proves nothing about the fault it is supposed to be about unless the old step is green on the same tree.

**Reason.** The results, old exit against new exit. Clean branch carrying only the `ci.yml` commit: 0, 0. Marker in a commit message: 1, 1. Marker in a tracked file: 1, 1. Marker added and removed by a later commit, caught by the diff scan alone: 1, 1. `git log` and `git grep` stubbed to fail with a marker in the tree: **0, 1** — this is the reported fault. `grep` stubbed to exit 2 on a clean tree: **0, 1**. A repository with history and no tracked file: **0, 1**. A `.gitattributes` marking a path binary: 1, 1. A tracked symlink: 1, 1. A NUL byte in a tracked file: 1, 1. The last three exist because this change restructured those scans too and their detection had to be shown intact.

**Price.** The harness is a scratch script and is not committed, so these numbers are reproducible only by rebuilding it. Committing it was considered and would put a second copy of the step's semantics in the repository — the extractor reads the real `ci.yml`, but the plants encode what each scan is supposed to see, and that is a test of the workflow with nothing keeping it in step with the workflow. What is committed is this entry.

### Two plants did not behave as the finding described, and one of those is the finding itself
`E-804` · gate · gate, finding

**Context.** The reported fault says a failing-`git` PATH shim left the old job printing "No AI attribution found" and exiting 0. A shim in which *every* `git` invocation fails does not do that under `bash -e`: it dies at the NUL-byte check, whose `BINARY=$(git ls-files … | while …)` has no `|| true`, so `pipefail` and `errexit` end the step on whatever status the shim itself returned — 1 where the shim exits 1, 128 where it exits 128, and 127 where `git` is genuinely absent from the PATH, which is the case the reported fault described. What does not depend on the shim is that the status is not 0, and that the step ends with no `::error::` line, no mention of attribution, and nothing in the log saying a scan was skipped.

**Rejected.** Reporting the finding as reproduced, on the ground that a marker went undetected either way. The exit status is the half of the claim that matters to a merge gate, and it was wrong.

**Reason.** Two variants reproduce it exactly and are what the numbers in `E-803` are from. A shim failing only `git log` and `git grep` — the commands the three scans use, leaving the earlier checks working — gives old 0, new 1. The total shim run without `errexit` gives old 0, new 1. So the fault is real and the mechanism is as described; the total shim under the runner's own shell is the case that fails for a different reason, and its exit 1 is luck rather than detection. The other plant that did not redden is the empty range: it passes under the new step by construction, because `E-801` removed the state instead of failing on it.

**Price.** The log now carries a correction to a finding that was right about the defect and wrong about one observation, which is the kind of entry that reads as pedantry until someone reruns the plant and gets 1 where the record says 0. Three earlier rounds in this repository were lost to plant numbers that did not reproduce, which is why this is an entry rather than a footnote.

### The three checks the finding called correct were correct in the half it examined
`E-805` · gate · gate, finding

**Context.** The reported fault names the symlink, `.gitattributes` and NUL-byte checks as already using the capture-and-test pattern, and they do: each captures its output and tests the variable rather than the pipeline. None of them checked the exit status of the `git` that produced the output. With `git` failing, the symlink and `.gitattributes` checks each set an empty variable and add nothing to `fail`, and the NUL check ends the step silently.

**Rejected.** Leaving them, on the ground that they are outside the reported fault and that the whole step fails anyway once the commit-message scan refuses. That is true today and true only because of the order the scans run in.

**Reason.** They are in the same file, they are the same fault class, and each was one call to `read_surface` away from being right. Capturing the output is half of capture-and-test; the other half is knowing the output came from a command that succeeded. Their detection is unchanged and was replanted to show it — a `.gitattributes` marking a path binary, a tracked symlink and a NUL byte each still redden the job.

**Price.** This is more than the reported fault asked for, in a file three wave-5 branches are not touching but which belongs to nobody in particular. It is recorded here rather than assumed to be welcome, and a reviewer who disagrees can revert three lines without touching the rest.

### What is carried forward instead of fixed
`E-806` · gate · hand-off, open

**Context.** Two sibling faults of the same class were found alongside this one and are deliberately outside this change: `test/api-surface.test.ts` calls `readdirSync` without `{ recursive: true }`, so the API snapshot records only the top-level `dist/*.d.mts` and misses every type body, and `test/auth-route-table.test.ts` does not see eleven routes that now exist. Both live in files all three wave-5 branches are editing.

**Rejected.** Fixing them here because they are small and because they are the same shape. The file-ownership rule in §5 does not have an exception for a change being small, and a snapshot regenerated on this branch collides with three others.

**Reason.** They are reported and not touched. A search for the `if <pipeline>; then` shape across `.github/`, `tools/` and `package.json` found it in exactly the four lines this change rewrote and nowhere else, so there is no third instance of this particular shape outside `ci.yml` — which is a statement about that shape and not about the class, and the two faults above are the class showing up in a form no grep finds.

**Price.** An entry naming two known defects that no branch owns. `E-795` already records that this repository's hand-offs are numerous enough to be their own finding, and this is another; the API snapshot in particular is a check that has been reporting success over a surface it was not reading, for however long `{ recursive: true }` has been missing, and nothing dates that.

### The one line this branch reported as repaired still threw its consumer's status away
`E-807` · gate · gate, correction

**Context.** `E-805` said the symlink, `.gitattributes` and NUL-byte checks were "one call to `read_surface` away from being right", and this branch made that call for all three. For the `.gitattributes` scan that sentence is false and the change it describes was not enough: `read_surface` guards the **producer**, `git ls-files`, and the consumer stayed `HIDDEN=$(xargs grep -nE … || true)`. `|| true` discards a status exactly as the `if <pipeline>` this whole branch exists to remove discards one. Planted with a `.gitattributes` containing `src/*.ts binary` and a shim failing only the `-nE` invocation: old 0, new **0**. The fault was in the tree, the scan could not run, and the job said "No AI attribution found".

**Rejected.** Reading the scan's printed count as coverage. `E-799` added `Checking 1 .gitattributes files` and that line was printed on the failing run — it is a lower bound on the **surface**, not on the **search**, and here the surface was read and the search never happened. That is worse than printing nothing, because it reads as evidence of the thing it does not measure.

**Reason.** The consumer's status is captured and handed to `report`, like every other search in the step. `xargs` is gone with it, and not for tidiness: GNU `xargs` documents itself as exiting 123 for any invocation that exits 1 to 125, so it returns one status for the no-match this scan expects and the error it must refuse on — the distinction cannot survive it. That could not be measured here, because BSD `xargs` on the development machine passes 1 through unchanged; it is taken from the documented behaviour and stated as such rather than as a measurement, which is the mistake `E-893` records. Reading the file into an array removes the dependency on either platform's answer. Replanted: old 0, new 1.

**Price.** `E-805`'s Reason is wrong where it stands and is not edited, because a reason is not a measurement and this log corrects one with a new entry rather than in place. A reader meets the false sentence first and this entry second. What made it false is worth more than the correction: the crossing into those three checks was real work, was accepted on the merits, and stopped at the producer because "capture the output" and "check the producer" felt like the same repair — which is the same half-measure in a different place.

### The convention is enforced now, because its author broke it on its own branch
`E-808` · gate · gate, frozen

**Context.** `E-798`'s Price said the convention "is enforced by nothing" and that "a fifth scan added below these four can go back to `if <pipeline>` without anything failing". That was written as a limitation to be aware of. It stopped being hypothetical in the same commit: the fourth scan in the step was already back to it, nothing failed, and only a plant found it. §5 says to prove a check fails on a planted fault before trusting it passing; that was done for nine sites and skipped for the tenth, and the tenth is the one that was broken.

**Rejected.** Recording the recurrence and leaving the convention unenforced, which is what `E-798` already did once and is what produced `E-807`. Also rejected: a shell-syntax linter over the whole workflow, which is a parser this repository would then own.

**Reason.** `test/attribution-scan-status.test.ts` parses the step's block scalar out of `ci.yml`, joins continuation lines, drops comments, and asserts five things: a body with searches in it was found, every search invocation captures its status, every captured status reaches `report`, no status is discarded with `|| true` or `|| :`, and no pipeline is read as a condition. It refuses rather than passes when the step cannot be found, which is the property §5 asks for. Four faults were planted against it and each reddened it: the exact `|| true` the gate found, a status captured and never handed to `report`, the original `if <pipeline>; then` restored, and the step renamed so the body could not be located — the last one errors rather than reporting zero searches. Writing it found a fifth instance nobody had named: the NUL-byte check's `if ! tr … | cmp -s …; then`, where `cmp`'s error status 2 is read as "these differ". It fails closed, so it was never going to be noticed by a false pass, and "safe by luck" is what `E-804` already objected to elsewhere; it now reads `cmp`'s status as three states. Moving that loop out of its command substitution fixed a second thing that was never reported: `refuse` inside `$( … )` exits the subshell and leaves the job running, so a refusal from inside that loop would have been swallowed.

**Price.** A new file outside the set fixed for this work, which was `ci.yml`, `CASE-STUDY.md` and `DOCUMENTATION.md`. It is a file no other branch can collide with and it needed no change to `package.json` or to the workflow, but it is still a crossing and it is recorded rather than assumed. And the check is structural, not behavioural: it reads the shape of the step and cannot tell whether the step detects anything. A scan that captures its status, hands it to `report` and searches for the wrong pattern passes every one of these five assertions. What tests behaviour is still a scratch harness that is not committed, for the reason `E-803` gives.

### A refusal ends the job, so the first one hides every scan below it
`E-809` · gate · gate, finding

**Context.** `refuse` exits immediately rather than setting `fail=1`, so the scans below it never run and their findings never print. That is why `E-807`'s fault stayed invisible in almost every plant: the `.gitattributes` scan is the second of six, and any refusal above it — a failing `git`, an empty surface — ends the job before it, while any refusal below it never gets the chance to contradict it. Only a plant aimed at that one scan, with everything else working, could see it.

**Rejected.** Accumulating refusals like findings and reporting them all at the end, which reads as the friendlier behaviour. A refusal means the environment could not be trusted to answer; continuing to scan in it produces more results of unknown worth, and a list of six is not more informative than the first.

**Reason.** The two categories are genuinely different and the exit shapes follow from that. A **finding** is an answer, so every one of them is collected and printed and the job fails once at the end — that is why a branch with a marker in a commit message and one in the tree sees both. A **refusal** is the absence of an answer, and there is nothing to add to it. The cost is a diagnosis that arrives one fault at a time, and it is stated here so the next person to debug this step knows the log is truncated by design and not by accident.

**Price.** A run repairing several broken scans takes several rounds, each showing one refusal. More sharply: this ordering is what let a scan sit broken behind a passing gate, and nothing in the step marks the scans that did not run — the log simply stops. A line naming the scans skipped by a refusal would cost little and is not written here. Recorded alongside: `E-803`'s heading dropped its count rather than raising it from nine to ten, because `E-898` established that a count of the branch's own work goes stale before the branch ends and this one had already gone stale twice; and `E-804`'s exit status was restated in place to name the shim it depends on, both being measurements on an unmerged branch, which §6 permits.

### The property said to be unmeasurable here is measurable here, and it holds
`E-810` · gate · gate, correction

**Context.** `E-807` argued that `xargs` had to go because GNU `xargs` documents itself as exiting 123 for any invocation exiting 1 to 125, collapsing the no-match this scan expects into the error it must refuse on. It then said the property "could not be measured here, because BSD `xargs` on the development machine passes 1 through unchanged", and offered the GNU documentation in place of a measurement, citing `E-893` for the discipline of not asserting from inference.

**Rejected.** Leaving it on the ground that the conclusion was right and only the supporting sentence was wrong. The conclusion being right is what makes this worth an entry rather than a correction nobody needs: an argument that reaches the correct answer through a false premise is the one most likely to be reused.

**Reason.** Measured on this machine, `/usr/bin/xargs`: a child exiting 1 gives 1, a child exiting 2 gives 1, a child exiting 5 gives 1. BSD `xargs` collapses the distinction exactly as GNU's 123 does, to a different value, and the collapse is directly observable here. The end-to-end plant that was never run: routing the repaired scan back through `xargs`, with the capture and the `report` call intact, gives exit 0 and "No AI attribution found" on a tree carrying the fault; as shipped it gives exit 1 and a named refusal. So the claim `E-807` hedged — that the fix would not work through `xargs` — is provable here in one plant, and the case was stronger than it was stated. The GNU half stands and remains correctly sourced as documentation.

**Price.** This is the `E-895` shape a second time: an impossibility asserted where a measurement was available, in an entry whose subject is the difference between the two. `E-895` recorded the same move about a fetchable URL and this branch had already read it. What made it easy was that the false sentence was defensive — it claimed less, cited the right rule, and looked like care. Nothing detects a hedge; the only reason this one was caught is that a reader tried the measurement the entry said could not be made.

### The subshell swallows a refusal in one shape and dies silently in the other
`E-811` · gate · gate, correction

**Context.** `E-808` said that moving the NUL-byte loop out of its command substitution fixed a second thing never reported: that `refuse` inside `$( … )` "exits the subshell and leaves the job running, so a refusal from inside that loop would have been swallowed". The shape in question was `BINARY=$(while read … done < …)` — an assignment.

**Rejected.** Restating it in place. It is a reason, not a measurement, and §6 forbids that; the branch has already been caught once treating a claim about behaviour as a number.

**Reason.** Measured under `bash -e` with the step's own `set -uo pipefail`. In the **assignment** form the `::error::` line is captured into the variable and never printed, and `errexit` fires on the failed assignment: the step ends at exit 1 with no diagnostic at all. In the **argument** form, `echo "$( … refuse … )"`, the error prints, the job continues and exits 0. Only the second is the false pass `E-808` described, and the step never had that shape. What the assignment form actually gives is a silent fail-closed hole: it blocks correctly and says nothing about why, which is worse to debug and much better to have. Moving the loop out is right either way, because a refusal should print and end the job on its own terms rather than through an assignment's failure.

**Price.** `E-808` overstates the fault it fixed, in the direction that flatters the fix, and that is the same class as `E-804` — an entry this branch wrote about exactly this. Three rounds, three findings, and each time the wrong sentence was in a line believed correct rather than in code believed risky. The pattern worth naming is that the measurement was cheap in all three cases and was not taken, because the sentence sounded like something already known.

### Two of the three evasions are closed; the third is enumerated, not solved
`E-812` · gate · gate, frozen

**Context.** `E-808` admitted the enforcement test is structural and cannot tell whether a scan detects anything. That admission was true and too general to act on. Three concrete evasions passed it five assertions out of five: a status captured for one scan handed to `report` for another, `report`'s default branch reduced to `*) ;;` so the entire refusal semantic disappears, and a sixth scan whose status is never read.

**Rejected.** Leaving all three under the word "structural". A limit named as a category is not a limit anyone can plan around; a limit named as three cases is.

**Reason.** The crossing is caught by **order rather than membership**: the sequence of statuses consumed must equal the sequence captured, so swapping two leaves every name present and still fails. The neutering is caught **per branch rather than per file** — every default branch must refuse. That distinction was itself found by a plant: the first attempt asserted that the body contained one refusing default branch, which passed while one of the two was neutered, because the other still matched. The third is caught only where the new scan uses a command the matcher list names. `grep`, `git grep`, `awk` and `cmp` are named because the step uses them; a scan built on `sed` passes every assertion, and that was planted and confirmed rather than assumed.

**Price.** The matcher list is an enumeration, so it goes stale the moment the step reaches for a command nobody added to it, and nothing announces that — the test simply stops covering the new scan while still reporting six green assertions. That is the same shape as the count in `E-799`: an instrument that keeps passing over a surface it no longer reads. The honest mitigation is to invert the list and fail on any command the step is not declared to use, which would make every new scan a deliberate edit; it is not written here, and the reason is that the step's command vocabulary is not stable enough yet to be worth pinning against the churn.

### The one consumer that was not read, and what it was hiding
`E-813` · gate · gate, finding

**Context.** Every consumer in the step reports three states except one: the symlink scan's `awk`, which was guarded only by `errexit`. `E-805` and `E-807` both walked past it, and the second round's repair of the `.gitattributes` consumer did not look sideways at the scan directly above it.

**Rejected.** Handing `awk` to `report`. It does not fit: `grep` distinguishes match from no-match in its exit status, whereas `awk` and `cmp` exit 0 whether or not they printed anything and report only "could not look" through their status. Forcing them through `report` would mean inventing a match status they do not have.

**Reason.** They get `refuse_unless_zero`, which is the refusal without the three-way reading, and the finding still comes from the output being non-empty. The distinction is real and stating it is what stops the next reader from "fixing" the asymmetry. Planted with a real symlink in the tree and `awk` stubbed to exit 2: before, exit 0 and "No AI attribution found" with the fault present; after, exit 1 and a named refusal. The scan was previously reported as blocking correctly and merely undiagnosed — with `errexit` that is true of the exit status, and the plant shows the finding itself was lost, which is a false pass and not a diagnostics problem.

**Price.** Four rounds were needed to read every consumer in a step of six scans, and each round repaired the one that had just been demonstrated rather than the class. The step is uniform now, and nothing about the process that got here would have found the fourth one any faster than the third.

### The structural check exists because the immediate exit hides what is below it
`E-814` · gate · gate, frozen

**Context.** `E-809` recorded that a refusal ends the job, so the first one masks every scan below it, and defended that as the right trade: a refusal means the environment cannot be trusted, and a list of six such is no more informative than the first. It named the cost as a diagnosis arriving one fault at a time.

**Rejected.** Nothing new. This entry adds an argument `E-809` did not make rather than reversing one it did.

**Reason.** The stronger justification is that the trade is now **compensated**, and by an instrument that already exists for another reason. The reason the `.gitattributes` fault survived a full round is that any refusal above it ended the job first, so only a shim aimed at that one scan could see it — the immediate exit did not cause the fault, it hid it. The structural test reads all six scans in one pass, in the file, regardless of which would run first or whether any of them runs at all. So the masking costs diagnosis at runtime and no longer costs coverage, and the two mechanisms fit together: the behavioural plants prove one scan at a time and the structural check sees them all at once.

**Price.** The compensation is only as wide as `E-812`'s matcher list, so a scan the list does not name is both masked at runtime and unseen by the structural pass, which is the worst of both and is exactly the case that has no detector. And this argument was available when `E-809` was written and was not made, so the trade was accepted on weaker grounds than the ones that actually support it.
