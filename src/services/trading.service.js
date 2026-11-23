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
// next step. Each trade's outcome is checked 2 minutes after its event ends, and the order for the next trade is
// placed right then, on the group's first event that hasn't started yet. On start, the first order is placed
// right away the same way (the event in progress is skipped).
//
// TRADING_MODE "simulated" (default): each buy is only saved as a trade in Firebase.
// TRADING_MODE "live": real orders on Polymarket with real money (polymarketTrading.service.js). A trade's
// result then depends on the shares its order actually bought, and winnings are redeemed automatically.

const LIVE = config.trading.isLive;
const GROUPS = ['odd', 'even'];
const SIDE = EVENT_OUTCOME.DOWN;
const TRADES = 'trades'; // database collection: trades/<id>
const STATE = 'trading'; // Firebase: trading/{odd|even} = each group's state, shown live in the mobile app

const TICK_MS = 5_000; // how often the trading loop runs
const RESULT_DELAY_SECONDS = 2 * 60; // check a trade's outcome 2 minutes after its event ends
const GIVE_UP_SECONDS = 15 * 60; // still no outcome 15 minutes after the end: UNKNOWN, the step is kept
const LATE_LIMIT_SECONDS = 60; // buy into an event at most 1 minute after it started; later, take the next one
const BUY_ATTEMPTS = 5; // a failed buy is retried up to 4 more times, then that event is skipped
const REDEEM_ATTEMPTS = 5; // redeeming winnings is tried 1, 2, 4 and 8 minutes after a failure, then left to you

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
  openTrade: null, // { id, eventTime, step, ...order, epoch, orderId? }: placed, waiting for its outcome
  lastResult: null, // { eventTime, step, outcome, result }
  lastError: null, // { at, message }: e.g. a buy that failed every attempt; cleared by the next successful buy
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

/** What the mobile app shows for a group. */
function publicState(group) {
  const state = trading.groups[group];
  return {
    group,
    mode: config.trading.mode,
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
  await updateTrade(trade.id, {
    status: TRADE_STATUS.CANCELLED,
    cancelledAt: new Date().toISOString(),
    cancelReason: reason,
  });
  return true;
}

// ── Trading loop ───────────────────────────────────────────────────────────────────────────────

/**
 * Places one order on an event's DOWN side and saves it as a trade. Simulated: only saved. Live: the trade is saved
 * first (status "placing"), so an order can never exist without a record, then the order is sent. A rejected order
 * is marked "failed" and throws, so it can be retried; one that may have been placed is marked "unconfirmed" and
 * throws UnconfirmedOrderError, which must not be retried.
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

  const trade = await database.create(TRADES, {
    ...record,
    price: order.price ?? null,
    status: TRADE_STATUS.PLACING,
  });
  let placed;
  try {
    placed = await polymarketTrading.placeOrder(eventTime, order);
  } catch (err) {
    const unconfirmed = err instanceof polymarketTrading.UnconfirmedOrderError;
    await updateTrade(trade.id, {
      status: unconfirmed ? TRADE_STATUS.UNCONFIRMED : TRADE_STATUS.FAILED,
      error: err.message,
    }).catch((updateErr) => logger.error({ err: updateErr }, `Trading: could not record the failed order`));
    throw err;
  }
  await updateTrade(trade.id, { ...placed, status: TRADE_STATUS.OPEN });
  return { ...trade, ...placed, status: TRADE_STATUS.OPEN };
}

/** Makes a placed trade the group's open trade, and checks its outcome when its event is over. */
function trackTrade(group, trade, step, order) {
  const state = trading.groups[group];
  state.openTrade = {
    id: trade.id,
    eventTime: trade.eventTime,
    step,
    orderType: order.orderType,
    amount: order.amount,
    price: trade.price ?? null,
    ...(order.quantity && { quantity: order.quantity }),
    epoch: trade.epoch,
    ...(trade.orderId && { orderId: trade.orderId }),
  };
  const { id, eventTime, orderId, conditionId } = trade;
  trading.unresolved.set(id, { id, group, eventTime, orderId, conditionId });
}

/**
 * Buys the DOWN side of the group's next event, as soon as that event has been chosen (on start, and right after
 * the previous trade's outcome). A failed buy is retried up to BUY_ATTEMPTS times; if every attempt fails, that
 * event is skipped and the group's next event is bought instead, at the same step. Live, an order that may or may
 * not have been placed is never retried: trading stops for the group, to be checked on polymarket.com.
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
    if (!cancelled) {
      trackTrade(group, trade, step, order);
      await saveState(group);
    }
    logger.info(
      `Trading: ${group} stopped during a buy on ${eventTime}, ${cancelled ? 'cancelled' : 'kept'} it`,
    );
    return;
  }

  trackTrade(group, trade, step, order);
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
  logger.info(`Trading: ${group} trade on ${eventTime}: ${finalOutcome}, ${result}`);

  const state = trading.groups[group];
  if (state.openTrade?.id !== id) return; // a trade from before a restart of this group: only its record changes

  state.lastResult = { eventTime, step: state.openTrade.step, outcome: finalOutcome, result };
  state.openTrade = null;
  if (result === TRADE_STATUS.WON) state.step = 1;
  if (result === TRADE_STATUS.LOST) state.step += 1; // UNKNOWN or UNFILLED: the same step again

  if (state.step > STEPS.length) {
    stopGroup(group, `Lost at the last step (${STEPS.length})`);
    state.step = 1;
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
    await updateTrade(item.id, { redeemedAt: new Date().toISOString(), redeemTx: transactionHash });
    logger.info(`Trading: redeemed the winnings of the ${item.group} trade on ${item.eventTime}`);
  } catch (err) {
    if (item.attempts < REDEEM_ATTEMPTS) {
      item.nextAttemptAt = now + 60 * 2 ** (item.attempts - 1);
      logger.warn({ err }, `Trading: redeeming the ${item.eventTime} winnings failed, retrying`);
      return;
    }
    trading.toRedeem.delete(item.id);
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

// ── Start / stop ───────────────────────────────────────────────────────────────────────────────

/**
 * Starts trading a group at step 1. The event in progress is skipped: the first trade is on the group's next
 * event. Live, first checks that Polymarket allows trading from here and that the account connects. Throws a 409
 * if the group is already trading.
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

  // A trade from an earlier run that bought something keeps being checked, but no longer moves this group's steps.
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
 * On server start: trading doesn't survive a restart, so groups that Firebase still shows as trading are marked
 * stopped. A trade they left open is handled like a stop: cancelled while still possible, otherwise its result is
 * still recorded.
 */
export async function markStoppedOnStartup() {
  const saved = (await firebase.get(STATE)) ?? {};
  const now = Date.now() / 1000;
  for (const group of GROUPS.filter((name) => saved[name]?.active || saved[name]?.openTrade)) {
    const { active, openTrade: open } = saved[group];
    const cancelled = open && canCancel(open, now) ? await cancelTrade(open, 'Server restarted') : false;
    if (open && !cancelled) {
      const { id, eventTime, orderId } = open;
      trading.unresolved.set(id, { id, group, eventTime, orderId });
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
