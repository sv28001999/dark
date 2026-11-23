import { performance } from 'node:perf_hooks';
import config from '../config/index.js';
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
import * as polymarketTrading from './polymarketTrading.service.js';

// Odd and even are traded separately, each on its own events (see groupOf). Every trade buys the DOWN side of
// an event, following STEPS: after a win (the event ended DOWN) the next trade is step 1, after a loss (UP) the
// next step. Each trade's outcome is checked 1 minute after its event ends, and the order for the next trade is
// placed right then, on the group's first event that hasn't started yet.
//
// On start, the starting step comes from the group's latest results, as if it had been trading all along: after
// U, U, U (and a D before them) it starts at step 4. The event in progress is skipped, and the first order is
// placed as soon as that step is known.
//
// Trading survives a server restart: each group's state (step, open trade, next event) and the pending work
// (trades waiting for their result, winnings to redeem) are kept in Firebase, and the server continues from there
// when it starts, by the group's own trades (resumeOnStartup).
//
// TRADING_MODE "simulated" (default): each buy is only saved as a trade in Firebase.
// TRADING_MODE "live": real orders on Polymarket with real money (polymarketTrading.service.js). A trade's
// result then depends on the shares its order actually bought, and winnings are redeemed automatically.

const LIVE = config.trading.isLive;
const GROUPS = ['odd', 'even'];
const SIDE = EVENT_OUTCOME.DOWN;
const TRADES = 'trades'; // database collection: trades/<id>
const STATE = 'trading'; // Firebase: trading/{odd|even} = each group's state, shown live in the mobile app
const QUEUE = 'tradingQueue'; // Firebase: { unresolved, redeem }: pending work, kept for after a restart

const TICK_MS = 5_000; // how often the trading loop runs
const RESULT_DELAY_SECONDS = 60; // check a trade's outcome 1 minute after its event ends
const GIVE_UP_SECONDS = 15 * 60; // still no outcome 15 minutes after the end: UNKNOWN, the step is kept
const LATE_LIMIT_SECONDS = 60; // buy into an event at most 1 minute after it started; later, take the next one
const BUY_ATTEMPTS = 5; // a failed buy is retried up to 4 more times, then that event is skipped
const REDEEM_ATTEMPTS = 5; // redeeming winnings is tried 1, 2, 4 and 8 minutes after a failure, then left to you
const START_LOOKBACK = 12; // the group's latest results looked at to choose the starting step
const PAUSE_WAIT_MS = 8_000; // on shutdown, how long to let a tick in progress finish

/** The order for each step, all on the DOWN side. Losing the last step stops trading for the group. */
export const STEPS = Object.freeze([
  { amount: 1, orderType: ORDER_TYPE.MARKET },
  { amount: 1.5, orderType: ORDER_TYPE.MARKET },
  { amount: 2.94, orderType: ORDER_TYPE.LIMIT, price: 0.49, quantity: 6 },
  { amount: 6, orderType: ORDER_TYPE.LIMIT, price: 0.49, quantity: 12 },
  { amount: 12, orderType: ORDER_TYPE.LIMIT, price: 0.49, quantity: 24 },
  { amount: 24, orderType: ORDER_TYPE.LIMIT, price: 0.49, quantity: 48 },
  { amount: 48, orderType: ORDER_TYPE.LIMIT, price: 0.5, quantity: 96 },
  { amount: 96, orderType: ORDER_TYPE.LIMIT, price: 0.5, quantity: 192 },
  { amount: 192, orderType: ORDER_TYPE.LIMIT, price: 0.5, quantity: 384 },
  { amount: 384, orderType: ORDER_TYPE.LIMIT, price: 0.5, quantity: 768 },
]);

const newGroupState = () => ({
  active: false,
  step: null, // step of the open trade, or of the next one; null until the starting step is chosen
  nextEventTime: null, // event the next trade is for (null while a trade is open, or when stopped)
  openTrade: null, // { id, eventTime, step, ...order, epoch, orderId?, conditionId? }: waiting for its outcome
  placingTradeId: null, // live: the trade whose order is being sent right now
  lastResult: null, // { eventTime, step, outcome, result }
  lastError: null, // { at, message }: e.g. a buy that failed every attempt; cleared by the next successful buy
  startedFrom: null, // { step, upStreak }: how the starting step was chosen
  resumedAt: null, // when trading continued after a server restart
  startedAt: null,
  stoppedAt: null,
  stoppedReason: null,
  run: 0, // which start this state belongs to: a buy started before a stop or restart must not count
});

