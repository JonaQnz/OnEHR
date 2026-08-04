# Debug-EHRbase templates

Lege hier openEHR Operational Templates (`.opt`) ab. Beim Einschalten der Debug-Umgebung werden alle vorhandenen `.opt`-Dateien einmal gegen die lokale EHRbase importiert.

Nach dem Ergänzen weiterer Templates den Import erneut ausführen:

```bash
docker compose -f docker-compose.yml -f docker-compose.debug-ehrbase.yml --profile debug-ehrbase run --rm debug-ehrbase-templates
```

Die Dateien bleiben bewusst lokal und werden nicht mit produktiven Systemen geteilt.
