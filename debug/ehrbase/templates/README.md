# Debug-EHRbase templates

Lege hier openEHR Operational Templates (`.opt`) ab. Beim Einschalten der Debug-Umgebung werden alle vorhandenen `.opt`-Dateien einmal gegen die lokale EHRbase importiert.

Nach dem Ergänzen weiterer Templates den Import erneut ausführen:

```bash
./scripts/debug-ehrbase.sh import
```

Die Dateien bleiben bewusst lokal und werden nicht mit produktiven Systemen geteilt.