const trading = {
  timer: null,
  busy: false, // a tick is in progress
  clockOffsetSeconds: 0, // Polymarket time minus this computer's time
  groups: { odd: newGroupState(), even: newGroupState() },
  runs: 0, // number of starts so far, for `run`
  // Trades waiting for their outcome, by id: { id, group, eventTime, orderId?, conditionId? }. A trade that
  // bought something stays here after a stop, so its result is still recorded.
  unresolved: new Map(),
  // Live: won trades whose winnings are still to be redeemed, by id: { id, group, eventTime, conditionId, ... }
  toRedeem: new Map(),
};

const polymarketNow = () => Date.now() / 1000 + trading.clockOffsetSeconds;
const groupName = (group) => (group === 'odd' ? 'Odd' : 'Even');
const errorAt = (message) => ({ at: new Date().toISOString(), message });

/** The group's first event after the one in progress (which has already started, so it's skipped). */
function nextEventFor(group, now) {
  const next = windowStart(now) + WINDOW_SECONDS;
  return groupOf(next) === group ? next : next + WINDOW_SECONDS;
}

const stepOrder = (step) => (STEPS[step - 1] ? { step, ...STEPS[step - 1] } : null);

/** A group's state: what the mobile app shows, and what trading continues from after a restart. */
function publicState(group) {
  const state = trading.groups[group];
  return {
    group,
    mode: config.trading.mode,
    active: state.active,
    step: state.step,
    // While trading: the open trade's order, or the next one's, and the order after a loss (null after the last
    // step). Null when stopped, or while the starting step is being chosen.
    current: state.active && state.step ? stepOrder(state.step) : null,
    ifLost: state.active && state.step ? stepOrder(state.step + 1) : null,
    nextEventTime: state.nextEventTime,
    openTrade: state.openTrade,
    placingTradeId: state.placingTradeId,
    lastResult: state.lastResult,
    lastError: state.lastError,
    startedFrom: state.startedFrom,
    resumedAt: state.resumedAt,
    startedAt: state.startedAt,
    stoppedAt: state.stoppedAt,
    stoppedReason: state.stoppedReason,
    updatedAt: new Date().toISOString(),
  };
}

const saveState = (group) => firebase.put(`${STATE}/${group}`, publicState(group));

/** Saves the pending work (trades waiting for their result, winnings to redeem), for after a restart. */
const saveQueue = () =>
  firebase.put(QUEUE, {
    unresolved: Object.fromEntries(trading.unresolved),
    redeem: Object.fromEntries(trading.toRedeem),
  });

function stopGroup(group, reason) {
  const state = trading.groups[group];
  if (state.active) {
    state.stoppedAt = new Date().toISOString();
    state.stoppedReason = reason;
  }
  state.active = false;
  state.nextEventTime = null;
}

const updateTrade = (id, changes) =>
  retry(() => database.update(TRADES, id, changes), {
    attempts: BUY_ATTEMPTS,
    label: `Trading: update trade ${id}`,
  });

/**
 * Cancels an open trade's order. Resolves to true when the trade is cancelled because nothing was bought (always,
 * when simulated). Live, shares already bought (a market order, or a partly filled limit order) are a real
 * position: the rest of the order is cancelled, the trade stays open and its result is still recorded (false).
 */
async function cancelTrade(trade, reason) {
  if (LIVE && trade.orderId) {
    const filledShares = await retry(() => polymarketTrading.cancelOrder(trade.orderId), {
      attempts: BUY_ATTEMPTS,
      label: `Trading: cancel order ${trade.orderId}`,
    });
    if (filledShares > 0) {
      await updateTrade(trade.id, { filledShares, cancelReason: `${reason}: rest of the order cancelled` });
      return false;
    }
  }
  trading.unresolved.delete(trade.id);
  await saveQueue();
  await updateTrade(trade.id, {
    status: TRADE_STATUS.CANCELLED,
    cancelledAt: new Date().toISOString(),
    cancelReason: reason,
  });
  return true;
}

// ── Trading loop ───────────────────────────────────────────────────────────────────────────────

/**
 * The starting step for a group: one more than the number of UP results its latest events ended with, as if it
 * had been trading all along (U, U, U after a D → step 4), up to the last step. Events without a clear result are
 * skipped. Resolves to null while one of those events is still waiting for its result.
 */
