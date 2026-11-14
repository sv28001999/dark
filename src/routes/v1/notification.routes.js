import { Router } from 'express';
import * as notificationController from '../../controllers/notification.controller.js';

const router = Router();

router.post('/', notificationController.sendNotification);
router.get('/', notificationController.listNotifications);
router.get('/:notificationId', notificationController.getNotification);

export default router;
