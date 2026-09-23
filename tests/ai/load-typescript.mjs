import { registerHooks } from "node:module";

// The application uses extensionless TypeScript imports for Next's bundler.
// Resolve those imports only inside this Node test process.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "server-only") return { url: "data:text/javascript,", shortCircuit: true };
    if (context.parentURL?.includes("/lib/ai/") &&
        (specifier.startsWith("./") || specifier === "../contracts/primitives") &&
        !/\.[cm]?[jt]s$/.test(specifier)) {
      return nextResolve(`${specifier}.ts`, context);
    }
    return nextResolve(specifier, context);
  },
});
