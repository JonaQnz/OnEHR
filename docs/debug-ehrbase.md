# Lokale Debug-EHRbase

Die Debug-Umgebung verwendet die offiziellen EHRbase-Images `ehrbase/ehrbase:2.30.0` und `ehrbase/ehrbase-v2-postgres:16.2`. Sie ist ein reines Entwicklerprofil und nutzt keinen HIP-/Keycloak-Login.

```bash
./scripts/debug-ehrbase.sh on
./scripts/debug-ehrbase.sh off
```

Mit `on` startet EHRbase auf `http://localhost:8082`, importiert `.opt`-Dateien aus `debug/ehrbase/templates` und setzt Forms auf die zusätzliche aktive Verbindung **Lokale Debug-EHRbase**. `off` beendet nur die Container; `reset` entfernt zusätzlich deren lokale Daten.

Das Profil ist für spätere Integrations- und Roundtrip-Tests vorgesehen. Tests werden bewusst noch nicht gestartet oder angelegt.
