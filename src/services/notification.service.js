import database from '../config/database.js';
import logger from '../config/logger.js';
import { NOTIFICATION_STATUS } from '../constants/status.js';
import ApiError from '../utils/ApiError.js';

const NOTIFICATIONS = 'notifications'; // database collection

/**
 * Records a push notification for exactly one of: `token`, `tokens` (up to 500) or `topic`.
 * Sending is not implemented yet: the notification is written to the server log and saved with
 * status "logged".
 *
 * @param {object} message - { token | tokens | topic, title, body, imageUrl?, data? }
 * @param {object} [options] - { source }: what triggered it, e.g. "api" or "run:<runId>"
 */
export async function sendNotification(message, { source = 'api' } = {}) {
  const { token, tokens, topic, title, body, data } = message;
  logger.info(
    { token, tokens, topic, data },
    `Notification NOT sent (sending not implemented): "${title}" - ${body}`,
  );

  return database.create(NOTIFICATIONS, {
    ...message,
    source,
    status: NOTIFICATION_STATUS.LOGGED,
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
