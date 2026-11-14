import path from 'node:path';
import { z } from 'zod';

// Load .env into process.env. Variables already set in the real environment take precedence.
try {
  process.loadEnvFile();
} catch (err) {
  if (err.code !== 'ENOENT') throw err;
}

const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'production']).default('development'),
    PORT: z.coerce.number().int().positive().default(3000),
    // false = run without Firebase: data is kept in memory and notifications are only logged.
    FIREBASE_ENABLED: z.stringbool().default(true),
    FIREBASE_SERVICE_ACCOUNT_PATH: z.string().min(1).default('./serviceAccountKey.json'),
    FIREBASE_DATABASE_URL: z.url('FIREBASE_DATABASE_URL must be your Realtime Database URL').optional(),
    SCRIPTS_DIR: z.string().min(1).default('./scripts'),
    SCRIPT_TIMEOUT_MS: z.coerce.number().int().positive().default(300_000), // 5 minutes
    MAX_CONCURRENT_RUNS: z.coerce.number().int().positive().default(5),
    POLYMARKET_CLOB_URL: z.url().default('https://clob.polymarket.com'),
    CORS_ORIGIN: z.string().default('*'),
    TRUST_PROXY: z.coerce.number().int().min(0).default(0),
    RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(900_000), // 15 minutes
    RATE_LIMIT_MAX: z.coerce.number().int().positive().default(100),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).optional(),
  })
  .refine((env) => !env.FIREBASE_ENABLED || env.FIREBASE_DATABASE_URL, {
    message: 'FIREBASE_DATABASE_URL is required when FIREBASE_ENABLED=true',
    path: ['FIREBASE_DATABASE_URL'],
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
    enabled: env.FIREBASE_ENABLED,
    serviceAccountPath: path.resolve(env.FIREBASE_SERVICE_ACCOUNT_PATH),
    databaseURL: env.FIREBASE_DATABASE_URL,
  },
  scripts: {
    dir: path.resolve(env.SCRIPTS_DIR),
    timeoutMs: env.SCRIPT_TIMEOUT_MS,
    maxConcurrent: env.MAX_CONCURRENT_RUNS,
  },
  polymarket: {
    clobUrl: env.POLYMARKET_CLOB_URL.replace(/\/+$/, ''), // without trailing slash
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
