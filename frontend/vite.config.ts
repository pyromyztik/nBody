import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ mode }) => ({
  base: process.env.VITE_BASE_PATH ?? (mode === 'production' ? '/nBody/' : '/'),
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: false
  }
}));
