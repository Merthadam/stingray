import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
export default defineConfig({ base: './', plugins: [react(), { name: 'local-dev-csp', transformIndexHtml(html, ctx) { return ctx.server ? html.replace("script-src 'self';", "script-src 'self' 'unsafe-inline';") : html; } }], server: { host: '127.0.0.1', port: 5178, strictPort: true } });
