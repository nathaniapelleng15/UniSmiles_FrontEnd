import path from 'path';
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ mode }) => {
    const env = loadEnv(mode, '.', '');
    return {
      server: {
        port: 3000,
        host: '0.0.0.0',
        allowedHosts: true
      },
      plugins: [react()],
      build: {
        rollupOptions: {
          // Dua entry: aplikasi photobooth dan halaman uji cetak Niimbot.
          // Halaman uji harus jadi entry supaya Vite mengompilasi skrip
          // TypeScript-nya; berkas .ts di public/ hanya disalin mentah dan
          // tidak bisa dimuat browser.
          input: {
            main: path.resolve(__dirname, 'index.html'),
            niimbot: path.resolve(__dirname, 'niimbot-test.html'),
          },
        },
      },
      define: {
        'process.env.API_KEY': JSON.stringify(env.GEMINI_API_KEY),
        'process.env.GEMINI_API_KEY': JSON.stringify(env.GEMINI_API_KEY),
        'import.meta.env.AUTO_PRINT_ENABLED': JSON.stringify(env.AUTO_PRINT_ENABLED)
      },
      resolve: {
        alias: {
          '@': path.resolve(__dirname, '.'),
        }
      }
    };
});
