import { randomUUID } from 'node:crypto';
import { getDatabase } from 'firebase-admin/database';
import ApiError from '../utils/ApiError.js';
import config from './index.js';

// The Realtime Database rejects `undefined` values; a JSON round-trip drops them (and copies the data).
const clean = (data) => JSON.parse(JSON.stringify(data));

// ── Firebase Realtime Database: records live at <collection>/<id> ──────────────────────────────

const OPERATION_TIMEOUT_MS = 10_000;

// While offline, Realtime Database operations wait for a connection instead of failing.
// Fail the request instead of letting it hang.
function withTimeout(promise) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new ApiError(503, 'Database is unavailable, try again later')),
      OPERATION_TIMEOUT_MS,
    );
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

const ref = (collection) => getDatabase().ref(collection);
const toRecord = (snapshot) => ({ id: snapshot.key, ...snapshot.val() });
const firebaseId = (collection) => ref(collection).push().key; // push keys sort by creation time

const firebaseStore = {
  newId: firebaseId,

  async create(collection, data, id = firebaseId(collection)) {
    await withTimeout(ref(collection).child(id).set(clean(data)));
    return { id, ...data };
  },

  async update(collection, id, changes) {
    await withTimeout(ref(collection).child(id).update(clean(changes)));
  },

  async findById(collection, id) {
    const snapshot = await withTimeout(ref(collection).child(id).once('value'));
    return snapshot.exists() ? toRecord(snapshot) : null;
  },

  async list(collection, { limit }) {
    const snapshot = await withTimeout(ref(collection).orderByKey().limitToLast(limit).once('value'));
    const records = [];
    snapshot.forEach((child) => {
      records.push(toRecord(child));
    });
    return records.reverse();
  },
};

// ── In memory, used when FIREBASE_ENABLED=false. Everything is lost on restart. ───────────────

const memory = new Map(); // collection -> Map(id -> record), in creation order

function records(collection) {
  if (!memory.has(collection)) memory.set(collection, new Map());
  return memory.get(collection);
}

const memoryStore = {
  newId: () => randomUUID(),

  async create(collection, data, id = randomUUID()) {
    records(collection).set(id, clean(data));
    return { id, ...data };
  },

  async update(collection, id, changes) {
    records(collection).set(id, { ...records(collection).get(id), ...clean(changes) });
  },

  async findById(collection, id) {
    const record = records(collection).get(id);
    return record ? { id, ...clean(record) } : null;
  },

  async list(collection, { limit }) {
    return [...records(collection)]
      .slice(-limit)
      .reverse()
      .map(([id, record]) => ({ id, ...clean(record) }));
  },
};

/**
 * Storage used by the services. Same functions either way:
 *   newId(collection)                       → a new unique id, nothing written
 *   create(collection, data, id?)           → the saved record, with its id
 *   update(collection, id, changes)         → merges top-level fields
 *   findById(collection, id)                → the record, or null
 *   list(collection, { limit })             → the newest records first
 */
const database = config.firebase.enabled ? firebaseStore : memoryStore;

export default database;
