import {
  ConsoleLogger,
  Inject,
  Injectable,
  Logger,
  LogLevel,
  OnModuleInit,
} from "@nestjs/common";
import { AsyncLocalStorage } from "async_hooks";
import { ObserveModuleOptionsWithDefaults } from "../interfaces/observe-options.interface.js";
import { OBSERVE_OPTIONS } from "../observe.constants.js";

@Injectable()
export class LoggerPatcherService implements OnModuleInit {
  private readonly logger = new Logger(LoggerPatcherService.name);
  private readonly patchedWatermark = Symbol("observe:logger_patched");

  constructor(
    private readonly asyncLocalStorage: AsyncLocalStorage<any>,
    @Inject(OBSERVE_OPTIONS)
    private readonly options: ObserveModuleOptionsWithDefaults,
  ) {}

  onModuleInit() {
    this.injectTraceIdIntoLogs();
  }

  /**
   * Injects the trace ID into the logs if the `attachTraceIdToLogs` option is enabled.
   * This method modifies the ConsoleLogger's methods to include the trace ID in the log output.
   */
  injectTraceIdIntoLogs() {
    if (!this.options.attachTraceIdToLogs) {
      return;
    }

    const isAlreadyPatched =
      Reflect.getOwnPropertyDescriptor(
        ConsoleLogger.prototype,
        this.patchedWatermark,
      )?.value === true;
    if (isAlreadyPatched) {
      return;
    }

    const options = this.options;
    const asyncLocalStorage = this.asyncLocalStorage;
    const originalFormatMessage = ConsoleLogger.prototype["formatMessage"];
    const originalGetJsonLogObject =
      ConsoleLogger.prototype["getJsonLogObject"];

    if (!originalFormatMessage || !originalGetJsonLogObject) {
      this.logger.warn(
        'ConsoleLogger methods "formatMessage" or "getJsonLogObject" are not available, which means that you are likely using a version of NestJS that does not support these methods. Please, upgrade to at least NestJS 11.2.0. Skipping trace ID injection.',
      );
      return;
    }

    ConsoleLogger.prototype["getJsonLogObject"] = function (
      this: ConsoleLogger,
      logLevel: LogLevel,
      message: unknown,
      context?: string,
    ) {
      const store = asyncLocalStorage.getStore();
      const requestId = store?.get(options.traceIdKey);
      const jsonLogObject = originalGetJsonLogObject.call(
        this,
        logLevel,
        message,
        context,
      );
      if (requestId) {
        jsonLogObject["traceId"] = requestId;
      }
      return jsonLogObject;
    };

    ConsoleLogger.prototype["formatMessage"] = function (
      this: ConsoleLogger,
      logLevel: LogLevel,
      message: unknown,
      pidMessage: string,
      formattedLogLevel: string,
      contextMessage: string,
      timestampDiff: string,
    ) {
      const store = asyncLocalStorage.getStore();
      const requestId = store?.get(options.traceIdKey);
      const output = originalFormatMessage.call(
        this,
        logLevel,
        message,
        pidMessage,
        formattedLogLevel,
        contextMessage,
        timestampDiff,
      );
      if (requestId) {
        return `${output}   Trace ID: ${this.colorize(requestId, logLevel)}\n`;
      }
      return output;
    };

    // Add watermark to flag that the logger has been patched
    Reflect.defineProperty(ConsoleLogger.prototype, this.patchedWatermark, {
      value: true,
      writable: false,
      enumerable: false,
      configurable: false,
    });
  }
}
