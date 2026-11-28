# Credential hygiene audit

- Date: 2026-11-26
- Audited commit: `6bfa752` (develop)
- Tasks: #129 (credential hygiene) / #161 (remove tracked runtime configuration, audit)

## Method

Scan command:

```
node scripts/secret-scan.js --history --allowlist scripts/secret-scan-allowlist.json
```

Rules (ids are the values the scanner reports):

| id | description |
| --- | --- |
| private-key | PEM private key header |
| aws-access-key | AWS access key id |
| github-token | GitHub personal access or app token |
| llm-api-key | LLM provider API key |
| slack-token | Slack bot, app, user or refresh token |
| url-credentials | Password embedded in a URL |
| json-secret-field | Secret-looking JSON field with a literal value |
| env-secret-assignment | Secret-looking environment or compose assignment |

Redaction: this audit reports only paths, line numbers, rule ids, commit ids, counts and
same-value group ids. Matched values are never reported - not as values, hashes, prefixes
or lengths. The scanner keeps matched values in a non-enumerable property so they cannot be
serialised by accident.

Placeholders the scanner ignores by design: empty values, `***`, `$`/`${` references,
`process.env` references, and the literal words changeme, placeholder, `<redacted>`,
example and xxx.

Same-value groups are shared between the tree scan and the history scan: two findings that
report the same group id carry the same matched value. A `group=null` finding means the
value occurs only once across everything that was scanned, so it cannot be matched to a
compose-file default by group.

## Tracked files

Tree scan of the tracked files at `6bfa752`, after the allowlist:

| path | rule | findings | class | reason |
| --- | --- | --- | --- | --- |
| README.md | env-secret-assignment | 1 | doc-example | placeholder example value in documentation |
| apps/api/tests/http/health.test.js | url-credentials | 1 | test-fixture | synthetic connection string of the health endpoint test |
| deploy/import-packages/onehr-basis-2026-09-01/README.md | env-secret-assignment | 2 | doc-example | placeholder example value in documentation |
| docker-compose.ehrbase-test.yml | env-secret-assignment | 7 | dev-default | local EHRbase test stack |
| docker-compose.yml | env-secret-assignment | 2 | dev-default | local development stack (Postgres/EHRbase containers) |
| docker-compose.yml | url-credentials | 1 | dev-default | local development stack (Postgres/EHRbase containers) |
| docs/authentication.md | env-secret-assignment | 1 | doc-example | placeholder example value in documentation |
| docs/scripting-integration.md | env-secret-assignment | 1 | doc-example | placeholder example value in documentation |
| tests/deploy/smoke-test.test.js | env-secret-assignment | 1 | test-fixture | synthetic credential of the smoke-test unit test |

Total: 24 findings in 10 path/rule pairs. 0 unclassified after the allowlist - proven by
`apps/api/tests/secret-scan-tree.test.js`, which re-runs the tree scan and the allowlist on
every test run. `compose.yaml` reports nothing, i.e. the deployment stack has no literal
credential in the tree.

Limitation: the allowlist matches by path + rule, not by line or group. A new credential
added to an already-allowlisted path with an already-allowlisted rule would be hidden, so
those paths stay under review whenever they change. The test also asserts that no entry
covers `compose.yaml`, runtime config (`apps/data/`, `.data/`), env files or this document.

## Git history

History was not scanned here. The audit worker ran in a one-commit snapshot of develop, so
`git log --all` sees no real history and no history row would be evidence. History is
therefore PENDING: run the command above in a full clone (output is redacted) and add the
`path | rule | commits | newest | oldest | groups | class` rows from it.

Until that run exists, no history finding is claimed clean, and any former secret value is
treated as EXPOSED for the purpose of the operator actions below.

## Former runtime config files

Both former runtime config files are absent from the tree at `6bfa752` and git-ignored;
their content was never part of this audit.

- `apps/data/config.json`: added in commit `9638743`, untracked by commit `3d86825`
  (task #157). Its history rows are PENDING with the history scan.
- `apps/data/config.json`, field `ehrbasePass` (rule json-secret-field) verdict:
  UNVERIFIED - treated as EXPOSED until the history scan shows its group also occurs on a
  `docker-compose*.yml` finding.
- `.data/config.json`: added in commit `6f87688`; also absent from the tree and git-ignored.
  Its history rows are PENDING with the history scan. No tree findings.

## Build context and images

`.dockerignore` keeps secrets out of the build context and therefore out of every image:

- `.env` and `**/.env` / `**/.env.*` (with `!**/.env.example`);
- `data` and `.data` at the context root, plus `**/data/config.json` and `**/.data`;
- `docker-compose*.yml`, so no local stack file is ever copied;
- `**/docs` and `**/*.md`, so documentation examples are excluded;
- the key material patterns `**/*.pem` and `**/*.key` (lines 23-31).

The production `Dockerfile` (TEST/PROD): the build stage runs `COPY . .` and the runtime
stage runs `COPY --from=build /app /app`, so the image holds every tracked file that passes
`.dockerignore`. From the table above, the only allowlisted findings that reach that image
are the two test fixtures (`apps/api/tests/http/health.test.js`,
`tests/deploy/smoke-test.test.js`). The compose-file and documentation findings do not
reach it.

`Dockerfile.api` additionally copies `node_modules`, `apps/api` and the `packages/*`
directories from the build stage into its runtime; it inherits the same `.dockerignore`
exclusions, so the same two test fixtures are the only allowlisted findings present
there. `Dockerfile.web` was removed as unused.

`compose.yaml` uses `${VAR}` references only. Its database password default inside the
`${ONEHR_DB_PASSWORD:-...}` form is reachable on the internal compose network only, not
publicly (task #128). Recommended: set `ONEHR_DB_PASSWORD` explicitly in the CI/CD
environment settings rather than relying on that default; the default value is deliberately
not repeated here.

## Environment configuration

Credentials never live in tracked files. They come from:

- environment variables, documented in `apps/api/.env.example`;
- the untracked runtime config in `DATA_DIR`, templated by
  `apps/data/config.example.json` (copy it to `apps/data/config.json` locally);
- the "Configuration & secrets" note in `README.md`.

Runtime `data/config.json` and `.env` files are untracked and git-ignored.

## Operator actions

0. In a full clone, run the history scan:
   `node scripts/secret-scan.js --history --allowlist scripts/secret-scan-allowlist.json`.
   If the `apps/data/config.json` json-secret-field row lists only groups that also appear
   on a `docker-compose*.yml` row, that field is a dev default and needs no rotation.
   Otherwise treat it as EXPOSED and rotate it as described next.

For `ehrbasePass` (currently unverified, treated as EXPOSED):

1. In the EHRbase server your local `apps/data/config.json` points to (`ehrbaseUrl`), change
   the basic-auth password of the `ehrbaseUser` account. For an EHRbase container that is
   its `SECURITY_AUTHPASSWORD` environment setting; restart the container afterwards.
2. Put the new value only into the untracked local `apps/data/config.json` (`ehrbasePass`)
   or the `EHRBASE_PASS` environment variable of each deployment that uses that server.
   Never put it into git or a chat.

For any other row the history scan marks EXPOSED: change the credential in the issuing
service, then set it through the matching environment variable in the deployment settings.

If the history scan shows nothing EXPOSED, then: No rotation needed.

No history rewrite was performed. Rewriting history needs the operator's explicit
authorization.

## Out of scope

The literal dev-default passwords in `docker-compose*.yml` stay as they are: they belong to
local development stacks, task #128 owns the compose files and Dockerfiles, and those files
are excluded from every image.
