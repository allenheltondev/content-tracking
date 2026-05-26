import type { AuthProviderProps } from 'react-oidc-context';
import { WebStorageStateStore } from 'oidc-client-ts';

interface RuntimeEnv {
  apiBaseUrl: string;
  cognitoAuthority: string;
  cognitoHostedUiDomain: string;
  cognitoClientId: string;
  cognitoRedirectUri: string;
  cognitoPostLogoutUri: string;
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
  cognitoAuthority: required('VITE_COGNITO_AUTHORITY'),
  cognitoHostedUiDomain: required('VITE_COGNITO_HOSTED_UI_DOMAIN'),
  cognitoClientId: required('VITE_COGNITO_CLIENT_ID'),
  cognitoRedirectUri: required('VITE_COGNITO_REDIRECT_URI'),
  cognitoPostLogoutUri: required('VITE_COGNITO_POST_LOGOUT_URI'),
};

// Removes the `?code=...&state=...` Cognito appends after sign-in so the
// browser URL stays clean. Without this every refresh tries to re-process
// the same authorization code and the library throws.
function stripAuthCodeFromUrl(): void {
  window.history.replaceState({}, document.title, window.location.pathname);
}

export const oidcConfig: AuthProviderProps = {
  authority: env.cognitoAuthority,
  client_id: env.cognitoClientId,
  redirect_uri: env.cognitoRedirectUri,
  post_logout_redirect_uri: env.cognitoPostLogoutUri,
  response_type: 'code',
  scope: 'openid email',
  // PKCE flow is automatic with response_type=code in oidc-client-ts.
  // localStorage so the user stays signed in across tabs and refreshes.
  userStore: new WebStorageStateStore({ store: window.localStorage }),
  onSigninCallback: stripAuthCodeFromUrl,
};

// Cognito's logout endpoint isn't OIDC-discoverable, so the library can't
// build it from authority metadata. We construct it here per AWS docs:
// https://docs.aws.amazon.com/cognito/latest/developerguide/logout-endpoint.html
export function buildCognitoLogoutUrl(): string {
  const params = new URLSearchParams({
    client_id: env.cognitoClientId,
    logout_uri: env.cognitoPostLogoutUri,
  });
  return `https://${env.cognitoHostedUiDomain}/logout?${params.toString()}`;
}
