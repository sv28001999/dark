import firebase from '../config/firebase.js';
import logger from '../config/logger.js';
import { EVENT_OUTCOME } from '../constants/status.js';
import * as notificationService from './notification.service.js';
import * as polymarketService from './polymarket.service.js';

// Polymarket's "Bitcoin Up or Down - 5 minute" events start every 5 minutes, on multiples of
// 300 seconds. Each event's slug is "btc-updown-5m-<start time in Unix seconds>".
const WINDOW_SECONDS = 5 * 60;
const SLUG_PREFIX = 'btc-updown-5m-';

// Firebase layout: btc-updown-5m/{odd|even}/<eventTime> = record. Consecutive events alternate between
// the groups: an event is "even" when its number in the 5-minute sequence (eventTime / 300) is even.
const ROOT = 'btc-updown-5m';
const GROUPS = ['odd', 'even'];

const KEEP_RECORDS = 40; // collected on start, and kept when old records are removed
const LIST_SIZE = 20; // records returned per group by getRecords

const TICK_MS = 5_000; // how often the capture loop runs
const OUTCOME_DELAY_SECONDS = 60; // start looking for an event's outcome 1 minute after it ends
const OUTCOME_GIVE_UP_SECONDS = 15 * 60; // store UNKNOWN if still unresolved 15 minutes after it ends
// Notify all devices when a group's DOWN streak reaches 3 ("more than 2"), and again on every DOWN after that.
const DOWN_STREAK_ALERT = 3;

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
async function getOutcomes(eventTimes) {
  const events = await polymarketService.getEventsBySlugs(eventTimes.map((time) => SLUG_PREFIX + time));
  const eventsBySlug = new Map(events.map((event) => [event.slug, event]));
  return eventTimes.map((eventTime) => ({
    eventTime,
    outcome: outcomeOf(eventsBySlug.get(SLUG_PREFIX + eventTime)),
  }));
}

const isFinal = (outcome) => outcome === EVENT_OUTCOME.UP || outcome === EVENT_OUTCOME.DOWN;
const windowStart = (time) => Math.floor(time / WINDOW_SECONDS) * WINDOW_SECONDS;
const groupOf = (eventTime) => ((eventTime / WINDOW_SECONDS) % 2 === 0 ? 'even' : 'odd');
const recordPath = (eventTime) => `${groupOf(eventTime)}/${eventTime}`; // relative to ROOT

function newRecord(eventTime, outcome) {
  return {
    eventTime,
    slug: SLUG_PREFIX + eventTime,
    group: groupOf(eventTime),
    outcome,
    updatedAt: new Date().toISOString(),
  };
}

// ── Firebase reads / cleanup ───────────────────────────────────────────────────────────────────

/** The records of one group, oldest first. `query` is passed to Firebase. */
async function readGroup(group, query) {
  const records = await firebase.get(`${ROOT}/${group}`, query);
  return Object.values(records ?? {})
    .filter(Boolean)
    .sort((a, b) => a.eventTime - b.eventTime);
}

/** All records (both groups) of events from `fromTime` onwards, as a Map of eventTime → record. */
async function readRecordsFrom(fromTime) {
  const groups = await Promise.all(
    GROUPS.map((group) => readGroup(group, { orderBy: '$key', startAt: String(fromTime) })),
  );
  return new Map(groups.flat().map((record) => [record.eventTime, record]));
}

/**
 * Deletes every record except the latest KEEP_RECORDS. Records of events from `currentEventTime`
 * onwards (the event in progress) are always kept. Returns how many were deleted.
 */
async function pruneRecords(currentEventTime) {
  const keysByGroup = await Promise.all(
    GROUPS.map((group) => firebase.get(`${ROOT}/${group}`, { shallow: true })),
  );
  const older = GROUPS.flatMap((group, i) =>
    Object.keys(keysByGroup[i] ?? {}).map((key) => ({ group, eventTime: Number(key) })),
  )
    .filter((record) => record.eventTime < currentEventTime)
    .sort((a, b) => b.eventTime - a.eventTime);

  const toDelete = older.slice(KEEP_RECORDS);
  if (toDelete.length > 0) {
    await firebase.patch(
      ROOT,
      Object.fromEntries(toDelete.map((record) => [`${record.group}/${record.eventTime}`, null])),
    );
  }
  return toDelete.length;
}

