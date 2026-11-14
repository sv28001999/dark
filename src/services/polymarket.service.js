import config from '../config/index.js';
import ApiError from '../utils/ApiError.js';

const REQUEST_TIMEOUT_MS = 10_000;

/** Calls a Polymarket CLOB endpoint and returns the raw response text. Throws a 502 if it fails. */
async function request(path) {
  const url = `${config.polymarket.clobUrl}${path}`;

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

/** Current Polymarket server time, in Unix seconds (GET /time). */
export async function getServerTime() {
  const text = await request('/time');
  const serverTime = Number(text.trim());

  if (!Number.isInteger(serverTime) || serverTime <= 0) {
    throw new ApiError(502, `Unexpected response from Polymarket /time: ${text.slice(0, 100)}`);
  }
  return serverTime;
}
