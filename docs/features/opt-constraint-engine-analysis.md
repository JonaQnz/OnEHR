# OPT Constraint Engine — Analyse des bestehenden Stands

Analyse vor Beginn des Umbaus (branch `feature/opt-constraint-engine`), Grundlage für die
Neuarchitektur in diesem Branch. Entwickelt/getestet gegen das reale `vg_Diagnosis.v1.1.1`.

## Kernbefund: keine Ingestion von rohem OPT-XML

Der Form Builder konsumiert heute ausschließlich EHRbase's bereits **flach vorverarbeitetes
WebTemplate-JSON** (`GET /definition/template/adl1.4/{id}`, `Accept: application/openehr.wt+json`,
siehe `apps/api/src/services/ehrbaseService.ts:getRemoteWebTemplate`). Rohes OPT-XML
(`C_ARCHETYPE_ROOT`, `C_COMPLEX_OBJECT`, `C_CODE_PHRASE`, `term_definitions`,
`component_ontologies`, `term_bindings`) wird von der App selbst nirgends geparst — das existierte
bisher nur in einem separaten, nicht eingebundenen Authoring-Tool (`packages/openehr-architect-mcp`).

**Überraschender Gegenbefund beim Abgleich mit echten Daten:** Ein WebTemplate-JSON-Export trägt
bereits deutlich mehr, als der Name "flach" vermuten lässt — bestätigt an der echten
`vg_Diagnosis.v1.1.1`-Antwort:
- **Mehrsprachigkeit ist bereits enthalten**, ohne `?lang=`-Parameter: jeder Knoten trägt
  `localizedNames`/`localizedDescriptions`, jede Coded-Text-Option `localizedLabels`/
  `localizedDescriptions`, für alle im Template konfigurierten Sprachen (`de`+`en`) in einer
  einzigen Antwort.
- **`name/value`-Instanz-Disambiguierung ist bereits enthalten**: "primary diagnosis" und
  "secondary diagnosis" (zweimal `EVALUATION.problem_diagnosis.v1`) bekommen bereits eigene
  `id`s und ihr `aqlPath` trägt bereits das volle `name/value='primary diagnosis'`-Prädikat.
- **DV_CODED_TEXT-oder-DV_TEXT wird bereits als zwei `inputs`-Einträge exponiert**
  (`{suffix:'code', list:[...], listOpen:true}` + `{suffix:'other', type:'TEXT'}`).
- **Polymorphe ELEMENTs** (z. B. `admission_diagnosis`/at0073: DV_BOOLEAN ODER DV_CODED_TEXT) werden
  bereits als ein `ELEMENT`-Knoten mit typisierten `children` exponiert.

**Was WebTemplate-JSON nachweislich NICHT enthält** (Test: alle Vorkommen von "snomed"/"SNOMED"/
"termBinding"/"8319008" im echten Export = 0): **`term_bindings`** (externe Terminologie-Querverweise,
z. B. SNOMED). Dafür ist tatsächlich rohes OPT-XML nötig.

→ Entscheidung (mit Nutzer abgestimmt): **Hybrid-Ansatz.** WebTemplate-JSON bleibt Quelle für
Struktur/Occurrences/rmType/Mehrsprachigkeit/Value-Unions (dort bereits vorhanden und live
verifiziert). Rohes OPT-XML wird zusätzlich gezogen, aber nur für das, was WebTemplate strukturell
nicht tragen kann: `term_bindings`. Neue Infrastruktur dafür: `getRemoteTemplateOpt()`
(`apps/api/src/services/ehrbaseService.ts`), Route `GET /api/admin/ehrbase/remote-templates/:id/opt`,
MCP-Tool `get_remote_template_opt`.

## Bestehende Implementierung — Ist-Zustand je Konzept

