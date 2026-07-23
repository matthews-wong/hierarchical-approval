import { Inject, Module } from '@nestjs/common';
import type {
  DynamicModule,
  InjectionToken,
  ModuleMetadata,
  OnModuleDestroy,
  OptionalFactoryDependency,
  Provider,
} from '@nestjs/common';

import { ApprovalEngine } from '../engine/ApprovalEngine.js';
import type { ApprovalEngineOptions } from '../engine/ApprovalEngine.js';
import { APPROVAL_ENGINE } from './tokens.js';

/** Options for {@link HierarchicalApprovalModule.forRoot}. */
export interface HierarchicalApprovalModuleOptions extends ApprovalEngineOptions {
  /**
   * Register the module globally so `ApprovalEngine` can be injected anywhere
   * without importing the module in every feature module. Defaults to `false`.
   */
  isGlobal?: boolean;
}

/** Options for {@link HierarchicalApprovalModule.forRootAsync}. */
export interface HierarchicalApprovalModuleAsyncOptions extends Pick<ModuleMetadata, 'imports'> {
  /** Register the module globally. Defaults to `false`. */
  isGlobal?: boolean;
  /** Providers to inject into `useFactory`. */
  inject?: Array<InjectionToken | OptionalFactoryDependency>;
  /** Factory that resolves the engine options, e.g. from a ConfigService. */
  useFactory: (...args: unknown[]) => Promise<ApprovalEngineOptions> | ApprovalEngineOptions;
}

/**
 * NestJS module that provides a configured {@link ApprovalEngine} to the DI
 * container under the {@link APPROVAL_ENGINE} token.
 *
 * Register once at the application root:
 * ```ts
 * @Module({
 *   imports: [
 *     HierarchicalApprovalModule.forRoot({
 *       adapter: new MemoryAdapter(),
 *       isGlobal: true,
 *     }),
 *   ],
 * })
 * export class AppModule {}
 * ```
 *
 * Then inject it anywhere with {@link InjectApprovalEngine}. The module stops the
 * engine's escalation scheduler on application shutdown via `onModuleDestroy`
 * (enable Nest shutdown hooks with `app.enableShutdownHooks()`).
 */
export class HierarchicalApprovalModule implements OnModuleDestroy {
  constructor(private readonly engine: ApprovalEngine) {}

  static forRoot(options: HierarchicalApprovalModuleOptions): DynamicModule {
    const { isGlobal, ...engineOptions } = options;
    const engineProvider: Provider = {
      provide: APPROVAL_ENGINE,
      useValue: new ApprovalEngine(engineOptions),
    };
    return {
      module: HierarchicalApprovalModule,
      global: isGlobal,
      providers: [engineProvider],
      exports: [APPROVAL_ENGINE],
    };
  }

  static forRootAsync(options: HierarchicalApprovalModuleAsyncOptions): DynamicModule {
    const engineProvider: Provider = {
      provide: APPROVAL_ENGINE,
      useFactory: async (...args: unknown[]): Promise<ApprovalEngine> =>
        new ApprovalEngine(await options.useFactory(...args)),
      inject: options.inject ?? [],
    };
    return {
      module: HierarchicalApprovalModule,
      global: options.isGlobal,
      imports: options.imports ?? [],
      providers: [engineProvider],
      exports: [APPROVAL_ENGINE],
    };
  }

  /** Stops the engine's escalation scheduler when the Nest application shuts down. */
  async onModuleDestroy(): Promise<void> {
    await this.engine.shutdown();
  }
}

// Nest metadata is applied programmatically (rather than via `@Module`/`@Inject`
// decorator syntax) so this package compiles without `experimentalDecorators` in
// tsconfig. `Module({})` marks the class as a Nest module; the explicit
// constructor-injection token wires the engine in for the onModuleDestroy hook
// without relying on `emitDecoratorMetadata`.
Module({})(HierarchicalApprovalModule);
Inject(APPROVAL_ENGINE)(HierarchicalApprovalModule, undefined, 0);
