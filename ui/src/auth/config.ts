import { Amplify } from 'aws-amplify';
import type { ResourcesConfig } from 'aws-amplify';

interface RuntimeEnv {
  apiBaseUrl: string;
  awsRegion: string;
  userPoolId: string;
  userPoolClientId: string;
}

function required(name: string): string {
  const value = import.meta.env[name];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(
      `Missing required env var ${name}. Copy dashboard-ui/.env.example to .env.local and fill it in.`,
    );
  }
  return value;
}

export const env: RuntimeEnv = {
  apiBaseUrl: required('VITE_API_BASE_URL').replace(/\/$/, ''),
  awsRegion: required('VITE_AWS_REGION'),
  userPoolId: required('VITE_USER_POOL_ID'),
  userPoolClientId: required('VITE_USER_POOL_CLIENT_ID'),
};

// Mirrors newsletter-service's Amplify config so the same `RSCUserPool`
// users have a consistent sign-in experience across both apps. We don't
// configure the API category here -- the dashboard's API client builds
// its own fetch wrapper that pulls the access token directly from the
// auth session.
// Amplify v6's ResourcesConfig types the Auth.Cognito field as an
// intersection of UserPool + IdentityPool configs, which forces
// identityPoolId even when you're only using a user pool. The
// `Pick` cast tells TS we're committing to the user-pool-only shape
// the runtime accepts.
const amplifyConfig = {
  Auth: {
    Cognito: {
      userPoolId: env.userPoolId,
      userPoolClientId: env.userPoolClientId,
      loginWith: { email: true },
      allowGuestAccess: false,
    },
  },
} as unknown as ResourcesConfig;

Amplify.configure(amplifyConfig);
