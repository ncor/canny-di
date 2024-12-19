import chalk from "chalk";

type MaybePromise<T> = T | Promise<T>;
type ElementType<T> = T extends (infer E)[] ? E : never;
type PairToRecord<K extends string, V> = { [key in K]: V };
type Remap<
    A extends Record<string, any>,
    B extends Partial<Record<keyof A, string>>,
> = { [K in keyof A as K extends keyof B ? B[K] & string : K]: A[K] };

function assert(condition: any, message?: string): asserts condition {
    if (!condition) throw new Error(message);
}

const asyncify =
    <A extends any[], T>(fn: (...args: A) => MaybePromise<T>) =>
    async (...args: A) =>
        await fn(...args);

const promisify = <T>(x: MaybePromise<T>): Promise<T> =>
    x instanceof Promise ? x : Promise.resolve(x);

const withoutElementsFrom = <T>(it: T[], xs: T[]) =>
    xs.filter((x) => !it.includes(x));

const containsOnlyElementsFrom = <T>(it: T[], xs: T[]) =>
    xs.every((x) => it.includes(x));

const unique = <T>(xs: T[]) => Array.from(new Set(xs));

/**
 * Provider.
 */

type ResolutionLifetime = "transient" | "singleton";

type Resolver<DepedencyContainer extends Record<string, any>, Instance> = (
    container: DepedencyContainer,
) => MaybePromise<Instance>;

type Disposer<Instance> = (instance: Instance) => any;

type Resolution<Instance> = Promise<Instance>;

const DEFAULT_RESOLUTION_LIFETIME: ResolutionLifetime = "transient";

const SINGLETON_CACHE_KEY = "_unsafeSingleton";

type ReservedCacheKey = typeof SINGLETON_CACHE_KEY;

type ReservedCacheKeyGuard<CacheKey> = CacheKey extends ReservedCacheKey
    ? "This key is reserved"
    : CacheKey;

type ResolveOpts = {
    /**
     * The key that will be used to retrieve or save an entity in cache.
     */
    cacheKey?: string;
    /**
     * The time in milliseconds during which the instance will be available.
     */
    ttl?: number;
};

class ResolutionCacheEntry<Instance> {
    resolution: Resolution<Instance>;
    private disposer?: Disposer<Instance>;
    private disposeTimeout?: NodeJS.Timeout;

    constructor(opts: {
        resolution: Resolution<Instance>;
        disposer?: Disposer<Instance>;
        ttl?: number;
    }) {
        this.resolution = opts.resolution;
        this.disposer = opts.disposer;

        if (this.disposer && opts.ttl) this.startDisposeTimer(opts.ttl);
    }

    private async startDisposeTimer(ttl: number) {
        if (this.disposer) {
            const instance = await this.resolution;
            this.disposeTimeout = setTimeout(
                () => this.disposer!(instance),
                ttl,
            );
        }
    }

    private stopDisposeTimeout() {
        this.disposeTimeout &&= void clearTimeout(this.disposeTimeout);
    }

    async dispose() {
        this.stopDisposeTimeout();
        await this.disposer?.(await this.resolution);
    }
}

class ResolutionCache<Instance> {
    private map: Map<string, ResolutionCacheEntry<Instance>> = new Map();

    private makeEntryCleaner(
        keyToDelete: string,
        disposer?: Disposer<Instance>,
    ) {
        return async (instance: Instance) => {
            await disposer?.(instance);
            this.map.delete(keyToDelete);
        };
    }

    set(opts: {
        key: string;
        resolution: Resolution<Instance>;
        disposer?: Disposer<Instance>;
        ttl?: number;
    }) {
        const entry = new ResolutionCacheEntry({
            resolution: opts.resolution,
            disposer: this.makeEntryCleaner(opts.key, opts.disposer),
            ttl: opts.ttl,
        });

        this.map.set(opts.key, entry);
    }

    get(key: string) {
        return this.map.get(key);
    }

    values() {
        return Array.from(this.map.values());
    }

    inspect() {
        return this.map;
    }
}

class Provider<
    Instance = any,
    DependencyContainer extends Record<string, any> = Record<string, any>,
    Id extends string = string,