/** On server start: removes all records except the latest 40 (plus the event in progress). */
export async function pruneRecordsOnStartup() {
  const removed = await pruneRecords(windowStart(Date.now() / 1000));
  logger.info(`Capture: removed ${removed} old record(s) from Firebase, kept the latest ${KEEP_RECORDS}`);
}

// ── Capture loop ───────────────────────────────────────────────────────────────────────────────

// The loop runs in this process only: after a server restart, call start again.
const capture = {
  timer: null,
  clockOffsetSeconds: 0, // Polymarket time minus this computer's time
  latestEventTime: null, // newest event that has a record
  pending: new Set(), // events whose outcome still has to be collected
  busy: false, // a tick is in progress
  startedAt: null, // when the running loop was started (ISO string), null when stopped
  alerted: { odd: null, even: null }, // the last DOWN streak notified per group, so it isn't sent twice
};
let starting = null; // a start in progress, shared by concurrent start calls

const polymarketNow = () => Date.now() / 1000 + capture.clockOffsetSeconds;
const isCapturing = () => capture.timer !== null;

/** Creates a PENDING record for every event that started since the last one (normally just one). */
async function recordNewEvents(now) {
  const latest = windowStart(now);
  if (latest <= capture.latestEventTime) return;

  // After a long pause (e.g. the computer slept), only fill in the most recent events.
  const first = Math.max(
    capture.latestEventTime + WINDOW_SECONDS,
    latest - (KEEP_RECORDS - 1) * WINDOW_SECONDS,
  );
  const eventTimes = [];
  for (let time = first; time <= latest; time += WINDOW_SECONDS) eventTimes.push(time);

  await firebase.patch(
    ROOT,
    Object.fromEntries(eventTimes.map((time) => [recordPath(time), newRecord(time, EVENT_OUTCOME.PENDING)])),
  );
  for (const time of eventTimes) capture.pending.add(time);
  capture.latestEventTime = latest;
  logger.info(`Capture: event ${latest} started (${groupOf(latest)} group)`);
}

/** Saves the outcome of events that ended at least 1 minute ago. Unresolved ones are retried on later ticks. */
async function collectOutcomes(now) {
  const due = [...capture.pending].filter((time) => now >= time + WINDOW_SECONDS + OUTCOME_DELAY_SECONDS);
  if (due.length === 0) return;

  const updates = {};
  const saved = [];
  for (const { eventTime, outcome } of await getOutcomes(due)) {
    const gaveUp = now >= eventTime + WINDOW_SECONDS + OUTCOME_GIVE_UP_SECONDS;
    if (!isFinal(outcome) && !gaveUp) continue;

    const finalOutcome = isFinal(outcome) ? outcome : EVENT_OUTCOME.UNKNOWN;
    updates[`${recordPath(eventTime)}/outcome`] = finalOutcome;
    updates[`${recordPath(eventTime)}/updatedAt`] = new Date().toISOString();
    saved.push({ eventTime, outcome: finalOutcome });
  }
  if (saved.length === 0) return;

  await firebase.patch(ROOT, updates);
  for (const { eventTime, outcome } of saved) {
    capture.pending.delete(eventTime);
    logger.info(`Capture: event ${eventTime} (${groupOf(eventTime)}) outcome ${outcome}`);
  }
  await alertDownStreaks(new Set(saved.map(({ eventTime }) => groupOf(eventTime))));
}

/**
 * For each group that just got an outcome: if its latest outcomes are DOWN at least DOWN_STREAK_ALERT times
 * in a row, sends a push notification to all registered devices ("Odd: 3 DOWN in a row"). Failures are logged,
 * not thrown, so they never stop the capture loop.
 */
