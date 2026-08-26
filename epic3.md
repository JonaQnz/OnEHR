# Epic 3 – Version History, Audit & Semantic Diff

## Ziel

Baue eine generische Historien-, Audit- und Diff-Schicht für openEHR-Compositions.

Der Form Builder soll nicht nur den aktuellen Stand einer Composition anzeigen, sondern nachvollziehbar machen:

* welche Versionen existieren
* wann eine Version entstanden ist
* wer sie committed hat
* wer fachlicher Composer war
* welcher `change_type` verwendet wurde
* warum die Änderung durchgeführt wurde
* welcher Lifecycle State vorliegt
* was sich fachlich zwischen zwei Versionen geändert hat

Ziel ist eine klinisch verständliche Versionshistorie und kein technischer JSON-Diff.

Epic 3 baut auf folgenden Grundlagen aus Epic 2 auf:

```text
Composition UID
Version UID
Base Version UID
Lifecycle State
Change Type
Change Description
Optimistic Concurrency
Editing Session
Central Save Pipeline
```

---

# Zielbild

Eine Composition besitzt eine nachvollziehbare Historie:

```text
Composition
│
├── Version 1
│   ├── incomplete
│   ├── creation
│   └── User A
│
├── Version 2
│   ├── incomplete
│   ├── modification
│   └── User A
│
├── Version 3
│   ├── complete
│   ├── modification
│   └── User A
│
├── Version 4
│   ├── complete
│   ├── amendment
│   └── User B
│
└── Version 5
    ├── deleted
    ├── deleted
    └── User B
```

Die UI soll daraus beispielsweise erzeugen:

```text
Version 5
26.08.2026 09:14
J. Müller
Dokument zurückgezogen

Version 4
26.08.2026 08:52
Dr. Schmidt
Dokumentationsfehler korrigiert

Version 3
25.08.2026 18:41
Dr. Schmidt
Finalisiert

Version 2
25.08.2026 18:33
Dr. Schmidt
Entwurf gespeichert
```

Beim Vergleich zweier Versionen soll nicht primär JSON angezeigt werden.

Stattdessen:

```text
Version 3 → Version 4

Körpergewicht
87 kg → 78 kg

Diagnose
+ Diabetes mellitus Typ 2

Kommentar
"Patient stabil"
→
"Patient klinisch stabil"
```

---

# Scope

## 1. Zentralen Version-History-Layer einführen

Versionshistorie darf nicht direkt in einzelnen React-Komponenten oder CDR-Plugins implementiert werden.

Ziel ist eine zentrale Abstraktion, beispielsweise:

```ts
VersionHistoryService
```

oder:

```ts
CompositionHistoryService
```

Mögliche API:

```ts
getHistory(compositionUid)

getVersion(versionUid)

getLatestVersion(compositionUid)

compareVersions(fromVersionUid, toVersionUid)

getAuditMetadata(versionUid)
```

Die exakte Struktur soll zur bestehenden Architektur passen.

---

# 2. Internes Version-Modell

Normalisiere CDR-spezifische Antworten auf ein internes Modell.

Beispiel:

```ts
type CompositionVersion = {
  compositionUid: string
  versionUid: string

  versionNumber?: number

  lifecycleState:
    | "incomplete"
    | "complete"
    | "deleted"
    | "unknown"

  changeType:
    | "creation"
    | "modification"
    | "amendment"
    | "deleted"
    | "attestation"
    | "unknown"

  committedAt?: string

  committer?: PartyReference

  composer?: PartyReference

  changeDescription?: string

  contributionUid?: string

  precedingVersionUid?: string

  raw?: unknown
}
```

Keine UI-Komponente soll CDR-Rohdaten direkt interpretieren.

---

# 3. Version Tree berücksichtigen

openEHR-Versionen besitzen nicht einfach nur eine lokale Integer-Version.

Version IDs können eine Version Tree ID enthalten.

Beispiel:

```text
objectUid::systemId::1
objectUid::systemId::2
objectUid::systemId::3
```

später eventuell auch:

```text
1.1.1
```

für Branching-Szenarien.

Für Epic 3 muss noch kein Distributed Merge implementiert werden.

Aber:

```text
Version UID nicht auf Integer reduzieren.
```

Ein optional extrahiertes:

```ts
versionNumber
```

darf nur Convenience sein.

Die vollständige `version_uid` bleibt Source of Truth.

---

