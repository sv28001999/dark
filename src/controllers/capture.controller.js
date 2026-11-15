import * as captureService from '../services/capture.service.js';
import { sendSuccess } from '../utils/apiResponse.js';

export async function getRecords(_req, res) {
  const data = await captureService.getRecords();
  sendSuccess(res, { data });
}

export async function startCapturing(_req, res) {
  const data = await captureService.startCapturing();
  sendSuccess(res, { message: 'Capturing started', data });
}

export async function stopCapturing(_req, res) {
  const data = await captureService.stopCapturing();
  sendSuccess(res, { message: 'Capturing stopped', data });
}

export async function cleanupRecords(_req, res) {
  const data = await captureService.cleanupRecords();
  sendSuccess(res, { message: 'Old records removed', data });
}
