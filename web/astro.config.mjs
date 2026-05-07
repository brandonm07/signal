import { defineConfig } from 'astro/config';
import tailwind from '@astrojs/tailwind';

export default defineConfig({
  site: 'https://signaladvise.com',
  integrations: [tailwind({ applyBaseStyles: false })],
});
