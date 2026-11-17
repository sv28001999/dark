import database from '../config/database.js';
import firebase from '../config/firebase.js';
import logger from '../config/logger.js';
import { EVENT_OUTCOME, ORDER_TYPE, TRADE_STATUS } from '../constants/status.js';
import ApiError from '../utils/ApiError.js';
import retry from '../utils/retry.js';
import {
  getDownPrice,
  getOutcomes,
  groupOf,
  isFinal,
  SLUG_PREFIX,
  WINDOW_SECONDS,
  windowStart,
} from './btcEvent.service.js';
import * as polymarketService from './polymarket.service.js';

// SIMULATED trading: no order is sent to Polymarket. Each "buy" is saved as a trade in Firebase.
//
// Odd and even are traded separately, each on its own events (see groupOf). Every trade buys the DOWN side of
// an event, following STEPS: after a win (the event ended DOWN) the next trade is step 1, after a loss (UP) the
// next step. Each trade's outcome is checked 2 minutes after its event ends, and the order for the next trade is
// placed right then, on the group's first event that hasn't started yet. On start, the first order is placed
// right away the same way (the event in progress is skipped).

const GROUPS = ['odd', 'even'];
const SIDE = EVENT_OUTCOME.DOWN;
const TRADES = 'trades'; // database collection: trades/<id>
const STATE = 'trading'; // Firebase: trading/{odd|even} = each group's state, shown live in the mobile app

const TICK_MS = 5_000; // how often the trading loop runs
const RESULT_DELAY_SECONDS = 2 * 60; // check a trade's outcome 2 minutes after its event ends
const GIVE_UP_SECONDS = 15 * 60; // still no outcome 15 minutes after the end: UNKNOWN, the step is kept
const LATE_LIMIT_SECONDS = 60; // buy into an event at most 1 minute after it started; later, take the next one
const BUY_ATTEMPTS = 5; // a failed buy is retried up to 4 more times, then that event is skipped

/** The order for each step, all on the DOWN side. Losing the last step stops trading for the group. */
export const STEPS = Object.freeze([
  { amount: 1, orderType: ORDER_TYPE.MARKET },
  { amount: 1.5, orderType: ORDER_TYPE.MARKET },
  { amount: 2.94, orderType: ORDER_TYPE.LIMIT, price: 0.49, quantity: 6 },
  { amount: 6, orderType: ORDER_TYPE.LIMIT, price: 0.49, quantity: 12 },
  { amount: 12, orderType: ORDER_TYPE.LIMIT, price: 0.49, quantity: 24 },
  { amount: 24, orderType: ORDER_TYPE.LIMIT, price: 0.49, quantity: 48 },
  { amount: 48, orderType: ORDER_TYPE.LIMIT, price: 0.49, quantity: 96 },
  { amount: 96, orderType: ORDER_TYPE.LIMIT, price: 0.49, quantity: 192 },
  { amount: 192, orderType: ORDER_TYPE.LIMIT, price: 0.49, quantity: 384 },
  { amount: 384, orderType: ORDER_TYPE.LIMIT, price: 0.49, quantity: 768 },
]);

const newGroupState = () => ({
  active: false,
  step: 1, // step of the open trade, or of the next one
  nextEventTime: null, // event the next trade is for (null while a trade is open, or when stopped)
  openTrade: null, // { id, eventTime, step, ...order, epoch }: placed, waiting for its outcome
  lastResult: null, // { eventTime, step, outcome, result }
  lastError: null, // { at, message }: the last buy that failed every attempt; cleared by the next successful buy
  startedAt: null,
  stoppedAt: null,
  stoppedReason: null,
  run: 0, // which start this state belongs to: a buy started before a stop or restart must not count
});

// The loop runs in this process only: after a server restart, call start again.
const trading = {
  timer: null,
  busy: false, // a tick is in progress
  clockOffsetSeconds: 0, // Polymarket time minus this computer's time
  groups: { odd: newGroupState(), even: newGroupState() },
  runs: 0, // number of starts so far, for `run`
  // Trades waiting for their outcome, by id. A trade whose event is under way stays here after a stop, so its
  // result is still recorded.
  unresolved: new Map(),
};

