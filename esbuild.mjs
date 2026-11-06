import {globSync, rmSync} from 'node:fs';
import {build} from 'esbuild';

const production = process.argv.includes('--production');

if (process.argv.includes('--tests')) {
  // Unbundled, so every integration test file shares one instance of each harness module. The
  // vitest files stay out: vitest runs them from source.
  const entryPoints = globSync(['src/**/*.ts', 'scripts/**/*.ts']).filter(
    (file) => !file.endsWith('.test.ts') || file.includes('test-integration')
  );
  // The runner launches every test file in out/, so a deleted test must not stay there.
  rmSync('out', {recursive: true, force: true});
  await build({
    entryPoints,
    outdir: 'out',
    outbase: '.',
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    sourcemap: true,
    logLevel: 'info'
  });
} else {
  await build({
    entryPoints: ['src/extension.ts'],
    outfile: 'dist/extension.js',
    bundle: true,
    platform: 'node',
    format: 'cjs',
    // VS Code 1.91 runs extensions on Node 20.
    target: 'node20',
    external: ['vscode'],
    minify: production,
    sourcemap: !production,
    logLevel: 'info'
  });
  // The results webview's script. The panel inlines it under a per-render nonce.
  await build({
    entryPoints: ['media/results.ts'],
    outfile: 'dist/results.js',
    bundle: true,
    platform: 'browser',
    format: 'iife',
    target: 'es2022',
    minify: production,
    logLevel: 'info'
  });
}