| Konzept | Ist-Zustand |
|---|---|
| `C_ARCHETYPE_ROOT` | Nicht modelliert (rohes OPT nie geparst). In WebTemplate äquivalent erkennbar: ein Knoten, dessen `nodeId` ein voller Archetyp-Id-String ist (`openEHR-EHR-EVALUATION.problem_diagnosis.v1`) — ein generisches, rmType-unabhängiges Signal, real bestätigt für EVALUATION/CLUSTER-Wurzeln gleichermaßen. |
| `ELEMENT` | `webTemplateParser.ts` erkennt Blattknoten an `rmType.startsWith('DV_')`; das eigentliche RM-`ELEMENT`-Konzept (Werteträger, unabhängig vom konkreten DV-Typ) existiert nicht als eigener Layer — `rmType` ist überall genau ein String (`FieldRegistryItem.rmType`, `OpenEhrBinding.rmType`), kein Union. |
| `node_id` | Korrekt pro Pfad extrahiert (`parseOpenEhrAqlPath`, letzter `[atNNNN]`-Klammerausdruck) — nicht global aufgelöst, sondern lokal aus dem jeweiligen `aqlPath`. |
| `occurrences` | Solide vorhanden: `isRepeatable`/`getRepeatMeta` lesen `node.min`/`node.max`, propagiert auf Container UND Blattfelder, inkl. `parentRepeatable`. Kein Totalausfall wie ursprünglich vermutet. |
| `DV_TEXT` | Korrekt als eigener `dataType`/`input-text` erkannt. |
| `DV_CODED_TEXT` | Wird korrekt geparst — ABER: `needsOptions`/`getInputType` nehmen NUR den `code`-Input, der parallele `other`(TEXT)-Input wird beim Import stillschweigend verworfen → die DV_TEXT-Alternative geht verloren, obwohl die Quelldaten sie bereits explizit tragen. |
| `CODE_PHRASE` | Wie DV_CODED_TEXT behandelt (gleicher Options-Pfad). |
| `defining_code` | Wird pro Feld korrekt aus dem feldeigenen `options`/`inputs[].list` gebaut (`packages/openehr-engine/src/index.ts:setFlatValue`) — **kein** globales `Map<atCode,...>`, anders als ursprünglich befürchtet. Lücke: fällt bei fehlendem Options-Match still auf `terminology:'local'` zurück statt zu warnen. |
| `terminology_id` | Pro Feld aus `inputs[].terminology` übernommen — korrekt gescoped. |
| `code_list` | = `inputs[].list`, korrekt pro Feld gelesen. |
| `term_definitions` | In WebTemplate real vorhanden (`localizedNames`/`localizedLabels`), aber vom bestehenden Parser komplett verworfen — `label: node.name \|\| node.id` nimmt nur einen einzigen String, keine Sprachauswahl, kein `lang`-Parameter beim Fetch. |
| `component_ontologies` | Als OPT-Konzept nie geparst; WebTemplate liefert das funktionale Äquivalent (`localizedNames`/`localizedLabels` je Sprache) bereits mit — ungenutzt. |
| `term_bindings` | Nirgends im Code vorhanden (weder gelesen noch missbraucht) — WebTemplate trägt sie strukturell nicht; nur über rohes OPT-XML erreichbar (neu gebaut, siehe unten). |
| Wiederholbare Nodes | Funktioniert (s. `occurrences`), inkl. UI (Repeat-Gruppen in `FormBuilder.tsx`) und Submit-Aufbau (`canonicalComposition.ts:resolveScopes`). |
| Alternative Value-Typen im selben ELEMENT | **Nicht modelliert.** Ein polymorpher Slot (z. B. `admission_diagnosis`: DV_BOOLEAN ODER DV_CODED_TEXT) wird nur an EINER Live-Stelle (`canonicalComposition.ts`, submit-seitig) als Sonderfall behandelt — durch zwei separate Felder mit identischem Pfad, aufgelöst nach "wer hat zur Laufzeit einen Wert". Kein Union-Typ auf einem Feld. |
| Feste name/value-Constraints von Archetyp-Instanzen | WebTemplate liefert das Prädikat bereits im `aqlPath`; der bestehende Parser liest es nirgends aus — Disambiguierung passiert nur zufällig über bereits unterschiedliche `node.id`-Strings, es gibt keinen expliziten `nameConstraint`/Instance-Key. |
| Serialisierung zurück nach openEHR | Zwei Pfade: `toOpenEhrFlatComposition` (FLAT, tatsächlich live für normale Form-Submits) und `buildCanonicalComposition` (nur für den Contribution/Atomic-Commit-Pfad). Beide bauen Werte aus feldeigenen `options`, kein globaler Lookup — aber beide arbeiten auf untypisierten Runtime-Werten (`FormSession.values: Json`), RM-typisierte Objekte entstehen nur transient beim Schreiben. |

## Bestätigte semantische Verlustpunkte (aus Code + echten Daten)

