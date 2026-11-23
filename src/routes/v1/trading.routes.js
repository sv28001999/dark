import { Router } from 'express';
import * as tradingController from '../../controllers/trading.controller.js';
import requireApiKey from '../../utils/requireApiKey.js';

const router = Router();

// Trading can spend real money: every trading endpoint needs the API key (when TRADING_API_KEY is set).
router.use(requireApiKey);

router.get('/status', tradingController.getStatus);
router.post('/stop', tradingController.stopAllTrading);
router.post('/:group/start', tradingController.startTrading);
router.post('/:group/stop', tradingController.stopTrading);

export default router;
