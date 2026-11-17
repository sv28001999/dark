import logger from '../config/logger.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Runs `fn` up to `attempts` times, waiting a little longer after each failure (1 s, 2 s, 3 s, ...), and resolves
 * to its result. Throws the last error when every attempt failed, or right away when `shouldRetry(err)` is false.
 * `label` names the operation in the warning logged for each failed attempt.
 */
export default async function retry(
  fn,
  { attempts = 5, delayMs = 1000, label = 'Operation', shouldRetry = () => true } = {},
) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= attempts || !shouldRetry(err)) throw err;
      logger.warn(`${label} failed (attempt ${attempt} of ${attempts}): ${err.message}. Retrying`);
      await sleep(delayMs * attempt);
    }
  }
}
