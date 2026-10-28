import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

const dirname = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
    root: dirname,
    plugins: [react()],
    server: {
        port: 5173,
        proxy: {
            '/api': 'http://localhost:8787',
        },
    },
    build: {
        outDir: 'dist',
        emptyOutDir: true,
    },
});
