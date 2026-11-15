import { createHash } from 'node:crypto';
import database from '../config/database.js';
import firebase from '../config/firebase.js';

const DEVICES = 'devices'; // database collection: devices/<id> = { token, platform, updatedAt }

// The id comes from the token, so registering the same device again updates its record instead of adding one.
const deviceId = (token) => createHash('sha256').update(token).digest('hex').slice(0, 32);

/** Saves a device's push token (FCM registration token), so it receives the alerts sent to all devices. */
export function registerDevice({ token, platform }) {
  return database.create(DEVICES, { token, platform, updatedAt: new Date().toISOString() }, deviceId(token));
}

/** The push tokens of all registered devices. */
export async function listTokens() {
  const devices = await firebase.get(DEVICES);
  return Object.values(devices ?? {})
    .map((device) => device?.token)
    .filter(Boolean);
}

/** Removes the devices with these tokens, e.g. once FCM reports them unregistered (app uninstalled). */
export async function removeTokens(tokens) {
  if (tokens.length === 0) return;
  await firebase.patch(DEVICES, Object.fromEntries(tokens.map((token) => [deviceId(token), null])));
}
