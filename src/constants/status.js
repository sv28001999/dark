export const RUN_STATUS = Object.freeze({
  RUNNING: 'running',
  SUCCEEDED: 'succeeded',
  FAILED: 'failed',
  TIMED_OUT: 'timed_out',
  CANCELLED: 'cancelled',
});

export const NOTIFICATION_STATUS = Object.freeze({
  // Sending is not implemented yet: the notification was only written to the server log.
  LOGGED: 'logged',
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
