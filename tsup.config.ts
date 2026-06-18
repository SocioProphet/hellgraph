import { defineConfig } from 'tsup'

// Dual ESM + CJS build so both ESM consumers (e.g. the Noetica agent-machine,
// nodenext) and CJS consumers get real named exports. Bundling into a single
// file per format also resolves the engine's mixed extensionless/.js relative
// imports cleanly.
export default defineConfig({
  entry: { index: 'ts/src/index.ts' },
  outDir: 'ts/dist',
  format: ['esm', 'cjs'],
  dts: true,
  sourcemap: false,
  clean: true,
  splitting: false,
  treeshake: true,
  platform: 'node',
  target: 'node18',
  // rocksdb is an optional NATIVE dependency: keep it external so the dynamic
  // import resolves from the consumer's node_modules (and its node-gyp-build
  // prebuild path works), and so absence degrades gracefully to the JSONL
  // backend instead of breaking the bundle.
  external: ['rocksdb'],
})