# 4. Audit Metadata

Pro Version sollen mindestens folgende Informationen verfügbar sein:

```text
Version UID

Lifecycle State

Change Type

Commit Timestamp

Committer

Change Description

Contribution UID
```

Soweit verfügbar zusätzlich:

```text
Composer

System ID

Preceding Version UID
```

Die Daten sollen aus openEHR-Audit-/Version-Metadaten stammen.

Nicht aus UI-eigenen Shadow-Tabellen, sofern nicht technisch zwingend notwendig.

---

# 5. Committer und Composer trennen

Die Architektur muss explizit unterscheiden:

```text
COMPOSITION.composer
```

und:

```text
VERSION.commit_audit.committer
```

Diese Personen können identisch sein, müssen es aber nicht.

Beispiel:

```text
Composer:
Dr. Schmidt

Committer:
M. Meyer
```

Die UI darf diese Werte nicht zusammenwerfen.

Im normalen UI kann bei identischen Personen vereinfachte Darstellung erfolgen.

Im Developer Inspector müssen beide sichtbar sein.

---

# 6. Change Type normalisieren

Unterstütze mindestens:

```text
creation
modification
amendment
deleted
attestation
```

und unbekannte Werte robust über:

```text
unknown
```

Keine UI-Logik direkt auf numerische openEHR-Codes aufbauen.

Stattdessen zentral mappen.

Beispiel:

```ts
mapChangeType(code)
```

UI-Labels:

```text
creation
→ Erstellt

modification
→ Aktualisiert

amendment
→ Korrigiert

deleted
→ Zurückgezogen

attestation
→ Attestiert
```

---

# 7. Lifecycle State normalisieren

Unterstütze mindestens:

```text
incomplete
complete
deleted
```

und:

```text
unknown
```

UI:

```text
incomplete
→ Entwurf

complete
→ Finalisiert

deleted
→ Zurückgezogen
```

Numerische Codes gehören nicht in den normalen Clinical UI Layer.

---

# 8. History Panel

Baue eine wiederverwendbare History-Komponente.

Beispiel:

```text
Dokumenthistorie

v5
26.08.2026 09:14
J. Müller
Zurückgezogen
Grund: Falschem Patienten zugeordnet

v4
26.08.2026 08:52
Dr. Schmidt
Korrigiert
Grund: Falsches Körpergewicht

v3
25.08.2026 18:41
Dr. Schmidt
Finalisiert
```

Funktionen:

```text
Version auswählen

Version öffnen

Version vergleichen

Audit Details anzeigen
```

Noch keine Attestation UI in diesem Epic.

---

# 9. Historische Version read-only öffnen

Benutzer sollen ältere Versionen ansehen können.

Eine historische Version darf standardmäßig nicht editierbar sein.

UI:

```text
Historische Version

Version 3
25.08.2026 18:41

Diese Version ist schreibgeschützt.
```

Die Form Engine soll hierfür einen expliziten Read-Only-Modus unterstützen.

Beispiel:

```ts
mode = "history"
readOnly = true
```

Nicht denselben Editing Mode wie bei aktuellen Compositions verwenden.

---

# 10. Aktuelle vs historische Version

Die Anwendung muss klar unterscheiden zwischen:

```text
latest/current version
```

und:

```text
historical version
```

Beim Öffnen einer historischen Version darf kein versehentliches Update mit deren Version UID erfolgen.

Wenn ein Benutzer aus einer historischen Version heraus eine Änderung durchführen möchte:

```text
Neue aktuelle Version öffnen
```

oder später:

```text
Werte als Ausgangspunkt übernehmen
```

Keine direkte Bearbeitung der alten Version.

---

# 11. Semantischer Diff

Implementiere eine generische Diff Engine.

Ziel:

```text
Composition A
vs.
Composition B
```

nicht als:

```text
raw JSON diff
```

sondern auf Basis des internen openEHR Runtime Models aus Epic 1.

Beispiel:

```ts
type SemanticDiff = {
  added: DiffEntry[]
  removed: DiffEntry[]
  changed: DiffEntry[]
  unchanged?: DiffEntry[]
}
```

Beispiel für einen Eintrag:

```ts
type DiffEntry = {
  path: string

  archetypeNodeId?: string
  rmType?: string

  label?: string

  oldValue?: unknown
  newValue?: unknown

  change:
    | "added"
    | "removed"
    | "changed"
}
```

