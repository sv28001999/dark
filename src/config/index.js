import path from 'node:path';
import { z } from 'zod';

// Load .env into process.env. Variables already set in the real environment take precedence.
try {
  process.loadEnvFile();
} catch (err) {
  if (err.code !== 'ENOENT') throw err;
}

const isJson = (value) => {
  try {
    JSON.parse(value);
    return true;
  } catch {
    return false;
  }
};

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  FIREBASE_DATABASE_URL: z.url('FIREBASE_DATABASE_URL must be your Firebase Realtime Database URL'),
  // The service account key file's contents, for sending push notifications through FCM. Optional: without
  // it, notifications are only logged.
  FIREBASE_SERVICE_ACCOUNT: z
    .string()
    .refine(isJson, 'FIREBASE_SERVICE_ACCOUNT must be the service account key file contents (JSON)')
    .transform((value) => JSON.parse(value))
    .pipe(
      z.looseObject({
        project_id: z.string().min(1),
        client_email: z.string().min(1),
        private_key: z.string().min(1),
      }),
    )
    .optional(),
  SCRIPTS_DIR: z.string().min(1).default('./scripts'),
  SCRIPT_TIMEOUT_MS: z.coerce.number().int().positive().default(300_000), // 5 minutes
  MAX_CONCURRENT_RUNS: z.coerce.number().int().positive().default(5),
  POLYMARKET_CLOB_URL: z.url().default('https://clob.polymarket.com'),
  POLYMARKET_GAMMA_URL: z.url().default('https://gamma-api.polymarket.com'),
  CORS_ORIGIN: z.string().default('*'),
  TRUST_PROXY: z.coerce.number().int().min(0).default(0),
  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(900_000), // 15 minutes
  RATE_LIMIT_MAX: z.coerce.number().int().positive().default(100),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).optional(),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  // The logger depends on this config, so fall back to console here.
  console.error(`Invalid environment configuration:\n${z.prettifyError(parsed.error)}`);
  process.exit(1);
}

const env = parsed.data;

const defaultLogLevel = env.NODE_ENV === 'production' ? 'info' : 'debug';

const config = Object.freeze({
  env: env.NODE_ENV,
  isProduction: env.NODE_ENV === 'production',
  isDevelopment: env.NODE_ENV === 'development',
  port: env.PORT,
  trustProxy: env.TRUST_PROXY,
  logLevel: env.LOG_LEVEL ?? defaultLogLevel,
  firebase: {
    databaseUrl: env.FIREBASE_DATABASE_URL.replace(/\/+$/, ''), // without trailing slash
    // null when FIREBASE_SERVICE_ACCOUNT isn't set: push notifications are then logged, not sent.
    serviceAccount: env.FIREBASE_SERVICE_ACCOUNT
      ? {
          projectId: env.FIREBASE_SERVICE_ACCOUNT.project_id,
          clientEmail: env.FIREBASE_SERVICE_ACCOUNT.client_email,
          privateKey: env.FIREBASE_SERVICE_ACCOUNT.private_key,
        }
      : null,
  },
  scripts: {
    dir: path.resolve(env.SCRIPTS_DIR),
    timeoutMs: env.SCRIPT_TIMEOUT_MS,
    maxConcurrent: env.MAX_CONCURRENT_RUNS,
  },
  polymarket: {
    // Without trailing slashes.
    clobUrl: env.POLYMARKET_CLOB_URL.replace(/\/+$/, ''), // trading API (server time, order books)
    gammaUrl: env.POLYMARKET_GAMMA_URL.replace(/\/+$/, ''), // market/event data API
  },
  cors: {
    origin: env.CORS_ORIGIN === '*' ? '*' : env.CORS_ORIGIN.split(',').map((o) => o.trim()),
  },
  rateLimit: {
    windowMs: env.RATE_LIMIT_WINDOW_MS,
    max: env.RATE_LIMIT_MAX,
  },
});

export default config;
