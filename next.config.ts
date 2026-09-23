import type { NextConfig } from "next";
import { realpathSync } from "node:fs";
import { dirname, join, relative } from "node:path";
// Общий корень нужен только для локального node_modules, подключённого symlink.
let root = process.cwd();
const dependencies = realpathSync(join(root, "node_modules"));
while (relative(root, dependencies).startsWith("..")) root = dirname(root);
const nextConfig: NextConfig = { turbopack: { root } };
export default nextConfig;
