import { Router } from 'express';
import captureRoutes from './capture.routes.js';
import deviceRoutes from './device.routes.js';
import notificationRoutes from './notification.routes.js';
import runRoutes from './run.routes.js';
import scriptRoutes from './script.routes.js';
import settingsRoutes from './settings.routes.js';
import tradingRoutes from './trading.routes.js';

const router = Router();

router.use('/scripts', scriptRoutes);
router.use('/runs', runRoutes);
router.use('/notifications', notificationRoutes);
router.use('/devices', deviceRoutes);
router.use('/capture', captureRoutes);
router.use('/settings', settingsRoutes);
router.use('/trading', tradingRoutes);

export default router;
