import { Router } from 'express';
import * as scriptController from '../../controllers/script.controller.js';

const router = Router();

router.get('/', scriptController.listScripts);
router.post('/:name/run', scriptController.runScript);

export default router;
