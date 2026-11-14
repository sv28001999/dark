import { getMessaging } from 'firebase-admin/messaging';
import config from '../config/index.js';
import logger from '../config/logger.js';
import { NOTIFICATION_STATUS } from '../constants/status.js';
import database from '../config/database.js';
import ApiError from '../utils/ApiError.js';

const NOTIFICATIONS = 'notifications'; // database collection

/** Used when Firebase is disabled: logs the notification instead of sending it. */
function simulateDelivery({ token, tokens, topic, title, body, data }) {
  logger.info(
    { token, tokens, topic, data },
    `[Firebase disabled] Notification NOT sent: "${title}" - ${body}`,
  );
  return { successCount: tokens?.length ?? 1, failureCount: 0 };
}

/** Sends through Firebase Cloud Messaging and returns delivery counts. */
async function deliver(message) {
  if (!config.firebase.enabled) return simulateDelivery(message);

  const { token, tokens, topic, title, body, imageUrl, data } = message;
  const messaging = getMessaging();
  const notification = { title, body, imageUrl };

  if (tokens) {
    const response = await messaging.sendEachForMulticast({ tokens, notification, data });
    return {
      successCount: response.successCount,
      failureCount: response.failureCount,
      failures: response.responses.flatMap((result, i) =>
        result.success
          ? []
          : [{ token: tokens[i], code: result.error?.code, message: result.error?.message }],
      ),
    };
  }

  const target = token ? { token } : { topic };
  const messageId = await messaging.send({ ...target, notification, data });
  return { successCount: 1, failureCount: 0, messageId };
}

function statusOf({ successCount, failureCount }) {
  if (!config.firebase.enabled) return NOTIFICATION_STATUS.SIMULATED;
  if (failureCount === 0) return NOTIFICATION_STATUS.SENT;
  if (successCount === 0) return NOTIFICATION_STATUS.FAILED;
  return NOTIFICATION_STATUS.PARTIAL;
}

/**
 * Sends a push notification to exactly one of: `token`, `tokens` (up to 500) or `topic`,
 * and records the outcome in the Realtime Database. Delivery errors are recorded, not thrown.
 *
 * @param {object} message - { token | tokens | topic, title, body, imageUrl?, data? }
 * @param {object} [options] - { source }: what triggered the send, e.g. "api" or "run:<runId>"
 */
export async function sendNotification(message, { source = 'api' } = {}) {
  let outcome;
  try {
    outcome = await deliver(message);
  } catch (err) {
    outcome = {
      successCount: 0,
      failureCount: message.tokens?.length ?? 1,
      failures: [{ code: err.code ?? 'unknown', message: err.message }],
    };
  }

  const status = statusOf(outcome);
  const notification = await database.create(NOTIFICATIONS, {
    ...message,
    source,
    status,
    ...outcome,
    createdAt: new Date().toISOString(),
  });

  logger.info({ notificationId: notification.id, status, source }, 'Notification processed');
  return notification;
}

export function listNotifications({ limit }) {
  return database.list(NOTIFICATIONS, { limit });
}

export async function getNotification(notificationId) {
  const notification = await database.findById(NOTIFICATIONS, notificationId);
  if (!notification) throw ApiError.notFound('Notification not found');
  return notification;
}