async function alertDownStreaks(groups) {
  for (const group of groups) {
    try {
      const records = completed(await readGroup(group, { orderBy: '$key', limitToLast: LIST_SIZE + 5 }));
      const count = streak(records, EVENT_OUTCOME.DOWN);
      const alert = `${records.at(-1)?.eventTime}:${count}`; // the same streak and length is only sent once
      if (count < DOWN_STREAK_ALERT || capture.alerted[group] === alert) continue;
      capture.alerted[group] = alert;

      const name = group === 'odd' ? 'Odd' : 'Even';
      await notificationService.sendToAllDevices(
        {
          title: `${name}: ${count} DOWN in a row`,
          body: `The last ${count} ${group} events ended DOWN.`,
          data: { type: 'down-streak', group, count: String(count) }, // FCM data values must be strings
        },
        { source: `capture:${group}` },
      );
      logger.info(`Capture: ${group} DOWN streak ${count}, notified all devices`);
    } catch (err) {
      logger.warn({ err }, `Capture: could not send the ${group} DOWN streak notification`);
    }
  }
}

async function tick() {
  if (capture.busy) return; // the previous tick is still running (slow network)
  capture.busy = true;
  try {
    const now = polymarketNow();
    await recordNewEvents(now);
    await collectOutcomes(now);
  } catch (err) {
    logger.warn({ err }, 'Capture tick failed, retrying on the next tick');
  } finally {
    capture.busy = false;
  }
}

function stopLoop() {
  if (capture.timer) clearInterval(capture.timer);
  capture.timer = null;
  capture.startedAt = null;
  capture.pending.clear();
}

async function start() {
  stopLoop();

  const serverTime = await polymarketService.getServerTime();
  capture.clockOffsetSeconds = serverTime - Date.now() / 1000;
  const currentEventTime = windowStart(serverTime);

  // 1. The previous 40 events and their outcomes, and what Firebase already has for them.
  const previousTimes = Array.from(
    { length: KEEP_RECORDS },
    (_, i) => currentEventTime - (i + 1) * WINDOW_SECONDS,
  );
  const [results, existing] = await Promise.all([
    getOutcomes(previousTimes),
    readRecordsFrom(previousTimes.at(-1)),
  ]);

  // 2. Save them (outcomes already stored are kept), plus a record for the event in progress.
  const updates = {};
  const pending = new Set([currentEventTime]);
  for (const { eventTime, outcome } of results) {
    if (isFinal(existing.get(eventTime)?.outcome)) continue;
    updates[recordPath(eventTime)] = newRecord(eventTime, outcome);
    if (!isFinal(outcome)) pending.add(eventTime); // the loop collects it once Polymarket has it
  }
  if (!existing.has(currentEventTime)) {
    updates[recordPath(currentEventTime)] = newRecord(currentEventTime, EVENT_OUTCOME.PENDING);
  }
  if (Object.keys(updates).length > 0) await firebase.patch(ROOT, updates);

  // 3. Remove everything older than those 40.
  const removedRecords = await pruneRecords(currentEventTime);

  // 4. Keep collecting until stop is called.
  capture.pending = pending;
  capture.latestEventTime = currentEventTime;
  capture.timer = setInterval(tick, TICK_MS);
  capture.startedAt = new Date().toISOString();
  logger.info(`Capture: started at event ${currentEventTime} (${groupOf(currentEventTime)} group)`);

  return {
    currentEventTime,
    capturing: true,
    savedRecords: Object.keys(updates).length,
    removedRecords,
  };
}

/**
 * Stores the previous 40 events in Firebase, removes older records, and starts a loop that records
 * every new event (alternately in the odd and even group) and its outcome 1 minute after it ends,
 * until stopCapturing is called. Calling it again restarts the process.
 */
export function startCapturing() {
  starting ??= start().finally(() => {
    starting = null;
  });
  return starting;
}

