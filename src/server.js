import app from './app.js';
import config from './config/index.js';
import logger from './config/logger.js';
import { pruneRecordsOnStartup, stopCapturing } from './services/capture.service.js';
import { stopAllRuns } from './services/script.service.js';
import { markStoppedOnStartup, stopAllTrading } from './services/trading.service.js';

const SHUTDOWN_TIMEOUT_MS = 10_000;

// The logger writes asynchronously in development (pino-pretty), so a message logged right before
// process.exit can be lost: print the error to the console too, so the reason a crash happened is never lost.
function exitOnFatal(message, err) {
  console.error(`[${new Date().toISOString()}] FATAL ${message}:`, err);
  logger.fatal({ err }, message);
  process.exit(1);
}

process.on('unhandledRejection', (reason) => exitOnFatal('Unhandled promise rejection', reason));
process.on('uncaughtException', (err) => exitOnFatal('Uncaught exception', err));

const server = app.listen(config.port, (err) => {
  if (err) {
    logger.fatal({ err }, `Could not listen on port ${config.port}`);
    process.exit(1);
  }
  logger.info(`Server listening on http://localhost:${config.port} (${config.env})`);
});

// On every start, keep only the latest 40 capture records in Firebase.
pruneRecordsOnStartup().catch((err) => logger.error({ err }, 'Could not remove old capture records'));
// Trading doesn't survive a restart: show it as stopped in the mobile app.
markStoppedOnStartup().catch((err) => logger.error({ err }, 'Could not update the trading state'));

let shuttingDown = false;

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info(`${signal} received, shutting down gracefully`);

  setTimeout(() => {
    logger.error('Graceful shutdown timed out, forcing exit');
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS).unref();

  // Stop accepting requests and let in-flight ones finish; meanwhile stop the capture loop, trading and
  // running scripts (they get recorded as cancelled).
  await Promise.all([
    new Promise((resolve) => server.close(resolve)),
    stopCapturing(),
    stopAllTrading('Server stopped').catch((err) => logger.error({ err }, 'Could not stop trading')),
    stopAllRuns(),
  ]);
  logger.info('Shutdown complete');
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
