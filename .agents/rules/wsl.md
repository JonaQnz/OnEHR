---
trigger: always_on
---

Führe Linux- und Docker-Befehle direkt in der bereits geöffneten WSL-Shell aus. Starte niemals selbst `wsl.exe`. Verwende für Docker-Befehle ein Timeout und prüfe anschließend explizit den Exit-Code und Containerstatus.

Beispiel:

```bash
timeout 30s docker restart formbuilder-api-1
status=$?
docker inspect -f '{{.State.Status}}' formbuilder-api-1
echo "EXIT_CODE=$status"
```

Wenn der Container bereits läuft, betrachte den Schritt als erfolgreich und wiederhole `wsl.exe` oder `docker restart` nicht.
