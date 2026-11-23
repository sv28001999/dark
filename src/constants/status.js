export const RUN_STATUS = Object.freeze({
  RUNNING: 'running',
  SUCCEEDED: 'succeeded',
  FAILED: 'failed',
  TIMED_OUT: 'timed_out',
  CANCELLED: 'cancelled',
});

export const NOTIFICATION_STATUS = Object.freeze({
  // FCM accepted it for at least one target.
  SENT: 'sent',
  // FCM rejected it for every target, or there was no target (no registered devices).
  FAILED: 'failed',
  // Not sent because FIREBASE_SERVICE_ACCOUNT isn't set: only written to the server log.
  LOGGED: 'logged',
});

/** A trade on an event's DOWN side. */
export const TRADE_STATUS = Object.freeze({
  PLACING: 'placing', // live: saved, the order is being sent to Polymarket
  OPEN: 'open', // placed, waiting for the event's outcome
  WON: 'won', // the event ended DOWN
  LOST: 'lost', // the event ended UP
  UNKNOWN: 'unknown', // no clear outcome 15 minutes after the event ended
  UNFILLED: 'unfilled', // live: the order bought nothing (a limit order that never filled)
  CANCELLED: 'cancelled', // trading stopped before anything was bought
  FAILED: 'failed', // live: Polymarket rejected the order (another attempt may follow)
  UNCONFIRMED: 'unconfirmed', // live: sending the order failed in a way that leaves unclear whether it was placed
});

export const ORDER_TYPE = Object.freeze({
  MARKET: 'MARKET',
  LIMIT: 'LIMIT',
});

/** Result of a Polymarket Up/Down event. */
export const EVENT_OUTCOME = Object.freeze({
  UP: 'UP',
  DOWN: 'DOWN',
  // The event has ended but Polymarket hasn't resolved it yet (takes about 1–2 minutes).
  PENDING: 'PENDING',
  // The event wasn't found, or it has no clear winner.
  UNKNOWN: 'UNKNOWN',
});
