import { Router } from 'express';
import captureRoutes from './capture.routes.js';
import deviceRoutes from './device.routes.js';
import notificationRoutes from './notification.routes.js';
import runRoutes from './run.routes.js';
import scriptRoutes from './script.routes.js';

const router = Router();

router.use('/scripts', scriptRoutes);
router.use('/runs', runRoutes);
router.use('/notifications', notificationRoutes);
router.use('/devices', deviceRoutes);
router.use('/capture', captureRoutes);

export default router;