async function chooseStartStep(group, now) {
  let newest = windowStart(now) - WINDOW_SECONDS; // the event that ended last
  if (groupOf(newest) !== group) newest -= WINDOW_SECONDS;
  const eventTimes = Array.from({ length: START_LOOKBACK }, (_, i) => newest - i * 2 * WINDOW_SECONDS);
  const results = await getOutcomes(eventTimes);

  const stillComing = ({ eventTime, outcome }) =>
    outcome === EVENT_OUTCOME.PENDING && now < eventTime + WINDOW_SECONDS + GIVE_UP_SECONDS;
  if (results.some(stillComing)) return null;

  let upStreak = 0;
  for (const { outcome } of results) {
    if (outcome === EVENT_OUTCOME.DOWN) break;
    if (outcome === EVENT_OUTCOME.UP) upStreak += 1;
  }
  return { upStreak, step: Math.min(upStreak + 1, STEPS.length) };
}

/**
 * Places one order on an event's DOWN side and saves it as a trade. Simulated: only saved. Live: the trade is saved
 * first (status "placing", and noted in the group's state), so an order can never exist without a record and a
 * restart during the send is noticed. Then the order is sent. A rejected order is marked "failed" and throws, so it
 * can be retried; one that may have been placed is marked "unconfirmed" and throws UnconfirmedOrderError, which
 * must not be retried.
 */
async function buy(group, eventTime, step, order, now) {
  const record = {
    group,
    eventTime,
    slug: SLUG_PREFIX + eventTime,
    side: SIDE,
    orderType: order.orderType,
    amount: order.amount,
    ...(order.quantity && { quantity: order.quantity }),
    step,
    epoch: Math.floor(now), // when the trade was placed, Unix seconds
    placedAt: new Date().toISOString(),
    simulated: !LIVE,
  };

  if (!LIVE) {
    // A market order fills at about the DOWN side's current price (null if unavailable); a limit order at its own.
    const price =
      order.orderType === ORDER_TYPE.MARKET ? await getDownPrice(eventTime).catch(() => null) : order.price;
    return database.create(TRADES, { ...record, price, status: TRADE_STATUS.OPEN });
  }

  const state = trading.groups[group];
  const trade = await database.create(TRADES, {
    ...record,
    price: order.price ?? null,
    status: TRADE_STATUS.PLACING,
  });
  state.placingTradeId = trade.id;
  await saveState(group);

  let placed;
  try {
    placed = await polymarketTrading.placeOrder(eventTime, order);
  } catch (err) {
    const unconfirmed = err instanceof polymarketTrading.UnconfirmedOrderError;
    await updateTrade(trade.id, {
      status: unconfirmed ? TRADE_STATUS.UNCONFIRMED : TRADE_STATUS.FAILED,
      error: err.message,
    }).catch((updateErr) => logger.error({ err: updateErr }, `Trading: could not record the failed order`));
    state.placingTradeId = null;
    throw err;
  }
  await updateTrade(trade.id, { ...placed, status: TRADE_STATUS.OPEN });
  state.placingTradeId = null; // the caller saves the state, with this trade as the open one
  return { ...trade, ...placed, status: TRADE_STATUS.OPEN };
}

/** Makes a placed trade the group's open trade, and checks its outcome when its event is over. */
async function trackTrade(group, trade, step, order) {
  const state = trading.groups[group];
  const { id, eventTime, orderId, conditionId } = trade;
  state.openTrade = {
    id,
    eventTime,
    step,
    orderType: order.orderType,
    amount: order.amount,
    price: trade.price ?? null,
    ...(order.quantity && { quantity: order.quantity }),
    epoch: trade.epoch,
    ...(orderId && { orderId }),
    ...(conditionId && { conditionId }),
  };
  trading.unresolved.set(id, { id, group, eventTime, orderId, conditionId });
  await saveQueue();
}

/**
 * Buys the DOWN side of the group's next event, as soon as that event has been chosen (on start, once the starting
 * step is known, and right after the previous trade's outcome). A failed buy is retried up to BUY_ATTEMPTS times;
 * if every attempt fails, that event is skipped and the group's next event is bought instead, at the same step.
 * Live, an order that may or may not have been placed is never retried: trading stops for the group, to be checked
 * on polymarket.com.
 */
