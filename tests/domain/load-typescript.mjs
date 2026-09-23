import { existsSync } from "node:fs";
import { registerHooks } from "node:module";
import { fileURLToPath } from "node:url";

// Только тестовый процесс: поддержка extensionless-импортов чистого ядра и DTO.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (
      context.parentURL?.startsWith("file:") &&
      specifier.startsWith(".") &&
      !/\.[cm]?[jt]sx?$/.test(specifier)
    ) {
      for (const suffix of [".ts", "/index.ts"]) {
        const url = new URL(`${specifier}${suffix}`, context.parentURL);
        if (existsSync(fileURLToPath(url))) return nextResolve(url.href, context);
      }
    }
    return nextResolve(specifier, context);
  },
});
