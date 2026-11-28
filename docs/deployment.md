# Deployment

OnEHR ships as **one image** built from the root `Dockerfile`. The API
serves the built SPA from `WEB_DIST_DIR`, so there is no separate web
container in TEST/PROD. Each environment is a compose project started from
the shared `compose.yaml`:

```bash
IMAGE=onehr:<sha> HOST_PORT=18114 APP_ENV=test \
  docker compose -f compose.yaml -p onehr-test up -d
```

The dev stack (`Dockerfile.api` + `docker-compose.yml`) is unchanged and unrelated to deployment.

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
SMOKE_BASE_URL=http://127.0.0.1:18114 SMOKE_WAIT_S=180 node scripts/smoke-test.mjs
```

The steps are:

- optional wait for `/api/health/ready` (up to `SMOKE_WAIT_S` seconds);
- `GET /api/health` (the version must equal `SMOKE_EXPECT_VERSION` when set);
- `GET /api/health/ready`;
- `GET /` (expects `text/html`);
- with `SMOKE_USERNAME` / `SMOKE_PASSWORD`:
  - `GET /api/forms` without a session must give 401/403;
  - `POST /api/auth/login`;
  - `GET /api/auth/me` must report `authenticated: true`;
  - `POST /api/forms` creates a synthetic form named `smoke-synthetic-<timestamp>`;
  - `GET /api/forms/:id` reads it back;
  - `POST /api/forms/:id/delete` cleans it up.

It prints one PASS/FAIL line per step, never prints the password or the
session cookie, and exits 1 on any failure.

## Host proof (test.integration)

The deploy files are `Dockerfile` + `compose.yaml` (described in this file,
`docs/deployment.md`); their tests live in `tests/deploy/` and run with the
unit test command.

`bash scripts/integration-smoke.sh` is the project's acceptance proof. The
AI Dev Home platform runs it automatically in a clean clone of the integration
head before a task closes. Nobody runs it by hand; it needs Docker and
Node >= 18.

- It builds the image of that commit with `--build-arg APP_VERSION=<sha12>`.
- It starts `compose.yaml` as the separate compose project `onehr-proof` on a
  free `127.0.0.1` port. That gives separate containers and volumes, so TEST
  (`onehr-test`) and PROD (`onehr-prod`) are never touched.
- It generates a random bootstrap admin password per run, which is never
  printed and is redacted from the report.
- It runs the smoke flow with `SMOKE_EXPECT_VERSION=<sha12>` and
  `SMOKE_WAIT_S=180`.
- It always removes the stack with `docker compose -p onehr-proof down -v`
  and the image tag.
- It writes `reports/integration-smoke.txt` (commit, result, step lines). The
  platform keeps that file, so `reports/` must never be git-ignored.
