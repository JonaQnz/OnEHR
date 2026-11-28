# Lokale Debug-EHRbase

Die Debug-Umgebung verwendet die offiziellen EHRbase-Images `ehrbase/ehrbase:2.30.0` und `ehrbase/ehrbase-v2-postgres:16.2`. Sie ist ein reines Entwicklerprofil und nutzt keinen HIP-/Keycloak-Login.

Definiert wird sie ausschließlich in `docker-compose.ehrbase-test.yml` (Services `ehrbase-test-db` und `ehrbase-test`, Volume `ehrbase_test_data`, Host-Port `8082`). Das Skript kombiniert diese Datei mit dem Dev-Stack (`docker-compose.yml`) und dem Overlay `docker-compose.debug-ehrbase.yml`. Das Overlay hat keine Profiles und verdrahtet die API auf `http://ehrbase-test:8080`.

```bash
./scripts/debug-ehrbase.sh on
./scripts/debug-ehrbase.sh import
./scripts/debug-ehrbase.sh off
./scripts/debug-ehrbase.sh reset
```

- `on` startet EHRbase auf `http://localhost:8082`, importiert `.opt`-Dateien aus `debug/ehrbase/templates` und setzt Forms auf die zusätzliche aktive Verbindung **Lokale Debug-EHRbase**.
- `import` importiert nur die Templates erneut (nach dem Ergänzen weiterer `.opt`-Dateien).
- `off` beendet die Container, lässt die Daten aber stehen.
- `reset` beendet die Container **und** löscht das Volume `ehrbase_test_data`.

> **Achtung:** Debug-Daten und der opt-in Integrationstest
> (`docs/testing/ehrbase-integration.md`) teilen sich das Volume
> `ehrbase_test_data`. `reset` löscht daher auch die Daten des
> Integrationstests - und ein `down -v` des Integrationstests löscht die
> Debug-Daten. Nicht gegen eine Umgebung laufen lassen, deren Daten noch
> gebraucht werden.

Das Profil ist für Integrations- und Roundtrip-Tests gedacht; die Details des opt-in Tests stehen in `docs/testing/ehrbase-integration.md`.
