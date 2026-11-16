import firebase from '../config/firebase.js';

const SETTINGS = 'settings'; // Firebase: settings = { upStreakAlert, updatedAt }

/** Used for any setting that hasn't been saved yet. */
export const DEFAULT_SETTINGS = Object.freeze({
  // Notify all devices when the odd or even group has at least this many UP outcomes in a row.
  upStreakAlert: 2,
});

/**
 * All settings: the saved values, with the defaults for any not saved yet. Only known settings are returned, so a
 * setting that no longer exists but is still in Firebase (e.g. the old downStreakAlert) is ignored.
 */
export async function getSettings() {
  const saved = (await firebase.get(SETTINGS)) ?? {};
  const settings = Object.fromEntries(
    Object.entries(DEFAULT_SETTINGS).map(([key, value]) => [key, saved[key] ?? value]),
  );
  return saved.updatedAt ? { ...settings, updatedAt: saved.updatedAt } : settings;
}

/** Saves the given settings (the others are kept) and returns all of them. */
export async function updateSettings(changes) {
  await firebase.patch(SETTINGS, { ...changes, updatedAt: new Date().toISOString() });
  return getSettings();
}