const polymarketNow = () => Date.now() / 1000 + trading.clockOffsetSeconds;
const groupName = (group) => (group === 'odd' ? 'Odd' : 'Even');

/** The group's first event after the one in progress (which has already started, so it's skipped). */
function nextEventFor(group, now) {
  const next = windowStart(now) + WINDOW_SECONDS;
  return groupOf(next) === group ? next : next + WINDOW_SECONDS;
}

const stepOrder = (step) => (STEPS[step - 1] ? { step, ...STEPS[step - 1] } : null);

/** What the mobile app shows for a group. */
function publicState(group) {
  const state = trading.groups[group];
  return {
    group,
    active: state.active,
    // While trading: the open trade's order, or the next one's, and the order after a loss (null after the last
    // step). Null when stopped.
    current: state.active ? stepOrder(state.step) : null,
    ifLost: state.active ? stepOrder(state.step + 1) : null,
    nextEventTime: state.nextEventTime,
    openTrade: state.openTrade,
    lastResult: state.lastResult,
    lastError: state.lastError,
    startedAt: state.startedAt,
    stoppedAt: state.stoppedAt,
    stoppedReason: state.stoppedReason,
    updatedAt: new Date().toISOString(),
  };
}

const saveState = (group) => firebase.put(`${STATE}/${group}`, publicState(group));

function stopGroup(group, reason) {
  const state = trading.groups[group];
  if (state.active) {
    state.stoppedAt = new Date().toISOString();
    state.stoppedReason = reason;
  }
  state.active = false;
  state.nextEventTime = null;
}

/**
 * Cancels an open trade whose event hasn't started: nothing is bought. SIMULATED: only its record changes; with
 * real orders, this is where the order is cancelled.
 */
async function cancelTrade(id, reason) {
  trading.unresolved.delete(id);
  await retry(
    () =>
      database.update(TRADES, id, {
        status: TRADE_STATUS.CANCELLED,
        cancelledAt: new Date().toISOString(),
        cancelReason: reason,
      }),
    { attempts: BUY_ATTEMPTS, label: `Trading: cancel trade ${id}` },
  );
}

// ── Trading loop ───────────────────────────────────────────────────────────────────────────────

/**
 * Places one order on an event's DOWN side. SIMULATED: it's only saved as a trade. With real orders, make this
 * idempotent (e.g. a client order id), so a retry after a timeout can't buy twice.
 */
async function buy(group, eventTime, step, order, now) {
  // A market order fills at about the DOWN side's current price (null if Polymarket's price isn't available);
  // a limit order at its own price.
  const price =
    order.orderType === ORDER_TYPE.MARKET ? await getDownPrice(eventTime).catch(() => null) : order.price;

  return database.create(TRADES, {
    group,
    eventTime,
    slug: SLUG_PREFIX + eventTime,
    side: SIDE,
    orderType: order.orderType,
    amount: order.amount,
    price,
    ...(order.quantity && { quantity: order.quantity }),
    step,
    epoch: Math.floor(now), // when the trade was placed, Unix seconds
    placedAt: new Date().toISOString(),
    status: TRADE_STATUS.OPEN,
    simulated: true,
  });
}

/**
 * Buys the DOWN side of the group's next event, as soon as that event has been chosen (on start, and right after
 * the previous trade's outcome). A failed buy is retried up to BUY_ATTEMPTS times; if every attempt fails, that
 * event is skipped and the group's next event is bought instead, at the same step.
 */
