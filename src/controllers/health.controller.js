import { getActiveRunCount } from '../services/script.service.js';

export function getHealth(_req, res) {
  res.json({
    success: true,
    data: {
      status: 'ok',
      activeRuns: getActiveRunCount(),
      uptime: Math.round(process.uptime()),
      timestamp: new Date().toISOString(),
    },
  });
}
