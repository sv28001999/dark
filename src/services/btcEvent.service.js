import { EVENT_OUTCOME } from '../constants/status.js';
import * as polymarketService from './polymarket.service.js';

// Polymarket's "Bitcoin Up or Down - 5 minute" events start every 5 minutes, on multiples of
// 300 seconds. Each event's slug is "btc-updown-5m-<start time in Unix seconds>".
export const WINDOW_SECONDS = 5 * 60;
export const SLUG_PREFIX = 'btc-updown-5m-';

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

/** Looks up the outcome of each event on Polymarket, in one request. */
export async function getOutcomes(eventTimes) {
  const events = await polymarketService.getEventsBySlugs(eventTimes.map((time) => SLUG_PREFIX + time));
  const eventsBySlug = new Map(events.map((event) => [event.slug, event]));
  return eventTimes.map((eventTime) => ({
    eventTime,
    outcome: outcomeOf(eventsBySlug.get(SLUG_PREFIX + eventTime)),
  }));
}

/** The current price (0–1) of an event's DOWN side, or null if Polymarket doesn't list the event (yet). */
export async function getDownPrice(eventTime) {
  const [event] = await polymarketService.getEventsBySlugs([SLUG_PREFIX + eventTime]);
  const market = event?.markets?.[0];
  if (!market) return null;

  const outcomes = parseList(market.outcomes).map((outcome) => String(outcome).toUpperCase());
  const price = Number(parseList(market.outcomePrices)[outcomes.indexOf(EVENT_OUTCOME.DOWN)]);
  return Number.isFinite(price) ? price : null;
}

export const isFinal = (outcome) => outcome === EVENT_OUTCOME.UP || outcome === EVENT_OUTCOME.DOWN;

/** The start of the event in progress at `time` (Unix seconds). */
export const windowStart = (time) => Math.floor(time / WINDOW_SECONDS) * WINDOW_SECONDS;

// Consecutive events alternate between the groups: an event is "even" when its number in the 5-minute
// sequence (eventTime / 300) is even.
export const groupOf = (eventTime) => ((eventTime / WINDOW_SECONDS) % 2 === 0 ? 'even' : 'odd');