---

# 12. Diff über semantische Identität

Felder sollen primär über die openEHR-Identität verglichen werden.

Nicht:

```text
Label
```

und nicht ausschließlich:

```text
Array Index
```

sondern Kombination aus:

```text
path

archetypeNodeId

Runtime Instance Context
```

Die Path Engine aus Epic 1 soll hierfür verwendet werden.

Keine zweite parallele Path-Implementierung.

---

# 13. Datentyp-aware Diff

Vergleiche Werte nicht nur über:

```ts
JSON.stringify(a) !== JSON.stringify(b)
```

Die Diff Engine soll zentrale openEHR-Datentypen sinnvoll normalisieren.

Mindestens:

```text
DV_TEXT

DV_CODED_TEXT

DV_QUANTITY

DV_COUNT

DV_BOOLEAN

DV_DATE

DV_DATE_TIME

DV_DURATION

DV_PROPORTION
```

Beispiele:

```text
DV_QUANTITY

old:
{
  magnitude: 87,
  units: "kg"
}

new:
{
  magnitude: 78,
  units: "kg"
}
```

UI:

```text
Körpergewicht

87 kg
→
78 kg
```

Nicht:

```text
{"magnitude":87,"units":"kg"}
→
{"magnitude":78,"units":"kg"}
```

---

# 14. DV_CODED_TEXT Diff

Bei coded values soll möglichst angezeigt werden:

```text
Display Text
Code
Terminology
```

Beispiel:

```text
Diagnoseart

Verdachtsdiagnose
→
Gesicherte Diagnose
```

Developer Details optional:

```text
local::at0012
→
local::at0013
```

oder externe Terminologie:

```text
SNOMED CT 123456
```

---

# 15. Strukturelle Änderungen

Die Diff Engine muss erkennen:

```text
Element hinzugefügt

Element entfernt

Repeat Instance hinzugefügt

Repeat Instance entfernt
```

Beispiel:

```text
Medikation

+ Metoprolol 50 mg
```

oder:

```text
Allergien

- Penicillin
```

---

# 16. Wiederholbare Nodes vergleichen

Repeating Nodes sind kritisch.

Nicht einfach:

```text
index 0 gegen index 0
index 1 gegen index 1
```

vergleichen, wenn eine fachliche Identität verfügbar ist.

Beispiel:

Version A:

```text
Medication[0] = Aspirin
Medication[1] = Metoprolol
```

Version B:

```text
Medication[0] = Metoprolol
Medication[1] = Aspirin
```

Das darf nicht als zwei fachliche Änderungen erscheinen, wenn lediglich die Reihenfolge geändert wurde.

Strategie:

1. stabile Runtime Instance ID verwenden, falls vorhanden
2. ansonsten semantischen Matching-Mechanismus nutzen
3. als Fallback Index verwenden

Die genaue Strategie dokumentieren.

---

# 17. Noise reduzieren

Nicht jede technische Veränderung ist klinisch relevant.

Die Diff Engine soll technische Metadaten standardmäßig ausblenden.

Beispiele:

```text
UID

internal form IDs

render metadata

UI state

timestamps, sofern sie nicht fachlicher Inhalt sind

temporary client IDs
```

Optional:

```text
Developer Diff
```

kann technische Details anzeigen.

---

# 18. Diff Kategorien

UI sollte Änderungen gruppieren können:

```text
Geändert

Hinzugefügt

Entfernt
```

Optional nach Template-Struktur:

```text
Vitalwerte

Diagnosen

Medikation

Anamnese
```

Die Template-Struktur aus Epic 1 kann dafür verwendet werden.

---

# 19. Inline Diff

Bei einzelnen Feldern:

```text
Körpergewicht

Alt:
87 kg

Neu:
78 kg
```

Bei Text:

```text
Kommentar

Alt:
Patient stabil

Neu:
Patient klinisch stabil
```

Ein Wort-für-Wort-Textdiff ist optional.

Für Epic 3 reicht zunächst Value-Level Diff.

---

# 20. Full Version Compare

Der Benutzer soll zwei Versionen explizit auswählen können.

Beispiel:

```text
Vergleichen:

Von:
Version 3

Mit:
Version 5
```

Dann:

```text
Version 3 → Version 5
```

anzeigen.

Default beim Klick auf eine Version:

```text
Version N
vs.
Version N-1
```

---

# 21. Diff direkt aus History Panel

