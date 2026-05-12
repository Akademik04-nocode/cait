import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const productsDir = join(import.meta.dirname, '..', 'src', 'content', 'products');
const outputFile = join(import.meta.dirname, '..', 'public', '_redirects');

const files = readdirSync(productsDir).filter((f) => f.endsWith('.json'));
const lines = [];

for (const file of files) {
  const data = JSON.parse(readFileSync(join(productsDir, file), 'utf-8'));
  if (data.sourceUrl && data.slug) {
    try {
      const url = new URL(data.sourceUrl);
      const oldPath = url.pathname.replace(/\/$/, '') + '/';
      const newPath = `/katalog/${data.slug}/`;
      if (oldPath !== newPath && oldPath !== '/') {
        lines.push(`${oldPath}  ${newPath}  301`);
      }
    } catch {
      // skip invalid URLs
    }
  }
}

// Sort for determinism
lines.sort();

writeFileSync(outputFile, lines.join('\n') + '\n', 'utf-8');
console.log(`Generated ${lines.length} redirects to public/_redirects`);
