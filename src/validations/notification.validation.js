import { z } from 'zod';
import {
  exactlyOneTarget,
  listQuery,
  notificationBody,
  notificationTarget,
  notificationTitle,
  recordId,
} from './common.validation.js';

export const sendNotification = z.object({
  body: z
    .object({
      ...notificationTarget,
      title: notificationTitle,
      body: notificationBody,
      imageUrl: z.url({ protocol: /^https?$/ }).optional(),
      // FCM data payload values must be strings.
      data: z.record(z.string(), z.string()).optional(),
    })
    .refine(...exactlyOneTarget),
});

export const listNotifications = listQuery;

export const getNotification = z.object({
  params: z.object({ notificationId: recordId }),
});
