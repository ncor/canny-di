Completely type-safe, async-first IoC container without bullshit.

```ts
const di = new Container()
    .register("config", {
        resolve: getEnv
    })
    .register("databaseConnection", {
        deps: ["config"],
        resolve: ({ databaseUrl }) =>
            connectToDatabase(databaseUrl),
        dispose: connection =>
            connection.disconnect(),
        lifetime: "singleton"
    })
    .register("todoRepository", {
        deps: ["databaseConnection"],
        resolve: makeTodoRepository
    })
    .register("todoService", {
        deps: ["todoRepository"],
        resolve: makeTodoService
    });

const requestDi = di.clone()
    .provide("todoController", {
        deps: ["todoService"],
        resolve: makeTodoController
    });

app.use(async (req, res) => {
    const todoController = await requestDi.resolve("todoController", {
        cacheKey: computeClientId(req),
        ttl: 60_000
    });
    todoController.handle(req, res);
})
```

### Features
- **Complete type-safety:** The dependency tree, providers, their resolvers and identifiers are fully typed, which helps to avoid bugs in container construction.
- **Async-first:** All resolvers (constructors) are called in an asynchronous context by default, which allows you to use any instance creation methods.
- **Simple integration:** The library does not force modification of the existing code base or any modifications to the existing injection system. You simply import constructors and connect them together in one compact place.
- **Implementation agnostic:** In the context of a container, a constructor is just a function that returns an instance. In it, we can use class constructors, other functions, or simply return a plain value.
- **Advanced caching:** In addition to being able to define singleton providers, we can retrieve entities by cache key and save them for a certain period of time (TTL), which can reduce memory usage and response time.

### What it doesn't support
- **In-place/independent registration:** There's no set of utilities for registering constructors using decorators or other registration methods outside the tree.
- **Circular dependencies:** The resolver does not contain a check for cyclic dependencies, just as the type system does not provide the ability to safely establish such dependencies.
- **Generator constructors:** Although the container supports both synchronous and asynchronous resolvers, there is currently no support for generator functions.

# Documentation

Coming soon.