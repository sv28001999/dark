import * as captureService from '../services/capture.service.js';
import { sendSuccess } from '../utils/apiResponse.js';

export async function getRecords(_req, res) {
  const data = await captureService.getRecords();
  sendSuccess(res, { data });
}

export async function startCapturing(_req, res) {
  const data = await captureService.startCapturing();
  sendSuccess(res, { data });
}

export async function stopCapturing(_req, res) {
  const data = await captureService.stopCapturing();
  sendSuccess(res, { data });
}
