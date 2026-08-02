import { Module } from '@nestjs/common';
import { LoggerModule } from 'nestjs-pino';
import {
  genReqId,
  isHealthProbe,
  REDACT_CENSOR,
  REDACT_PATHS,
  resolveLogLevel,
  resolveTransport,
  serializers
} from './redaction.js';

/**
 * Structured JSON logging via pino (observability plan §A.2):
 * request-id propagation, secret redaction, phone masking, quiet health
 * probes, env-driven level, pretty transport only behind LOG_PRETTY=1.
 */
@Module({
  imports: [
    LoggerModule.forRoot({
      pinoHttp: {
        level: resolveLogLevel(),
        transport: resolveTransport(),
        genReqId,
        redact: { paths: REDACT_PATHS, censor: REDACT_CENSOR },
        serializers,
        autoLogging: { ignore: isHealthProbe }
      }
    })
  ]
})
export class LoggingModule {}
