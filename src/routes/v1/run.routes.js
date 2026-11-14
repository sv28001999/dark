import { Router } from 'express';
import * as runController from '../../controllers/run.controller.js';

const router = Router();

router.get('/', runController.listRuns);
router.get('/:runId', runController.getRun);
router.post('/:runId/cancel', runController.cancelRun);

export default router;
