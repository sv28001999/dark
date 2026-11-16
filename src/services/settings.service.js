import firebase from '../config/firebase.js';

const SETTINGS = 'settings'; // Firebase: settings = { downStreakAlert, updatedAt }

/** Used for any setting that hasn't been saved yet. */
export const DEFAULT_SETTINGS = Object.freeze({
  // Notify all devices when the odd or even group has at least this many DOWN outcomes in a row.
  downStreakAlert: 2,
});

/** All settings: the saved values, with the defaults for any not saved yet. */
export async function getSettings() {
  return { ...DEFAULT_SETTINGS, ...(await firebase.get(SETTINGS)) };
}

/** Saves the given settings (the others are kept) and returns all of them. */
export async function updateSettings(changes) {
  await firebase.patch(SETTINGS, { ...changes, updatedAt: new Date().toISOString() });
  return getSettings();
}
