import type { FactoryProvider } from "@nestjs/common";
import type {
  ObserveOptions,
  ObserveOptionsFactory,
} from "./interfaces/observe-options.interface.js";
import { createObserveModule } from "./observe.module.js";
import { OBSERVE_OPTIONS } from "./observe.constants.js";

/**
 * The `forRootAsync` wiring, which has three mutually exclusive shapes and one
 * invalid one. The providers are built by plain static methods, so these assert
 * on what those return rather than booting an application - the protocol
 * integration suites already cover a module that actually starts.
 */
describe("createObserveModule#forRootAsync", () => {
  const { ObserveModule } = createObserveModule();

  const optionsOf = (provider: unknown) => provider as FactoryProvider;

  // Returned as a loose bag rather than `ObserveOptions`: the assertions below
  // reach for the defaults `createObserveModule` merges in, which live on
  // `ObserveModuleOptionsWithDefaults` rather than on the options a caller
  // supplies.
  const resolve = async (
    provider: unknown,
    ...args: unknown[]
  ): Promise<Record<string, unknown>> =>
    (await optionsOf(provider).useFactory(...args)) as Record<string, unknown>;

  const observeOptions = (): ObserveOptions =>
    ({
      appKey: "key",
      appSecret: "secret",
      serviceId: "svc",
    }) as ObserveOptions;

  describe("useFactory", () => {
    it("resolves the options through the factory", async () => {
      const [provider] = ObserveModule.createAsyncProviders({
        useFactory: () => observeOptions(),
      });

      expect(optionsOf(provider).provide).toBe(OBSERVE_OPTIONS);
      await expect(resolve(provider)).resolves.toMatchObject({
        appKey: "key",
        serviceId: "svc",
      });
    });

    it("awaits an async factory", async () => {
      const [provider] = ObserveModule.createAsyncProviders({
        useFactory: async () => observeOptions(),
      });

      await expect(resolve(provider)).resolves.toMatchObject({
        appSecret: "secret",
      });
    });

    it("keeps the module defaults the factory did not override", async () => {
      const [provider] = ObserveModule.createAsyncProviders({
        useFactory: () => observeOptions(),
      });

      // `traceIdKey` and friends are defaulted by `createObserveModule`, and the
      // async path has to carry them through - forgetting to would leave every
      // trace id written under `undefined`.
      const resolved = await resolve(provider);
      expect(resolved.traceIdKey).toBe("traceId");
      expect(resolved.attachTraceIdToLogs).toBe(true);
    });

    it("passes the declared dependencies through to the factory", async () => {
      const [provider] = ObserveModule.createAsyncProviders({
        useFactory: (config: { serviceId: string }) =>
          ({
            ...observeOptions(),
            serviceId: config.serviceId,
          }) as ObserveOptions,
        inject: ["CONFIG"],
      });

      expect(optionsOf(provider).inject).toEqual(["CONFIG"]);
      await expect(
        resolve(provider, { serviceId: "from-config" }),
      ).resolves.toMatchObject({ serviceId: "from-config" });
    });
  });

  describe("useClass", () => {
    class ObserveConfig implements ObserveOptionsFactory {
      createObserveOptions(): ObserveOptions {
        return observeOptions();
      }
    }

    it("registers the factory class alongside the options provider", () => {
      const providers = ObserveModule.createAsyncProviders({
        useClass: ObserveConfig,
      });

      // Two providers: the options themselves, and the class that produces them
      // - which nothing else in the graph would otherwise instantiate.
      expect(providers).toHaveLength(2);
      expect(providers[1]).toEqual({
        provide: ObserveConfig,
        useClass: ObserveConfig,
      });
    });

    it("resolves the options through createObserveOptions", async () => {
      const [provider] = ObserveModule.createAsyncProviders({
        useClass: ObserveConfig,
      });

      expect(optionsOf(provider).inject).toEqual([ObserveConfig]);
      await expect(
        resolve(provider, new ObserveConfig()),
      ).resolves.toMatchObject({ appKey: "key", serviceId: "svc" });
    });

    it("awaits a factory class that resolves asynchronously", async () => {
      class AsyncObserveConfig implements ObserveOptionsFactory {
        async createObserveOptions(): Promise<ObserveOptions> {
          return observeOptions();
        }
      }
      const [provider] = ObserveModule.createAsyncProviders({
        useClass: AsyncObserveConfig,
      });

      await expect(
        resolve(provider, new AsyncObserveConfig()),
      ).resolves.toMatchObject({ appSecret: "secret" });
    });
  });

  describe("useExisting", () => {
    class ObserveConfig implements ObserveOptionsFactory {
      createObserveOptions(): ObserveOptions {
        return observeOptions();
      }
    }

    it("injects the existing provider without registering it again", async () => {
      const providers = ObserveModule.createAsyncProviders({
        useExisting: ObserveConfig,
      });

      // One provider only: the class is already in the graph, and registering a
      // second copy would give the module a different instance than the rest of
      // the application shares.
      expect(providers).toHaveLength(1);
      expect(optionsOf(providers[0]).inject).toEqual([ObserveConfig]);
      await expect(
        resolve(providers[0], new ObserveConfig()),
      ).resolves.toMatchObject({ serviceId: "svc" });
    });
  });

  describe("with none of the three", () => {
    it("says which options are missing instead of failing at injection time", () => {
      // Nest would otherwise try to resolve `undefined` as a token and fail much
      // later, with nothing pointing back at the module's configuration.
      expect(() => ObserveModule.createAsyncProviders({})).toThrow(
        /requires one of "useFactory", "useClass" or "useExisting"/,
      );
      expect(() => ObserveModule.createAsyncOptionsProvider({})).toThrow(
        /requires one of "useFactory", "useClass" or "useExisting"/,
      );
    });
  });
});