Beispiel:

```text
Version 5

[Öffnen]
[Mit vorheriger Version vergleichen]
```

Zusätzlich:

```text
Version auswählen
```

und später:

```text
Mit Version ... vergleichen
```

---

# 22. Change Summary

Erzeuge aus einem Semantic Diff eine kompakte maschinenlesbare Zusammenfassung.

Beispiel:

```ts
{
  changed: 3,
  added: 2,
  removed: 1
}
```

UI:

```text
6 Änderungen

3 geändert
2 hinzugefügt
1 entfernt
```

Noch keine KI-Zusammenfassung erforderlich.

---

# 23. Audit Detail View

Für eine Version soll ein Detaildialog existieren.

Beispiel:

```text
Version Details

Version UID
abc::ehrbase::4

Composition UID
abc

Committed
26.08.2026 08:52

Committer
J. Müller

Composer
Dr. Schmidt

Change Type
Amendment

Lifecycle
Complete

Description
Falsches Körpergewicht korrigiert

Contribution
xyz...
```

Dieser View ist vor allem für Admins, Entwickler und Audits relevant.

---

# 24. Developer Inspector erweitern

Developer Inspector aus Epic 1 und 2 ergänzen.

Mindestens:

```text
Current Composition UID

Current Version UID

Base Version UID

Preceding Version UID

Lifecycle State

Change Type

Commit Timestamp

Committer

Composer

Contribution UID
```

Bei historischer Version:

```text
Historical Version = true
```

---

# 25. History Cache

Historieninformationen können gecacht werden.

Aber:

```text
Nach erfolgreichem Save
```

muss der History Cache invalidiert bzw. aktualisiert werden.

Keine veraltete Versionshistorie nach:

```text
Autosave

Finalize

Modification

Amendment

Delete
```

anzeigen.

---

# 26. CDR-Abstraktion

CDR-spezifische REST-Details gehören in den Connector.

Beispiel:

```ts
interface CompositionHistoryRepository {
  getVersionHistory(
    ehrId: string,
    compositionUid: string
  ): Promise<CompositionVersion[]>

  getVersion(
    ehrId: string,
    versionUid: string
  ): Promise<CompositionSnapshot>
}
```

Die Form UI soll nicht wissen:

```text
welcher EHRbase Endpoint

welcher Header

welches Original-Version JSON
```

---

# 27. Capability Detection

Falls unterschiedliche CDRs unterschiedliche History-Funktionen unterstützen:

```ts
type CdrCapabilities = {
  supportsVersionHistory?: boolean
  supportsVersionAtTime?: boolean
  supportsAuditDetails?: boolean
}
```

Nur ergänzen, wenn die bestehende Connector-Architektur dies sinnvoll unterstützt.

Bei fehlender Capability:

```text
Versionshistorie wird von diesem CDR nicht unterstützt.
```

Keine stillen Fehler.

---

# 28. Performance

Bei umfangreichen Compositions darf History nicht alle historischen Versionen vollständig laden.

Zuerst:

```text
History metadata
```

laden.

Erst beim Öffnen oder Vergleichen:

```text
Version content
```

nachladen.

Also:

```text
History List
↓
Metadata only

User selects version
↓
Fetch Composition version
```

---

# 29. Lazy Diff

Semantic Diff nur erzeugen, wenn:

```text
Benutzer Vergleich öffnet
```

oder eine andere Funktion ihn benötigt.

Nicht für jede Version automatisch alle Composition-Inhalte laden und vergleichen.

---

# 30. Fehlerzustände

History UI muss robuste Fehlerzustände besitzen.

Beispiele:

```text
Historie konnte nicht geladen werden.

Version konnte nicht geladen werden.

Vergleich konnte nicht erzeugt werden.
```

Aktuelle Composition darf dadurch nicht unbenutzbar werden.

---

# Architekturprinzipien

## Historie gehört nicht in die Form Components

Nicht:

```ts
DVQuantity.tsx

if (previousValue) ...
```

Sondern:

```text
Version History Layer
        │
        ▼
Semantic Diff Engine
        │
        ▼
Diff UI
```

---

## Semantic Diff basiert auf Runtime Foundation

Keine zweite interne openEHR-Repräsentation einführen.

Verwende aus Epic 1:

```text
RM Type

Archetype Node ID

Paths

Runtime Identity

Template Tree
```

---

## Audit-Daten nicht duplizieren

