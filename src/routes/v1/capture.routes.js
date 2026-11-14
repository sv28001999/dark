import { Router } from 'express';
import * as captureController from '../../controllers/capture.controller.js';

const router = Router();

router.get('/records', captureController.getRecords);
router.get('/start', captureController.startCapturing);
router.post('/stop', captureController.stopCapturing);

export default router;
