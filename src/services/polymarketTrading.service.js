import { createSecureClient, OrderSide, OrderType, relayerApiKey } from '@polymarket/client';
import { privateKey } from '@polymarket/client/viem';
import config from '../config/index.js';
import logger from '../config/logger.js';
import { ORDER_TYPE } from '../constants/status.js';
import ApiError from '../utils/ApiError.js';
import { SLUG_PREFIX, WINDOW_SECONDS } from './btcEvent.service.js';

// LIVE trading: real orders on Polymarket with real money, through the account in config.trading.account.

const GEOBLOCK_URL = 'https://polymarket.com/api/geoblock';
const REQUEST_TIMEOUT_MS = 10_000;

// SDK errors raised before an order could reach the matching engine, or by the venue rejecting it: retrying
// such an order can't buy twice. Any other failure (a lost connection, a timeout) leaves unclear whether it was
// placed, so it's never retried.
const NOT_PLACED_ERRORS = new Set([
  'UserInputError',
  'SigningError',
  'RateLimitError',
  'RequestRejectedError',
]);

/** Thrown when an order may or may not have been placed: it must not be sent again. */
export class UnconfirmedOrderError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = 'UnconfirmedOrderError';
  }
}

let clientPromise = null;

async function connect() {
  const { privateKey: key, wallet, relayer } = config.trading.account;
  // Derives (or creates) the CLOB API credentials by signing with the private key.
  const client = await createSecureClient({
    signer: privateKey(key.startsWith('0x') ? key : `0x${key}`),
    wallet,
    ...(relayer && { apiKey: relayerApiKey(relayer) }),
  });
  logger.info(
    { wallet: client.account.wallet, walletType: client.account.walletType },
    'Polymarket: connected for live trading',
  );
  return client;
}

/** The authenticated Polymarket client, connected on first use. */
function getClient() {
  clientPromise ??= connect().catch((err) => {
    clientPromise = null; // try again next time
    throw new ApiError(502, `Could not connect to Polymarket: ${err.message}`);
  });
  return clientPromise;
}

/** Replaces the Polymarket client, for tests. */
export function setClientForTests(client) {
  clientPromise = Promise.resolve(client);
}

/**
 * Throws if live trading can't work from here: Polymarket blocks this server's location, or the account can't
 * connect. Called before live trading starts.
 */
export async function checkCanTrade() {
  let geoblock = null;
  try {
    const response = await fetch(GEOBLOCK_URL, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    geoblock = response.ok ? await response.json() : null;
  } catch (err) {
    logger.warn({ err }, 'Polymarket: could not check the location block, continuing');
  }
  if (geoblock?.blocked) {
    const where = [geoblock.country, geoblock.region].filter(Boolean).join('/');
    throw new ApiError(403, `Polymarket blocks trading from this server's location (${where})`);
  }
  await getClient();
}

/** The DOWN side of an event's market: its asset ID for orders, and the condition ID for redeeming. */
async function downSide(client, eventTime) {
  const market = await client.fetchMarket({ slug: SLUG_PREFIX + eventTime });
  const down = market.outcomes.no;
  if (String(down.label).toUpperCase() !== 'DOWN') {
    throw new Error(`Unexpected outcomes on ${market.slug}: "${down.label}" instead of "Down"`);
  }
  if (!market.state.acceptingOrders) throw new Error(`The ${eventTime} market isn't accepting orders`);
  return {
    assetId: market.version === 'v2' ? down.positionId : down.tokenId,
    conditionId: market.conditionId,
  };
}

/**
 * Buys an event's DOWN side with one step's order. A market order is fill-or-kill for the step's USD amount
 * (before fees). A limit order rests on the book until its event ends, then expires. Resolves to what to save
 * with the trade. Throws UnconfirmedOrderError when it's unclear whether the order was placed.
 */
export async function placeOrder(eventTime, order) {
  const client = await getClient();
  const { assetId, conditionId } = await downSide(client, eventTime);
  const isMarket = order.orderType === ORDER_TYPE.MARKET;
  // The highest price the market order may pay: what the current asks give for the amount.
  const price = isMarket
    ? await client.estimateMarketPrice({
        assetId,
        side: OrderSide.BUY,
        amount: order.amount,
        orderType: OrderType.FOK,
      })
    : order.price;

  let response;
  try {
    response = isMarket
      ? await client.placeMarketOrder({
          assetId,
          side: OrderSide.BUY,
          amount: order.amount,
          maxPrice: price,
          orderType: OrderType.FOK,
        })
      : await client.placeLimitOrder({
          assetId,
          side: OrderSide.BUY,
          price: order.price,
          size: order.quantity,
          // A GTD order expires 1 minute before its expiration: this one when its event ends.
          expiration: eventTime + WINDOW_SECONDS + 60,
        });
  } catch (err) {
    if (NOT_PLACED_ERRORS.has(err?.name)) throw err;
    throw new UnconfirmedOrderError(`Sending the order failed, it may or may not be placed: ${err.message}`, {
      cause: err,
    });
  }

  if (!response.ok) throw new Error(`Polymarket rejected the order: ${response.message} (${response.code})`);
  return {
    orderId: response.orderId,
    orderStatus: response.status, // live (resting), matched, or delayed (queued by the market)
    assetId,
    conditionId,
    price: Number(price),
    // For a buy, takingAmount is the shares received by fills at placement ('0' if none yet).
    filledShares: Number(response.takingAmount),
  };
}

/** How many shares the order has bought so far. */
export async function getFilledShares(orderId) {
  const client = await getClient();
  const order = await client.fetchOrder({ orderId });
  return Number(order.sizeMatched);
}

/**
 * Cancels whatever is still open of an order (nothing for a filled market order) and resolves to the shares it
 * bought, which are kept.
 */
export async function cancelOrder(orderId) {
  const client = await getClient();
  await client.cancelOrder({ orderId }); // an order that's already filled or expired is reported, not thrown
  return getFilledShares(orderId);
}

/** Redeems the account's winning shares of a resolved market for USDC. Resolves to the transaction hash. */
export async function redeem(conditionId) {
  const client = await getClient();
  const handle = await client.redeemPositions({ conditionId });
  const outcome = await handle.wait();
  return outcome?.transactionHash ?? handle.transactionHash ?? null;
}
