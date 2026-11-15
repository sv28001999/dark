import { Router } from 'express';
import * as captureController from '../../controllers/capture.controller.js';

const router = Router();

router.get('/records', captureController.getRecords);
router.get('/start', captureController.startCapturing);
router.get('/stop', captureController.stopCapturing);
router.get('/cleanup', captureController.cleanupRecords);

export default router;
