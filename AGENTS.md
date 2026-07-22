# AGENTS.md

Guidance for AI agents and new contributors working in this repository.
Booked is an influencer analytics aggregator: a single AWS SAM stack
(`template.yaml`), a monolithic Lambda API (`api/`), event-driven standalone
functions (`functions/`), a React dashboard (`ui/`), a Chrome extension
(`extension/`), and a GitHub Action (`action/`). See `README.md` for the
architecture overview and `docs/` for feature deep-dives.

## Commands

```bash
npm test                 # backend jest suite (api/__tests__ + functions)
npm run lint             # eslint for backend .mjs files
cd ui && npm test        # dashboard vitest suite
cd ui && npm run lint    # dashboard eslint
cd ui && npx tsc --noEmit  # dashboard typecheck (also runs in `npm run build`)
sam build && sam validate  # template checks (W1100 merge-key lint warnings are expected)
```

Run the backend suite and lint before every commit that touches `api/`,
`functions/`, or `scripts/`. Run the UI suite, lint, and typecheck for `ui/`
changes.

## Backend layering (api/)

Requests flow route -> validation -> domain, with cross-cutting concerns in
services. Keep each layer to its job:

- **Routes** (`api/routes/*.mjs`) are thin HTTP glue: resolve the tenant,
  parse, validate, call domain/services, shape the response. If a handler
  grows orchestration (multi-step pipelines, fan-out loops), extract it to a
  service module. Register new route modules in `api/app.mjs`.
- **Body parsing**: use `parseBody(event, { optional })` from
  `api/services/http-handler.mjs`. Do not write a per-route copy.
- **Responses**: `jsonResponse` / `emptyResponse` from `http-handler.mjs`.
- **Errors**: throw the typed classes from `api/services/errors.mjs`
  (`NotFoundError`, `BadRequestError`, `UpstreamError`, ...). Never return a
  hand-rolled `jsonResponse(4xx/5xx, ...)` — the central mapper produces the
  canonical `{ message, code }` body, and bypassing it forks the error shape.
- **Tenant scoping**: every route derives identity from the authorizer via
  `requireTenantId` / `resolveTenantId` / `requirePublisherTenantId` in
  `api/services/identity.mjs`. Never read a tenant id from the body, path, or
  query.
- **Validation** (`api/validation/<entity>.mjs`): hand-written imperative
  validators that throw `BadRequestError`, co-located with the entity's
  `format*` response shapers. New endpoints get a validation module, not
  inline validators in the route file. Reuse shared regexes instead of
  redefining ULID/ISO-date patterns.
- **Idempotency**: wrap mutating POST routes with `withIdempotency` (the UI
  sends an `idempotency-key` header on every POST).

## Data access (DynamoDB)

Single-table design in `api/domain/*.mjs`:

- Always import the shared `ddb` DocumentClient and `TABLE_NAME` from
  `api/services/ddb.mjs`. Never construct a client in a domain module.
- Keys are built by per-entity helper functions (`contentKey(...)`,
  `tenantPartition(...)`), never inline string templates at call sites.
- **New entities are tenant-partitioned**: `pk = TENANT#{tenantId}`. The
  older entity-scoped partitions (campaign, vendor) are legacy; do not copy
  that pattern, and do not copy their FilterExpression + paginate-until-full
  workaround.
- Conventions: `entity` discriminator attribute, `ulid()` ids,
  `new Date().toISOString()` timestamps, GSI named `GSI1` with
  `gsi1pk`/`gsi1sk`, `ConditionalCheckFailedException` mapped to
  `NotFoundError`.
- Thread `LastEvaluatedKey`/`ExclusiveStartKey` through list functions and
  expose opaque cursors via `api/services/pagination.mjs`. No `Scan` in
  request paths (migration scripts in `scripts/` are the only exception).
- Bound fan-out: when aggregating across many items, run the queries through
  a batching helper (see `runInBatches` in `campaign-analytics.mjs`) instead
  of one unbounded `Promise.all`.

## Services and AWS clients

- AWS SDK clients are module-scoped singletons. Before constructing one,
  check whether a shared service already exports it (`ddb.mjs`, `s3.mjs`).
- Secrets and config come from Powertools `getParameter` (cached); raw SSM
  clients are for writes only.
- Bedrock model ids come from env (`BEDROCK_MODEL_ID`, `EMBEDDING_MODEL_ID`),
  never hardcoded, and every converse call sets an explicit `maxTokens`.

## Standalone functions (functions/)

Handlers stay thin (well under 200 lines) and import business logic from
`api/services` and `api/domain` via relative paths — esbuild bundles them.
Do not duplicate api/ logic into a function directory. Every function dir
has a colocated `*.test.mjs`. Async event sources get a DLQ in the template.

## Infrastructure (template.yaml)

- Shared settings live in `Globals` (arm64, nodejs24.x, tracing, 512 MB) and
  the `esbuild-properties` YAML anchor; override per function only with a
  comment explaining why.
- IAM is least-privilege per function, scoped to specific resources.
- Every new function gets a CloudFormation-managed log group
  (`/booked/<env>/<name>`, retention from `LogRetentionInDays`) referenced by
  its `LoggingConfig` — never rely on the Lambda-created default group.
- Env var names are SCREAMING_SNAKE; CFN parameters are PascalCase.

## Dashboard (ui/)

- All JSON API calls go through `useApiFetch` (`ui/src/auth/useApiFetch.ts`);
  per-domain wrappers in `ui/src/api/*.ts` stay thin. The auth header is
  `Authorization: Bearer <token>` everywhere. Streaming/NDJSON and presigned
  S3 uploads are the only sanctioned raw `fetch` uses; throw the shared
  `ApiError` from them, not bare `Error`.
- Styling is Tailwind on the `@readysetcloud/ui` design system only — no CSS
  modules, styled-components, or inline style objects.
- Prefer extracting shared components/helpers over copy-pasting between
  routes; keep route components focused (roughly one screen per file, split
  sub-views out once a file passes ~400 lines).
- Don't define one-off formatters in route files; put shared money/date
  formatting in `ui/src/lib/` and import it.

## Testing conventions

Backend tests live in `api/__tests__/` named by layer: `route-*.test.mjs`,
`domain-*.test.mjs`, `validation-*.test.mjs`, service tests by module name.
Mock AWS at the client boundary (`DynamoDBDocumentClient.prototype.send`)
and external HTTP at the service module boundary. `action/` uses `node:test`
and is excluded from jest on purpose.

## Writing style for user-facing copy

Short declarative sentences. No em dashes. Avoid "not X, but Y"
constructions and call-to-action endings.
