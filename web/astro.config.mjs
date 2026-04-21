import { defineConfig } from 'astro/config';
import tailwind from '@astrojs/tailwind';

export default defineConfig({
  site: 'https://signaladvisory.com',
  integrations: [tailwind({ applyBaseStyles: false })],
});
