import { timingSafeEqual } from 'node:crypto';
import config from '../config/index.js';
import ApiError from './ApiError.js';

/**
 * Express middleware for the trading endpoints: requires the X-Api-Key header to equal TRADING_API_KEY.
 * Without TRADING_API_KEY (simulated trading only) every request is allowed.
 */
export default function requireApiKey(req, _res, next) {
  const expected = config.trading.apiKey;
  if (!expected) return next();

  const given = Buffer.from(req.get('x-api-key') ?? '');
  const wanted = Buffer.from(expected);
  // Constant-time comparison, so response timing reveals nothing about the key
  if (given.length !== wanted.length || !timingSafeEqual(given, wanted)) {
    return next(ApiError.unauthorized('Missing or wrong API key (X-Api-Key header)'));
  }
  return next();
}
