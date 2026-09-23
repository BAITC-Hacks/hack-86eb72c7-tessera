import { existsSync } from "node:fs";
import { registerHooks } from "node:module";

// Разрешение расширений Next.js ограничено чистым ядром и его DTO.
const roots = [
  new URL("../../lib/domain/forecast/", import.meta.url).href,
  new URL("../../lib/domain/replenishment/", import.meta.url).href,
  new URL("../../lib/contracts/", import.meta.url).href,
];

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (
      context.parentURL &&
      roots.some((root) => context.parentURL.startsWith(root)) &&
      specifier.startsWith(".") &&
      !/\.[cm]?[jt]sx?$/.test(specifier)
    ) {
      for (const suffix of [".ts", "/index.ts"]) {
        const url = new URL(`${specifier}${suffix}`, context.parentURL);
        if (roots.some((root) => url.href.startsWith(root)) && existsSync(fileURLToPath(url))) {
          return nextResolve(url.href, context);
        }
      }
    }
    return nextResolve(specifier, context);
  },
});
