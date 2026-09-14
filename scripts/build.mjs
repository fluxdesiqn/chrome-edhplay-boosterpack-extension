// Builds the three extension bundles into dist/ and copies static files.
// Usage: node scripts/build.mjs [--watch]
import { build } from 'vite';
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');
const watch = process.argv.includes('--watch');
const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));

const alias = {
  '@shared': path.join(root, 'src/shared'),
  '@main': path.join(root, 'src/main'),
  '@ui': path.join(root, 'src/ui'),
};

/** @returns {import('vite').InlineConfig} */
function target(name, entry, format, extra = {}) {
  return {
    configFile: false,
    root,
    resolve: { alias },
    define: { __EXT_VERSION__: JSON.stringify(pkg.version), 'process.env.NODE_ENV': JSON.stringify('production') },
    esbuild: { jsx: 'automatic', jsxImportSource: 'preact' },
    build: {
      outDir: dist,
      emptyOutDir: false,
      minify: false,
      sourcemap: true,
      target: 'es2022',
      watch: watch ? {} : null,
      codeSplitting: false,
      lib: { entry, name: name.replace(/-/g, '_'), formats: [format], fileName: () => `${name}.js` },
      rollupOptions: { output: { extend: true } },
      ...extra,
    },
    logLevel: 'info',
  };
}

rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });
cpSync(path.join(root, 'manifest.json'), path.join(dist, 'manifest.json'));
cpSync(path.join(root, 'public'), dist, { recursive: true });

// Keep manifest version in sync with package.json
const manifest = JSON.parse(readFileSync(path.join(dist, 'manifest.json'), 'utf8'));
manifest.version = pkg.version;
writeFileSync(path.join(dist, 'manifest.json'), JSON.stringify(manifest, null, 2));

await Promise.all([
  build(target('main-world', path.join(root, 'src/main/index.ts'), 'iife')),
  build(target('content', path.join(root, 'src/content/index.ts'), 'iife')),
  build(target('background', path.join(root, 'src/background/index.ts'), 'es')),
]);
if (!watch) console.log('Built extension into dist/');
