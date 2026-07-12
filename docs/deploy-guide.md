# Deploy guide

End-to-end walkthrough for deploying Booked, locally and via
GitHub Actions. Read this before your first deploy.

## Prerequisites

- AWS CLI v2 with a profile that can deploy to the target account.
- [AWS SAM CLI](https://docs.aws.amazon.com/serverless-application-model/latest/developerguide/install-sam-cli.html).
- Node.js 24 (`node --version` should report `v24.x`).
- An IAM identity (local profile or OIDC role) with permission to create
  IAM roles, Lambda functions, API Gateway, DynamoDB tables, and read
  SSM parameters under `/readysetcloud/*` and `/newsletter-service/*`.

## Cross-stack dependencies

This stack does not run standalone. The following SSM parameters must
exist in the target account and region (`us-east-1`) before the first
deploy. CloudFormation resolves them at deploy time, so a missing
parameter fails the change set, not a Lambda invocation.

| Parameter | Published by | Required for |
| --- | --- | --- |
| `/readysetcloud/auth/user-pool-arn` | `readysetcloud/rsc-core` | Cognito authorizer on every route |
| `/newsletter-service/staging/newsletter-api-base-url` | `readysetcloud/newsletter-service` | Staging mint and analytics calls |
| `/newsletter-service/staging/campaign-short-link-base` | `readysetcloud/newsletter-service` | Staging short-link host in API responses |
| `/newsletter-service/production/newsletter-api-base-url` | `readysetcloud/newsletter-service` | Production mint and analytics calls |
| `/newsletter-service/production/campaign-short-link-base` | `readysetcloud/newsletter-service` | Production short-link host in API responses |

Deploy `rsc-core` and `newsletter-service` to the same environment
first. Verify with:

```bash
aws ssm get-parameter --name /readysetcloud/auth/user-pool-arn --region us-east-1
aws ssm get-parameter --name /newsletter-service/staging/newsletter-api-base-url --region us-east-1
aws ssm get-parameter --name /newsletter-service/staging/campaign-short-link-base --region us-east-1
```

## Required deploy parameter (secret)

`NewsletterMintApiKey` is a CloudFormation parameter with `NoEcho: true`
and no default. It authenticates this stack's calls to
newsletter-service's mint endpoint, so the value must match what
newsletter-service was deployed with.

To mint a fresh key, call newsletter-service's admin endpoint that
issues campaign-link API keys (see that repo's deploy guide for the
exact URL and credentials). Then store the key:

- **Local dev:** add to `samconfig.local.toml` (gitignored). Never
  commit the key.
- **CI/CD:** add as a GitHub environment-scoped secret named
  `NEWSLETTER_MINT_API_KEY` on the `Staging` and `Production`
  environments.

The key has a minimum length of 20 characters and is rejected by
CloudFormation if shorter.

## Google credentials (configured at runtime, not at deploy)

The GA4 + Core Web Vitals integration powering
`GET /campaigns/{id}/web-analytics` is **not** configured via deploy
parameters. Credentials are entered in the dashboard's **Settings** page
(or `PUT /profile`) and stored by the app as SSM SecureStrings under
`/booked/{env}/*`:

| SSM parameter | Holds |
| --- | --- |
| `/booked/{env}/ga4/service-account` | The GA4 service-account JSON key |
| `/booked/{env}/crux/api-key` | A Google API key for the CrUX + PageSpeed Insights APIs |

The Lambda execution role grants `ssm:GetParameter`/`ssm:PutParameter` on
`/booked/{env}/*` plus `kms:Encrypt`/`kms:Decrypt` restricted (via the
`kms:ViaService` condition) to SSM, so it can read and write these
SecureStrings using the AWS-managed `aws/ssm` key. No deploy-time
parameter or KMS key creation is required.

To set them up: create a Google Cloud service account, download its JSON
key, grant it **Viewer** on the GA4 property, and create a Google API key
with the **CrUX API** and **PageSpeed Insights API** enabled. Paste both
into the Settings page.

## Local-dev deploy

The `[default]` profile in `samconfig.toml` targets staging via the
`sandbox` AWS profile.

1. Configure the AWS profile.

   ```bash
   aws configure --profile sandbox
   ```

2. Create `samconfig.local.toml` (gitignored) with the secret:

   ```toml
   version = 0.1

   [default.deploy.parameters]
   parameter_overrides = [
     "NewsletterMintApiKey=<paste-the-key-here>",
   ]
   ```

   SAM merges `samconfig.local.toml` on top of `samconfig.toml` when both
   exist.

3. Build and deploy.

   ```bash
   sam build
   sam deploy
   ```

   Alternatively, pass the parameter inline and skip the local file:

   ```bash
   sam deploy --parameter-overrides "NewsletterMintApiKey=<paste-the-key-here>"
   ```

The stack's API base URL is printed as `ContentTrackingApiBaseUrl` in
the deploy output and exposed as a stack output.

## CI/CD overview

GitHub Actions workflows in `.github/workflows/`:

| Workflow | Trigger | Purpose |
| --- | --- | --- |
| `ci.yml` | Pull requests and pushes to `main` | `npm ci` + `npm run lint` + `npm test` |
| `deploy.yml` | Push to `main`, pull requests targeting `main`, `workflow_dispatch` | `sam build` + `sam deploy` to the `Staging` GitHub Environment via OIDC. PRs deploy to the *same* Staging stack so the PR sidebar shows the deployed dashboard URL. |
| `prod-deploy.yml` | Push of a tag matching `v*.*.*`, `workflow_dispatch` | Same, but targets the `Production` GitHub Environment |

PR deploys and `main` deploys share the `deploy-staging` concurrency group, so they serialize — a PR push won't race with a main deploy already in flight. Staging is whatever was last pushed; in a solo workflow this is the trade for cheap preview deploys. If a second contributor joins, switch to per-PR stacks before the race condition bites.

Required GitHub Environments:

- `Staging`
- `Production`

Required environment-scoped secrets (set on each environment):

- `AWS_DEPLOY_ROLE_ARN` - the IAM role assumed via OIDC.
- `NEWSLETTER_MINT_API_KEY` - same value used in local dev.

Required environment-scoped variables (used to build the dashboard at
deploy time; these are not secrets):

- `USER_POOL_ID` - the shared `RSCUserPool` id (same one newsletter-service
  uses). Passed to SAM as the `UserPoolId` parameter. Booked no longer needs
  a `USER_POOL_CLIENT_ID` variable — the stack creates its own app client
  (`UserPoolClient`) on this shared pool and the deploy build reads its id
  from the `UserPoolClientId` stack output.

The Cognito user pool ARN itself is always read from
`/readysetcloud/auth/user-pool-arn`.

After SAM deploys, both workflows also build `ui/` with these
variables (the redirect URIs are derived from the `DashboardUrl` stack
output), sync the output to the `DashboardBucket`, and invalidate the
CloudFront distribution. The deploy summary lists both the API URL and
the dashboard URL.

Failed deploys dump CloudFormation diagnostics (recent stack events,
latest change set) to the workflow log to speed up triage.

## AWS OIDC role setup

The deploy workflows authenticate to AWS via GitHub's OIDC provider.
Each environment needs an IAM role whose trust policy allows
`token.actions.githubusercontent.com` and is scoped to this repository.

Staging trust policy condition:

```json
{
  "StringLike": {
    "token.actions.githubusercontent.com:sub": "repo:allenheltondev/content-tracking:*"
  }
}
```

Production trust policy condition (tag-only):

```json
{
  "StringLike": {
    "token.actions.githubusercontent.com:sub": "repo:allenheltondev/content-tracking:ref:refs/tags/v*"
  }
}
```

Attach a deploy policy that grants CloudFormation, S3 (for the SAM
artifact bucket **and** the dashboard bucket), Lambda, API Gateway,
DynamoDB, IAM (role creation), SSM (read), CloudFront (creating
distributions, response-headers policies, and origin access controls;
`cloudfront:CreateInvalidation` is required for post-deploy cache
busting), Route53 (when a custom domain is used), and CloudWatch Logs
permissions sufficient to manage the stack.

Store the role ARN as the `AWS_DEPLOY_ROLE_ARN` secret on the matching
GitHub Environment.

## Smoke-testing a fresh deploy

1. Open the workflow run summary on GitHub Actions. Copy the API URL.

2. Mint a Cognito access token for a user in the `RSCUserPool`. Any
   tool that exchanges username/password for an access token works (for
   example `aws cognito-idp initiate-auth`). The token must be the
   **access token**, not the ID token.

3. Hit `GET /campaigns/<id>` or one of the list endpoints. Expect HTTP
   401 if the token is missing or invalid, HTTP 200 (or 404) if it is
   accepted.

   ```bash
   curl -i \
     -H "Authorization: <access-token>" \
     "<API_URL>/campaigns/abc123"
   ```

A 401 response with no body means API Gateway rejected the token before
it reached the Lambda. Verify the token's `aud`/`client_id` matches a
client in `RSCUserPool` and that the token is unexpired.

## API custom domain (optional)

By default the REST API is served from the autogenerated
`https://<api-id>.execute-api.us-east-1.amazonaws.com/v1` hostname. To
attach a stable custom domain, set both CFN parameters:

| CFN parameter | Notes |
| --- | --- |
| `ApiCustomDomain` | The fully-qualified hostname (e.g. `api.booked.example.com`). |
| `ApiHostedZoneId` | The Route53 hosted zone id containing that hostname. |

The stack auto-provisions an ACM certificate via DNS validation
through that hosted zone — no separate cert-must-exist-first step. The
base-path mapping has no `BasePath`, so the custom-domain root maps
directly to the v1 stage. Callers use
`https://api.booked.example.com/campaigns` (no `/v1` prefix). The
`ContentTrackingApiBaseUrl` stack output and the dashboard's
`VITE_API_BASE_URL` automatically reflect the custom domain when it's
configured.

Both params must be set together. Setting just one is a no-op (the
combined `DeployApiCustomDomain` condition is false), not a deploy
error. Put the values in `samconfig.local.toml` (local dev) or pass
them via `--parameter-overrides` in the deploy workflow.

## Dashboard UI

`ui/` is a Vite + React app built on the shared `@readysetcloud/ui`
design system. It signs users into the shared `RSCUserPool` via
`@readysetcloud/ui/auth` and calls this stack's API with the resulting
id token. The same pool backs every Ready, Set, Cloud surface, so an
existing account (newsletter, bootcamp, etc.) signs in here with the
same credentials.

### Cognito App Client

No manual step. The stack creates its own public app client on the
shared pool — the `UserPoolClient` resource in `template.yaml`
(`ALLOW_USER_SRP_AUTH` + `ALLOW_USER_PASSWORD_AUTH`, no secret). Its id
is exported as the `UserPoolClientId` stack output, which the deploy
workflow injects into the build as `VITE_USER_POOL_CLIENT_ID`. Sign-in,
sign-up, email confirmation, and password reset are all handled inline
by the package's prebuilt auth forms.

### Local dev

```bash
cp ui/.env.example ui/.env.local
# fill in VITE_USER_POOL_CLIENT_ID and VITE_API_BASE_URL
# (VITE_USER_POOL_CLIENT_ID = the UserPoolClientId stack output for the
#  environment you're pointing at)
cd ui
npm install
npm run dev
```

Open <http://localhost:5173>. You'll land on `/signin`. Enter the same
email + password you use on any Ready, Set, Cloud surface. The session
lives in localStorage under the shared `rsc:auth` key; a fresh id token
is pulled on every API call and sent as the raw `Authorization` header
(not `Bearer X`, per the API's authorizer config).

### Required env vars

| Var | Example | Purpose |
| --- | --- | --- |
| `VITE_API_BASE_URL` | `https://api.booked.readysetcloud.io` | Base of the deployed API. |
| `VITE_AWS_REGION` | `us-east-1` | Region the user pool lives in. |
| `VITE_USER_POOL_CLIENT_ID` | `abcd1234efgh5678` | Booked's app client (the `UserPoolClientId` stack output). |

The required-env check throws at module load time, so missing vars fail
loudly during dev rather than at the first API call.

### Hosting

Static hosting is part of the SAM stack: a private S3 bucket and a
CloudFront distribution with Origin Access Control. SPA routing is
handled by rewriting 403/404 responses to `/index.html` so deep links
survive a refresh. Cache-Control is split during the sync step — hashed
assets get `max-age=31536000, immutable`; `index.html` gets `max-age=0,
must-revalidate` so users always see the latest manifest.

The CI deploy workflows build the dashboard, sync the output to the
bucket, and invalidate the distribution. The dashboard URL is part of
the deploy summary in the workflow run.

### Custom domain (optional)

Without these parameters the dashboard is served from the
CloudFront-issued `*.cloudfront.net` domain. To attach a custom domain,
set both:

| CFN parameter | Notes |
| --- | --- |
| `DashboardCustomDomain` | The fully-qualified hostname (e.g. `booked.example.com`). |
| `DashboardHostedZoneId` | The Route53 hosted zone id containing that hostname. |

The stack auto-provisions the ACM certificate via DNS validation
through that hosted zone. CloudFront requires the cert in `us-east-1`;
since the stack also lives in `us-east-1` this Just Works.

Both params must be set together. Setting just one is a no-op (the
combined `DeployDashboardCustomDomain` condition is false), not a
deploy error. Put the values in `samconfig.local.toml` (local dev) or
pass them via `--parameter-overrides` in the deploy workflow.
