/**
 * Sends a successful response in the standard envelope:
 * { success: true, message?, data?, meta? }
 */
export function sendSuccess(res, { statusCode = 200, message, data, meta } = {}) {
  return res.status(statusCode).json({ success: true, message, data, meta });
}
