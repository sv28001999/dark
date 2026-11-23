import app from './app.js';
import config from './config/index.js';
import logger from './config/logger.js';
import { pruneRecordsOnStartup, stopCapturing } from './services/capture.service.js';
import { stopAllRuns } from './services/script.service.js';
import { pauseTrading, resumeOnStartup } from './services/trading.service.js';

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
// Continue trading where it was before the restart.
resumeOnStartup().catch((err) => logger.error({ err }, 'Could not resume trading'));

let shuttingDown = false;

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info(`${signal} received, shutting down gracefully`);

  setTimeout(() => {
    logger.error('Graceful shutdown timed out, forcing exit');
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS).unref();

  // Stop accepting requests and let in-flight ones finish; meanwhile stop the capture loop and running scripts
  // (they get recorded as cancelled). Trading is only paused: it continues when the server starts again.
  await Promise.all([
    new Promise((resolve) => server.close(resolve)),
    stopCapturing(),
    pauseTrading(),
    stopAllRuns(),
  ]);
  logger.info('Shutdown complete');
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
