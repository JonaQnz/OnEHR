# Wertekataloge (Value Catalogs) — Konzept

**Status:** Entwurf zur Diskussion, mit externer Recherche fundiert (§2), keine Implementierung begonnen.
**Bezug:** Löst explizit den in [`docs/features/dv-text-code-mappings.md`](../features/dv-text-code-mappings.md)
zurückgestellten Punkt ein ("Phase 1 ... no terminology lookup/autocomplete
service ... A terminology lookup plugin ... is a deliberately deferred
follow-up") — und generalisiert ihn auf jede Stelle im System, an der heute
nur manuelle Freitext-Eingabe möglich ist, wo eigentlich eine wiederverwendbare,
zentral gepflegte Werteliste dahinterstehen sollte.

---

## 1. Ausgangslage: wo heute manuell getippt wird, wo ein Katalog helfen würde

Zwei konkrete, bereits im Code vorhandene Stellen zeigen exakt das Muster,
das der Nutzer meint — beide sind Teil derselben Feature-Familie
(`codeMappings`), aber an unterschiedlichen Punkten im Lebenszyklus:

**a) Design-Zeit — `FormBuilder.tsx:2129-2196`.** Ein Form-Designer, der
einem DV_TEXT-Feld eine Code-Zuordnung erlaubt, tippt für jede erlaubte
Terminologie eine rohe `terminology_id` **frei** ein
(Placeholder: `"terminology_id, z. B. http://fhir.de/CodeSystem/dimdi/icd-10-gm"`)
plus ein Label. Keine Validierung, keine Vervollständigung, kein Hinweis, ob
diese Terminologie im Haus überhaupt existiert oder wie sie in einem anderen
Formular schon einmal benannt wurde. Jedes Formular erfindet seine eigene
Schreibweise neu.

**b) Laufzeit — `FormRuntime.tsx:745`.** Der Kliniker, der tatsächlich einen
Code anhängt, sieht nur `<input type="text" placeholder="Code" />` — er muss
den exakten ICD-10-GM/SNOMED-Code **auswendig kennen und korrekt tippen**.
Kein Autocomplete, keine Prüfung, ob der Code überhaupt existiert. Das ist
wörtlich das "Phase 1"-Limit aus dem bestehenden Feature-Dokument.

Dasselbe Muster taucht strukturell auch anderswo auf, sobald man genauer
hinschaut:

- **`field.options`** (`packages/core/src/canonical/index.ts`) ist bereits
  dropdown-fähig (siehe `AutocompleteInput` in `FormRuntime.tsx`) — aber nur,
  wenn die Werte aus dem openEHR-Archetyp selbst importiert wurden. Ein
  Designer, der ein eigenständiges, nicht-archetyp-gebundenes Freitextfeld
  (z. B. "Zuweisender Arzt", "Fachabteilung", ein hausinterner
  Leistungskatalog) trotzdem als Dropdown mit wiederverwendbaren Werten
  anbieten will, hat dafür heute keinen Mechanismus — nur die pro-Formular
  copy-paste-Optionen desselben `options`-Arrays.
- Jedes Formular, das denselben Werte-Pool braucht (z. B. "Fachabteilungen"
  in drei verschiedenen Compositions), pflegt ihn heute unabhängig drei Mal.

**Der gemeinsame Kern:** Es fehlt eine erste-Klasse-Entität "Katalog" — eine
benannte, zentral administrierte, versionierte Liste von Code+Anzeigetext-
Paaren, auf die *jede* Konfigurationsstelle im System per Referenz zeigen
kann, statt Werte jedes Mal neu einzutippen.

---

## 2. Vorarbeit / Prior Art (recherchiert, mit Quellen)

### FHIR: `ValueSet`/`CodeSystem` — die Modell-Trennung, die sich lohnt zu übernehmen

