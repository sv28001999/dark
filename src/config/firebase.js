import ApiError from '../utils/ApiError.js';
import config from './index.js';

const REQUEST_TIMEOUT_MS = 10_000;

/**
 * Calls the Firebase Realtime Database REST API: <database url>/<path>.json
 * Query values are sent the way Firebase expects them: strings JSON-quoted (orderBy="$key"),
 * numbers and booleans as-is (limitToLast=20, shallow=true).
 * Throws a 503 ApiError if the database can't be reached or rejects the request.
 */
async function request(method, path, { query = {}, body } = {}) {
  const url = new URL(`${config.firebase.databaseUrl}/${path}.json`);
  for (const [key, value] of Object.entries(query)) {
    url.searchParams.set(key, typeof value === 'string' ? JSON.stringify(value) : String(value));
  }
  // Writes don't need the data echoed back.
  if (method !== 'GET') url.searchParams.set('print', 'silent');

  let response;
  try {
    response = await fetch(url, {
      method,
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    throw new ApiError(503, `Could not reach the Firebase database: ${err.message}`);
  }

  const text = await response.text();
  if (!response.ok) {
    let reason = text;
    try {
      reason = JSON.parse(text).error ?? text;
    } catch {
      // Not JSON: use the raw text.
    }
    throw new ApiError(503, `Firebase database error (HTTP ${response.status}): ${reason}`);
  }
  return text ? JSON.parse(text) : null;
}

const firebase = {
  /** Reads the data at `path` (null if nothing is there). */
  get: (path, query) => request('GET', path, { query }),
  /** Replaces the data at `path`. */
  put: (path, data) => request('PUT', path, { body: data }),
  /**
   * Updates only the given children of `path`. Keys can be deeper paths ("odd/123/outcome"),
   * and a null value deletes that child, so many records can be written or removed in one call.
   */
  patch: (path, data) => request('PATCH', path, { body: data }),
  /** Deletes the data at `path`. */
  delete: (path) => request('DELETE', path),
};

export default firebase;
