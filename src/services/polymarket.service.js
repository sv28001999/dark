import config from '../config/index.js';
import ApiError from '../utils/ApiError.js';

const REQUEST_TIMEOUT_MS = 10_000;

/** GETs a Polymarket URL and returns the response body as text. Throws a 502 if it fails. */
async function get(url) {
  let response;
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  } catch (err) {
    throw new ApiError(502, `Could not reach Polymarket (${url}): ${err.message}`);
  }

  if (!response.ok) {
    throw new ApiError(502, `Polymarket returned HTTP ${response.status} for ${url}`);
  }
  return response.text();
}

async function getJson(url) {
  const text = await get(url);
  try {
    return JSON.parse(text);
  } catch {
    throw new ApiError(502, `Unexpected (non-JSON) response from ${url}`);
  }
}

/** Current Polymarket server time, in Unix seconds (CLOB GET /time). */
export async function getServerTime() {
  const text = await get(`${config.polymarket.clobUrl}/time`);
  const serverTime = Number(text.trim());

  if (!Number.isInteger(serverTime) || serverTime <= 0) {
    throw new ApiError(502, `Unexpected response from Polymarket /time: ${text.slice(0, 100)}`);
  }
  return serverTime;
}

/**
 * Events with the given slugs, fetched in one request (Gamma GET /events?slug=a&slug=b...).
 * Slugs that don't exist are simply missing from the result.
 */
export async function getEventsBySlugs(slugs) {
  const url = new URL(`${config.polymarket.gammaUrl}/events`);
  for (const slug of slugs) url.searchParams.append('slug', slug);
  // Without an explicit limit Gamma returns at most 20 events.
  url.searchParams.set('limit', String(slugs.length));
  // Gamma is served through a CDN that caches each URL for up to 5 minutes, so a repeated request
  // could return an event as unresolved long after it was resolved. A unique parameter forces fresh data.
  url.searchParams.set('_', String(Date.now()));

  const events = await getJson(url.toString());
  if (!Array.isArray(events)) {
    throw new ApiError(502, 'Unexpected response from Polymarket /events: expected a list');
  }
  return events;
}