Wenn der CDR die Daten bereits zuverlässig liefert:

```text
nicht zusätzlich eigene Audit-Schattenhistorie führen.
```

Eigene Datenbank nur ergänzen, wenn produktseitig Informationen erforderlich sind, die openEHR selbst nicht enthält.

---

## Immutable History

Historische Versionen sind immutable.

UI darf keine Funktion anbieten:

```text
Version 3 ändern
```

sondern nur:

```text
Version 3 ansehen

Version 3 vergleichen
```

Eine Änderung erzeugt immer eine neue aktuelle Version.

---

# Empfohlene interne Struktur

```text
Clinical Editing Layer
        │
        ▼
Composition Repository
        │
        ├──────────────┐
        ▼              ▼
Current State     Version History
                       │
                       ▼
                 Version Loader
                       │
                       ▼
                Semantic Diff
                       │
             ┌─────────┴─────────┐
             ▼                   ▼
       History Panel          Diff View
```

---

# Nicht Teil dieses Epics

Noch nicht implementieren:

```text
Automatic Merge

3-Way Merge

Attestation Workflow

Digital Signatures

FEEDER_AUDIT

PARTICIPATION

Contribution Editor

ITEM_TAG

LINK

Template Migration

AI-generated Change Summary

Distributed Version Merge
```

Eine vorhandene `contribution_uid` soll aber bereits angezeigt und intern mitgeführt werden.

---

# Tests

## Test 1 – History laden

Gegeben:

```text
Composition mit 4 Versionen
```

Erwartung:

```text
4 Versionseinträge

korrekte Version UIDs

korrekte Reihenfolge

Lifecycle State vorhanden

Change Type vorhanden
```

---

## Test 2 – Committer und Composer

Gegeben:

```text
Composer != Committer
```

Erwartung:

```text
beide Werte getrennt erhalten

beide Werte getrennt anzeigen
```

---

## Test 3 – Lifecycle Mapping

Input:

```text
openEHR lifecycle code incomplete
```

Erwartung:

```text
internal:
incomplete

UI:
Entwurf
```

Dasselbe für:

```text
complete
deleted
```

---

## Test 4 – Change Type Mapping

Prüfen:

```text
creation
modification
amendment
deleted
```

Unbekannter Code:

```text
unknown
```

Keine Exception.

---

## Test 5 – Historische Version öffnen

```text
Version 2 auswählen
```

Erwartung:

```text
Composition wird geladen

readOnly = true

mode = history

keine Save-Actions
```

---

## Test 6 – Simple Text Diff

Version A:

```text
Kommentar = "Patient stabil"
```

Version B:

```text
Kommentar = "Patient klinisch stabil"
```

Erwartung:

```text
1 changed entry
```

mit:

```text
oldValue
newValue
path
nodeId
```

---

## Test 7 – Quantity Diff

Version A:

```text
87 kg
```

Version B:

```text
78 kg
```

Erwartung:

```text
changed

old = 87 kg
new = 78 kg
```

Keine Darstellung als Raw JSON.

---

## Test 8 – Added Node

Version A:

```text
keine Diagnose
```

Version B:

```text
Diagnose Diabetes
```

Erwartung:

```text
added
```

---

## Test 9 – Removed Node

Version A:

```text
Allergie Penicillin
```

Version B:

```text
keine Allergie Penicillin
```

Erwartung:

```text
removed
```

---

## Test 10 – Repeating Nodes

Version A:

```text
Aspirin
Metoprolol
```

Version B:

```text
Metoprolol
Aspirin
```

Wenn eine stabile semantische oder Runtime-Identität vorhanden ist:

```text
keine fachliche Änderung
```

Nur Reihenfolge hat sich geändert.

---

## Test 11 – Added Repeat Instance

Version A:

```text
Aspirin
```

Version B:

```text
Aspirin
Metoprolol
```

Erwartung:

```text
Metoprolol = added
```

Nicht:

```text
Aspirin changed to Metoprolol
```

---

## Test 12 – Label Change

Version A und B besitzen denselben semantischen Node.

UI Label wurde geändert:

```text
Blood Pressure
→
Blutdruck
```

Klinischer Wert unverändert.

Erwartung:

```text
kein fachlicher Diff
```

UI-Metadaten dürfen keinen Composition-Diff erzeugen.

---

## Test 13 – Ignore Technical Metadata

Unterschiede ausschließlich in:

