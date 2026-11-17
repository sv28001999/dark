import config from '../config/index.js';
import ApiError from '../utils/ApiError.js';
import retry from '../utils/retry.js';

const REQUEST_TIMEOUT_MS = 10_000;
const ATTEMPTS = 5; // a failed request is retried up to 4 more times

/** A 502 ApiError; `retryable` when trying again may help (network error, timeout, overload, rate limit). */
function polymarketError(message, retryable) {
  const error = new ApiError(502, message);
  error.retryable = retryable;
  return error;
}

/** One GET of a Polymarket URL, returning the response body as text. */
async function getOnce(url) {
  let response;
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  } catch (err) {
    throw polymarketError(`Could not reach Polymarket (${url}): ${err.message}`, true);
  }

  if (!response.ok) {
    await response.text().catch(() => {}); // read the body anyway, so the connection is released
    const retryable = response.status >= 500 || response.status === 429;
    throw polymarketError(`Polymarket returned HTTP ${response.status} for ${url}`, retryable);
  }
  try {
    return await response.text();
  } catch (err) {
    throw polymarketError(`Polymarket's response was cut off (${url}): ${err.message}`, true);
  }
}

/** GETs a Polymarket URL and returns the body as text, retrying failures that may pass. Throws a 502 if it fails. */
function get(url) {
  return retry(() => getOnce(url), {
    attempts: ATTEMPTS,
    label: `Polymarket ${new URL(url).pathname}`,
    shouldRetry: (err) => err.retryable,
  });
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
