import database from '../config/database.js';
import fcm from '../config/fcm.js';
import logger from '../config/logger.js';
import { NOTIFICATION_STATUS } from '../constants/status.js';
import ApiError from '../utils/ApiError.js';
import * as deviceService from './device.service.js';

const NOTIFICATIONS = 'notifications'; // database collection

// The Android notification channel the mobile app creates (same id there). Its settings, such as showing
// notifications as heads-up banners, apply to these notifications.
const ANDROID_CHANNEL_ID = 'alerts';

/** The FCM message for one target: { token } or { topic }. */
function fcmMessage(target, { title, body, imageUrl, data }) {
  return {
    ...target,
    notification: { title, body, ...(imageUrl && { image: imageUrl }) },
    ...(data && { data }),
    // High priority: delivered right away, also when the app is closed or the phone is idle.
    android: { priority: 'high', notification: { channel_id: ANDROID_CHANNEL_ID } },
  };
}

/**
 * Sends the notification to each target through FCM and returns what to save with it:
 * { status, sentCount, failedCount, errors? }. Devices FCM reports as unregistered (app uninstalled) are removed.
 */
async function deliver(targets, message) {
  if (!fcm.isConfigured) {
    logger.info(
      `Notification NOT sent (FIREBASE_SERVICE_ACCOUNT is not set): "${message.title}" - ${message.body}`,
    );
    return { status: NOTIFICATION_STATUS.LOGGED };
  }
  if (targets.length === 0) {
    logger.info(`Notification NOT sent (no registered devices): "${message.title}"`);
    return {
      status: NOTIFICATION_STATUS.FAILED,
      sentCount: 0,
      failedCount: 0,
      errors: ['No registered devices'],
    };
  }

  const results = await Promise.all(targets.map((target) => fcm.send(fcmMessage(target, message))));
  const sentCount = results.filter((result) => result.ok).length;
  const failed = results.filter((result) => !result.ok);
  const errors = [...new Set(failed.map((result) => result.errorCode ?? result.error))];

  const unregistered = targets
    .filter((_, i) => results[i].errorCode === 'UNREGISTERED')
    .map(({ token }) => token);
  await deviceService
    .removeTokens(unregistered)
    .catch((err) => logger.warn({ err }, 'Could not remove unregistered devices'));

  const log = failed.length > 0 ? logger.warn.bind(logger) : logger.info.bind(logger);
  log({ errors }, `Notification sent to ${sentCount} of ${targets.length} target(s): "${message.title}"`);
  return {
    status: sentCount > 0 ? NOTIFICATION_STATUS.SENT : NOTIFICATION_STATUS.FAILED,
    sentCount,
    failedCount: failed.length,
    ...(errors.length > 0 && { errors }),
  };
}

/**
 * Sends a push notification to exactly one of: `token`, `tokens` (up to 500) or `topic`, and saves it with the
 * result. Without FIREBASE_SERVICE_ACCOUNT nothing is sent: it's written to the server log, status "logged".
 *
 * @param {object} message - { token | tokens | topic, title, body, imageUrl?, data? }
 * @param {object} [options] - { source }: what triggered it, e.g. "api" or "run:<runId>"
 */
export async function sendNotification(message, { source = 'api' } = {}) {
  const { token, tokens, topic } = message;
  const targets = topic ? [{ topic }] : (tokens ?? [token]).map((value) => ({ token: value }));
  const result = await deliver(targets, message);

  return database.create(NOTIFICATIONS, {
    ...message,
    source,
    ...result,
    createdAt: new Date().toISOString(),
  });
}

/** Sends a push notification to every registered device (see device.service.js) and saves it with the result. */
export async function sendToAllDevices({ title, body, data }, { source }) {
  const tokens = await deviceService.listTokens();
  const result = await deliver(
    tokens.map((token) => ({ token })),
    { title, body, data },
  );

  return database.create(NOTIFICATIONS, {
    title,
    body,
    data,
    target: 'all devices',
    deviceCount: tokens.length,
    source,
    ...result,
    createdAt: new Date().toISOString(),
  });
}

export function listNotifications({ limit }) {
  return database.list(NOTIFICATIONS, { limit });
}

export async function getNotification(notificationId) {
  const notification = await database.findById(NOTIFICATIONS, notificationId);
  if (!notification) throw ApiError.notFound('Notification not found');
  return notification;
}
