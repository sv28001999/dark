import * as notificationService from '../services/notification.service.js';
import { sendSuccess } from '../utils/apiResponse.js';
import validateRequest from '../utils/validateRequest.js';
import * as notificationValidation from '../validations/notification.validation.js';

export async function sendNotification(req, res) {
  const { body } = validateRequest(req, notificationValidation.sendNotification);
  const notification = await notificationService.sendNotification(body);

  sendSuccess(res, {
    statusCode: 201,
    message: 'Notification logged (sending is not implemented yet)',
    data: { notification },
  });
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
