import { readFile } from 'node:fs/promises';
import { defineConfig, defaultClientConditions, type Plugin } from 'vite';

const API = 'http://127.0.0.1:8080';
const REGIONS = new URL('../../packages/geo/data/map-regions.geojson', import.meta.url);

/** Dev only: serve the region borders from the repo so `?demo=1` works without the API. */
function regionsFromRepo(): Plugin {
  return {
    name: 'horizont-regions',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/api/regions.geojson', (_req, res) => {
        readFile(REGIONS)
          .then((body) => {
            res.setHeader('Content-Type', 'application/geo+json');
            res.end(body);
          })
          .catch((err: unknown) => {
            res.statusCode = 500;
            res.end(String(err));
          });
      });
    },
  };
}

export default defineConfig({
  root: import.meta.dirname,
  plugins: [regionsFromRepo()],
  resolve: { conditions: ['source', ...defaultClientConditions] },
  worker: { format: 'es' },
  build: { outDir: 'dist', emptyOutDir: true, target: 'es2022', chunkSizeWarningLimit: 1200 },
  server: {
    proxy: {
      '/api': { target: API, changeOrigin: false },
      '/auth': { target: API, changeOrigin: false },
      '/ws': { target: API.replace('http', 'ws'), ws: true },
    },
  },
});
