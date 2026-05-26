# Booked

Influencer analytics aggregator backend. Owns Campaign, Vendor, and Link
metadata plus revenue tracking. Delegates short-link minting and redirect
tracking to [`readysetcloud/newsletter-service`](https://github.com/readysetcloud/newsletter-service),
which captures clicks and publishes per-code analytics that this stack
consumes for campaign-level rollups.

## Architecture overview

- Single AWS SAM stack (`template.yaml`) deployed to one of two
  environments: `staging` or `production`.
- All routes are authenticated by the shared `RSCUserPool` Cognito user
  pool, published by the [`readysetcloud/rsc-core`](https://github.com/readysetcloud/rsc-core)
  stack. The pool ARN is resolved from SSM at deploy time
  (`/readysetcloud/auth/user-pool-arn`).
- DynamoDB single-table store (`pk` + `sk`) holds Campaigns, Links,
  Vendors, and the campaign-by-vendor index.
- API Gateway REST API defined by `publicapi.yaml`. Lambda integrations
  use the `aws_proxy` type and run Node.js 24 on arm64.
- Newsletter-service integration is pull-only: this stack reads
  newsletter-service's published SSM parameters to discover its API base
  URL and the short-link host, and calls newsletter-service's mint and
  analytics endpoints from inside its Lambdas.

Dashboard work is tracked separately.

## Resources created

The SAM stack provisions:

- 1 DynamoDB table (`ContentTrackingTable`) with point-in-time recovery
  enabled and on-demand billing.
- 1 API Gateway REST API (`ContentTrackingApi`) on stage `v1`.
- 13 Lambda functions:
  - `CreateCampaignFunction` (`POST /campaigns`)
  - `GetCampaignFunction` (`GET /campaigns/{campaignId}`)
  - `GetCampaignAnalyticsFunction` (`GET /campaigns/{campaignId}/analytics`)
  - `UpdateCampaignPayoutFunction` (`PATCH /campaigns/{campaignId}/payout`)
  - `CreateCampaignLinkFunction` (`POST /campaigns/{campaignId}/links`)
  - `GetCampaignLinkAnalyticsFunction` (`GET /campaigns/{campaignId}/links/{linkId}/analytics`)
  - `GetRevenueFunction` (`GET /revenue`)
  - `CreateVendorFunction` (`POST /vendors`)
  - `ListVendorsFunction` (`GET /vendors`)
  - `GetVendorFunction` (`GET /vendors/{vendorId}`)
  - `UpdateVendorFunction` (`PUT /vendors/{vendorId}`)
  - `DeleteVendorFunction` (`DELETE /vendors/{vendorId}`)
  - `ListVendorCampaignsFunction` (`GET /vendors/{vendorId}/campaigns`)

Stack outputs include `ContentTrackingApiBaseUrl` and
`ContentTrackingTableName` for downstream tooling.

## Quick start

```bash
npm install
npm test
sam build
sam deploy --guided
```

`sam deploy --guided` walks you through the first deploy and writes the
chosen values to `samconfig.toml`. The `NewsletterMintApiKey` parameter is
required and has no default. See [`docs/deploy-guide.md`](docs/deploy-guide.md)
for the full walkthrough, including cross-stack prerequisites and CI/CD.

## How it connects to newsletter-service

This stack consumes three published values from newsletter-service plus
one shared secret:

| Value | Source | Purpose |
| --- | --- | --- |
| `/newsletter-service/{env}/newsletter-api-base-url` | SSM (newsletter-service) | Base URL the Lambdas call for mint and per-link analytics. In production this resolves to `https://api.newsletter.readysetcloud.io`. |
| `/newsletter-service/{env}/campaign-short-link-base` | SSM (newsletter-service) | Public host for minted short links (for example `https://rdyset.click/c`). Surfaced in API responses. |
| `NEWSLETTER_MINT_API_KEY` | Deploy parameter (secret) | Authenticates calls to newsletter-service's mint endpoint. Must match the value newsletter-service was deployed with. |

`{env}` is `staging` or `production`. Both stacks must be deployed to
the same environment for the wiring to resolve.

## Auth

Every route requires an `Authorization` header containing a Cognito
access token issued by the `RSCUserPool` user pool. The pool ARN is
read from SSM (`/readysetcloud/auth/user-pool-arn`) at deploy time and
wired into API Gateway as a `cognito_user_pools` authorizer.

There is no anonymous access. There are no API keys.

## Deeper docs

- [`docs/deploy-guide.md`](docs/deploy-guide.md) - prerequisites,
  cross-stack SSM dependencies, local-dev deploy, CI/CD via GitHub
  Actions, OIDC role setup.
- [`docs/api-reference.md`](docs/api-reference.md) - every route, every
  schema, status codes and example payloads.