async function placeNextOrder(group, now) {
  const state = trading.groups[group];
  if (!state.active || state.openTrade || state.nextEventTime === null) return;

  if (now > state.nextEventTime + LATE_LIMIT_SECONDS) {
    // e.g. the server was busy or asleep: don't buy into an event that's well under way
    logger.warn(`Trading: missed the ${group} event ${state.nextEventTime}, taking the next one`);
    state.nextEventTime = nextEventFor(group, now);
    await saveState(group);
    return;
  }

  const eventTime = state.nextEventTime;
  const { step, run } = state;
  const order = STEPS[step - 1];
  // False once the group is stopped or restarted while this buy is in progress (it can take a while with retries).
  const stillWanted = () => state.active && state.run === run && state.nextEventTime === eventTime;

  let trade;
  try {
    trade = await retry(() => (stillWanted() ? buy(group, eventTime, step, order, now) : null), {
      attempts: BUY_ATTEMPTS,
      label: `Trading: ${group} buy on ${eventTime}`,
    });
  } catch (err) {
    if (!stillWanted()) return;
    logger.error(
      { err },
      `Trading: ${group} buy on ${eventTime} failed ${BUY_ATTEMPTS} times, skipping that event`,
    );
    state.lastError = {
      at: new Date().toISOString(),
      message: `Couldn't buy on the ${eventTime} event: ${err.message}`,
    };
    state.nextEventTime = eventTime + 2 * WINDOW_SECONDS; // the group's next event
    await saveState(group);
    return;
  }

  if (!trade) return; // stopped before buying: nothing bought
  if (!stillWanted()) {
    // Stopped while the order was being placed: cancel it, the event hasn't started
    await cancelTrade(trade.id, 'Stopped while the order was being placed');
    logger.info(`Trading: ${group} stopped during a buy on ${eventTime}, cancelled it`);
    return;
  }

  state.openTrade = {
    id: trade.id,
    eventTime,
    step,
    orderType: order.orderType,
    amount: order.amount,
    price: trade.price,
    ...(order.quantity && { quantity: order.quantity }),
    epoch: trade.epoch,
  };
  state.nextEventTime = null;
  state.lastError = null;
  trading.unresolved.set(trade.id, { id: trade.id, group, eventTime });
  await saveState(group);
  logger.info(
    `Trading: ${group} step ${step}: bought DOWN $${order.amount} (${order.orderType}) on ${eventTime}`,
  );
}

/** Records a trade's result once its event's outcome is known, and moves its group to the next step. */
async function resolveTrade({ id, group, eventTime }, now) {
  if (now < eventTime + WINDOW_SECONDS + RESULT_DELAY_SECONDS) return;

  const [{ outcome }] = await getOutcomes([eventTime]);
  const gaveUp = now >= eventTime + WINDOW_SECONDS + GIVE_UP_SECONDS;
  if (!isFinal(outcome) && !gaveUp) return; // not resolved yet: try again on the next tick

  const finalOutcome = isFinal(outcome) ? outcome : EVENT_OUTCOME.UNKNOWN;
  const result =
    finalOutcome === SIDE
      ? TRADE_STATUS.WON
      : finalOutcome === EVENT_OUTCOME.UNKNOWN
        ? TRADE_STATUS.UNKNOWN
        : TRADE_STATUS.LOST;
  await database.update(TRADES, id, {
    status: result,
    outcome: finalOutcome,
    resolvedAt: new Date().toISOString(),
  });
  trading.unresolved.delete(id);
  logger.info(`Trading: ${group} trade on ${eventTime}: ${finalOutcome}, ${result}`);

  const state = trading.groups[group];
  if (state.openTrade?.id !== id) return; // a trade from before a restart of this group: only its record changes

  state.lastResult = { eventTime, step: state.openTrade.step, outcome: finalOutcome, result };
  state.openTrade = null;
  if (result === TRADE_STATUS.WON) state.step = 1;
  if (result === TRADE_STATUS.LOST) state.step += 1; // UNKNOWN: the same step again

  if (state.step > STEPS.length) {
    stopGroup(group, `Lost at the last step (${STEPS.length})`);
    state.step = 1;
    logger.warn(`Trading: ${group} lost at the last step, stopped`);
  } else if (state.active) {
    state.nextEventTime = nextEventFor(group, now);
  }
  await saveState(group);
}

function stopLoop() {
  if (trading.timer) clearInterval(trading.timer);
  trading.timer = null;
}

