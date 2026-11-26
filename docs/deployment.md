# Deployment

OnEHR ships as **one image** built from the root `Dockerfile`. The API
serves the built SPA from `WEB_DIST_DIR`, so there is no separate web
container in TEST/PROD. Each environment is a compose project started from
the shared `compose.yaml`:

```bash
IMAGE=onehr:<sha> HOST_PORT=18114 APP_ENV=test \
  docker compose -f compose.yaml -p onehr-test up -d
```

The dev stack (`Dockerfile.api`, `Dockerfile.web`, `docker-compose.yml`) is
unchanged and unrelated to deployment.

## Environment variables

| Variable | Purpose | Default |
| --- | --- | --- |
| `IMAGE` | Image tag to run | `onehr:dev` |
| `HOST_PORT` | Loopback host port for the app (**required**) | - |
| `APP_ENV` | Environment label (`test`/`production`) | `test` |
| `ONEHR_DB_PASSWORD` | Postgres password for the app and db service | `onehr-internal` |
| `WEB_ORIGIN` | Allowed browser origin (CORS) | empty |
| `EHRBASE_URL` | EHRbase base URL | empty |
| `FORMS_BOOTSTRAP_ADMIN_USERNAME` | Initial admin username | `admin` |
| `FORMS_BOOTSTRAP_ADMIN_PASSWORD` | Initial admin password (secret) | empty |
| `AID_NOTIFY_TOKEN` | AI Dev Home notification token (secret) | empty |
| `OPENROUTER_API_KEY` | OpenRouter key for app LLM calls (secret) | empty |

Credentials come from the CI/CD environment only; never commit them.

## TEST/PROD isolation

TEST and PROD are separate compose projects, so their containers, networks
and named volumes cannot collide:

| | TEST | PROD |
| --- | --- | --- |
| Branch | `develop` | `main` |
| Compose project | `onehr-test` | `onehr-prod` |
| Loopback port | `18114` | `18115` |
| Volumes | `onehr-test_pgdata`, `onehr-test_app_data` | `onehr-prod_pgdata`, `onehr-prod_app_data` |

Only the app publishes a port, bound to `127.0.0.1` (the platform proxies
it). The db has no host port and is reachable only on the compose project
network, which is why the internal default password is acceptable; set
`ONEHR_DB_PASSWORD` in the CI/CD environment to override it. Production
deploys require approval (`requires_approval: true`).

## Migration policy

On start the container runs `prisma db push --skip-generate` **without**
`--accept-data-loss`. The schema is applied only if it does not require
dropping data. If the push fails, the container exits and the deployment is
considered failed: roll back to the previous image (the platform keeps the
last 3 artifacts) instead of forcing the migration.

## Backup and restore

```bash
# backup
docker compose -p onehr-test exec -T db pg_dump -U onehr onehr > backup.sql

# restore
docker compose -p onehr-test exec -T db psql -U onehr -d onehr < backup.sql
```

Swap `onehr-test` for `onehr-prod` for production.

## Smoke test

With no dependencies (`fetch` is global on Node >= 18):

```bash
SMOKE_BASE_URL=http://127.0.0.1:18114 node scripts/smoke-test.mjs
```

It checks `GET /api/health` (optionally matching `SMOKE_EXPECT_VERSION`),
`GET /api/health/ready`, the SPA at `/`, and - when `SMOKE_USERNAME` and
`SMOKE_PASSWORD` are set - logs in at `/api/auth/login` and reads
`/api/auth/me` with the session cookie. It prints one PASS/FAIL line per
step and exits 1 on any failure.
