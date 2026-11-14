import { randomUUID } from 'node:crypto';
import compression from 'compression';
import cors from 'cors';
import express from 'express';
import { rateLimit } from 'express-rate-limit';
import helmet from 'helmet';
import { pinoHttp } from 'pino-http';

import config from './config/index.js';
import logger from './config/logger.js';
import routes from './routes/index.js';
import ApiError from './utils/ApiError.js';

const app = express();

app.set('trust proxy', config.trustProxy);

// Request logging with a request id (reused from X-Request-Id if the caller sent one).
app.use(
  pinoHttp({
    logger,
    genReqId(req, res) {
      const id = req.headers['x-request-id'] ?? randomUUID();
      res.setHeader('X-Request-Id', id);
      return id;
    },
    customLogLevel(_req, res, err) {
      if (err || res.statusCode >= 500) return 'error';
      if (res.statusCode >= 400) return 'warn';
      return 'info';
    },
    customSuccessMessage: (req, res, ms) => `${req.method} ${req.originalUrl} ${res.statusCode} ${ms}ms`,
    customErrorMessage: (req, res) => `${req.method} ${req.originalUrl} ${res.statusCode} failed`,
    serializers: {
      req: (req) => ({ id: req.id, method: req.method, url: req.url }),
      res: (res) => ({ statusCode: res.statusCode }),
    },
    autoLogging: { ignore: (req) => req.url === '/health' },
  }),
);

// Security, CORS and body parsing.
app.use(helmet());
app.use(cors({ origin: config.cors.origin }));
app.use(compression());
app.use(express.json({ limit: '100kb' }));
app.use(express.urlencoded({ extended: true, limit: '100kb' }));

// Per-IP request limit. The API has no authentication, so this is its only protection against abuse.
app.use(
  '/api',
  rateLimit({
    windowMs: config.rateLimit.windowMs,
    limit: config.rateLimit.max,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    handler: (_req, _res, next, options) =>
      next(new ApiError(options.statusCode, 'Too many requests, please try again later')),
  }),
);

app.use(routes);

// No route matched.
app.use((req, _res, next) => {
  next(ApiError.notFound(`Route ${req.method} ${req.originalUrl} not found`));
});

/** Maps an error to the ApiError sent to the client, or null for unexpected errors (sent as a 500). */
function toApiError(err) {
  if (err instanceof ApiError) return err;

  // Errors raised by Express's body parsers (http-errors).
  if (err?.type === 'entity.parse.failed') return ApiError.badRequest('Malformed JSON in request body');
  if (err?.expose && err.status >= 400 && err.status < 500) return new ApiError(err.status, err.message);

  return null;
}

// Central error handler: every error thrown in a route or controller ends up here.
// Express recognizes error handlers by their four-argument signature.
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);

  const apiError = toApiError(err);
  const statusCode = apiError?.statusCode ?? 500;

  // Unexpected errors: hand to pino-http so the request log line includes the error and stack.
  if (!apiError) res.err = err;

  res.status(statusCode).json({
    success: false,
    error: {
      message: apiError?.message ?? 'Internal server error',
      ...(apiError?.details && { details: apiError.details }),
      ...(!apiError && !config.isProduction && { stack: err.stack }),
    },
  });
});
// This is for testing
export default app;
