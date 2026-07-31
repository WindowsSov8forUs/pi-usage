import { registerHooks } from "node:module";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

function resolveInstalled(specifier, fallback) {
  try {
    return fileURLToPath(import.meta.resolve(specifier));
  } catch {
    return fallback;
  }
}

const globalPackageRoot = process.env.APPDATA
  ? join(process.env.APPDATA, "npm", "node_modules", "@earendil-works", "pi-coding-agent")
  : undefined;
const packageRoot = process.env.PI_PACKAGE_ROOT ?? globalPackageRoot ?? "";
const aliases = new Map([
  [
    "@earendil-works/pi-tui",
    resolveInstalled(
      "@earendil-works/pi-tui",
      join(packageRoot, "node_modules", "@earendil-works", "pi-tui", "dist", "index.js"),
    ),
  ],
]);

registerHooks({
  resolve(specifier, context, nextResolve) {
    const target = aliases.get(specifier);
    if (target) return { shortCircuit: true, url: pathToFileURL(target).href };
    return nextResolve(specifier, context);
  },
});
