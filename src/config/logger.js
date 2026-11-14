import pino from 'pino';
import config from './index.js';

const logger = pino({
  level: config.logLevel,
  redact: ['req.headers.authorization', 'req.headers.cookie', '*.password'],
  // Human-readable logs in development; structured JSON everywhere else.
  ...(config.isDevelopment && {
    transport: {
      target: 'pino-pretty',
      // Request details are already in the message line; production JSON logs keep them as fields.
      options: { colorize: true, translateTime: 'SYS:HH:MM:ss', ignore: 'pid,hostname,req,res,responseTime' },
    },
  }),
});

export default logger;
