import { Router } from 'express';
import * as tradingController from '../../controllers/trading.controller.js';

const router = Router();

router.get('/status', tradingController.getStatus);
router.post('/stop', tradingController.stopAllTrading);
router.post('/:group/start', tradingController.startTrading);
router.post('/:group/stop', tradingController.stopTrading);

export default router;
