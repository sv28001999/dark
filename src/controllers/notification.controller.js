import { NOTIFICATION_STATUS } from '../constants/status.js';
import * as notificationService from '../services/notification.service.js';
import ApiError from '../utils/ApiError.js';
import { sendSuccess } from '../utils/apiResponse.js';
import validateRequest from '../utils/validateRequest.js';
import * as notificationValidation from '../validations/notification.validation.js';

export async function sendNotification(req, res) {
  const { body } = validateRequest(req, notificationValidation.sendNotification);
  const notification = await notificationService.sendNotification(body);

  // Nothing was delivered: report it as an upstream (Firebase) failure. It is still saved in history.
  if (notification.status === NOTIFICATION_STATUS.FAILED) {
    throw new ApiError(502, 'Notification could not be delivered', {
      notificationId: notification.id,
      failures: notification.failures,
    });
  }

  const message =
    notification.status === NOTIFICATION_STATUS.SIMULATED
      ? 'Firebase is disabled: notification was logged, not sent'
      : 'Notification sent';
  sendSuccess(res, { statusCode: 201, message, data: { notification } });
}

export async function listNotifications(req, res) {
  const { query } = validateRequest(req, notificationValidation.listNotifications);
  const notifications = await notificationService.listNotifications(query);
  sendSuccess(res, { data: { notifications } });
}

export async function getNotification(req, res) {
  const { params } = validateRequest(req, notificationValidation.getNotification);
  const notification = await notificationService.getNotification(params.notificationId);
  sendSuccess(res, { data: { notification } });
}
