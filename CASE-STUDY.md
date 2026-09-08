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
*Grund:* (a) wäre die strukturell schönere Lösung, ändert aber das Schema aus 3.2, das dort keinen solchen Index vorsieht, und liegt damit außerhalb dieses Features. (b) hätte eine Verhaltensanforderung in eine Empfehlung umgedeutet: 3.7 sagt nicht „bei nacheinander eintreffenden Anforderungen". Stattdessen serialisiert eine Sperre auf der Nutzerzeile — `SELECT 1 FROM velve.user WHERE id = $1 FOR UPDATE` in derselben Transaktion, vor der Ersetzung. Die zweite Anforderung wartet, bis die erste festgeschrieben ist, und ihr `DELETE` nimmt den Schnappschuss danach. Beide Treiber verbinden sich mit einer bereits offenen Transaktion, statt eine zweite zu eröffnen, also bleibt der Rücklauf beim gescheiterten Mailversand (3.15 A.7) unberührt.
*Preis:* Anforderungen desselben Nutzers laufen jetzt nacheinander, und sie tun es über eine Sperre auf einer Zeile in `velve.user`, also auf einer Tabelle, die dieses Feature sonst nicht anfasst. Wer dort später eine weitere Sperre in anderer Reihenfolge nimmt, hat eine Verklemmung. Die Sperre ist außerdem der erste lesende Zugriff im Repository überhaupt — sie liest eine andere Tabelle als die, die gleich geschrieben wird, und entscheidet nichts über deren Zeile, aber sie muss jedem erklärt werden, der die Datei mit S-RACE-2 im Kopf öffnet.

**E-261 — Auch der Fehler, den niemand erreichen sollte, trägt einen Code.**
*Kontext:* Das Repository warf ein blankes `Error`, wenn das `INSERT … RETURNING` keine Zeile meldet. Das ist ein Bruch einer Invariante und im Betrieb nicht erreichbar; die Regel aus Abschnitt 3 kennt aber keine Ausnahme für unerreichbare Fehler.
*Verworfen:* Den Zweig zu entfernen und die Zeile mit einer Nicht-Null-Behauptung zu lesen.
*Grund:* Die Behauptung wäre eine Typlüge über eine Antwort, die von einem fremden Treiber kommt — genau die Stelle, an der eine Bibliothek nichts behaupten sollte. Ein `OneTimeTokenNotWrittenError` mit `code = "one_time_token_not_written"` kostet acht Zeilen und macht den Fall unterscheidbar, wenn ihn doch einmal jemand sieht, etwa mit einem selbstgeschriebenen Treiber, der Zeilen verschluckt.
*Preis:* Eine Fehlerklasse mehr, die in keiner Fehlerabbildung auftaucht — sie ist kein sichtbarer Code aus 3.13, sondern ein innerer. Wer sie über HTTP zu sehen bekommt, sieht `internal_error`, und das ist richtig so.

**E-260 — Der Token trägt eine Marke, und die Umwandlung prüft nichts.**
*Kontext:* `redeem({ token: userId })` übersetzte, weil Nutzerkennung und Token beide `string` sind. S-RAND-6 verlangt, dass ein Datenbankschlüssel nicht ohne ausdrückliche Umwandlung als Token verwendbar ist, und T-RAND-6 verlangt, dass der Negativfall nicht übersetzt statt in einer Prüfnotiz zu stehen.
*Verworfen:* `toSecretToken` die Form prüfen zu lassen — 43 Zeichen, base64url —, weil eine Umwandlung, die alles annimmt, wie eine Attrappe aussieht.
*Grund:* Eine Formprüfung wäre eine zweite Antwort neben „keine Zeile". Ein Token mit falscher Länge würde früher und anders abgelehnt als ein wohlgeformter, der nie ausgestellt wurde — messbar an der Laufzeit und sichtbar an der Fehlerstelle. S-REPLAY-3 verlangt eine einzige Antwort; die Marke ist deshalb ausdrücklich nominal und nicht validierend. Was sie leistet, ist genau das, was verlangt war: Der Übergang von einer beliebigen Zeichenkette zu einem Token steht als Aufruf im Quelltext und ist in der Durchsicht sichtbar.
*Preis:* Die zweite Richtung fehlt. Ein `SecretToken` ist weiterhin dort zulässig, wo eine Nutzerkennung erwartet wird, weil es den Typ `EntityId` aus S-RAND-6 im Kern noch nicht gibt und er nicht in `core/token/` gehört. Von den zwei Negativfällen, die T-RAND-6 fordert, ist einer erfüllt.
