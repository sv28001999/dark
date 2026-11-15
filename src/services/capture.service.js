import { setTimeout as sleep } from 'node:timers/promises';
import logger from '../config/logger.js';
import { EVENT_OUTCOME } from '../constants/status.js';
import * as polymarketService from './polymarket.service.js';

// Polymarket's "Bitcoin Up or Down - 5 minute" events start every 5 minutes, on multiples of
// 300 seconds. Each event's slug is "btc-updown-5m-<start time in Unix seconds>".
const WINDOW_SECONDS = 5 * 60;
const SLUG_PREFIX = 'btc-updown-5m-';
const PREVIOUS_EVENT_COUNT = 10;

// Polymarket resolves each event about 80 seconds after it ends, and the result shows up in its API
// up to ~160 seconds after the end. So just after a new event starts, the previous one has no result
// yet: keep re-checking until it has one, up to this limit.
const RESULT_WAIT_TIMEOUT_MS = 240_000;
const RESULT_POLL_INTERVAL_MS = 5_000;

// Gamma returns some list fields as JSON strings, e.g. outcomes: '["Up", "Down"]'.
function parseList(value) {
  if (Array.isArray(value)) return value;
  try {
    return JSON.parse(value);
  } catch {
    return [];
  }
}

/**
 * UP or DOWN once the market is resolved (the winning outcome's price becomes 1, the loser's 0),
 * PENDING while it is still waiting to be resolved, UNKNOWN if the event is missing or unclear.
 */
function outcomeOf(event) {
  const market = event?.markets?.[0];
  if (!market) return EVENT_OUTCOME.UNKNOWN;
  if (!market.closed) return EVENT_OUTCOME.PENDING;

  const outcomes = parseList(market.outcomes); // ["Up", "Down"]
  const prices = parseList(market.outcomePrices).map(Number); // [1, 0] = Up won, [0, 1] = Down won
  const winner = String(outcomes[prices.indexOf(1)] ?? '').toUpperCase();

  return winner === EVENT_OUTCOME.UP || winner === EVENT_OUTCOME.DOWN ? winner : EVENT_OUTCOME.UNKNOWN;
}

/** Looks up the outcome of each event, in one request. */
async function getOutcomes(eventTimes) {
  const events = await polymarketService.getEventsBySlugs(eventTimes.map((time) => SLUG_PREFIX + time));
  const eventsBySlug = new Map(events.map((event) => [event.slug, event]));

  return eventTimes.map((eventTime) => {
    const slug = SLUG_PREFIX + eventTime;
    return { eventTime, slug, outcome: outcomeOf(eventsBySlug.get(slug)) };
  });
}

/** Like getOutcomes, but re-checks PENDING events until they are resolved or the wait limit is reached. */
async function waitForOutcomes(eventTimes) {
  const results = await getOutcomes(eventTimes);
  const deadline = Date.now() + RESULT_WAIT_TIMEOUT_MS;
  let pending = results.filter((result) => result.outcome === EVENT_OUTCOME.PENDING);

  while (pending.length > 0 && Date.now() < deadline) {
    const slugs = pending.map((result) => result.slug).join(', ');
    logger.info(`Waiting for Polymarket to resolve ${slugs}`);
    await sleep(RESULT_POLL_INTERVAL_MS);

    try {
      // getOutcomes keeps the input order, so updates[i] belongs to pending[i].
      const updates = await getOutcomes(pending.map((result) => result.eventTime));
      updates.forEach((update, i) => Object.assign(pending[i], update));
    } catch (err) {
      // A temporary Polymarket error shouldn't fail the whole request; try again on the next round.
      logger.warn({ err }, 'Checking for event results failed, retrying');
    }
    pending = results.filter((result) => result.outcome === EVENT_OUTCOME.PENDING);
  }
  return results;
}

export async function getRecords() {
  return {};
}

/**
 * Gets Polymarket's current time and rounds it down to the start of the current 5-minute event
 * (e.g. 1794623420 → 1794623400, 1794623779 → 1794623700), then looks up the outcome of the
 * previous 10 BTC Up/Down events, newest first.
 *
 * Called in the first ~80 seconds of an event, the response waits until Polymarket has resolved
 * the previous event, so every outcome is UP or DOWN (PENDING only if that takes over 4 minutes).
 */
export async function startCapturing() {
  const serverTime = await polymarketService.getServerTime();
  const currentEventTime = Math.floor(serverTime / WINDOW_SECONDS) * WINDOW_SECONDS;

  // currentEventTime - 300, currentEventTime - 600, ...
  const eventTimes = Array.from(
    { length: PREVIOUS_EVENT_COUNT },
    (_, i) => currentEventTime - (i + 1) * WINDOW_SECONDS,
  );

  const previousResults = await waitForOutcomes(eventTimes);
  return { currentEventTime, previousResults };
}

export async function stopCapturing() {
  return {};
}
