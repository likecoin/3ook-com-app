// ESM resolve hook used by probe.mjs. Runs on Node's loader thread, so it gets
// the stub table via initialize(data) rather than sharing module scope.
import { existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

let stubs = {};

export function initialize(data) {
  stubs = data ?? {};
}

// Metro resolves extensionless relative imports and picks the platform variant
// (`./url-storage` → `url-storage.native.ts`). Node ESM does neither, so
// replicate the slice of Metro's resolution order this repo actually relies on.
const SUFFIXES = ['.native.ts', '.ts', '.native.tsx', '.tsx', '.native.js', '.js',
  '/index.native.ts', '/index.ts', '/index.js'];

export async function resolve(specifier, context, next) {
  const hit = stubs[specifier];
  if (hit) return { url: hit, shortCircuit: true };
  // Subpath import of a stubbed native package (e.g. `expo-file-system/next`).
  for (const [pkg, url] of Object.entries(stubs)) {
    if (specifier.startsWith(pkg + '/')) return { url, shortCircuit: true };
  }

  if (specifier.startsWith('.') && context.parentURL?.startsWith('file:')) {
    const base = fileURLToPath(new URL(specifier, context.parentURL));
    if (!existsSync(base)) {
      for (const suffix of SUFFIXES) {
        if (existsSync(base + suffix)) {
          return { url: pathToFileURL(base + suffix).href, format: 'module-typescript', shortCircuit: true };
        }
      }
    }
  }

  const resolved = await next(specifier, context);
  // package.json has no `"type": "module"`, so Node would reparse every .ts as
  // CommonJS first and warn. Declare the format up front instead.
  if (resolved?.url?.endsWith?.('.ts') || resolved?.url?.endsWith?.('.tsx')) {
    return { ...resolved, format: 'module-typescript' };
  }
  return resolved;
}
