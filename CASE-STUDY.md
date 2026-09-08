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

**E-140 — Die S-FIX-2-Prüfung liest das gebaute Paket, und Tests stehen außerhalb ihres Bereichs.**
*Kontext:* Der Detektor blockierte beim Zusammenführen das Feature `db` mit zehn Treffern über zwei Dateien — sämtlich in dessen Tests für den E-23-Trigger. Der Beweis, dass die Datenbank eine Umschreibung des Sitzungseigentümers zurückweist, besteht darin, sie zu versuchen.
*Verworfen:* (a) Das Angriffskorpus jedes betroffenen Tests in Datendateien auslagern. (b) Dem Detektor beibringen, dass eine Anweisung, die an eine Hilfsfunktion wie `expectRefused` geht, eine Behauptung ist und keine Ausführung.
*Grund:* T-FIX-2 verlangt beides zugleich — null Treffer einer statischen Prüfung **und** ein direktes `UPDATE velve.session SET user_id` über den Treiber gegen die Testdatenbank. Beide Forderungen sind nur erfüllbar, wenn der Bereich der statischen Prüfung genau den Test ausnimmt, den die Spezifikation vorschreibt. Der Ausschluss von `test/` ist damit kein Zugeständnis an die Bequemlichkeit, sondern die einzige Lesart, unter der T-FIX-2 überhaupt erfüllbar ist. Variante (a) hätte fremde Tests umgebaut und die Datei-für-Datei-Ausnahmeliste zurückgebracht, die sich zweimal als Loch erwiesen hat — und sie hätte nichts gelöst, weil der Wortlaut ohnehin in einem Test stehen muss. Variante (b) hätte die Sicherheitsprüfung an den Namen einer Testhilfsfunktion gekoppelt; eine Umbenennung hätte sie laut brechen lassen, aber jeder beliebige Code mit einer gleichnamigen Funktion hätte still eine Ausnahme bekommen.
*Preis:* Der Quelltextpfad allein kann nicht belegen, was ausgeliefert wird — eine Datei unter `test/`, die aus `src/` re-exportiert wird, landet in `dist/` wie jede andere, und das Tor blieb dabei vollständig grün. Der Ausschluss ist deshalb nur zusammen mit einer zweiten Prüfung vertretbar, die das **gebaute Artefakt** liest. Erst die beantwortet die Frage, die S-FIX-2 tatsächlich stellt, nämlich ob die Bibliothek die Anweisung enthält, statt der Frage, wie ihr Quelltext gegliedert ist.