```text
internal IDs
UI metadata
temporary IDs
```

Erwartung:

```text
0 clinical changes
```

---

## Test 14 – History nach Save aktualisieren

History:

```text
v1
v2
```

Dann Save.

Erwartung:

```text
v3 erscheint

kein manueller Full Reload der Anwendung notwendig
```

---

## Test 15 – History API Fehler

CDR liefert Fehler.

Erwartung:

```text
History Panel zeigt Fehlerzustand

aktuelle Form bleibt nutzbar
```

---

## Test 16 – Diff Performance

Große Composition mit vielen Nodes.

Erwartung:

```text
History list lädt keine vollständigen Composition-Versionen

Version content wird lazy geladen

Diff wird nur bei Bedarf berechnet
```

---

# Definition of Done

Epic gilt als abgeschlossen, wenn:

* Versionshistorie einer Composition geladen werden kann
* Version UID vollständig erhalten bleibt
* Version Tree IDs nicht auf Integer reduziert werden
* Lifecycle State zentral normalisiert wird
* Change Type zentral normalisiert wird
* Committer und Composer getrennt behandelt werden
* Change Description angezeigt werden kann
* Contribution UID mitgeführt wird
* historische Versionen read-only geöffnet werden können
* aktuelle und historische Version technisch klar getrennt sind
* History Panel generisch für alle Templates funktioniert
* Audit Detail View vorhanden ist
* zwei Versionen verglichen werden können
* Semantic Diff auf dem Runtime Model aus Epic 1 basiert
* Added / Removed / Changed erkannt werden
* zentrale RM-Datentypen sinnvoll dargestellt werden
* wiederholbare Nodes nicht ausschließlich nach Array-Index verglichen werden
* reine UI-/technische Änderungen nicht als klinischer Diff erscheinen
* History und Version Content lazy geladen werden
* History Cache nach Änderungen korrekt aktualisiert wird
* CDR-spezifische History-Logik im Connector liegt
* Developer Inspector um Versions- und Audit-Metadaten erweitert wurde
* alle relevanten Unit- und Integrationstests vorhanden sind
* bestehende Editing-Funktionen aus Epic 2 weiterhin funktionieren

---

# Wichtige Vorgabe für die Umsetzung

Vor der Implementierung:

1. Bestehende Composition- und Version-APIs analysieren.
2. Prüfen, welche History-/Version-Endpunkte die vorhandenen CDR-Connectoren bereits unterstützen.
3. Bestehende Verwendung von:

   * Composition UID
   * Version UID
   * ETag / If-Match
   * lifecycle state
   * change type
   * contribution UID
     untersuchen.
4. Prüfen, ob bereits Audit-Metadaten irgendwo extrahiert werden.
5. Das interne Runtime Model aus Epic 1 wiederverwenden.
6. Keine zweite Path Engine einführen.
7. Bestehende Editing Session aus Epic 2 wiederverwenden.
8. Zunächst Version-Metadaten normalisieren.
9. Danach History UI implementieren.
10. Danach historische Versionen read-only laden.
11. Erst anschließend Semantic Diff implementieren.
12. Diff zunächst auf zentrale RM-Datentypen fokussieren.
13. Danach Repeating Nodes robust behandeln.
14. Performance mit realistischen großen Templates testen.

Empfohlene interne Reihenfolge:

```text
Version Metadata Model
↓
History Repository
↓
History Panel
↓
Historical Read-Only Mode
↓
Audit Detail View
↓
Diff Model
↓
Primitive RM Value Diff
↓
Structured / Repeating Node Diff
↓
Diff UI
↓
Performance Hardening
```

Besonders auf Regressionen achten bei:

```text
Drafts

Autosave

Finalize

Modification

Amendment

Logical Delete

Conflict Handling

Composition Rendering

Live JSON Editor

Scripting

Plugins

Prefill

Multi-EHRbase Support
```

Ziel dieses Epics ist eine belastbare, klinisch verständliche und technisch korrekte Historien- und Diff-Funktion für openEHR-Compositions.

Nach Abschluss dieses Epics soll der Form Builder jederzeit beantworten können:

```text
Was war vorher?

Was ist jetzt?

Was wurde geändert?

Wer hat es geändert?

Wann wurde es geändert?

War es eine fachliche Änderung oder eine Korrektur?

Welche konkrete openEHR-Version liegt zugrunde?
```
