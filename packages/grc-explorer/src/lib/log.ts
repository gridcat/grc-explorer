import { createLogger, format, transports } from 'winston';

const { combine, timestamp, prettyPrint } = format;

const consoleTransport = new transports.Console();

export const log = createLogger({
  level: process.env.NODE_ENV === 'production' ? 'info' : 'debug',
  format: combine(timestamp(), prettyPrint()),
  transports: [consoleTransport],
});

if (process.env.NODE_ENV === 'testing') {
  log.silent = true;
}