async function placeNextOrder(group, now) {
  const state = trading.groups[group];
  if (!state.active || state.openTrade || state.nextEventTime === null) return;

  if (now > state.nextEventTime + LATE_LIMIT_SECONDS) {
    // e.g. the server was busy, asleep or restarting: don't buy into an event that's well under way
    logger.warn(`Trading: missed the ${group} event ${state.nextEventTime}, taking the next one`);
    state.nextEventTime = nextEventFor(group, now);
    await saveState(group);
    return;
  }

  if (state.step === null) {
    const { run } = state;
    const start = await chooseStartStep(group, now);
    if (!start || !state.active || state.run !== run) return; // waiting for the latest result, or stopped
    state.step = start.step;
    state.startedFrom = start;
    await saveState(group);
    logger.info(`Trading: ${group} starts at step ${start.step} (last ${start.upStreak} result(s) UP)`);
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
      shouldRetry: (err) => !(err instanceof polymarketTrading.UnconfirmedOrderError),
    });
  } catch (err) {
    if (err instanceof polymarketTrading.UnconfirmedOrderError) {
      logger.error({ err }, `Trading: ${group} order on ${eventTime} unconfirmed, stopping`);
      stopGroup(
        group,
        'An order may or may not have been placed: check polymarket.com before starting again',
      );
      state.lastError = errorAt(`Order on the ${eventTime} event unconfirmed: ${err.message}`);
      await saveState(group);
      return;
    }
    if (!stillWanted()) return;
    logger.error(
      { err },
      `Trading: ${group} buy on ${eventTime} failed ${BUY_ATTEMPTS} times, skipping that event`,
    );
    state.lastError = errorAt(`Couldn't buy on the ${eventTime} event: ${err.message}`);
    state.nextEventTime = eventTime + 2 * WINDOW_SECONDS; // the group's next event
    await saveState(group);
    return;
  }

  if (!trade) return; // stopped before buying: nothing bought
  if (!stillWanted()) {
    // Stopped while the order was being placed: cancel it. Live, shares it already bought are kept and tracked.
    const cancelled = await cancelTrade(trade, 'Stopped while the order was being placed');
    if (!cancelled) await trackTrade(group, trade, step, order);
    await saveState(group);
    logger.info(
      `Trading: ${group} stopped during a buy on ${eventTime}, ${cancelled ? 'cancelled' : 'kept'} it`,
    );
    return;
  }

  await trackTrade(group, trade, step, order);
  state.nextEventTime = null;
  state.lastError = null;
  await saveState(group);
  logger.info(
    `Trading: ${group} step ${step}: ${LIVE ? 'LIVE' : 'simulated'} buy DOWN $${order.amount} (${order.orderType}) on ${eventTime}`,
  );
}

/**
 * Records a trade's result once its event's outcome is known, and moves its group to the next step. Live, an order
 * that bought nothing is "unfilled" (the same step again), and the winnings of a won trade are queued for redeeming.
 */
async function resolveTrade({ id, group, eventTime, orderId, conditionId }, now) {
  if (now < eventTime + WINDOW_SECONDS + RESULT_DELAY_SECONDS) return;

  const [{ outcome }] = await getOutcomes([eventTime]);
  const gaveUp = now >= eventTime + WINDOW_SECONDS + GIVE_UP_SECONDS;
  if (!isFinal(outcome) && !gaveUp) return; // not resolved yet: try again on the next tick

  // Live: what the order actually bought (a limit order has expired by now, so this is final).
  const filledShares =
    LIVE && orderId
      ? await retry(() => polymarketTrading.getFilledShares(orderId), {
          attempts: BUY_ATTEMPTS,
          label: `Trading: fills of order ${orderId}`,
        })
      : null;

  const finalOutcome = isFinal(outcome) ? outcome : EVENT_OUTCOME.UNKNOWN;
  let result = TRADE_STATUS.LOST;
  if (filledShares === 0) result = TRADE_STATUS.UNFILLED;
  else if (finalOutcome === EVENT_OUTCOME.UNKNOWN) result = TRADE_STATUS.UNKNOWN;
  else if (finalOutcome === SIDE) result = TRADE_STATUS.WON;

  // The record, then the pending work, then the group: if the server stops in between, this runs again after the
  // restart and the steps still move only once.
  await updateTrade(id, {
    status: result,
    outcome: finalOutcome,
    resolvedAt: new Date().toISOString(),
    ...(filledShares !== null && { filledShares }),
  });
  trading.unresolved.delete(id);
  if (LIVE && result === TRADE_STATUS.WON) {
    trading.toRedeem.set(id, { id, group, eventTime, conditionId, attempts: 0, nextAttemptAt: now });
  }
  await saveQueue();
  logger.info(`Trading: ${group} trade on ${eventTime}: ${finalOutcome}, ${result}`);

  const state = trading.groups[group];
  if (state.openTrade?.id !== id) return; // a trade from an earlier start of this group: only its record changes

  state.lastResult = { eventTime, step: state.openTrade.step, outcome: finalOutcome, result };
  state.openTrade = null;
  if (result === TRADE_STATUS.WON) state.step = 1;
  if (result === TRADE_STATUS.LOST) state.step += 1; // UNKNOWN or UNFILLED: the same step again

  if (state.step > STEPS.length) {
    stopGroup(group, `Lost at the last step (${STEPS.length})`);
    state.step = null;
    logger.warn(`Trading: ${group} lost at the last step, stopped`);
  } else if (state.active) {
    state.nextEventTime = nextEventFor(group, now);
  }
  await saveState(group);
}

