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

**Price.** A member named `lockoutseconds`, all lower case, is one word that starts with `lock` and is caught, but a name that hides a stem in the middle of a word with no case change would not be. The check is a vocabulary filter and can be walked around by anyone who wants to; it exists to catch the option somebody adds in good faith, not the one somebody hides. This is the second entry in a row about a check that looked green — both were found in the same afternoon, both by planting, and neither by reading the check.

### Fifty connections for a two-hundred-way race
`E-388` · rate · test cost, frozen

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