/** Stops the capture loop. Records already in Firebase are kept. */
export async function stopCapturing() {
  await starting?.catch(() => {}); // let a start in progress finish first, so it can't restart the loop
  const wasCapturing = isCapturing();
  stopLoop();
  if (wasCapturing) logger.info('Capture: stopped');
  return { capturing: false };
}

/**
 * Whether the capture loop is running, since when, and the newest event it has recorded (null before the first
 * start). Answered from memory, without calling Polymarket or Firebase, so it's cheap to poll.
 */
export function getStatus() {
  return {
    capturing: isCapturing(),
    startedAt: capture.startedAt,
    latestEventTime: capture.latestEventTime,
  };
}

/**
 * Deletes old odd and even records. In each group it keeps the latest 20 records that have an outcome
 * (UP/DOWN), plus any newer records still waiting for theirs (the event in progress, or one that just ended).
 */
export async function cleanupRecords() {
  const updates = {};
  const removedRecords = {};
  const keptRecords = {};

  for (const group of GROUPS) {
    const records = await readGroup(group);
    const completed = records.filter((record) => isFinal(record.outcome));
    // Everything older than the 20th-newest completed record goes.
    const cutoff = completed.length > LIST_SIZE ? completed.at(-LIST_SIZE).eventTime : -Infinity;
    const toDelete = records.filter((record) => record.eventTime < cutoff);

    for (const record of toDelete) {
      updates[`${group}/${record.eventTime}`] = null;
      capture.pending.delete(record.eventTime); // so the loop doesn't recreate it
    }
    removedRecords[group] = toDelete.length;
    keptRecords[group] = records.length - toDelete.length;
  }

  if (Object.keys(updates).length > 0) await firebase.patch(ROOT, updates);
  logger.info(`Capture: cleanup removed ${removedRecords.odd} odd and ${removedRecords.even} even record(s)`);
  return { removedRecords, keptRecords };
}

// ── Records ────────────────────────────────────────────────────────────────────────────────────

/** The latest 20 records with an outcome (UP or DOWN), oldest first, with the fields the API returns. */
function completed(records) {
  return records
    .filter((record) => isFinal(record.outcome))
    .slice(-LIST_SIZE)
    .map(({ eventTime, slug, outcome }) => ({ eventTime, slug, outcome }));
}

/** How many records in a row, counting back from the newest, have this outcome (0 if the newest doesn't). */
function streak(records, outcome) {
  let count = 0;
  for (let i = records.length - 1; i >= 0 && records[i].outcome === outcome; i -= 1) count += 1;
  return count;
}

/**
 * The latest 20 records with an outcome (UP or DOWN) of each group, oldest first, with how many
 * DOWN / UP outcomes in a row each group ends with, and the latest 20 outcomes overall.
 */
export async function getRecords() {
  const [serverTime, odd, even] = await Promise.all([
    polymarketService.getServerTime(),
    // A few extra: the newest records (event in progress, outcome not collected yet) have no outcome.
    ...GROUPS.map((group) => readGroup(group, { orderBy: '$key', limitToLast: LIST_SIZE + 5 })),
  ]);

  const oddRecords = completed(odd);
  const evenRecords = completed(even);
  const latest = [...oddRecords, ...evenRecords].sort((a, b) => a.eventTime - b.eventTime).slice(-LIST_SIZE);

  // Summary first, then the details.
  return {
    oddDownCount: streak(oddRecords, EVENT_OUTCOME.DOWN),
    oddUpCount: streak(oddRecords, EVENT_OUTCOME.UP),
    evenDownCount: streak(evenRecords, EVENT_OUTCOME.DOWN),
    evenUpCount: streak(evenRecords, EVENT_OUTCOME.UP),
    last20Outcomes: latest.map((record) => record.outcome),
    currentEventTime: windowStart(serverTime),
    capturing: isCapturing(),
    oddRecords,
    evenRecords,
  };
}