> {
    id: Id;
    private resolver: Resolver<DependencyContainer, Instance>;
    dependencies: (keyof DependencyContainer)[];
    private disposer?: Disposer<Instance>;
    lifetime: ResolutionLifetime;
    private cache: ResolutionCache<Instance> = new ResolutionCache();
    isSingleton: boolean;

    constructor(opts: {
        id: Id;
        resolver: Resolver<DependencyContainer, Instance>;
        dependencies: (keyof DependencyContainer)[];
        disposer?: Disposer<Instance>;
        lifetime?: ResolutionLifetime;
    }) {
        this.id = opts.id;
        this.resolver = opts.resolver;
        this.dependencies = opts.dependencies;
        this.disposer = opts.disposer;
        this.lifetime = opts.lifetime || DEFAULT_RESOLUTION_LIFETIME;
        this.isSingleton = this.lifetime === "singleton";
    }

    private createResolution(container: DependencyContainer) {
        return asyncify(this.resolver)(container);
    }

    resolveFromCache(key?: string) {
        return this.cache.get(key || SINGLETON_CACHE_KEY)?.resolution;
    }

    async resolveFromContainer(
        container: DependencyContainer,
        opts?: ResolveOpts,
    ) {
        let key =
            opts?.cacheKey || (this.isSingleton ? SINGLETON_CACHE_KEY : "");

        if (key) {
            const resolution = this.createResolution(container);
            this.cache.set({
                key: SINGLETON_CACHE_KEY,
                resolution,
                disposer: this.disposer,
                ttl: opts?.ttl,
            });

            return resolution;
        }

        return this.createResolution(container);
    }

    async dispose<CacheKey extends string>(
        cacheKey?: ReservedCacheKeyGuard<CacheKey>,
    ) {
        if (!cacheKey)
            await Promise.all(this.cache.values().map((e) => e.dispose()));
        await this.cache.get(cacheKey!)?.dispose?.();
    }

    clone() {
        return new Provider({
            id: this.id,
            resolver: this.resolver,
            dependencies: this.dependencies,
            disposer: this.disposer,
            lifetime: this.lifetime,
        });
    }

    inspect() {
        return Object.freeze({
            cache: this.cache.inspect(),
        });
    }
}

/**
 * Container.
 */

type RegistryShape = Record<string, Provider>;

type ExistingIdsGuard<N, E> = N extends E
    ? "Provider with this id is already registered."
    : N;

type InferProviderInstance<P> = P extends Provider<infer I> ? I : never;

type InferProviderDependencyContainer<P> =
    P extends Provider<any, infer D> ? Partial<D> : never;

type InferProviderInstanceMap<R extends RegistryShape> = {
    [I in keyof R]: InferProviderInstance<R[I]>;
};

type InferProviderCacheMap<R extends RegistryShape> = {
    [I in keyof R]: Map<
        string,
        ResolutionCacheEntry<InferProviderInstance<R[I]>>
    >;
};

type DependencyContainerFrom<
    D extends (keyof R)[],
    R extends RegistryShape,
> = D extends [] ? {} : InferProviderInstanceMap<Pick<R, ElementType<D>>>;

type InferDependencyContainerFromResolver<R> =
    R extends Resolver<infer D, any> ? D : never;

type InferDependenciesFromResolver<R> =
    (keyof InferDependencyContainerFromResolver<R>)[];

type WithProvider<R extends RegistryShape, P extends Provider<any, any>> = R &
    PairToRecord<P["id"], P>;

type ContainerResolveOpts<
    Id extends keyof Registry,
    Registry extends RegistryShape,
> = ResolveOpts & {
    /**
     * Already resolved dependencies that will be passed
     * to the resolver.
     */
    with?: InferProviderDependencyContainer<Registry[Id]>;
};

const DEFAULT_CONTAINER_NAME = "app";

/**
 * Registers and resolves instances via dependency injection.
 */
export class Container<Registry extends RegistryShape = {}> {
    private registryEntries: [string, Provider][];
    private registryKeys: string[];

    constructor(protected registry = {} as Registry) {
        this.registryEntries = Object.entries(this.registry);
        this.registryKeys = Object.keys(this.registry);
    }

