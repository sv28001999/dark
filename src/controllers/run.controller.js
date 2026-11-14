import * as scriptService from '../services/script.service.js';
import { sendSuccess } from '../utils/apiResponse.js';
import validateRequest from '../utils/validateRequest.js';
import * as runValidation from '../validations/run.validation.js';

export async function listRuns(req, res) {
  const { query } = validateRequest(req, runValidation.listRuns);
  const runs = await scriptService.listRuns(query);
  sendSuccess(res, { data: { runs } });
}

export async function getRun(req, res) {
  const { params } = validateRequest(req, runValidation.getRun);
  const run = await scriptService.getRun(params.runId);
  sendSuccess(res, { data: { run } });
}

export async function cancelRun(req, res) {
  const { params } = validateRequest(req, runValidation.cancelRun);
  const run = await scriptService.cancelRun(params.runId);
  sendSuccess(res, { message: 'Run cancelled', data: { run } });
}
