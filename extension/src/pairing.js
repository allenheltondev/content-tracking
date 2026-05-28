// Pairing-token storage for the extension. The user generates a token
// on the dashboard's Settings → Extension page and pastes it into the
// popup. We store it in chrome.storage.local and send it as
// `Authorization: Bearer <token>` on every API call; the API's Lambda
// authorizer verifies the HMAC signature and checks revocation.

const PAIRING_KEY = "booked_pairing";

export async function getPairingToken() {
  const stored = await chrome.storage.local.get(PAIRING_KEY);
  return stored[PAIRING_KEY]?.token ?? null;
}

export async function isPaired() {
  return Boolean(await getPairingToken());
}

// Persists the pasted token plus a paired_at timestamp for display in
// the popup. Trims whitespace because copy/paste from a dialog often
// trails a newline.
export async function setPairingToken(rawToken) {
  const token = String(rawToken ?? "").trim();
  if (!token) {
    throw new Error("Pairing token is empty.");
  }
  // Minimal shape check — the authorizer is the real validator. This
  // just rejects obvious paste errors (URL, plain word, etc.) before
  // we burn an API call.
  if (token.split(".").length !== 3) {
    throw new Error("That doesn't look like a Booked pairing token.");
  }
  await chrome.storage.local.set({
    [PAIRING_KEY]: { token, paired_at: new Date().toISOString() },
  });
}

export async function clearPairing() {
  await chrome.storage.local.remove(PAIRING_KEY);
}

export async function getPairingMetadata() {
  const stored = await chrome.storage.local.get(PAIRING_KEY);
  const record = stored[PAIRING_KEY];
  if (!record) return null;
  return { paired_at: record.paired_at };
}
