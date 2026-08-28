import { defineConfig } from 'vite';
export default defineConfig({
  server: { port: 5178 },
  // Workspace packages are rebuilt in place by tsc; pre-bundling them makes
  // Vite serve a stale copy after every rebuild.
  optimizeDeps: { exclude: ['@corerus/chorus-core', '@corerus/chorus-web'] },
});
