import pino from 'pino'
import { config } from '../config'

export const logger = pino({
  level: config.app.logLevel,
  transport:
    config.nodeEnv === 'development'
      ? {
          target: 'pino-pretty',
          options: {
            colorize: true,
            translateTime: 'SYS:dd/mm/yyyy HH:MM:ss',
            ignore: 'pid,hostname',
          },
        }
      : undefined,
  serializers: {
    req(req: { method: string; url: string; headers: Record<string, string> }) {
      return {
        method: req.method,
        url: req.url,
        userAgent: req.headers['user-agent'],
      }
    },
    res(res: { statusCode: number }) {
      return {
        statusCode: res.statusCode,
      }
    },
  },
})

export type Logger = typeof logger
