import * as tradingService from '../services/trading.service.js';
import { sendSuccess } from '../utils/apiResponse.js';
import validateRequest from '../utils/validateRequest.js';
import * as tradingValidation from '../validations/trading.validation.js';

const groupName = (group) => (group === 'odd' ? 'Odd' : 'Even');

export function getStatus(_req, res) {
  sendSuccess(res, { data: tradingService.getStatus() });
}

export async function startTrading(req, res) {
  const { params } = validateRequest(req, tradingValidation.groupParams);
  const data = await tradingService.startTrading(params.group);
  sendSuccess(res, { message: `${groupName(params.group)} trading started (simulated)`, data });
}

export async function stopTrading(req, res) {
  const { params } = validateRequest(req, tradingValidation.groupParams);
  const data = await tradingService.stopTrading(params.group);
  sendSuccess(res, { message: `${groupName(params.group)} trading stopped`, data });
}

export async function stopAllTrading(_req, res) {
  const data = await tradingService.stopAllTrading();
  sendSuccess(res, { message: 'All trading stopped', data });
}
