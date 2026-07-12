import { configureAuth } from '@readysetcloud/ui/auth';

interface RuntimeEnv {
  apiBaseUrl: string;
  awsRegion: string;
  userPoolClientId: string;
  // Lambda Function URL for streaming compose/ask. Optional — when unset the
  // UI falls back to the buffered REST endpoints.
  streamBaseUrl?: string;
}

function required(name: string): string {
  const value = import.meta.env[name];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(
      `Missing required env var ${name}. Copy ui/.env.example to .env.local and fill it in.`,
    );
  }
  return value;
}

function optional(name: string): string | undefined {
  const value = import.meta.env[name];
  return typeof value === 'string' && value.length > 0 ? value.replace(/\/$/, '') : undefined;
}

export const env: RuntimeEnv = {
  apiBaseUrl: required('VITE_API_BASE_URL').replace(/\/$/, ''),
  awsRegion: required('VITE_AWS_REGION'),
  userPoolClientId: required('VITE_USER_POOL_CLIENT_ID'),
  streamBaseUrl: optional('VITE_STREAM_BASE_URL'),
};

// Configure the shared Ready, Set, Cloud auth core. All apps sign into
// the same rsc-core Cognito user pool; each brings its own app client id.
// This app's client id comes from the CloudFormation `UserPoolClientId`
// output (see template.yaml's UserPoolClient resource). The core mirrors
// the `rsc:auth` session into a parent-domain cookie so sign-in is shared
// across *.readysetcloud.io surfaces (booked, newsletter, bootcamp).
configureAuth({
  region: env.awsRegion,
  clientId: env.userPoolClientId,
});
