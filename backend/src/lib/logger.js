import pino from 'pino';

const pretty = process.env.LOG_PRETTY === '1' || (process.env.NODE_ENV !== 'production' && process.stdout.isTTY);

export const logger = pino({
  ...(pretty
    ? {
        transport: {
          target: 'pino-pretty',
          options: { colorize: true },
        },
      }
    : {}),
});
