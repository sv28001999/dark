import { isDatabaseConnected } from '../config/firebase.js';
import config from '../config/index.js';
import { getActiveRunCount } from '../services/script.service.js';

function databaseState() {
  if (!config.firebase.enabled) return 'in-memory';
  return isDatabaseConnected() ? 'connected' : 'disconnected';
}

export function getHealth(_req, res) {
  const database = databaseState();
  const healthy = database !== 'disconnected';

  res.status(healthy ? 200 : 503).json({
    success: healthy,
    data: {
      status: healthy ? 'ok' : 'degraded',
      database,
      activeRuns: getActiveRunCount(),
      uptime: Math.round(process.uptime()),
      timestamp: new Date().toISOString(),
    },
  });
}
