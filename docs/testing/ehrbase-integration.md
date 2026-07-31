# Lokale EHRbase-Integrationstests

Der optionale Stack nutzt eine isolierte EHRbase auf Port `8082`; die reguläre
Entwicklungs-EHRbase und ihre Daten bleiben unberührt.

Start:

```bash
docker compose -f docker-compose.ehrbase-test.yml up -d
```

Der opt-in Test lädt zwei kleine `vg_`-Artefakte direkt aus dem öffentlichen
Modell-Repository und prüft die Kompatibilitätsgrenze mit der lokalen EHRbase:

```bash
npm run test:integration:ehrbase --workspace=api
```

Verwendete Fixtures:

- `vg_BodyWeight.v1.0.1`
- `vg_HeartRate.v1.0.1`

Die Dateien im angegebenen Ordner sind Template-JSON-Dateien (`*.t.json`) und
keine Compositions. Sie tragen zwar `adlVersion: "1.4"`, sind jedoch nicht das
von EHRbase erwartete ADL-1.4-OPT als XML. Der produktive EHRbase-Endpunkt
verlangt dieses XML-Format. Der Test erwartet deshalb bewusst
`415 Unsupported Media Type` und verhindert, dass diese Einschränkung
unbemerkt bleibt.

Sobald ein gleichwertiges `vg_`-OPT (ADL 1.4/XML) vorliegt, wird derselbe
Test zu einem echten Template/WebTemplate-Integrationstest aktiviert:

```bash
EHRBASE_TEST_VG_OPT_URL=https://.../vg_example.opt \
EHRBASE_TEST_VG_OPT_TEMPLATE_ID=vg_Example.v1 \
npm run test:integration:ehrbase --workspace=api
```

Darauf aufbauend kann ein echter Composition-Submit/Read-Roundtrip gegen
dieses Template getestet werden. Ohne ein importierbares OPT wäre ein solcher
Test nicht aussagekräftig, weil EHRbase jede Composition ohne installiertes
Template ablehnt.

Aufräumen inklusive ausschließlich der Testdaten:

```bash
docker compose -f docker-compose.ehrbase-test.yml down -v
```
