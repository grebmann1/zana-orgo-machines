import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { environment: 'jsdom', include: ['*.test.ts', '*.test.tsx'], coverage: { provider: 'v8', include: ['server.ts', 'connection.ts', 'app.tsx'], reporter: ['text', 'json-summary'], thresholds: { lines: 80, statements: 80, functions: 80, branches: 80 } } } });
