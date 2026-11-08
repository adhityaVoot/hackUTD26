import {defineConfig} from 'vite';
export default defineConfig({build:{rollupOptions:{output:{manualChunks(id){if(id.includes('/node_modules/spacetimedb/'))return 'spacetime';if(id.includes('/node_modules/framer-motion/')||id.includes('/node_modules/motion')||id.includes('/node_modules/@motionone/'))return 'motion';if(id.includes('/node_modules/@radix-ui/'))return 'ui-primitives';}}}}});