- **DV_TEXT-Alternative bei DV_CODED_TEXT wird beim Import verworfen**, obwohl WebTemplate sie
  bereits liefert (`webTemplateParser.ts` nimmt nur den `code`-Input).
- **Mehrsprachigkeit wird verworfen**, obwohl WebTemplate sie bereits liefert
  (`label: node.name` statt `localizedNames`).
- **Kein Union-Typ pro Feld** — polymorphe ELEMENTs (DV_BOOLEAN|DV_CODED_TEXT) werden nur
  submit-seitig als Sonderfall behandelt, nicht als reguläres Modellkonzept.
- **Kein `nameConstraint`/Instance-Key** — "primary"/"secondary diagnosis" bleiben nur zufällig
  getrennt, weil ihre WebTemplate-`id`s zufällig unterschiedlich sind, nicht weil das System das
  `name/value`-Prädikat als Konzept kennt.
- **Terminology fällt still auf `'local'` zurück**, statt bei fehlendem Options-Match zu warnen.
- **`term_bindings` sind unerreichbar** ohne rohes OPT-XML (jetzt neu angebunden).
- **Kein Warn-Mechanismus** für unbekannte/nicht unterstützte RM-Typen — würden bisher `undefined`
  bzw. gar keine Options ergeben, ohne dass das irgendwo sichtbar würde.

## Nicht bestätigte / entkräftete ursprüngliche Annahmen

- "at-Codes werden global aufgelöst" — **nicht der Fall**, Auflösung ist bereits durchgehend pro
  Feld/Pfad gescoped, sowohl beim Import als auch beim Schreiben.
- "Wiederholbarkeit wird ignoriert" — **nicht der Fall**, `min`/`max` wird durchgängig korrekt
  propagiert und sowohl im Builder als auch beim Submit verwendet.
- "Code und Rubric sind unabhängig editierbar" — im bestehenden `codeMappings`-Mechanismus
  (separates Feature für DV_TEXT-Freitext-Codierung, nicht für DV_CODED_TEXT) ja, aber das ist ein
  bewusst anderes Feature (RM `TERM_MAPPING`), nicht `defining_code`. Für echtes DV_CODED_TEXT sind
  Code+Rubric bereits atomar (ein Dropdown-Eintrag).

## Neue Infrastruktur in diesem Branch

- `packages/core/src/openehr-constraint/index.ts` — das neutrale Constraint-Modell:
  `ArchetypeTerminology`, `resolveTerm`/`resolveTermIn` (archetyp-gescoped, nie global),
  `ValueConstraint`-Union, `OpenEhrFieldDefinition`, `ArchetypeInstanceDefinition`,
  `canonicalFieldId`/`canonicalInstanceKey`, typisierte `RuntimeOpenEhrValue`.
- `packages/openehr-engine/src/opt/buildConstraintModel.ts` — baut das Modell aus WebTemplate-JSON;
  generisch, kein Diagnose-spezifischer Code. Getestet gegen die reale
  `vg_Diagnosis.v1.1.1`-Antwort (`packages/openehr-engine/tests/fixtures/`,
  `packages/openehr-engine/tests/opt-constraint-model.test.js`, 14 Tests, decken u. a. die
  Primary/Secondary-Trennung, die at0076-Scope-Kollision (Bestätigt vs. Komplikation), alle in der
  Aufgabenstellung genannten konkreten Felder ab).
- `getRemoteTemplateOpt()`/`GET /api/admin/ehrbase/remote-templates/:id/opt`/MCP-Tool
  `get_remote_template_opt` — rohes OPT-XML für die noch ausstehende `term_bindings`-Erweiterung.

## Offen (noch nicht umgesetzt)

- `term_bindings`-Extraktion aus rohem OPT-XML + Merge in `ArchetypeTerminology.semanticBindings`.
- Renderer-Anbindung (Form Designer/Runtime) an das neue Modell statt der bisherigen,
  parse-zeit-fixierten `input-select`-Entscheidung.
- Typisierte Runtime-Werte end-to-end (`FormSession.values`) statt untypisiertem JSON.
- Serializer-Anpassung, damit `toOpenEhrFlatComposition`/`buildCanonicalComposition` aus dem neuen
  Modell statt aus Ad-hoc-Feldstrukturen schreiben.
- Developer-Inspector-Erweiterung um Occurrences/Value-Constraints/Semantic-Bindings.
