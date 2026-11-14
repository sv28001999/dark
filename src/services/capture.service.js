import * as polymarketService from './polymarket.service.js';

// Polymarket time is split into 5-minute windows that start on multiples of 300 seconds.
const WINDOW_SECONDS = 5 * 60;

export async function getRecords() {
  return {};
}

/**
 * Gets Polymarket's current time and rounds it down to the start of the current 5-minute window,
 * e.g. 1794623420 → 1794623400, 1794623646 → 1794623400, 1794623779 → 1794623700.
 */
export async function startCapturing() {
  const serverTime = await polymarketService.getServerTime();
  const currentEventTime = Math.floor(serverTime / WINDOW_SECONDS) * WINDOW_SECONDS;

  return { currentEventTime };
}

export async function stopCapturing() {
  return {};
}