FHIR trennt bewusst drei Dinge, die ein naiver Formular-Baukasten gerne
vermischt: **`CodeSystem`** (das Vokabular existiert, definiert Codes +
Anzeigetexte + Hierarchie), **`ValueSet.compose`** (die *Definition* einer
Teilmenge — extensional per `concept[]`, intensional per `filter[]`/ECL,
oder als Gruppierung anderer ValueSets), und **`ValueSet.expansion`** (das
*Ergebnis* — die konkret angezeigte Liste zu einem Zeitpunkt). Ein
ValueSet wird über eine **kanonische URL + optionale Version** identifiziert,
nicht über eine Datenbank-ID — Felder binden an die URL, ein Server löst sie
auf. Das macht Kataloge portabel zwischen Umgebungen (Dev/Test/Prod).
[[ValueSet — FHIR R4](https://hl7.org/fhir/R4/valueset.html)]

Die zentrale Operation ist **`$expand`**
([FHIR R4](https://hl7.org/fhir/R4/valueset-operation-expand.html)):
`filter=` ist exakt die Autocomplete-Grundoperation (serverseitige
Live-Suche), `count=0` liefert nur `expansion.total` — der Server-Aufruf,
mit dem ein Client selbst entscheidet, ob ein Katalog klein genug für
"alles vorab laden" ist oder zwingend serverseitig durchsucht werden muss
(siehe §7.1, wird als Muster übernommen). Der Spec-Text warnt ausdrücklich:
eine Expansion ist ein **transientes Ergebnis, das sich über die Zeit
ändert** — nur kurz cachen, nie als Wahrheitsquelle behandeln.
**`$validate-code`** prüft einen einzelnen Code gegen ein ValueSet und
liefert dabei den *empfohlenen Anzeigetext* zurück — genau das Muster für
unseren `/resolve`-Endpunkt (§3.2): ein gespeicherter Code wird angezeigt,
ohne dass der Client eine eigene Kopie der Liste vorhält.
[[ValueSet $validate-code](https://hl7.org/fhir/R4/valueset-operation-validate-code.html)]

FHIR **Structured Data Capture (SDC)** bindet eine Frage über drei sich
gegenseitig ausschließende Wege: `answerOption[]` (fest, = unser `manual`),
`answerValueSet` (extern, zur Laufzeit aufgelöst, = unser `fhir-valueset`),
oder `answerExpression` (datengetrieben per FHIRPath/Query). Wichtig für
unser Design: SDC platziert **wo die Vokabular herkommt** getrennt von
**wie es dargestellt wird** — `preferredTerminologyServer` ist eine
Eigenschaft des Formulars/Feldes, `questionnaire-itemControl`
(Dropdown/Autocomplete/Radio/Checkbox) ebenfalls eine reine
Darstellungs-Eigenschaft des *Feldes*, nicht des Katalogs. Bestätigt unsere
Trennung in §4.3 (`valueSource` = Quelle, Steuerelement bleibt Feld-Eigenschaft).
[[SDC preferredTerminologyServer](https://hl7.org/fhir/uv/sdc/STU3/StructureDefinition-sdc-questionnaire-preferredTerminologyServer.html),
[SDC rendering extensions](https://hl7.org/fhir/uv/sdc/STU3/rendering.html)]

### openEHR — und ein wichtiges, systemspezifisches Risiko

openEHRs ADL2-Archetypen kennen exakt dieselbe Zweiteilung: lokale
`value_sets` (benannte `ac`-Codes, deren Mitglieder eine Liste von
`at`-Codes sind — unser heutiges archetyp-eigenes `options`) und externe
`term_bindings` (ein `at`- oder `ac`-Code gebunden an eine externe
Terminologie-URI, ggf. sogar an ein *intensionales* Refset). Operational
Templates können das per `[ac1@snomed_ct]`-Syntax sogar erst zur
Deployment-Zeit festlegen, welche Bindung maßgeblich ist.
[[ADL2 terminology integration](https://github.com/openEHR/specifications-AM/blob/master/docs/ADL2/master08-terminology_integration.adoc)]

**Wichtig — EHRbase validiert bereits selbst gegen externe Terminologie,
unabhängig von uns.** EHRbase unterstützt in seiner eigenen Konfiguration
`validation.external-terminology.provider.<name>.type: fhir` +
`.url: <FHIR-R4-Terminologieserver>`, und validiert einen submitteten
`C_CODE_REFERENCE`-Wert serverseitig gegen genau diese URL (das ist exakt
der `terminology://fhir.hl7.org/...`-URI-Mechanismus, den unser Code für
`vg_Person`s Vitalstatus-Feld schon kennt — siehe
`packages/core/src/canonical/index.ts`s Kommentar zu `option.terminology`).
[[EHRbase — Terminology Validation](https://docs.ehrbase.org/docs/EHRbase/Explore/Terminology)]

**Konsequenz für dieses Konzept**: unser neuer Katalog-Layer darf nicht
unabhängig von EHRbases eigener Terminologie-Konfiguration existieren.
Zeigt ein Formular-Feld auf einen `fhir-valueset`-Katalog mit einer
ValueSet-URL X, EHRbase aber (für dasselbe Archetyp-Feld) auf eine andere
URL Y, kann unsere UI einen Wert anbieten/akzeptieren, den EHRbase beim
Submit ablehnt — ein Fehler, den die Formular-UI nie hätte vorhersehen
können. **Empfehlung**: bei einem archetyp-gebundenen Feld (`option.terminology`
bereits gesetzt) muss der zugeordnete Katalog dieselbe kanonische
ValueSet-URL tragen wie EHRbases eigener `referenceSetUri` für dieses
Feld — im Idealfall automatisch beim Template-Import vorgeschlagen, nicht
manuell doppelt gepflegt. Das ist eine der wichtigsten offenen
Architekturfragen für Phase B (§10), siehe auch §11.5 (neu).

### Enterprise-/Low-Code-Referenzarchitekturen

Vier Plattformen, ein gemeinsames Skelett — **Salesforce Global Value
Sets** (`GlobalValueSet`-Metadatentyp, `customValue[]` mit
`fullName`/`label`/`isActive`; *immer* restricted, nie konvertierbar zu
unrestricted — geteilte Kataloge erzwingen Konsistenz), **ServiceNow**
(zentrale `sys_choice`-Tabelle für kleine Listen, aber ausdrücklich
**keine** Referenzfelder direct darauf — für größere/geteilte Listen eine
eigene Tabelle mit Reference Qualifier), **Camunda 8 Forms** (sauberste
Formalisierung: `options source` = `static` | `input data` (Prozessvariable)
| `expression` — praktisch identisch zu unserer `manual`/`catalog`/…-Unterscheidung),
**DHIS2 Option Sets** (benanntes, code-identifiziertes Objekt mit
geordneten `Option`s; Render-Typ Dropdown/Radio/Checkbox ist eine
Eigenschaft des *bindenden Feldes*, nicht des Option Sets — wieder dieselbe
Trennung wie bei SDC).
[[Salesforce GlobalValueSet](https://developer.salesforce.com/docs/atlas.en-us.api_meta.meta/api_meta/meta_globalvalueset.htm),
[Camunda Options Source](https://docs.camunda.io/docs/components/modeler/forms/configuration/forms-config-options/),
[DHIS2 Metadata](https://docs.dhis2.org/en/use/user-guides/dhis-core-version-master/configuring-the-system/metadata.html)]

Wiederkehrende, nicht offensichtliche Invarianten aus allen vier Systemen,
die dieses Konzept übernimmt: **deaktivieren statt löschen** (§8); **`code`
ist der gespeicherte, unveränderliche Wert, `label` ist reine
Anzeige und übersetzbar** — nie das Label persistieren (bereits konsistent
mit unserem bestehenden `value`/`text`/`rmValue`-Split in
`FormElementLayout.options`); **explizite Sortierreihenfolge** ist Teil des
Katalogs, nicht alphabetisch abgeleitet (→ `CatalogEntry.sortOrder`
ergänzt, §3.1); **"Wo verwendet?"-Ansicht vor jeder Änderung** an einem
geteilten Katalog ist Pflicht, kein Nice-to-have.

### Autocomplete-UX für große Terminologien

Die Entscheidungsregel ist ein Größen-Schwellwert, und FHIR liefert die
Grundoperation dafür direkt mit: `$expand?count=0` lesen, `expansion.total`
prüfen, verzweigen. **Klein** (bis niedrige Hunderte): komplette Liste beim
Laden vorab holen, clientseitig filtern (= unser `manual`-Pfad im
Normalfall). **Groß** (SNOMED CT: >350.000 Konzepte): ausschließlich
serverseitige Suche, nie vollständig laden.
[LHNCBCs `autocomplete-lhc`](https://lhncbc.github.io/autocomplete-lhc/)
(Referenzimplementierung hinter LForms/NLM) formalisiert das exakt so in
zwei Klassen (`autoCompPrefetch`/`autoCompSearch`) und etabliert
Konventionen, die dieses Konzept übernimmt: Ergebnisse cachen um doppelte
Anfragen bei wiederholten Tastenanschlägen zu vermeiden, freie Texteingabe
standardmäßig erlauben (nur bei Bedarf strikt auf Listenwerte begrenzen —
deckt sich mit unserem bestehenden `allowFreeText`), und bei genau einem
verbleibenden Treffer automatisch vervollständigen.

Serverseitig empfiehlt SNOMED International selbst, Suche nicht
neu zu implementieren, sondern einen echten Terminologie-Server zu
betreiben ([Snowstorm](https://github.com/IHTSDO/snowstorm), die
SNOMED-Referenzimplementierung auf Elasticsearch). **HAPI FHIR**s
JPA-Server bietet zusätzlich **ValueSet-Pre-Expansion**: ein
Hintergrundjob materialisiert `compose`-Regeln vorab in durchsuchbare
Zeilen, mit einem inspizierbaren Status
(`NOT_EXPANDED → EXPANSION_IN_PROGRESS → EXPANDED`) — ein Muster, das wir
übernehmen sollten, falls wir große `fhir-valueset`-Kataloge je selbst
zwischenspeichern wollen (Phase B/E, nicht MVP).
[[HAPI FHIR Terminology](https://hapifhir.io/hapi-fhir/docs/server_jpa/terminology.html)]

### Katalog-Administrations-UIs — was "nicht-technischer Admin" konkret bedeutet

**Snapper:Author** (CSIRO/Ontoserver) ist das direkteste Vorbild für unsere
Admin-UI (§4.1): vier parallele Wege, einen Katalog zu befüllen — Codes
direkt in eine Tabelle tippen, **ein bereits geladenes CodeSystem
durchsuchen und Treffer per Drag&Drop übernehmen** (ergänzt unsere
CSV-Import-Idee um eine dritte, für Admins oft schnellere Variante — als
Phase-A/B-Ergänzung aufgenommen), CSV/TSV-Import mit Spalten-Mapping-Assistent,
oder intensionale Filter-/ECL-Regeln (dafür braucht es einen geführten
Regel-Builder, keine rohe Query-Box — [Shrimp](https://www.ontoserver.csiro.au/site/our-solutions/shrimp/)s
ECL-Builder ist das Vorbild). Snapper trennt außerdem **Definition** und
**Expansion** in zwei separate Tabs/Ansichten — genau das verhindert, dass
jemand die generierte Liste eines regelbasierten Katalogs von Hand
überschreibt.
[[Snapper:Author](https://ontoserver.csiro.au/site/technical-documentation/snapper-documentation/snapperauthor-guide/add-a-new-fhir-resource/create-a-new-valueset/)]

**VSAC** (NLM Value Set Authority Center) liefert das Governance-Modell:
jeder Value Set braucht eine strukturierte, vierteilige **Zweck-Erklärung**
(Klinischer Fokus, Data-Element-Scope, Einschluss-, Ausschlusskriterien) —
billig zu ergänzen, verhindert aber nachweislich Katalog-Wildwuchs. VSAC
kennt außerdem **Gruppierungs-Value-Sets** (ein Value Set, dessen
Mitglieder andere Value Sets sind, auch über Code-System-Grenzen hinweg) —
als Phase-D-Idee aufgenommen (§10).
[[VSAC](https://vsac.nlm.nih.gov/), [VSAC Authoring Best Practices](https://www.nlm.nih.gov/vsac/support/authorguidelines/bestpractices.html)]

---

## 3. Kernkonzept: die Entität "Katalog"

Ein **Katalog** ist eine benannte, administrierbare Quelle für
Code+Anzeigetext-Paare, in drei Ausprägungen (`sourceKind`):

| `sourceKind` | Bedeutung | Wo gespeichert |
|---|---|---|
| `manual` | Admin pflegt die Werteliste selbst (Freitext-Eintrag Zeile für Zeile, oder CSV-Import). | In unserer eigenen DB. |
| `fhir-valueset` | Katalog ist ein Live-Binding an eine FHIR-`ValueSet`-URL auf einem konfigurierten Terminologie-Server; Werte werden bei Bedarf per `$expand` nachgeladen, nicht lokal gespeichert. | Nur Referenz (Server + ValueSet-URL) in unserer DB, Werte selbst live vom Terminologie-Server. |
| `plugin` | Ein Plugin liefert die Werte über einen neuen Extension Point (siehe §6), z. B. eine hausinterne Datenbank, ein Nicht-FHIR-System, oder eine bereits bestehende externe API (Vorbild: `formbuilder-plugin-postal-lookup`, aktuell PLZ→Ort/Bundesland, strukturell identisch zu "Code→Anzeigetext"). | Beliebig, vom Plugin verwaltet. |

Ein Katalog wird **einmal** zentral angelegt und dann von beliebig vielen
Feldern in beliebig vielen Formularen referenziert — genau wie eine
`AqlFunction` heute von beliebig vielen `DataWidget`s referenziert wird
(gleiches, bereits etabliertes Muster in diesem Code).

### 3.1 Datenmodell (Prisma, angelehnt an `AqlFunction`/`DataWidget`)

```prisma
model Catalog {
  id            String   @id @default(uuid())
  name          String                              // "ICD-10-GM", "Fachabteilungen"
  description   String   @default("")
  sourceKind    String   @map("source_kind")          // 'manual' | 'fhir-valueset' | 'plugin'

  // sourceKind === 'manual': Werte liegen relational vor (siehe unten),
  // nicht als JSON-Blob — Suchperformance und CSV-Import sprechen dafür,
  // sobald ein Katalog über ein paar hundert Einträge hinauswächst (ein
  // hausinterner Leistungs-/Diagnosekatalog kann leicht mehrere tausend
  // Zeilen haben).

  // sourceKind === 'fhir-valueset':
  terminologyConnectionId String? @map("terminology_connection_id")  // siehe §5
  valueSetUrl              String? @map("value_set_url")             // kanonische FHIR-ValueSet-URL -
                                                                        // MUSS bei einem archetyp-gebundenen
                                                                        // Feld mit EHRbases eigenem
                                                                        // referenceSetUri übereinstimmen,
                                                                        // siehe §2 "Wichtiges Risiko"
  filterHint               String? @map("filter_hint")               // optionale ECL/Filter-Voreinstellung

  // sourceKind === 'plugin':
  pluginProviderId String? @map("plugin_provider_id")  // registrierte CatalogProvider-Id

  // Governance-Metadaten (VSAC-Vorbild, §2) - billig zu pflegen, verhindert
  // aber nachweislich Katalog-Wildwuchs ("wer hat das angelegt, wofür,
  // warum ist X drin und Y nicht"). Rein informativ, nicht validiert.
  clinicalFocus      String? @map("clinical_focus")       // "Wofür ist dieser Katalog gedacht?"
  inclusionCriteria  String? @map("inclusion_criteria")
  exclusionCriteria  String? @map("exclusion_criteria")

  enabled       Boolean  @default(true)
  createdAt     DateTime @default(now()) @map("created_at")
  updatedAt     DateTime @updatedAt @map("updated_at")

  entries       CatalogEntry[]

  @@map("catalogs")
}

model CatalogEntry {
  id         String  @id @default(uuid())
  catalogId  String  @map("catalog_id")
  code       String   // gespeicherter, unveränderlicher Wert - wird submittet, nie das display
  display    String   // reine Anzeige, überschreibbar/übersetzbar, nie selbst gespeichert
  sortOrder  Int      @default(0) @map("sort_order")  // explizite Reihenfolge, NICHT alphabetisch abgeleitet -
                                                          // z. B. eine klinische Skala braucht ihre eigene Ordnung
  isActive   Boolean  @default(true) @map("is_active")  // deaktivieren statt löschen (§8) - ein bereits
                                                          // gebundenes Feld verliert nie rückwirkend seinen Wert
  // Optional, für spätere hierarchische/fassettierte Darstellung
  // (z. B. ICD-10-Kapitel als Elternknoten) - nicht in der ersten Version
  // zwingend befüllt.
  parentCode String? @map("parent_code")

  catalog    Catalog @relation(fields: [catalogId], references: [id], onDelete: Cascade)

  @@unique([catalogId, code])
  @@index([catalogId])
  @@map("catalog_entries")
}
```

`CatalogEntry` bekommt zusätzlich einen Postgres-Trigram-Index
(`pg_trgm` auf `display`) für performante `ILIKE '%suche%'`-Server-Suche
ohne externe Suchmaschine — für die erwartete Größenordnung (Tausende, nicht
Millionen Einträge pro Katalog) ausreichend.

### 3.2 Backend-API

Neue Routen (`apps/api/src/routes/catalogRoutes.ts`,
`apps/api/src/services/catalogService.ts`), im Stil von
`aqlFunctionRoutes.ts`/`dataWidgetRoutes.ts`:

```
GET    /api/catalogs                    Liste (Admin-UI)
POST   /api/catalogs                    Anlegen
GET    /api/catalogs/:id                Detail
PUT    /api/catalogs/:id                Bearbeiten
DELETE /api/catalogs/:id
POST   /api/catalogs/:id/entries/import   CSV-Import (nur sourceKind='manual')
GET    /api/catalogs/:id/entries          Paginierte Volltliste (Admin-UI)

# Die eigentliche Laufzeit-Schnittstelle, von JEDEM sourceKind einheitlich
# bedient - der Form-Runtime-Client weiß nie, ob er gegen 'manual',
# 'fhir-valueset' oder 'plugin' spricht:
GET    /api/catalogs/:id/search?q=...&limit=50
GET    /api/catalogs/:id/resolve?codes=A,B,C     # Batch-Label-Lookup für bereits gespeicherte Werte
```

`search`/`resolve` sind die zwei Operationen, die der Runtime-Client
tatsächlich braucht — nicht mehr. Für `manual` sind sie eine simple
DB-Query; für `fhir-valueset` ein serverseitig geproxytes `$expand`
(vermeidet CORS-Probleme und hält Terminologie-Server-Credentials serverseitig,
genau wie `fhirCdrService.ts` es heute schon für die CDR-Anbindung macht);
für `plugin` ein Aufruf an den registrierten `CatalogProvider`.

**Caching**: `$expand`-Antworten eines externen Terminologie-Servers werden
serverseitig kurz gecacht (z. B. 5 Minuten, In-Memory oder ein einfacher
Redis-freier LRU-Cache) — SNOMED CT/ICD-10-GM ändern sich nicht
minütlich, und ein Terminologie-Server soll nicht bei jedem Tastendruck
jedes Klinikers erneut angefragt werden.

---

## 4. Design-Zeit-UX: wo im Formular-Designer sich das zeigt

### 4.1 Neue Admin-Fläche "Kataloge"

Ein neuer Nav-Eintrag neben Functions/Widgets/Plugins (gleiches Muster,
gleiche Berechtigung `form.design` — oder eine dedizierte
`catalog.manage`, falls Terminologiepflege organisatorisch getrennt vom
Formulardesign sein soll; siehe offene Frage in §8):

```
Bibliothek | Patienten | Settings | Plugins | Functions | Widgets | Kataloge | Users
```

Liste + Detail-Editor, identisch im Aufbau zu `WidgetsAdmin.tsx`:

- Liste: Name, Quelltyp-Badge (`manual`/`FHIR ValueSet`/`Plugin: <Name>`),
  Anzahl Einträge (bei `manual`), aktiv/inaktiv.
- Detail (`manual`): Name/Beschreibung, dann eine editierbare Tabelle
  (Code, Anzeigetext, +Zeile/−Zeile), plus ein "CSV importieren"-Button
  (zwei Spalten `code,display`, mit Vorschau vor dem Übernehmen).
- Detail (`fhir-valueset`): Name/Beschreibung, Dropdown "Terminologie-
  Server" (siehe §5), Textfeld "ValueSet-URL", ein "Testen"-Button, der
  serverseitig `$expand?count=10` aufruft und die ersten Treffer zur
  Kontrolle anzeigt — kein Rätselraten, ob die URL stimmt.
- Detail (`plugin`): Name/Beschreibung, Dropdown der registrierten
  `CatalogProvider`s (nur sichtbar/wählbar, wenn ein Plugin mit
  `catalogProvider`-Extension-Point aktiv ist).

### 4.2 `codeMappings.terminologies` — vom Freitext zum Katalog-Picker

`FormBuilder.tsx`s Terminologie-Zeilen (§1a) bekommen statt zweier freier
Textfelder (`id`, `label`) einen Such-Dropdown über die registrierten
Kataloge. Ausgewählt wird ein `catalogId`; `label` wird aus dem Katalog
übernommen (weiter überschreibbar, für den Fall, dass ein Formular eine
andere Bezeichnung braucht als der Katalogname). Die rohe
`terminology_id`, die openEHR am Ende braucht, wird eine Eigenschaft **des
Katalogs**, nicht mehr pro Formular neu erfunden:

```ts
interface CodeMappingTerminologyOption {
  catalogId: string;        // NEU - ersetzt freies `id` als Quelle der Wahrheit
  terminologyId: string;    // weiterhin die rohe openEHR-CODE_PHRASE.terminology_id -
                             // jetzt aber vom Katalog übernommen, nicht getippt
  label: string;             // weiterhin überschreibbar
  match?: '>' | '=' | '<' | '?';
}
```

**Abwärtskompatibel**: ein bestehendes `CodeMappingTerminologyOption` ohne
`catalogId` (jedes heute gespeicherte Formular) bleibt exakt wie es ist -
`catalogId` ist optional, fehlt es, verhält sich das Feld genau wie heute
(freie `id`/`label`, kein Lookup). Migration ist rein additiv, kein
Formular muss angefasst werden.

### 4.3 Neuer, generischer "Wertequelle"-Schalter für Freitextfelder

Für ein Feld, das (noch) keine `options` aus dem Archetyp hat, aber trotzdev
als Dropdown/Autocomplete laufen soll (§1, dritter Punkt), ein neues
Eigenschaften-Panel-Element neben dem bestehenden `options`-Editor:

```
Wertequelle:  ( ) Manuell eingeben   ( ) Aus Katalog wählen

  [wenn "Aus Katalog"]:  Katalog: [Fachabteilungen ▾]
```

Am Layout-Knoten landet das als:

```ts
valueSource?: { mode: 'catalog'; catalogId: string };
// fehlt `valueSource` (jedes bestehende Feld): weiterhin `options` wie heute.
```

---

## 5. Terminologie-Server-Verbindungen (Settings)

Analog zu den bestehenden "EHRbase Connections" in `Settings` (`configService.ts`'s
`ehrbaseConnections`, inkl. deren bewährtem Masking-Muster für Secrets) eine
neue, kleine, wiederverwendbare Verbindungsliste:

```ts
interface TerminologyServerConnection {
  id: string;
  name: string;            // "Nationaler Terminologieserver", "Ontoserver (selbst gehostet)"
  baseUrl: string;         // z. B. https://ontoserver.example.org/fhir
  authType: 'none' | 'bearer' | 'basic';
  // ... Secrets analog zum bestehenden EHRbase-Muster maskiert gespeichert
}
```

Mehrere Kataloge können dieselbe Verbindung referenzieren (ein Server hostet
typischerweise SNOMED CT, ICD-10-GM und LOINC ValueSets gemeinsam) - die
Basis-URL/Auth wird nur einmal gepflegt, nicht pro Katalog dupliziert.

**Datenhoheit-Hinweis** (bewusst analog zur bestehenden Entscheidung bei
`formbuilder-plugin-postal-lookup`, die explizit einen selbst-hostbaren
Open-Source-Dienst statt eines proprietären Cloud-Anbieters wählt): die
Dokumentation sollte explizit empfehlen, einen selbst gehosteten
Terminologie-Server (z. B. Ontoserver, ein HAPI-FHIR-Terminologie-Modul,
oder einen nationalen Server, sofern vorhanden) zu betreiben statt eines
öffentlichen Cloud-Diensts, weil Sucheingaben potenziell klinisch
sensiblen Kontext preisgeben (was ein Kliniker sucht, verrät oft schon,
woran der Patient leidet).

---

## 6. Plugin-Extension-Point: `catalogProvider`

Neuer Eintrag in `PluginExtensionPoint` (`packages/plugin-api/src/index.ts`),
im selben Muster wie `dataProvider`/`registerFormDataProvider`:

```ts
interface CatalogProvider {
  id: string;
  displayName: string;
  search(query: string, limit: number): Promise<Array<{ code: string; display: string }>>;
  resolve(codes: string[]): Promise<Array<{ code: string; display: string }>>;
}
// PluginContext:
registerCatalogProvider(provider: CatalogProvider): void;
```

Ein Plugin wie `formbuilder-plugin-postal-lookup` könnte so (als Analogie,
nicht als tatsächliche Umwidmung) einen "PLZ-Katalog" anbieten; realistischer
Anwendungsfall: ein hausinternes Leistungs-/Abteilungsverzeichnis, das schon
in einem anderen System liegt und per REST abgefragt werden kann, statt
dupliziert in unsere DB importiert zu werden.

---

## 7. Laufzeit-UX: Autocomplete statt Texteingabe

### 7.1 `codeMappings`-Code-Eingabe (`FormRuntime.tsx:745`)

Das bisherige `<input type="text" placeholder="Code">` wird - **nur wenn**
die gewählte Terminologie (§4.2) eine `catalogId` trägt - durch dieselbe
`AutocompleteInput`-Komponente ersetzt, die `field.options` heute schon
rendert, aber mit einer neuen, austauschbaren Datenquelle statt eines
statischen Arrays:

```ts
// Heute: AutocompleteInput bekommt eine feste field.options-Liste.
// Neu: eine optionale, debounced Remote-Suche als Alternative.
type OptionSource =
  | { kind: 'static'; options: RuntimeOption[] }
  | { kind: 'catalog'; catalogId: string };
```

Bei `kind: 'catalog'` fragt die Komponente `GET /api/catalogs/:id/search?q=`
debounced (300ms, wie bei jedem Typeahead-Standardmuster) statt lokal zu
filtern. Ein bereits gespeicherter Wert (z. B. beim erneuten Öffnen eines
Entwurfs) wird über `resolve` einmalig aufgelöst, damit der Anzeigetext
sofort erscheint, ohne dass der Nutzer erneut suchen muss.

Ein kleiner **"zuletzt verwendet"-Cache** pro Katalog (im Browser,
`localStorage`, wenige Einträge) beschleunigt die häufigsten Codes einer
Abteilung, ohne bei jedem Öffnen neu zum Server zu müssen — Standardmuster
bei großen Terminologien (SNOMED CT hat >350.000 Konzepte, niemand tippt
das komplett neu).

**Prefetch vs. Server-Suche automatisch entscheiden**: `GET /api/catalogs/:id/search`
liefert bei `fhir-valueset`-Katalogen serverseitig zunächst `$expand?count=0`
ab (nur `expansion.total`, kein Datentransfer), damit der Client selbst
entscheidet - unter einem Schwellwert (Vorschlag: 200 Einträge) wird einmal
komplett geladen und clientseitig gefiltert (schnelleres UX, kein
Netzwerk-Roundtrip pro Tastenanschlag), darüber ausschließlich debounced
Server-Suche. Für `manual`-Kataloge kennt der Server die Größe ohnehin
exakt (`COUNT(*)` über `CatalogEntry`).

### 7.2 Katalog-gebundene Freitextfelder (§4.3)

Identischer Mechanismus: `valueSource.mode === 'catalog'` lässt
`fieldInput` in `FormRuntime.tsx` denselben `AutocompleteInput` im
`kind: 'catalog'`-Modus statt im heutigen `kind: 'static'`-Modus rendern.

---

## 8. Datenintegrität, Versionierung, Governance

- **Eingaben werden bei Submission eingefroren.** Ein einmal übermittelter
  `DV_TEXT.mappings`-Eintrag bzw. ein `DV_CODED_TEXT`-Wert speichert Code
  **und** den zum Zeitpunkt der Eingabe gültigen Anzeigetext direkt in der
  Composition - genau wie heute schon. Ändert sich später ein
  Katalogeintrag (Umbenennung, Deaktivierung), ändert das **nichts** an
  bereits gespeicherten Daten - nur an den künftig angebotenen
  Auswahlmöglichkeiten. Das ist bereits die bestehende Systemarchitektur
  (Forms/Widgets funktionieren identisch: eine neue Version ändert nie
  rückwirkend, was schon gespeichert ist) und wird hier nur konsistent
  fortgeführt.
- **Kein Draft/Publish-Zyklus für Kataloge** (anders als bei Forms) - ein
  `manual`-Katalog wird direkt bearbeitet, analog zu `AqlFunction`/
  `DataWidget`, die auch keine Versionierung haben. Ein Katalog ist
  Referenzdaten, kein klinisches Artefakt mit eigenem Lebenszyklus; die
  Historisierung passiert implizit über die Compositions, die ihn zu einem
  Zeitpunkt referenziert haben (siehe Punkt oben).
- **`enabled: false`** deaktiviert einen Katalog für neue Bindungen
  (Admin-UI zeigt ihn nicht mehr im Picker an), lässt aber bereits
  gebundene Felder unverändert funktionsfähig - kein hartes Löschen, das
  ein bestehendes Formular bricht.

---

## 9. Abwärtskompatibilität — Zusammenfassung

Jede vorgeschlagene Änderung ist additiv:

| Bestehendes Feld | Verhalten ohne neue Konfiguration |
|---|---|
| `CodeMappingTerminologyOption` ohne `catalogId` | Exakt wie heute (freie `id`/`label`, manuelle Code-Eingabe). |
| `FormElementLayout` ohne `valueSource` | Exakt wie heute (`options` statisch oder Freitext). |
| Jedes bestehende Formular | Unverändert, kein Migrationsschritt nötig. |

Kein bestehendes Formular muss angefasst werden, damit dieses Konzept
sicher ausgerollt werden kann - es ist ein rein additiver Opt-in, genau wie
`codeMappings` selbst es schon war ("every existing DV_TEXT field keeps
behaving exactly as before").

---

## 10. Phasenplan (Vorschlag)

**Phase A — Fundament + `manual`-Kataloge**
Prisma-Modelle, CRUD-API, "Kataloge"-Admin-UI (nur `manual`), Verknüpfung
in `codeMappings.terminologies` (§4.2) und im neuen `valueSource`-Schalter
(§4.3), Laufzeit-Autocomplete gegen die eigene DB (§7). Liefert bereits den
Kernnutzen ("Katalog statt Freitext, zentral pflegbar, als Dropdown
nutzbar") ohne externe Abhängigkeit.

**Phase B — `fhir-valueset`**
Terminologie-Server-Verbindungen (§5), `$expand`/`$validate-code`-Proxy,
Server-seitiges Caching. Bringt SNOMED CT/ICD-10-GM/LOINC als Live-Katalog,
ohne sie lokal zu duplizieren.

**Phase C — `plugin`**
`catalogProvider`-Extension-Point (§6). Öffnet das System für
hausinterne/proprietäre Datenquellen, ohne Core-Code anzufassen.

**Phase D — Komfort**
CSV-Import-UI, "aus CodeSystem suchen & übernehmen" als dritter
Befüllungsweg für `manual`-Kataloge (Snapper-Vorbild, §2), "zuletzt
verwendet"-Cache, hierarchische/fassettierte Anzeige (`parentCode`) für
große Kataloge, ggf. "aus Archetyp-Options einen Katalog erzeugen"-Aktion
(macht bereits importierte, aber bisher pro-Formular gebundene Value-Sets
nachträglich wiederverwendbar), **Gruppierungs-Kataloge** (ein Katalog,
dessen Mitglieder andere Kataloge sind, auch über Quelltyp-Grenzen hinweg —
VSAC-Vorbild, §2).

---

## 11. Offene Entscheidungen für dich

1. **Berechtigung**: `form.design` mitverwenden (Designer pflegen
   Kataloge selbst) oder eine eigene `catalog.manage`-Rolle (z. B. für ein
   dediziertes Terminologie-/Datenmanagement-Team)?
2. **Umfang Phase A**: reicht `manual` erstmal, oder soll `fhir-valueset`
   von Anfang an mit rein (hängt davon ab, ob schon ein konkreter
   Terminologie-Server zur Verfügung steht)?
3. **Namensgebung**: "Katalog" im UI, oder ein anderer Begriff
   ("Werteliste", "Codeliste", "Terminologie")? Wirkt sich auf Nav-Label,
   Tabellen-/Routennamen aus.
4. **Reichweite von `valueSource` (§4.3)**: nur für `input-select`/
   DV_TEXT-Felder, oder auch für andere Konfigurationsstellen im System,
   die du im Kopf hattest (z. B. AQL-Function-Parameter, Composition-Block-
   Konfiguration)? Deine ursprüngliche Formulierung ("überall wo man das
   hinterlegen kann") ist bewusst weiter gefasst als das, was oben
   konkret ausgearbeitet ist - wenn es noch weitere Stellen gibt, an die du
   speziell gedacht hast, sag mir welche, dann nehme ich die mit auf.
5. **EHRbase-Abgleich bei `fhir-valueset`-Katalogen** (§2, neu durch die
   Recherche aufgefallen): EHRbase validiert einen archetyp-gebundenen
   externen Code bereits selbst gegen seine eigene
   `validation.external-terminology.provider`-Konfiguration. Soll Phase B
   die dort hinterlegte ValueSet-URL beim Template-Import automatisch als
   Vorschlag für den zugehörigen Katalog übernehmen (vermeidet
   Doppelpflege, aber koppelt uns enger an EHRbases Konfigurationsformat),
   oder bewusst getrennt lassen mit einem Warnhinweis in der Admin-UI,
   falls die URLs abweichen?

---

## Quellen

Vollständige, mit Fundstelle geprüfte Quellenliste der Recherche zu diesem
Konzept:

- FHIR: [ValueSet](https://hl7.org/fhir/R4/valueset.html), [$expand](https://hl7.org/fhir/R4/valueset-operation-expand.html), [$validate-code](https://hl7.org/fhir/R4/valueset-operation-validate-code.html), [Terminology Service Module (R5)](https://www.hl7.org/fhir/terminology-service.html)
- FHIR SDC: [preferredTerminologyServer](https://hl7.org/fhir/uv/sdc/STU3/StructureDefinition-sdc-questionnaire-preferredTerminologyServer.html), [Rendering-Extensions](https://hl7.org/fhir/uv/sdc/STU3/rendering.html), [answerOptionsToggleExpression](http://hl7.org/fhir/uv/sdc/STU3/StructureDefinition-sdc-questionnaire-answerOptionsToggleExpression.html), [Smart Forms — Terminology Binding](https://smartforms.csiro.au/docs/sdc/terminology)
- openEHR: [ADL2 Terminology Integration](https://github.com/openEHR/specifications-AM/blob/master/docs/ADL2/master08-terminology_integration.adoc), [Archetype Technology Overview](https://specifications.openehr.org/releases/AM/latest/Overview.html), [Support Terminology Spec](https://specifications.openehr.org/releases/TERM/latest/SupportTerminology.html), [EHRbase — Terminology Validation](https://docs.ehrbase.org/docs/EHRbase/Explore/Terminology)
- Enterprise/Low-Code: [Salesforce GlobalValueSet](https://developer.salesforce.com/docs/atlas.en-us.api_meta.meta/api_meta/meta_globalvalueset.htm), [ServiceNow sys_choice-Warnung](https://www.servicenow.com/community/developer-blog/how-to-fix-a-reference-to-the-choice-sys-choice-table/ba-p/2860768), [Camunda Options Source](https://docs.camunda.io/docs/components/modeler/forms/configuration/forms-config-options/), [DHIS2 Metadata](https://docs.dhis2.org/en/use/user-guides/dhis-core-version-master/configuring-the-system/metadata.html)
- Autocomplete/Terminologie-Server: [autocomplete-lhc (NLM)](https://lhncbc.github.io/autocomplete-lhc/), [Snowstorm](https://github.com/IHTSDO/snowstorm), [HAPI FHIR Terminology](https://hapifhir.io/hapi-fhir/docs/server_jpa/terminology.html)
- Admin-UIs: [Snapper:Author](https://ontoserver.csiro.au/site/technical-documentation/snapper-documentation/snapperauthor-guide/add-a-new-fhir-resource/create-a-new-valueset/), [Shrimp](https://www.ontoserver.csiro.au/site/our-solutions/shrimp/), [VSAC](https://vsac.nlm.nih.gov/), [VSAC Authoring Best Practices](https://www.nlm.nih.gov/vsac/support/authorguidelines/bestpractices.html)
