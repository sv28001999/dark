import * as settingsService from '../services/settings.service.js';
import { sendSuccess } from '../utils/apiResponse.js';
import validateRequest from '../utils/validateRequest.js';
import * as settingsValidation from '../validations/settings.validation.js';

export async function getSettings(_req, res) {
  const settings = await settingsService.getSettings();
  sendSuccess(res, { data: settings });
}

export async function updateSettings(req, res) {
  const { body } = validateRequest(req, settingsValidation.updateSettings);
  const settings = await settingsService.updateSettings(body);
  sendSuccess(res, { message: 'Settings saved', data: settings });
}
