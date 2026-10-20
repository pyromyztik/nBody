import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.resolve(__dirname, '../dist');
const indexHtml = path.join(distDir, 'index.html');

if (fs.existsSync(indexHtml)) {
  // 1. Copy index.html to 404.html for GitHub Pages SPA routing fallback
  fs.copyFileSync(indexHtml, path.join(distDir, '404.html'));
  console.log('✓ Created dist/404.html for GitHub Pages SPA routing');

  // 2. Create sim/index.html so /sim can be served directly by GitHub Pages
  const simDir = path.join(distDir, 'sim');
  fs.mkdirSync(simDir, { recursive: true });
  fs.copyFileSync(indexHtml, path.join(simDir, 'index.html'));
  console.log('✓ Created dist/sim/index.html for /sim direct access');

  // 3. Ensure .nojekyll exists
  fs.writeFileSync(path.join(distDir, '.nojekyll'), '# GitHub Pages nojekyll\n');
  console.log('✓ Created dist/.nojekyll to disable Jekyll processing');
} else {
  console.error('Error: dist/index.html not found for postbuild step.');
}
