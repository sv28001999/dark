import * as scriptService from '../services/script.service.js';
import { sendSuccess } from '../utils/apiResponse.js';
import validateRequest from '../utils/validateRequest.js';
import * as scriptValidation from '../validations/script.validation.js';

// Controllers validate the request, call a service and send the response. Business logic lives in services.
// Express 5 forwards rejected promises to the error handler, so no try/catch is needed.

export async function listScripts(_req, res) {
  const scripts = await scriptService.listScripts();
  sendSuccess(res, { data: { scripts } });
}

export async function runScript(req, res) {
  const { params, body } = validateRequest(req, scriptValidation.runScript);
  const run = await scriptService.startRun(params.name, body);
  res.location(`/api/v1/runs/${run.id}`);
  sendSuccess(res, { statusCode: 202, message: 'Script started', data: { run } });
}
