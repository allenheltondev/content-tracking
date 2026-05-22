# Deploy guide

End-to-end walkthrough for deploying content-tracking, locally and via
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
| `deploy.yml` | Push to `main`, `workflow_dispatch` | `sam build` + `sam deploy` to the `Staging` GitHub Environment via OIDC |
| `prod-deploy.yml` | Push of a tag matching `v*.*.*`, `workflow_dispatch` | Same, but targets the `Production` GitHub Environment |

Required GitHub Environments:

- `Staging`
- `Production`

Required environment-scoped secrets (set on each environment):

- `AWS_DEPLOY_ROLE_ARN` - the IAM role assumed via OIDC.
- `NEWSLETTER_MINT_API_KEY` - same value used in local dev.

Both deploy workflows resolve `NewsletterApiBaseUrl` and
`CampaignShortLinkBase` to the environment-specific SSM paths
(`/newsletter-service/staging/*` or `/newsletter-service/production/*`)
inline, so no parameter store writes are needed from this stack at
deploy time. The Cognito user pool ARN is always read from
`/readysetcloud/auth/user-pool-arn`.

After a deploy, both workflows write a job summary that includes the API
URL and DynamoDB table name. Failed deploys dump CloudFormation
diagnostics (recent stack events, latest change set) to the workflow log
to speed up triage.

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
artifact bucket), Lambda, API Gateway, DynamoDB, IAM (role creation),
SSM (read), and CloudWatch Logs permissions sufficient to manage the
stack.

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
