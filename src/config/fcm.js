import { JWT } from 'google-auth-library';
import config from './index.js';

const REQUEST_TIMEOUT_MS = 10_000;

const { serviceAccount } = config.firebase;

// Signs in as the service account; google-auth-library caches the access token and renews it before it expires.
const auth = serviceAccount
  ? new JWT({
      email: serviceAccount.clientEmail,
      key: serviceAccount.privateKey,
      scopes: ['https://www.googleapis.com/auth/firebase.messaging'],
    })
  : null;

/**
 * Sends one message through the FCM HTTP v1 API. `message` is an FCM message: `token` or `topic`, plus
 * `notification`, `data`, `android` (https://firebase.google.com/docs/reference/fcm/rest/v1/projects.messages).
 * Never throws, so one failing target doesn't stop the others: resolves to { ok: true } or
 * { ok: false, errorCode, error }, where errorCode is FCM's (e.g. UNREGISTERED: the app was uninstalled).
 */
async function send(message) {
  let response;
  try {
    const { token: accessToken } = await auth.getAccessToken();
    response = await fetch(
      `https://fcm.googleapis.com/v1/projects/${serviceAccount.projectId}/messages:send`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ message }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      },
    );
  } catch (err) {
    return { ok: false, error: `Could not reach FCM: ${err.message}` };
  }

  if (response.ok) return { ok: true };
  const body = await response.json().catch(() => null);
  return {
    ok: false,
    errorCode: body?.error?.details?.find((detail) => detail.errorCode)?.errorCode ?? body?.error?.status,
    error: body?.error?.message ?? `FCM returned HTTP ${response.status}`,
  };
}

const fcm = {
  /** False when FIREBASE_SERVICE_ACCOUNT isn't set. */
  isConfigured: auth !== null,
  send,
};

export default fcm;