    /**
     * Registers a new provider, which all subsequent ones will have access to.
     *
     * ```ts
     * declare function connectToDatabase(opts: {
     *     config: { databaseUrl: string }
     * }): DatabaseConnection;
     *
     * .register("databaseConnection", {
     *     deps: ["config"],
     *     resolve: connectToDatabase,
     *     dispose: c => c.disconnect(),
     *     lifetime: "singleton"
     * })
     * ```
     */
    register<
        Id extends string,
        Instance,
        Dependencies extends (keyof Registry)[] = [],
    >(
        id: ExistingIdsGuard<Id, keyof Registry>,
        opts: {
            /**
             * A function that takes an object with resolved dependencies
             * and returns an instance. Can be async.
             */
            resolve: Resolver<
                DependencyContainerFrom<Dependencies, Registry>,
                Instance
            >;
            /**
             * A list of dependencies as provider identifiers.
             */
            deps?: Dependencies;
            /**
             * `"singleton"` forces the provider to store the instance
             * in the cache until it is disposed.
             * `"transient"` (default) forces the provider to create
             * a new instance each time it is requested without storing it
             * (if the cache key is not specified explicitly).
             */
            lifetime?: ResolutionLifetime;
            /**
             * A function that will be run if a disposition (cleanup/exit)
             * is requested.
             */
            dispose?: Disposer<Instance>;
        },
    ) {
        assert(
            !this.registryKeys.includes(id),
            "Existing identifiers cannot be used as a new one.",
        );
        assert(
            !opts.deps ||
                containsOnlyElementsFrom(this.registryKeys, opts.deps),
            "The dependency list must contain only registered identifiers.",
        );

        const provider = new Provider({
            id,
            resolver: opts.resolve,
            dependencies: unique(
                opts.deps || [],
            ) as InferDependenciesFromResolver<typeof opts.resolve>,
            lifetime: opts.lifetime,
            disposer: opts.dispose,
        });

        return new Container<WithProvider<Registry, typeof provider>>({
            ...this.registry,
            [id]: provider,
        });
    }

    private async resolveDependencyContainer(ids: (keyof Registry)[]) {
        return Object.fromEntries(
            await Promise.all(
                ids.map(async (id) => [id, await this.resolve(id)]),
            ),
        ) as Record<keyof Registry, Provider>;
    }

    /**
     * Resolves an instance by provider identifier.
     *
     * ```
     * requestScope.resolve("userService", {
     *     cacheKey: ipAddress,
     *     ttl: 60_000,
     *     with: {
     *         userRepository: resolvedUserRepository
     *     },
     * })
     * ```
     */
    async resolve<Id extends keyof Registry>(
        id: Id,
        opts?: ContainerResolveOpts<Id, Registry>,
    ): Promise<InferProviderInstance<Registry[Id]>> {
        const provider = this.registry[id];

        if (provider.isSingleton || opts?.cacheKey) {
            const cachedResolution = provider.resolveFromCache(opts?.cacheKey);
            if (cachedResolution) return cachedResolution;
        }

        if (provider.dependencies.length === 0)
            return provider.resolveFromContainer({}, opts);

        const dependenciesToResolve = opts?.with
            ? withoutElementsFrom(
                  Object.keys(opts.with!),
                  provider.dependencies,
              )
            : provider.dependencies;

        const resolvedDependencyContainer =
            await this.resolveDependencyContainer(dependenciesToResolve);

        const dependencyContainer = {
            ...resolvedDependencyContainer,
            ...(opts?.with || {}),
        };

        return provider.resolveFromContainer(dependencyContainer, opts);
    }
    /**
     * Returns a function that will trigger instance resolution.
     *
     * ```ts
     * const heavyServiceThunk = container.resolveLazy("heavyService");
     * // ...
     * const heavyService = await heavyServiceThunk();
     * ```
     */
    async resolveLazy<Id extends keyof Registry>(
        id: Id,
        opts?: ContainerResolveOpts<Id, Registry>,
    ) {
        return () => this.resolve(id, opts);
    }

    /**
     * Resolves all instances and returns a map of them.
     *
     * ```ts
     * const modules = await di.resolveAll();
     * // ...
     * modules.someService
     * ```
     */
    async resolveAll() {
        return Object.fromEntries(
            await Promise.all(
                this.registryKeys.map(async (i) => [i, await this.resolve(i)]),
            ),
        ) as InferProviderInstanceMap<Registry>;
    }

    private findDependent(id: keyof Registry) {
        return this.registryEntries.reduce<(keyof Registry)[]>(
            (acc, [i, p]) => {
                if (p.dependencies.includes(id as string)) {
                    acc.push(i);
                }
                return acc;
            },
            [],
        );
    }