/**
 * Live: redeems a won trade's winning shares for USDC, so the money is available for the next trades. Tried again
 * 1, 2, 4 and 8 minutes after a failure (the market may not be settled on-chain yet), then left to be claimed on
 * polymarket.com, with an error shown in the app.
 */
async function redeemWinnings(item, now) {
  if (now < item.nextAttemptAt) return;
  item.attempts += 1;
  try {
    const transactionHash = await polymarketTrading.redeem(item.conditionId);
    trading.toRedeem.delete(item.id);
    await saveQueue();
    await updateTrade(item.id, { redeemedAt: new Date().toISOString(), redeemTx: transactionHash });
    logger.info(`Trading: redeemed the winnings of the ${item.group} trade on ${item.eventTime}`);
  } catch (err) {
    if (item.attempts < REDEEM_ATTEMPTS) {
      item.nextAttemptAt = now + 60 * 2 ** (item.attempts - 1);
      logger.warn({ err }, `Trading: redeeming the ${item.eventTime} winnings failed, retrying`);
      return;
    }
    trading.toRedeem.delete(item.id);
    await saveQueue();
    logger.error({ err }, `Trading: could not redeem the ${item.eventTime} winnings`);
    await updateTrade(item.id, { redeemError: err.message });
    trading.groups[item.group].lastError = errorAt(
      `Couldn't redeem the winnings of the ${item.eventTime} event (${err.message}): claim them on polymarket.com`,
    );
    await saveState(item.group);
  }
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
    for (const item of [...trading.toRedeem.values()]) {
      await redeemWinnings(item, now).catch((err) => logger.warn({ err }, 'Trading: redeem check failed'));
    }
    const anyActive = GROUPS.some((group) => trading.groups[group].active);
    if (!anyActive && trading.unresolved.size === 0 && trading.toRedeem.size === 0) stopLoop();
  } catch (err) {
    // Never let a tick reject: an unhandled rejection would stop the whole server.
    logger.error({ err }, 'Trading: tick failed');
  } finally {
    trading.busy = false;
  }
}

// ── Start / stop / restart ─────────────────────────────────────────────────────────────────────

/**
 * Starts trading a group. Its starting step comes from its latest results (see chooseStartStep), and its first
 * order is on its next event (the one in progress is skipped). Live, first checks that Polymarket allows trading
 * from here and that the account connects. Throws a 409 if the group is already trading.
 */
export async function startTrading(group) {
  const state = trading.groups[group];
  if (state.active) throw ApiError.conflict(`${groupName(group)} trading is already running`);
  state.active = true; // claimed now, so a second start at the same moment is rejected

  let serverTime;
  try {
    if (LIVE) await polymarketTrading.checkCanTrade();
    serverTime = await polymarketService.getServerTime();
  } catch (err) {
    state.active = false;
    throw err;
  }
  trading.clockOffsetSeconds = serverTime - Date.now() / 1000;

  // A trade from an earlier start that bought something keeps being checked, but no longer moves this group's
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
  logger.info(`Trading: ${group} started (${config.trading.mode}), first trade on ${state.nextEventTime}`);
  return publicState(group);
}

/** Whether stopping now can still cancel the open trade: before its event starts, or live until it ends. */
function canCancel(open, now) {
  return now < open.eventTime + (LIVE ? WINDOW_SECONDS : 0);
}

