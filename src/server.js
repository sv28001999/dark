import app from './app.js';
import config from './config/index.js';
import logger from './config/logger.js';
import { stopAllRuns } from './services/script.service.js';

const SHUTDOWN_TIMEOUT_MS = 10_000;

process.on('unhandledRejection', (reason) => {
  logger.fatal({ err: reason }, 'Unhandled promise rejection');
  process.exit(1);
});

process.on('uncaughtException', (err) => {
  logger.fatal({ err }, 'Uncaught exception');
  process.exit(1);
});

const server = app.listen(config.port, (err) => {
  if (err) {
    logger.fatal({ err }, `Could not listen on port ${config.port}`);
    process.exit(1);
  }
  logger.info(`Server listening on http://localhost:${config.port} (${config.env})`);
});

let shuttingDown = false;

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info(`${signal} received, shutting down gracefully`);

  setTimeout(() => {
    logger.error('Graceful shutdown timed out, forcing exit');
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS).unref();

  // Stop accepting requests and let in-flight ones finish; meanwhile stop running scripts
  // (they get recorded as cancelled).
  await Promise.all([new Promise((resolve) => server.close(resolve)), stopAllRuns()]);
  logger.info('Shutdown complete');
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