    /**
     * Disposes (calls the exit function of)
     * all cached entities of the provider by its identifier.
     *
     * ```ts
     * interface BrokerConnection {
     *     disconnect(): Promise<void>;
     * }
     *
     * .register("brokerConnection", {
     *     dispose: c => c.disconnect()
     * })
     *
     * onTerminate(async () => {
     *     await di.dispose("brokerConnection");
     *     // other cleanups...
     * })
     * ```
     */
    async dispose(
        id: keyof Registry,
        opts?: {
            /**
             * The key that will be used to retrieve the entity from the cache
             * for disposition.
             */
            cacheKey?: string;
            /**
             * Determines whether to dispose instances of
             * the entire branch of dependent providers.
             */
            propagate?: boolean;
            /**
             * Determines whether to only dispose instances of providers
             * that are directly dependent.
             */
            propagateOnce?: boolean;
        },
    ) {
        await this.registry[id].dispose(opts?.cacheKey);

        if (opts?.propagate || opts?.propagateOnce) {
            const dependent = this.findDependent(id);

            await Promise.all(
                dependent.map((p) =>
                    this.dispose(p, { propagate: opts.propagate }),
                ),
            );
        }
    }

    /**
     * Disposes (calls the exit function of) all cached entities
     * of all providers.
     *
     * ```ts
     * onTerminate(async () => {
     *     await di.disposeAll();
     *     // other cleanups...
     * })
     * ```
     */
    async disposeAll() {
        await Promise.all(this.registryKeys.map((i) => this.dispose(i)));
    }

    /**
     * Creates a new container with a new registry of cloned providers,
     * including cache.
     *
     * ```ts
     * const requestScope = di.clone();
     * // ...
     * app.get("/profile", requestScope.resolve("profileController").get)
     * ```
     */
    clone() {
        return new Container(
            Object.fromEntries(
                this.registryEntries.map(([i, p]) => [i, p.clone()]),
            ) as Registry,
        );
    }

    /**
     * Concatenates own registry with the registry of another container.
     * By default, preserves references to providers, but provides
     * the ability to clone both registers.
     *
     * ```ts
     * usersDi.merge(messagesDi).provide("someAggregate", { ... });
     * ```
     */
    merge<OtherRegistry extends RegistryShape>(
        other: Container<OtherRegistry>,
        opts?: {
            /**
             * Determines whether to clone both containers before merging.
             */
            clone?: boolean;
        },
    ) {
        const first = opts?.clone ? this.clone().registry : this.registry;
        const second = opts?.clone ? other.clone().registry : other.registry;

        return new Container({
            ...first,
            ...second,
        });
    }

    /**
     * Returns the current state of the container.
     *
     * ```ts
     * onError((error) => sendReportMessage({
     *     error,
     *     modules: di.inspect()
     * }))
     * ```
     */
    inspect() {
        return Object.freeze({
            registry: this.registry,
            cache: Object.fromEntries(
                this.registryEntries.map(([id, provider]) => [
                    id,
                    provider.inspect().cache,
                ]),
            ) as InferProviderCacheMap<Registry>,
        });
    }

    /**
     * Alias for `register`.
     */
    provide = this.register;

    /**
     * Alias for `resolve`.
     */
    get = this.resolve;
    /**
     * Alias for `resolve`.
     */
    build = this.resolve;
    /**
     * Alias for `resolve`.
     */
    fetch = this.resolve;
    /**
     * Alias for `resolve`.
     */
    retrieve = this.resolve;

    /**
     * Alias for `resolveLazy`.
     */
    lazy = this.resolveLazy;

    /**
     * Alias for `resolveAll`.
     */
    getAll = this.resolveAll;
    /**
     * Alias for `resolveAll`.
     */
    buildAll = this.resolveAll;
    /**
     * Alias for `resolveAll`.
     */
    fetchAll = this.resolveAll;
    /**
     * Alias for `resolveAll`.
     */
    retrieveAll = this.resolveAll;

    /**
     * Alias for `dispose`.
     */
    stop = this.dispose;
    /**
     * Alias for `dispose`.
     */
    exit = this.dispose;
    /**
     * Alias for `dispose`.
     */
    terminate = this.dispose;

    /**
     * Alias for `disposeAll`.
     */
    rolldown = this.disposeAll;
    /**
     * Alias for `disposeAll`.
     */
    stopAll = this.disposeAll;
    /**
     * Alias for `disposeAll`.
     */
    terminateAll = this.disposeAll;

    /**
     * Alias for `clone`.
     */
    fork = this.clone;
    /**
     * Alias for `clone`.
     */
    duplicate = this.clone;
    /**
     * Alias for `clone`.
     */
    scope = this.clone;

    /**
     * Alias for `merge`.
     */
    and = this.merge;
    /**
     * Alias for `merge`.
     */
    with = this.merge;
}

export const register: Container["register"] = (...args) =>
    new Container().register(...args);

export const provide: Container["register"] = (...args) =>
    new Container().register(...args);