/**
 * Stops trading a group: no new orders. The open trade's order is cancelled while that's still possible; whatever
 * it already bought (live) stays open until its result is recorded.
 */
export async function stopTrading(group, reason = 'Stopped') {
  const state = trading.groups[group];
  stopGroup(group, reason);
  const open = state.openTrade;
  if (open && canCancel(open, polymarketNow())) {
    if (await cancelTrade(open, reason)) state.openTrade = null;
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
  return { mode: config.trading.mode, odd: publicState('odd'), even: publicState('even'), steps: STEPS };
}

/**
 * On server shutdown: pauses the trading loop without stopping trading, after letting a tick in progress finish
 * (for up to 8 seconds). Everything is already saved, so the next start continues from here.
 */
export async function pauseTrading() {
  stopLoop();
  const deadline = performance.now() + PAUSE_WAIT_MS;
  while (trading.busy && performance.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/**
 * Live, after a restart: the group's state says an order was being sent when the server stopped. If its trade was
 * recorded as placed, it's simply the open trade. If it's still "placing", it's unclear whether it reached
 * Polymarket: it's marked "unconfirmed" and the group stops, to be checked on polymarket.com.
 */
async function recoverPlacingOrder(group, tradeId) {
  const state = trading.groups[group];
  const trade = await database.findById(TRADES, tradeId);
  if (trade?.status === TRADE_STATUS.OPEN && trade.orderId) {
    await trackTrade(group, trade, trade.step, STEPS[trade.step - 1]);
    state.nextEventTime = null;
  } else if (trade?.status === TRADE_STATUS.PLACING) {
    await updateTrade(tradeId, {
      status: TRADE_STATUS.UNCONFIRMED,
      error: 'The server stopped while this order was being sent',
    });
    stopGroup(
      group,
      'The server stopped while an order was being sent: check polymarket.com before starting again',
    );
    state.lastError = errorAt(
      `Order on the ${trade.eventTime} event unconfirmed (server stopped while sending)`,
    );
  }
  // "failed" or "unconfirmed": already handled before the restart
}

/**
 * On server start: continues trading where it was. Each group that was trading goes on with its own step, open
 * trade and next event, as its previous trades decided (not recomputed from the latest results); if the open
 * trade's result or its next event passed while the server was down, the loop catches up on its first tick.
 * Trades waiting for their result and winnings to redeem are picked up again.
 */
export async function resumeOnStartup() {
  const [saved, queue] = await Promise.all([firebase.get(STATE), firebase.get(QUEUE)]);
  try {
    trading.clockOffsetSeconds = (await polymarketService.getServerTime()) - Date.now() / 1000;
  } catch (err) {
    logger.warn({ err }, "Trading: couldn't get Polymarket's time, using this computer's clock");
  }
  const now = polymarketNow();
  for (const item of Object.values(queue?.unresolved ?? {})) trading.unresolved.set(item.id, item);
  for (const item of Object.values(queue?.redeem ?? {})) {
    trading.toRedeem.set(item.id, { ...item, nextAttemptAt: now });
  }

  for (const group of GROUPS.filter((name) => saved?.[name])) {
    const previous = saved[group];
    const state = trading.groups[group];
    Object.assign(state, newGroupState());
    for (const key of Object.keys(state)) if (previous[key] !== undefined) state[key] = previous[key];
    state.placingTradeId = null;

    const open = state.openTrade;
    if (open && !trading.unresolved.has(open.id)) {
      trading.unresolved.set(open.id, {
        id: open.id,
        group,
        eventTime: open.eventTime,
        orderId: open.orderId,
        conditionId: open.conditionId,
      });
    }
    if (previous.placingTradeId) await recoverPlacingOrder(group, previous.placingTradeId);
    if (state.active) {
      trading.runs += 1;
      state.run = trading.runs;
      state.resumedAt = new Date().toISOString();
      logger.info(
        `Trading: ${group} continues after the restart at step ${state.step ?? '(being chosen)'}` +
          (state.openTrade ? `, open trade on ${state.openTrade.eventTime}` : ''),
      );
    }
    await saveState(group);
  }
  await saveQueue();

  const anyActive = GROUPS.some((group) => trading.groups[group].active);
  if (anyActive || trading.unresolved.size > 0 || trading.toRedeem.size > 0) {
    trading.timer ??= setInterval(tick, TICK_MS);
  }
}
