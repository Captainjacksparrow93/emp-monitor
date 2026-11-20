import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: { output: { manualChunks: { charts: ['recharts'], react: ['react', 'react-dom', 'react-router-dom'] } } },
  },
  server: {
    // local dev: proxy API calls to the server
    proxy: { '/api': 'http://localhost:8080' },
  },
});
