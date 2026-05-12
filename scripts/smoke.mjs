#!/usr/bin/env node
/**
 * Post-build smoke test.
 * Walks dist/ and asserts correctness of the generated static site.
 * Uses only Node built-in modules.
 */
import { readFileSync, existsSync, readdirSync, statSync } from 'fs';
import { join, resolve } from 'path';

const DIST = resolve('dist');
const RED = '\x1b[31m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const RESET = '\x1b[0m';

let errors = 0;
let warnings = 0;

function fail(msg) {
  console.error(`${RED}FAIL: ${msg}${RESET}`);
  errors++;
}

function warn(msg) {
  console.warn(`${YELLOW}WARN: ${msg}${RESET}`);
  warnings++;
}

function pass(msg) {
  console.log(`${GREEN}  OK: ${msg}${RESET}`);
}

function readFile(rel) {
  const p = join(DIST, rel);
  if (!existsSync(p)) return null;
  return readFileSync(p, 'utf-8');
}

// --- 1. dist/index.html exists and contains <h1> ---
const indexHtml = readFile('index.html');
if (!indexHtml) {
  fail('dist/index.html does not exist');
} else if (!/<h1[\s>]/i.test(indexHtml)) {
  fail('dist/index.html does not contain <h1>');
} else {
  pass('dist/index.html exists and contains <h1>');
}

// --- 2. dist/404.html exists ---
if (!existsSync(join(DIST, '404.html'))) {
  fail('dist/404.html does not exist');
} else {
  pass('dist/404.html exists');
}

// --- 3. dist/kontakty/index.html contains phone and postal code ---
const kontakty = readFile('kontakty/index.html');
if (!kontakty) {
  fail('dist/kontakty/index.html does not exist');
} else {
  if (!kontakty.includes('+7 (812) 457-21-06')) {
    fail('dist/kontakty/index.html missing phone +7 (812) 457-21-06');
  } else {
    pass('kontakty contains phone number');
  }
  if (!kontakty.includes('198095')) {
    fail('dist/kontakty/index.html missing postal code 198095');
  } else {
    pass('kontakty contains postal code 198095');
  }
}

// --- 4. Sitemap exists ---
const hasSitemapIndex = existsSync(join(DIST, 'sitemap-index.xml'));
const hasSitemap0 = existsSync(join(DIST, 'sitemap-0.xml'));
if (!hasSitemapIndex && !hasSitemap0) {
  fail('Neither dist/sitemap-index.xml nor dist/sitemap-0.xml exists');
} else {
  pass(`Sitemap found: ${hasSitemapIndex ? 'sitemap-index.xml' : 'sitemap-0.xml'}`);
}

// --- 5. robots.txt exists and references sitemap ---
const robots = readFile('robots.txt');
if (!robots) {
  fail('dist/robots.txt does not exist');
} else if (!/sitemap/i.test(robots)) {
  fail('dist/robots.txt does not reference a sitemap');
} else {
  pass('dist/robots.txt exists and references sitemap');
}

// --- 6. At least 50 product detail pages under dist/katalog/ ---
function countProductPages(dir) {
  let count = 0;
  if (!existsSync(dir)) return 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      const sub = join(dir, entry.name);
      if (existsSync(join(sub, 'index.html'))) {
        count++;
      }
      // recurse into subdirectories
      count += countProductPages(sub);
    }
  }
  return count;
}

const katalogDir = join(DIST, 'katalog');
// Count directories inside katalog/ that have index.html (excluding katalog/index.html itself)
let productPageCount = 0;
if (existsSync(katalogDir)) {
  for (const entry of readdirSync(katalogDir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      const sub = join(katalogDir, entry.name);
      if (existsSync(join(sub, 'index.html'))) {
        productPageCount++;
      }
      // count nested subdirectories too
      productPageCount += countProductPages(sub);
    }
  }
}

if (productPageCount < 50) {
  fail(`Only ${productPageCount} product pages found under dist/katalog/ (need >= 50)`);
} else {
  pass(`${productPageCount} product detail pages under dist/katalog/`);
}

// --- 7. Sample 5 random product pages ---
function getAllProductPages(dir) {
  const pages = [];
  if (!existsSync(dir)) return pages;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      const sub = join(dir, entry.name);
      const idx = join(sub, 'index.html');
      if (existsSync(idx)) {
        pages.push(idx);
      }
      pages.push(...getAllProductPages(sub));
    }
  }
  return pages;
}

const allProductPages = getAllProductPages(katalogDir);
// Shuffle and pick 5
const shuffled = allProductPages.sort(() => Math.random() - 0.5);
const sample = shuffled.slice(0, 5);

let samplePassed = 0;
for (const pagePath of sample) {
  const content = readFileSync(pagePath, 'utf-8');
  const rel = pagePath.replace(DIST + '/', '');
  let pageOk = true;

  if (!/<h1[\s>]/i.test(content)) {
    fail(`${rel} missing <h1>`);
    pageOk = false;
  }

  if (!/<img[\s]/i.test(content)) {
    // Many product pages legitimately lack product images
    warn(`${rel} has no <img> tag`);
  }

  if (!/<script\s+type="application\/ld\+json">/i.test(content)) {
    fail(`${rel} missing <script type="application/ld+json">`);
    pageOk = false;
  }

  if (pageOk) samplePassed++;
}
pass(`Sampled ${sample.length} product pages: ${samplePassed}/${sample.length} passed (h1+JSON-LD)`);

// --- 8. Scan all HTML files for 'undefined' or '[object Object]' in text content ---
function walkDir(dir, ext) {
  const results = [];
  if (!existsSync(dir)) return results;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...walkDir(full, ext));
    } else if (entry.name.endsWith(ext)) {
      results.push(full);
    }
  }
  return results;
}

const allHtml = walkDir(DIST, '.html');
let violations = 0;

for (const file of allHtml) {
  const content = readFileSync(file, 'utf-8');
  // Strip <script>...</script> and <style>...</style> tags
  const textOnly = content
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    // Also strip HTML tags to get text nodes
    .replace(/<[^>]+>/g, ' ');

  const rel = file.replace(DIST + '/', '');

  if (/\bundefined\b/.test(textOnly)) {
    fail(`${rel} contains literal "undefined" in text content`);
    violations++;
  }
  if (/\[object Object\]/.test(textOnly)) {
    fail(`${rel} contains "[object Object]" in text content`);
    violations++;
  }
}

if (violations === 0) {
  pass(`Scanned ${allHtml.length} HTML files: no "undefined" or "[object Object]" found`);
}

// --- Summary ---
console.log('');
if (errors > 0) {
  console.error(`${RED}SMOKE TEST FAILED: ${errors} error(s), ${warnings} warning(s)${RESET}`);
  process.exit(1);
} else {
  console.log(`${GREEN}SMOKE TEST PASSED: all checks OK (${warnings} warning(s)), ${allHtml.length} HTML files scanned, ${productPageCount} catalog pages${RESET}`);
  process.exit(0);
}
