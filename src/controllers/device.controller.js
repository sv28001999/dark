import * as deviceService from '../services/device.service.js';
import { sendSuccess } from '../utils/apiResponse.js';
import validateRequest from '../utils/validateRequest.js';
import * as deviceValidation from '../validations/device.validation.js';

export async function registerDevice(req, res) {
  const { body } = validateRequest(req, deviceValidation.registerDevice);
  const device = await deviceService.registerDevice(body);
  sendSuccess(res, { message: 'Device registered', data: { device } });
}
