import { readFileSync } from 'node:fs';
import { cert, deleteApp, getApps, initializeApp } from 'firebase-admin/app';
import { getDatabase } from 'firebase-admin/database';
import config from './index.js';
import logger from './logger.js';

let databaseConnected = false;

function loadServiceAccount(filePath) {
  try {
    return JSON.parse(readFileSync(filePath, 'utf8'));
  } catch (err) {
    const hint =
      err.code === 'ENOENT'
        ? ' (download it from Firebase Console → Project settings → Service accounts)'
        : '';
    // The logger appends the cause's message, e.g. "ENOENT: no such file or directory".
    throw new Error(`Could not load Firebase service account from ${filePath}${hint}`, { cause: err });
  }
}

/**
 * Initializes the default Firebase app. Safe to call more than once.
 * After this, getDatabase() / getMessaging() from firebase-admin can be used anywhere.
 */
export function initFirebase() {
  if (getApps().length > 0) return;

  initializeApp({
    credential: cert(loadServiceAccount(config.firebase.serviceAccountPath)),
    databaseURL: config.firebase.databaseURL,
  });

  getDatabase()
    .ref('.info/connected')
    .on('value', (snapshot) => {
      const connected = snapshot.val() === true;
      if (connected === databaseConnected) return;
      databaseConnected = connected;
      if (connected) logger.info('Firebase Realtime Database connected');
      else logger.warn('Firebase Realtime Database disconnected');
    });
}

export function isDatabaseConnected() {
  return databaseConnected;
}

/** Resolves once the Realtime Database connection is up, or rejects after `timeoutMs`. */
export function waitForDatabaseConnection(timeoutMs = 10_000) {
  return new Promise((resolve, reject) => {
    const ref = getDatabase().ref('.info/connected');

    const timer = setTimeout(() => {
      ref.off('value', onValue);
      reject(new Error(`Could not connect to ${config.firebase.databaseURL} within ${timeoutMs}ms`));
    }, timeoutMs);

    function onValue(snapshot) {
      if (snapshot.val() !== true) return;
      clearTimeout(timer);
      ref.off('value', onValue);
      resolve();
    }

    ref.on('value', onValue);
  });
}

export async function closeFirebase() {
  await Promise.all(getApps().map((app) => deleteApp(app)));
}
