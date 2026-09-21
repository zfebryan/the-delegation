import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import {defineConfig, loadEnv} from 'vite';

export default defineConfig(({mode}) => {
  const env = loadEnv(mode, '.', '');
  return {
    base: '/the-delegation/',
    plugins: [react(), tailwindcss()],
    define: {
      'process.env.GEMINI_API_KEY': JSON.stringify(env.GEMINI_API_KEY),
      // External kanban board transport (see src/integration/transport/config.ts).
      // Both the VITE_ prefixed and the plain name are accepted, so a value set only in
      // the shell (e.g. CI/Vercel) still reaches the client bundle.
      'import.meta.env.VITE_KANBAN_WS_URL': JSON.stringify(env.VITE_KANBAN_WS_URL ?? env.KANBAN_WS_URL ?? ''),
      'import.meta.env.VITE_KANBAN_TRANSPORT_MODE': JSON.stringify(env.VITE_KANBAN_TRANSPORT_MODE ?? env.KANBAN_TRANSPORT_MODE ?? ''),
      'import.meta.env.VITE_KANBAN_AGENT_MAP': JSON.stringify(env.VITE_KANBAN_AGENT_MAP ?? env.KANBAN_AGENT_MAP ?? ''),
      'import.meta.env.VITE_KANBAN_BRIDGE_ADAPTER': JSON.stringify(env.VITE_KANBAN_BRIDGE_ADAPTER ?? env.KANBAN_BRIDGE_ADAPTER ?? ''),
      // Resync budget: how long a `board.snapshot.request` waits for the bridge `snapshot` reply,
      // and how many attempts one resync may make (see BridgeAdapter/KanbanTransport §7.8).
      'import.meta.env.VITE_KANBAN_WS_SNAPSHOT_TIMEOUT_MS': JSON.stringify(env.VITE_KANBAN_WS_SNAPSHOT_TIMEOUT_MS ?? env.KANBAN_WS_SNAPSHOT_TIMEOUT_MS ?? ''),
      'import.meta.env.VITE_KANBAN_WS_SNAPSHOT_ATTEMPTS': JSON.stringify(env.VITE_KANBAN_WS_SNAPSHOT_ATTEMPTS ?? env.KANBAN_WS_SNAPSHOT_ATTEMPTS ?? ''),
    },
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      },
    },
    server: {
      // HMR is disabled in AI Studio via DISABLE_HMR env var.
      // Do not modifyâfile watching is disabled to prevent flickering during agent edits.
      hmr: process.env.DISABLE_HMR !== 'true',
    },
  };
});