async function tick() {
  if (trading.busy) return; // the previous tick is still running (slow network)
  trading.busy = true;
  try {
    const now = polymarketNow();
    // Outcomes first, so a group whose trade just got its outcome places its next order in the same tick.
    // Whatever fails (after the Polymarket retries) is tried again on the next tick.
    for (const trade of [...trading.unresolved.values()]) {
      await resolveTrade(trade, now).catch((err) =>
        logger.warn({ err }, `Trading: could not check the outcome of the trade on ${trade.eventTime}`),
      );
    }
    for (const group of GROUPS) {
      await placeNextOrder(group, now).catch((err) =>
        logger.warn({ err }, `Trading: could not place the ${group} order, retrying`),
      );
    }
    const anyActive = GROUPS.some((group) => trading.groups[group].active);
    if (!anyActive && trading.unresolved.size === 0) stopLoop();
  } catch (err) {
    // Never let a tick reject: an unhandled rejection would stop the whole server.
    logger.error({ err }, 'Trading: tick failed');
  } finally {
    trading.busy = false;
  }
}

// ── Start / stop ───────────────────────────────────────────────────────────────────────────────

/**
 * Starts trading a group at step 1. The event in progress is skipped: the first trade is on the group's next
 * event. Throws a 409 if the group is already trading.
 */
export async function startTrading(group) {
  const state = trading.groups[group];
  if (state.active) throw ApiError.conflict(`${groupName(group)} trading is already running`);
  state.active = true; // claimed now, so a second start at the same moment is rejected

  let serverTime;
  try {
    serverTime = await polymarketService.getServerTime();
  } catch (err) {
    state.active = false;
    throw err;
  }
  trading.clockOffsetSeconds = serverTime - Date.now() / 1000;

  // A trade from an earlier run whose event is under way keeps being checked, but no longer moves this group's
  // steps.
  trading.runs += 1;
  Object.assign(state, newGroupState(), {
    active: true,
    nextEventTime: nextEventFor(group, serverTime),
    startedAt: new Date().toISOString(),
    run: trading.runs,
  });
  trading.timer ??= setInterval(tick, TICK_MS);
  await saveState(group);
  logger.info(`Trading: ${group} started, first trade on ${state.nextEventTime}`);
  return publicState(group);
}

/**
 * Stops trading a group: no new trades. An open trade whose event hasn't started is cancelled (nothing bought);
 * one whose event is under way stays open until its result is recorded.
 */
export async function stopTrading(group, reason = 'Stopped') {
  const state = trading.groups[group];
  stopGroup(group, reason);
  const open = state.openTrade;
  if (open && polymarketNow() < open.eventTime) {
    state.openTrade = null;
    await cancelTrade(open.id, reason);
    logger.info(`Trading: ${group} order on ${open.eventTime} cancelled`);
  }
  await saveState(group);
  logger.info(`Trading: ${group} stopped (${reason})`);
  return publicState(group);
}

/** Stops trading both groups. */
export async function stopAllTrading(reason = 'Stopped') {
  const [odd, even] = await Promise.all(GROUPS.map((group) => stopTrading(group, reason)));
  return { odd, even };
}

/** Each group's state, from this process. */
export function getStatus() {
  return { odd: publicState('odd'), even: publicState('even'), steps: STEPS };
}

/**
 * On server start: trading doesn't survive a restart, so groups that Firebase still shows as trading are marked
 * stopped. A trade they left open is handled like a stop: cancelled if its event hasn't started, otherwise its
 * result is still recorded.
 */
export async function markStoppedOnStartup() {
  const saved = (await firebase.get(STATE)) ?? {};
  const now = Date.now() / 1000;
  for (const group of GROUPS.filter((name) => saved[name]?.active || saved[name]?.openTrade)) {
    const { active, openTrade: open } = saved[group];
    if (open && now < open.eventTime) {
      await cancelTrade(open.id, 'Server restarted');
    } else if (open) {
      trading.unresolved.set(open.id, { id: open.id, group, eventTime: open.eventTime });
      trading.timer ??= setInterval(tick, TICK_MS);
    }
    await firebase.patch(`${STATE}/${group}`, {
      active: false,
      current: null,
      ifLost: null,
      nextEventTime: null,
      openTrade: null,
      ...(active && { stoppedAt: new Date().toISOString(), stoppedReason: 'Server restarted' }),
      updatedAt: new Date().toISOString(),
    });
    logger.info(
      `Trading: ${group} marked stopped after the restart${open ? `, open trade on ${open.eventTime} handled` : ''}`,
    );
  }
}
