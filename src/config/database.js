import { randomUUID } from 'node:crypto';
import firebase from './firebase.js';

// Ids start with the creation time in milliseconds, padded so they sort as text in creation order;
// the random suffix keeps them unique. "Newest first" lists rely on this ordering.
const newId = () => `${String(Date.now()).padStart(15, '0')}-${randomUUID().slice(0, 8)}`;

/**
 * Generic record storage used by the services, in the Firebase Realtime Database at
 * <collection>/<id>:
 *   newId(collection)                       → a new unique id, nothing written
 *   create(collection, data, id?)           → the saved record, with its id
 *   update(collection, id, changes)         → merges top-level fields
 *   findById(collection, id)                → the record, or null
 *   list(collection, { limit })             → the newest records first
 */
const database = {
  newId,

  async create(collection, data, id = newId()) {
    await firebase.put(`${collection}/${id}`, data);
    return { id, ...data };
  },

  async update(collection, id, changes) {
    await firebase.patch(`${collection}/${id}`, changes);
  },

  async findById(collection, id) {
    const record = await firebase.get(`${collection}/${id}`);
    return record ? { id, ...record } : null;
  },

  async list(collection, { limit }) {
    const records = await firebase.get(collection, { orderBy: '$key', limitToLast: limit });
    return Object.entries(records ?? {})
      .sort(([a], [b]) => (a < b ? 1 : -1))
      .map(([id, record]) => ({ id, ...record }));
  },
};

export default database;
