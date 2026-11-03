import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'wxt';

const E2E = process.env.LEAD_SCRAPER_E2E === '1';

export default defineConfig({
  srcDir: 'src',
  // A visible folder, since macOS file pickers hide names starting with a dot.
  // Keep this path stable: Chrome ties an unpacked extension's stored leads to its folder.
  outDir: E2E ? 'output-e2e' : 'output',
  modules: ['@wxt-dev/module-react'],
  vite: () => ({ plugins: [tailwindcss()] }),
  manifest: {
    name: 'Lead Scraper',
    description: 'Collect, verify, and score business leads from Google Maps.',
    permissions: ['storage', 'unlimitedStorage', 'alarms', 'notifications', 'sidePanel'],
    // Browser tests can't click Chrome's permission prompt, so their build allows localhost up front.
    host_permissions: ['https://www.google.com/*', 'https://cloudflare-dns.com/*', ...(E2E ? ['http://localhost/*'] : [])],
    // Business websites and webhook targets are requested at runtime.
    optional_host_permissions: ['http://*/*', 'https://*/*'],
    action: { default_title: 'Open Lead Scraper' },
  },
});
