import { randomUUID } from 'node:crypto';

// Records are kept in memory for now, so everything is lost when the server restarts.
// To store them in a database later, replace the functions below; the services only use these five.

const memory = new Map(); // collection -> Map(id -> record), in creation order

// Drops `undefined` values and makes a copy, so callers never share references with the store.
const clean = (data) => JSON.parse(JSON.stringify(data));

function records(collection) {
  if (!memory.has(collection)) memory.set(collection, new Map());
  return memory.get(collection);
}

/**
 * Storage used by the services:
 *   newId(collection)                       → a new unique id, nothing written
 *   create(collection, data, id?)           → the saved record, with its id
 *   update(collection, id, changes)         → merges top-level fields
 *   findById(collection, id)                → the record, or null
 *   list(collection, { limit })             → the newest records first
 */
const database = {
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

export default database;
