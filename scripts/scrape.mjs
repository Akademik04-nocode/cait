#!/usr/bin/env node
/**
 * scripts/scrape.mjs
 *
 * Polite, idempotent scraper that mirrors kvazarcomp.ru content via the
 * Wayback Machine. The live origin (78.108.80.146) is unreachable from the
 * sandbox, so every fetch goes through
 *   https://web.archive.org/web/2025id_/{original_url}      (raw HTML)
 *   https://web.archive.org/web/0if_/{original_image_url}   (raw bytes)
 *
 * Output:
 *   src/content/products/{slug}.json
 *   src/content/categories/{slug}.json
 *   src/content/brands/{slug}.json
 *   src/content/news/{slug}.md
 *   src/content/objects/{slug}.md
 *   src/content/articles/{slug}.md
 *   src/content/certificates/{slug}.json
 *   src/content/_scrape-report.json
 *   public/images/... (mirrors original /cache/images/ and /resources/...)
 *   scrape-errors.log
 *   .scrape-cache/{md5(url)}.{html|bin}
 */

import { mkdir, writeFile, readFile, stat, rm, access, unlink } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { request } from 'undici';
import * as cheerio from 'cheerio';
import pLimit from 'p-limit';
import yargsParser from 'yargs-parser';
import iconv from 'iconv-lite';

// ---------------------------------------------------------------------------
// Paths and constants
// ---------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const ROOT = resolve(dirname(__filename), '..');

const CACHE_DIR = join(ROOT, '.scrape-cache');
const CONTENT_DIR = join(ROOT, 'src', 'content');
const IMAGES_DIR = join(ROOT, 'public', 'images');
const ERROR_LOG = join(ROOT, 'scrape-errors.log');

const ORIGIN = 'http://kvazarcomp.ru';
const SITEMAP_URL =
  'https://web.archive.org/web/20250805012342id_/https://kvazarcomp.ru/sitemap.xml';
const WAYBACK_HTML = (url) => `https://web.archive.org/web/2025id_/${url}`;
const WAYBACK_IMG = (url) =>
  `https://web.archive.org/web/0if_/${url.replace(/^http:\/\//, 'https://')}`;
const USER_AGENT =
  'kvazar-migration-scraper/1.0 (+contact: info@kvazarcomp.ru)';

const DELAY_MS = 500;
const REQUEST_TIMEOUT_MS = 45_000;
const MAX_REDIRECTS = 5;
const MAX_RETRIES = 4;
const CONCURRENCY = 2;
// Wayback occasionally slams the door (ECONNREFUSED / 503) when many requests
// arrive in a short window. When that happens we back off aggressively so the
// next attempt succeeds instead of burning through the retry budget.
const RETRY_BACKOFFS_MS = [2_000, 5_000, 20_000, 60_000];

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const argv = yargsParser(process.argv.slice(2), {
  number: ['limit'],
  boolean: ['refresh', 'skip-images'],
  string: ['only'],
  default: { refresh: false, 'skip-images': false },
});

const LIMIT = Number.isFinite(argv.limit) ? argv.limit : 0;
const REFRESH = Boolean(argv.refresh);
const SKIP_IMAGES = Boolean(argv['skip-images']);
const ONLY_RE = argv.only ? new RegExp(argv.only) : null;

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

const errorLines = [];

function log(...parts) {
  // eslint-disable-next-line no-console
  console.log(parts.join(' '));
}

function logError(url, phase, err) {
  const msg = err instanceof Error ? err.message : String(err);
  const line = `[error] ${phase} ${url} :: ${msg}`;
  // eslint-disable-next-line no-console
  console.error(line);
  errorLines.push(line);
}

// ---------------------------------------------------------------------------
// Filesystem helpers
// ---------------------------------------------------------------------------

async function ensureDir(path) {
  await mkdir(path, { recursive: true });
}

async function fileExists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function writeJson(path, value) {
  await ensureDir(dirname(path));
  await writeFile(path, JSON.stringify(value, null, 2) + '\n', 'utf8');
}

function md5(s) {
  return createHash('md5').update(s).digest('hex');
}

// ---------------------------------------------------------------------------
// Polite delay (only applied after a real network fetch, not cache hits)
// ---------------------------------------------------------------------------

let lastNetworkAt = 0;

async function politeDelay() {
  const now = Date.now();
  const since = now - lastNetworkAt;
  if (since < DELAY_MS) {
    await sleep(DELAY_MS - since);
  }
  lastNetworkAt = Date.now();
}

// ---------------------------------------------------------------------------
// Cached fetch (with redirects and retries)
// ---------------------------------------------------------------------------

async function networkFetch(url, { binary = false } = {}) {
  let currentUrl = url;
  for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect += 1) {
    const res = await request(currentUrl, {
      method: 'GET',
      headers: {
        'user-agent': USER_AGENT,
        accept: binary
          ? 'image/*,application/pdf,application/octet-stream,*/*;q=0.1'
          : 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.1',
      },
      headersTimeout: REQUEST_TIMEOUT_MS,
      bodyTimeout: REQUEST_TIMEOUT_MS,
    });
    const status = res.statusCode;
    if (status >= 300 && status < 400 && res.headers.location) {
      const loc = Array.isArray(res.headers.location)
        ? res.headers.location[0]
        : res.headers.location;
      currentUrl = new URL(loc, currentUrl).toString();
      // drain
      await res.body.dump();
      continue;
    }
    if (status >= 500) {
      await res.body.dump();
      const err = new Error(`upstream status ${status}`);
      err.retryable = true;
      throw err;
    }
    if (status >= 400) {
      await res.body.dump();
      const err = new Error(`upstream status ${status}`);
      err.retryable = false;
      throw err;
    }
    const chunks = [];
    for await (const chunk of res.body) chunks.push(chunk);
    const buf = Buffer.concat(chunks);
    return { buffer: buf, contentType: res.headers['content-type'] || '' };
  }
  throw new Error(`too many redirects for ${url}`);
}

async function cachedFetch(url, { binary = false, refresh = REFRESH } = {}) {
  const ext = binary ? 'bin' : 'html';
  const cachePath = join(CACHE_DIR, `${md5(url)}.${ext}`);
  const miss404Path = `${cachePath}.404`;
  if (!refresh && (await fileExists(cachePath))) {
    log(`[cache] ${url} -> hit`);
    const buf = await readFile(cachePath);
    return { buffer: buf, fromCache: true };
  }
  if (!refresh && (await fileExists(miss404Path))) {
    const err = new Error('upstream status 404 (cached)');
    err.retryable = false;
    throw err;
  }
  await politeDelay();
  let lastErr;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
    try {
      const { buffer, contentType } = await networkFetch(url, { binary });
      await ensureDir(CACHE_DIR);
      await writeFile(cachePath, buffer);
      log(`[fetch] ${url} -> 200 (${buffer.length}b${contentType ? ', ' + contentType : ''})`);
      return { buffer, fromCache: false, contentType };
    } catch (err) {
      lastErr = err;
      const retryable = err.retryable !== false;
      // Remember persistent 404s so later runs skip instead of re-hitting Wayback
      if (/status 404/.test(err.message)) {
        try {
          await ensureDir(CACHE_DIR);
          await writeFile(miss404Path, '');
        } catch {
          /* best effort */
        }
      }
      if (!retryable || attempt === MAX_RETRIES) break;
      const backoff = RETRY_BACKOFFS_MS[Math.min(attempt, RETRY_BACKOFFS_MS.length - 1)];
      log(`[retry] ${url} (${err.message}) waiting ${backoff}ms`);
      await sleep(backoff);
    }
  }
  throw lastErr;
}

// ---------------------------------------------------------------------------
// Decode HTML (prefer UTF-8, fall back to windows-1251 if meta says so)
// ---------------------------------------------------------------------------

function decodeHtml(buffer) {
  const head = buffer.slice(0, 2048).toString('latin1').toLowerCase();
  if (head.includes('charset=windows-1251') || head.includes('charset=cp1251')) {
    return iconv.decode(buffer, 'win1251');
  }
  return buffer.toString('utf8');
}

// ---------------------------------------------------------------------------
// Sitemap parsing
// ---------------------------------------------------------------------------

async function loadSitemap() {
  const { buffer } = await cachedFetch(SITEMAP_URL, { binary: false });
  const xml = buffer.toString('utf8');
  const locs = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1].trim());
  // dedupe + normalize trailing slash
  const seen = new Set();
  const out = [];
  for (const raw of locs) {
    if (!raw.startsWith(`${ORIGIN}/`)) continue;
    // exclude bare home and /resources/*
    const u = raw.replace(/\/+$/, '/');
    const path = u.substring(ORIGIN.length);
    if (path === '/' || path === '') continue;
    if (path.startsWith('/resources/')) continue;
    if (path.includes('Unkown%20format')) continue; // broken source entry
    if (!seen.has(u)) {
      seen.add(u);
      out.push(u);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

function classify($, url) {
  const path = url.substring(ORIGIN.length);
  const hasProductMarkers =
    $('table.tovar-params').length > 0 && $('div.tovar-description').length > 0;
  if (hasProductMarkers) return 'product';

  if ($('div.tovar.span4').length > 0) return 'brand_listing';

  if ($('div.catsection').length > 0) return 'category';

  // URL-prefix fallbacks
  if (/^\/o_nas\/news\/[^/]+\/?$/.test(path)) return 'news_item';
  if (/^\/o_nas\/news\/?$/.test(path)) return 'list';
  if (/^\/o_nas\/nashi_objekti\/[^/]+\/?$/.test(path)) return 'object_item';
  if (/^\/o_nas\/nashi_objekti\/?$/.test(path)) return 'list';
  if (/^\/poleznaya_informatsiya\/sertifikati_tovara(\/.*)?$/.test(path)) {
    // A certificate page contains .cert-item nodes (image + title + pdf)
    if ($('.cert-item').length > 0) return 'certificate_group';
    return 'list';
  }
  if (/^\/poleznaya_informatsiya\/(instruktsii_po_montazhu|stati)\/[^/]+\/?$/.test(path)) {
    return 'article';
  }
  if (/^\/aktsii\/[^/]+\/?$/.test(path)) return 'article';
  if (path === '/kontakti/') return 'contacts';
  if (path === '/o_nas/prezentatsiya/') return 'about';
  if (path === '/o_nas/sertifikati_dilera/') return 'dealer_certificates';
  return 'list';
}

// ---------------------------------------------------------------------------
// Image download
// ---------------------------------------------------------------------------

const imageSuccesses = new Set();
const imageFailures = new Set();

function resolveImagePath(src) {
  if (!src) return null;
  const s = src.trim();
  if (!s) return null;
  if (s.startsWith('data:')) return null;
  if (s.startsWith('//')) return `http:${s}`;
  if (s.startsWith('http://') || s.startsWith('https://')) return s;
  if (s.startsWith('/')) return `${ORIGIN}${s}`;
  return null; // relative paths inside rich HTML get left alone
}

function isKvazarUrl(absUrl) {
  try {
    const u = new URL(absUrl);
    return /(^|\.)kvazarcomp\.ru$/.test(u.hostname);
  } catch {
    return false;
  }
}

/**
 * Download an image referenced by the original site.
 * `absUrl` must be an absolute http(s) URL on kvazarcomp.ru.
 * Returns the rewritten `/images/...` path to use in content, or null on failure.
 */
async function downloadImage(absUrl) {
  if (SKIP_IMAGES) return null;
  if (!absUrl || !isKvazarUrl(absUrl)) return null;
  try {
    const u = new URL(absUrl);
    const pathname = decodeURIComponent(u.pathname); // e.g. /cache/images/abc.jpg
    if (!pathname.startsWith('/cache/images/') && !pathname.startsWith('/resources/')) {
      // Only mirror the two content paths used by the site
      return null;
    }
    const localRel = pathname.replace(/^\//, '');
    const localFs = join(IMAGES_DIR, localRel);
    const publicRef = `/images/${localRel}`;

    if (imageFailures.has(absUrl)) return null;
    if (imageSuccesses.has(publicRef)) return publicRef;

    if (await fileExists(localFs)) {
      imageSuccesses.add(publicRef);
      return publicRef;
    }

    const wayback = WAYBACK_IMG(absUrl);
    const { buffer } = await cachedFetch(wayback, { binary: true });
    await ensureDir(dirname(localFs));
    await writeFile(localFs, buffer);
    log(`[image] ${absUrl} -> ${publicRef} (${buffer.length}b)`);
    imageSuccesses.add(publicRef);
    return publicRef;
  } catch (err) {
    logError(absUrl, 'image', err);
    imageFailures.add(absUrl);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Helpers for extraction
// ---------------------------------------------------------------------------

function slugFromUrl(url) {
  const path = url.substring(ORIGIN.length).replace(/\/+$/, '');
  const parts = path.split('/').filter(Boolean);
  return parts[parts.length - 1] || 'index';
}

function categorySlugFromProductUrl(url) {
  // /katalog/a/b/c/brand/product/ -> a/b/c
  const path = url.substring(ORIGIN.length).replace(/\/+$/, '');
  const parts = path.split('/').filter(Boolean);
  // parts[0] === 'katalog', last is product, second-last is brand
  if (parts[0] !== 'katalog') return '';
  const midParts = parts.slice(1, -2);
  return midParts.join('/');
}

function brandSlugFromProductUrl(url) {
  const path = url.substring(ORIGIN.length).replace(/\/+$/, '');
  const parts = path.split('/').filter(Boolean);
  if (parts[0] !== 'katalog' || parts.length < 3) return '';
  return parts[parts.length - 2];
}

function extractBreadcrumbs($) {
  const out = [];
  $('.breadcrumbs a').each((_, a) => {
    const $a = $(a);
    const href = ($a.attr('href') || '').trim();
    const title = $a.find('[itemprop="title"]').text().trim() || $a.text().trim();
    if (href && title) out.push({ title, href });
  });
  return out;
}

function cleanText(s) {
  return (s || '').replace(/\s+/g, ' ').trim();
}

function parsePriceValue(text) {
  const t = cleanText(text).replace(/\u00a0/g, ' ');
  const m = t.match(/([\d][\d\s]*[\d]|\d)\s*(?:р\.|руб|₽)/i);
  if (!m) return null;
  const n = Number(m[1].replace(/\s+/g, ''));
  return Number.isFinite(n) ? n : null;
}

/**
 * Sanitize an HTML fragment: drop <script>, inline on* handlers, and rewrite
 * kvazarcomp.ru links/images so they point at the local mirror.
 * `imageJobs` collects absolute image URLs to download, each mapped to its
 * new /images/... path after the walk.
 */
async function sanitizeAndRewriteHtml($, $node) {
  if (!$node || $node.length === 0) return '';
  // Remove scripts outright
  $node.find('script,noscript').remove();
  // Strip inline event handlers
  $node.find('*').each((_, el) => {
    const attribs = el.attribs || {};
    for (const name of Object.keys(attribs)) {
      if (/^on/i.test(name)) {
        $(el).removeAttr(name);
      }
    }
  });

  // Collect and download images inline
  const imgs = $node.find('img').toArray();
  for (const el of imgs) {
    const $el = $(el);
    const src = $el.attr('src');
    const abs = resolveImagePath(src);
    if (abs && isKvazarUrl(abs)) {
      const local = await downloadImage(abs);
      if (local) $el.attr('src', local);
    }
  }

  // Rewrite <a href> pointing at kvazarcomp.ru -> relative path
  $node.find('a[href]').each((_, el) => {
    const $el = $(el);
    const href = ($el.attr('href') || '').trim();
    if (!href) return;
    if (href.startsWith('//')) {
      const full = `http:${href}`;
      if (isKvazarUrl(full)) {
        const u = new URL(full);
        $el.attr('href', u.pathname + u.search);
      }
    } else if (href.startsWith('http://') || href.startsWith('https://')) {
      try {
        const u = new URL(href);
        if (/(^|\.)kvazarcomp\.ru$/.test(u.hostname)) {
          $el.attr('href', u.pathname + u.search);
        }
      } catch {
        /* ignore */
      }
    }
  });

  return $.html($node);
}

// ---------------------------------------------------------------------------
// Per-type extractors
// ---------------------------------------------------------------------------

function slugify(raw) {
  return (raw || '')
    .toString()
    .toLowerCase()
    .replace(/[^a-z0-9а-яё_\-]+/gi, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 120) || 'item';
}

async function extractProduct($, url, nowIso) {
  const slug = slugFromUrl(url);
  const title = cleanText($('title').first().text());
  const h1 = cleanText($('h1[itemprop="name"]').first().text()) || cleanText($('h1').first().text());
  const metaDescription = $('meta[name="description"]').attr('content') || '';
  const metaKeywords = $('meta[name="keywords"]').attr('content') || '';
  const breadcrumbs = extractBreadcrumbs($);

  // Gallery: all baguetteBoxItem hrefs (large image); main image from id_large_pict_img
  const gallerySet = [];
  const mainImg = $('#item_large_pict_img').attr('src');
  if (mainImg) gallerySet.push(mainImg);
  $('a.baguetteBoxItem').each((_, a) => {
    const href = $(a).attr('href');
    if (href) gallerySet.push(href);
  });

  const gallery = [];
  for (const src of gallerySet) {
    const abs = resolveImagePath(src);
    if (!abs) continue;
    const local = await downloadImage(abs);
    if (local && !gallery.includes(local)) gallery.push(local);
  }

  // Specs table; skip the "Цена:" itemprop offer row, capture it separately
  const specs = [];
  let priceLabel;
  let priceValue = null;
  $('table.tovar-params tr').each((_, tr) => {
    const tds = $(tr).find('td');
    if (tds.length < 2) return;
    const nameRaw = cleanText($(tds[0]).text()).replace(/[:：]+$/, '');
    const valueRaw = cleanText($(tds.last()).text());
    if (!nameRaw && !valueRaw) return;
    if (/^Цена$/i.test(nameRaw) || $(tr).attr('itemprop') === 'offers') {
      priceLabel = valueRaw;
      priceValue = parsePriceValue(valueRaw);
      return;
    }
    specs.push({ name: nameRaw, value: valueRaw });
  });

  // Some templates put the price label in a <span class="price"> near the params
  if (!priceLabel) {
    const $price = $('.tovar-short-desc .price, .tovar-short-desc span[itemprop="price"]').first();
    if ($price.length) {
      priceLabel = cleanText($price.text());
      priceValue = parsePriceValue(priceLabel);
    }
  }

  // Description: inner HTML of the div.tovar-description, plus trailing tovar-field blocks
  const $desc = $('div.tovar-description').first();
  const descriptionHtml = await sanitizeAndRewriteHtml($, $desc);

  const category = categorySlugFromProductUrl(url);
  const brand = brandSlugFromProductUrl(url);

  const record = {
    slug,
    title,
    h1,
    description: descriptionHtml || undefined,
    specs,
    priceLabel: priceLabel || undefined,
    priceValue,
    images: gallery.slice(0, 1), // first gallery image acts as the primary
    gallery,
    category,
    brand: brand || undefined,
    breadcrumbs,
    seo: {
      title: title || undefined,
      description: metaDescription || undefined,
      keywords: metaKeywords || undefined,
    },
    sourceUrl: url,
    scrapedAt: nowIso,
  };
  return record;
}

async function extractCategory($, url, nowIso) {
  const slug = slugFromUrl(url);
  const title =
    cleanText($('h1').first().text()) || cleanText($('title').first().text()) || slug;
  const metaDescription = $('meta[name="description"]').attr('content') || '';
  const metaKeywords = $('meta[name="keywords"]').attr('content') || '';
  const descNode = $('.full_description').first();
  const description = descNode.length
    ? await sanitizeAndRewriteHtml($, descNode)
    : undefined;

  const breadcrumbs = extractBreadcrumbs($);

  // Category image from the first catsection tile
  let image;
  const firstIcon = $('.catsection img').first().attr('src');
  if (firstIcon) {
    const abs = resolveImagePath(firstIcon);
    if (abs) image = (await downloadImage(abs)) || undefined;
  }

  // parent slug: second-last segment
  const path = url.substring(ORIGIN.length).replace(/\/+$/, '');
  const parts = path.split('/').filter(Boolean);
  const parent = parts.length > 2 ? parts[parts.length - 2] : undefined;

  return {
    slug,
    title,
    parent,
    description,
    image,
    breadcrumbs,
    seo: {
      title: title || undefined,
      description: metaDescription || undefined,
      keywords: metaKeywords || undefined,
    },
    sourceUrl: url,
    scrapedAt: nowIso,
  };
}

async function extractBrandListing($, url, nowIso) {
  const slug = slugFromUrl(url);
  const title =
    cleanText($('h1').first().text()) || cleanText($('title').first().text()) || slug;
  const metaDescription = $('meta[name="description"]').attr('content') || '';
  const descNode = $('.full_description').first();
  const description = descNode.length
    ? await sanitizeAndRewriteHtml($, descNode)
    : undefined;

  // Derive parent category (segment before brand slug)
  const path = url.substring(ORIGIN.length).replace(/\/+$/, '');
  const parts = path.split('/').filter(Boolean);
  const inCategory = [];
  if (parts.length >= 2) inCategory.push(parts.slice(0, -1).join('/'));

  // Logo: first tile image (fallback)
  let logo;
  const firstIcon = $('.tovar.span4 img').first().attr('src');
  if (firstIcon) {
    const abs = resolveImagePath(firstIcon);
    if (abs) logo = (await downloadImage(abs)) || undefined;
  }

  const breadcrumbs = extractBreadcrumbs($);

  return {
    slug,
    title,
    description,
    logo,
    inCategory,
    breadcrumbs,
    seo: {
      title: title || undefined,
      description: metaDescription || undefined,
    },
    sourceUrl: url,
    scrapedAt: nowIso,
  };
}

function parseRuDate(text) {
  const t = cleanText(text);
  // dd.mm.yyyy
  const m = t.match(/(\d{1,2})\.(\d{1,2})\.(\d{4})/);
  if (!m) return null;
  const [, d, mo, y] = m;
  const iso = `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  return iso;
}

function escapeYaml(s) {
  if (s == null) return '""';
  const str = String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return `"${str}"`;
}

function buildFrontmatter(obj) {
  const lines = ['---'];
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null || v === '') continue;
    if (Array.isArray(v)) {
      if (v.length === 0) continue;
      lines.push(`${k}:`);
      for (const item of v) lines.push(`  - ${escapeYaml(item)}`);
    } else if (typeof v === 'boolean' || typeof v === 'number') {
      lines.push(`${k}: ${v}`);
    } else if (typeof v === 'object') {
      lines.push(`${k}:`);
      for (const [kk, vv] of Object.entries(v)) {
        if (vv === undefined || vv === null || vv === '') continue;
        lines.push(`  ${kk}: ${escapeYaml(vv)}`);
      }
    } else {
      lines.push(`${k}: ${escapeYaml(v)}`);
    }
  }
  lines.push('---');
  return lines.join('\n');
}

async function extractNewsItem($, url, nowIso) {
  const slug = slugFromUrl(url);
  const title = cleanText($('h1').first().text()) || slug;
  const metaDescription = $('meta[name="description"]').attr('content') || '';
  const metaKeywords = $('meta[name="keywords"]').attr('content') || '';
  const dateText = cleanText($('.pubdate').first().text());
  const date = parseRuDate(dateText) || nowIso.slice(0, 10);

  // Body = .section-description (main). Also pick up a hero image from the
  // news-item-detail block.
  const $hero = $('.news-item-detail img').first();
  let image;
  if ($hero.length) {
    const abs = resolveImagePath($hero.attr('src'));
    if (abs) image = (await downloadImage(abs)) || undefined;
  }

  const $body = $('.section-description').first();
  const bodyHtml = await sanitizeAndRewriteHtml($, $body);

  const excerpt = cleanText($body.find('p').first().text()).slice(0, 240) || undefined;

  const frontmatter = buildFrontmatter({
    title,
    date,
    excerpt,
    image,
    draft: false,
    sourceUrl: url,
    seo: {
      title: title || undefined,
      description: metaDescription || undefined,
      keywords: metaKeywords || undefined,
    },
  });

  return { slug, frontmatter, body: bodyHtml || '' };
}

async function extractObject($, url, nowIso) {
  const slug = slugFromUrl(url);
  const title = cleanText($('h1').first().text()) || slug;
  const metaDescription = $('meta[name="description"]').attr('content') || '';
  const metaKeywords = $('meta[name="keywords"]').attr('content') || '';

  const $objectDetail = $('.object-detail').first();
  // Download all gallery images
  const images = [];
  const baguettes = $objectDetail.find('a.baguetteBoxItem').toArray();
  for (const a of baguettes) {
    const href = $(a).attr('href');
    const abs = resolveImagePath(href);
    if (!abs) continue;
    const local = await downloadImage(abs);
    if (local && !images.includes(local)) images.push(local);
  }

  const shortText = cleanText($objectDetail.find('.short').first().text()) || undefined;
  // Extract "Адрес:" row as location
  let location;
  $objectDetail.find('table tr').each((_, tr) => {
    const tds = $(tr).find('td');
    if (tds.length < 2) return;
    const k = cleanText($(tds[0]).text()).replace(/[:：]+$/, '').toLowerCase();
    const v = cleanText($(tds[1]).text());
    if (k === 'адрес' && !location) location = v;
  });

  const bodyHtml = await sanitizeAndRewriteHtml($, $objectDetail);

  const frontmatter = buildFrontmatter({
    title,
    excerpt: shortText,
    location,
    image: images[0],
    images,
    draft: false,
    sourceUrl: url,
    seo: {
      title: title || undefined,
      description: metaDescription || undefined,
      keywords: metaKeywords || undefined,
    },
  });

  return { slug, frontmatter, body: bodyHtml || '' };
}

async function extractArticle($, url, nowIso) {
  const slug = slugFromUrl(url);
  const title = cleanText($('h1').first().text()) || slug;
  const metaDescription = $('meta[name="description"]').attr('content') || '';
  const metaKeywords = $('meta[name="keywords"]').attr('content') || '';
  const dateText = cleanText($('.pubdate').first().text());
  const date = parseRuDate(dateText) || undefined;

  const $body =
    $('.section-description').first().length > 0
      ? $('.section-description').first()
      : $('#center').first();

  let image;
  const $img = $body.find('img').first();
  if ($img.length) {
    const abs = resolveImagePath($img.attr('src'));
    if (abs) image = (await downloadImage(abs)) || undefined;
  }

  const bodyHtml = await sanitizeAndRewriteHtml($, $body);
  const excerpt = cleanText($body.find('p').first().text()).slice(0, 240) || undefined;

  const frontmatter = buildFrontmatter({
    title,
    date,
    excerpt,
    image,
    draft: false,
    sourceUrl: url,
    seo: {
      title: title || undefined,
      description: metaDescription || undefined,
      keywords: metaKeywords || undefined,
    },
  });

  return { slug, frontmatter, body: bodyHtml || '' };
}

async function extractCertificateGroup($, url, nowIso) {
  // Each .cert-item -> one certificate record
  const results = [];
  const path = url.substring(ORIGIN.length).replace(/\/+$/, '');
  const parts = path.split('/').filter(Boolean);
  const category = parts.slice(2).join('/'); // after /poleznaya_informatsiya/sertifikati_tovara
  const groupSlug = parts[parts.length - 1] || 'group';

  const items = $('.cert-item').toArray();
  let idx = 0;
  for (const el of items) {
    const $el = $(el);
    const title = cleanText($el.find('.cert-title').text()) || `Сертификат ${groupSlug} ${idx + 1}`;
    const imgHref = $el.find('a.baguetteBoxItem').attr('href') || $el.find('img').attr('src');
    const abs = resolveImagePath(imgHref);
    if (!abs) {
      idx += 1;
      continue;
    }
    const local = await downloadImage(abs);
    if (!local) {
      idx += 1;
      continue;
    }
    const pdfHref = $el.find('a[href$=".pdf"]').attr('href');
    let pdf;
    if (pdfHref) {
      const pdfAbs = resolveImagePath(pdfHref);
      if (pdfAbs) pdf = (await downloadImage(pdfAbs)) || undefined;
    }
    const slug = slugify(`${groupSlug}-${idx + 1}-${title}`);
    results.push({
      slug,
      title,
      category,
      image: local,
      pdf,
      sortOrder: idx,
      sourceUrl: url,
      scrapedAt: nowIso,
    });
    idx += 1;
  }
  return results;
}

// ---------------------------------------------------------------------------
// Main pipeline
// ---------------------------------------------------------------------------

async function run() {
  const nowIso = new Date().toISOString();

  await ensureDir(CACHE_DIR);
  await ensureDir(CONTENT_DIR);
  await ensureDir(IMAGES_DIR);

  log(`[boot] scraper starting. refresh=${REFRESH} limit=${LIMIT || '-'} only=${argv.only || '-'} skipImages=${SKIP_IMAGES}`);

  // Clear any previous error log so a fresh run does not conflate failures
  try {
    await unlink(ERROR_LOG);
  } catch {
    /* not there yet */
  }

  const allUrls = await loadSitemap();
  log(`[sitemap] ${allUrls.length} URLs loaded`);

  let urls = allUrls;
  if (ONLY_RE) urls = urls.filter((u) => ONLY_RE.test(u));
  if (LIMIT > 0) urls = urls.slice(0, LIMIT);

  log(`[sitemap] ${urls.length} URLs selected after filters`);

  const counts = {
    urls_total: urls.length,
    urls_processed: 0,
    urls_failed: 0,
    products: 0,
    categories: 0,
    brands: 0,
    news: 0,
    objects: 0,
    articles: 0,
    certificates: 0,
    lists_skipped: 0,
    other_skipped: 0,
  };

  const productRecords = [];
  const categoryRecords = [];
  const brandRecords = [];
  const newsWrites = [];
  const objectWrites = [];
  const articleWrites = [];
  const certificateRecords = [];

  const limit = pLimit(CONCURRENCY);

  await Promise.all(
    urls.map((url) =>
      limit(async () => {
        try {
          const { buffer } = await cachedFetch(WAYBACK_HTML(url));
          const html = decodeHtml(buffer);
          const $ = cheerio.load(html, { decodeEntities: false });
          const type = classify($, url);
          log(`[classify] ${type} ${url}`);

          switch (type) {
            case 'product': {
              const rec = await extractProduct($, url, nowIso);
              productRecords.push(rec);
              counts.products += 1;
              log(`[extract] product ${rec.slug}`);
              break;
            }
            case 'brand_listing': {
              const rec = await extractBrandListing($, url, nowIso);
              brandRecords.push(rec);
              counts.brands += 1;
              log(`[extract] brand ${rec.slug}`);
              break;
            }
            case 'category': {
              const rec = await extractCategory($, url, nowIso);
              categoryRecords.push(rec);
              counts.categories += 1;
              log(`[extract] category ${rec.slug}`);
              break;
            }
            case 'news_item': {
              const doc = await extractNewsItem($, url, nowIso);
              newsWrites.push(doc);
              counts.news += 1;
              log(`[extract] news ${doc.slug}`);
              break;
            }
            case 'object_item': {
              const doc = await extractObject($, url, nowIso);
              objectWrites.push(doc);
              counts.objects += 1;
              log(`[extract] object ${doc.slug}`);
              break;
            }
            case 'article': {
              const doc = await extractArticle($, url, nowIso);
              articleWrites.push(doc);
              counts.articles += 1;
              log(`[extract] article ${doc.slug}`);
              break;
            }
            case 'certificate_group': {
              const recs = await extractCertificateGroup($, url, nowIso);
              for (const r of recs) certificateRecords.push(r);
              counts.certificates += recs.length;
              log(`[extract] certificate_group ${recs.length} items from ${url}`);
              break;
            }
            case 'list':
              counts.lists_skipped += 1;
              break;
            default:
              counts.other_skipped += 1;
              break;
          }
          counts.urls_processed += 1;
        } catch (err) {
          counts.urls_failed += 1;
          logError(url, 'process', err);
        }
      }),
    ),
  );

  // -------------------------------------------------------------------------
  // Write content files
  // -------------------------------------------------------------------------

  for (const rec of productRecords) {
    await writeJson(join(CONTENT_DIR, 'products', `${rec.slug}.json`), rec);
  }

  // Derive categories/brands from product URL tree (in addition to the
  // landing pages we scraped via classify)
  const extraCategories = new Map(); // slug -> {slug, parent, title}
  const extraBrands = new Map();
  for (const p of productRecords) {
    // category = "a/b/c"; we want a record keyed by each segment
    if (p.category) {
      const segs = p.category.split('/').filter(Boolean);
      for (let i = 0; i < segs.length; i += 1) {
        const slug = segs[i];
        if (!extraCategories.has(slug)) {
          extraCategories.set(slug, {
            slug,
            title: slug.replace(/[_-]+/g, ' '),
            parent: i > 0 ? segs[i - 1] : undefined,
            sourceUrl: `${ORIGIN}/katalog/${segs.slice(0, i + 1).join('/')}/`,
          });
        }
      }
    }
    if (p.brand) {
      if (!extraBrands.has(p.brand)) {
        extraBrands.set(p.brand, {
          slug: p.brand,
          title: p.brand.replace(/[_-]+/g, ' '),
          inCategory: p.category ? [p.category] : [],
        });
      } else {
        const b = extraBrands.get(p.brand);
        if (p.category && !b.inCategory.includes(p.category)) {
          b.inCategory.push(p.category);
        }
      }
    }
  }

  // Merge with explicit category records (those win on title/description)
  const categoryBySlug = new Map();
  for (const [slug, seed] of extraCategories) {
    categoryBySlug.set(slug, { ...seed, scrapedAt: nowIso });
  }
  for (const rec of categoryRecords) {
    const existing = categoryBySlug.get(rec.slug) || {};
    categoryBySlug.set(rec.slug, { ...existing, ...rec });
  }

  for (const [slug, rec] of categoryBySlug) {
    await writeJson(join(CONTENT_DIR, 'categories', `${slug}.json`), rec);
  }

  const brandBySlug = new Map();
  for (const [slug, seed] of extraBrands) {
    brandBySlug.set(slug, { ...seed, scrapedAt: nowIso });
  }
  for (const rec of brandRecords) {
    const existing = brandBySlug.get(rec.slug) || {};
    brandBySlug.set(rec.slug, { ...existing, ...rec });
  }
  for (const [slug, rec] of brandBySlug) {
    await writeJson(join(CONTENT_DIR, 'brands', `${slug}.json`), rec);
  }

  for (const doc of newsWrites) {
    const path = join(CONTENT_DIR, 'news', `${doc.slug}.md`);
    await ensureDir(dirname(path));
    await writeFile(path, `${doc.frontmatter}\n\n${doc.body}\n`, 'utf8');
  }
  for (const doc of objectWrites) {
    const path = join(CONTENT_DIR, 'objects', `${doc.slug}.md`);
    await ensureDir(dirname(path));
    await writeFile(path, `${doc.frontmatter}\n\n${doc.body}\n`, 'utf8');
  }
  for (const doc of articleWrites) {
    const path = join(CONTENT_DIR, 'articles', `${doc.slug}.md`);
    await ensureDir(dirname(path));
    await writeFile(path, `${doc.frontmatter}\n\n${doc.body}\n`, 'utf8');
  }
  for (const rec of certificateRecords) {
    await writeJson(join(CONTENT_DIR, 'certificates', `${rec.slug}.json`), rec);
  }

  // -------------------------------------------------------------------------
  // Remove placeholder .md files from FEAT-001, but only if we actually
  // wrote real content for that collection.
  // -------------------------------------------------------------------------
  const placeholderRemovals = [
    { coll: 'news', wrote: newsWrites.length },
    { coll: 'objects', wrote: objectWrites.length },
    { coll: 'articles', wrote: articleWrites.length },
  ];
  for (const { coll, wrote } of placeholderRemovals) {
    if (!wrote) continue;
    const ph = join(CONTENT_DIR, coll, 'placeholder.md');
    if (await fileExists(ph)) {
      await unlink(ph);
      log(`[cleanup] removed placeholder ${coll}/placeholder.md`);
    }
  }

  // -------------------------------------------------------------------------
  // Scrape report
  // -------------------------------------------------------------------------
  const imagesCount = imageSuccesses.size;
  const imagesFailedCount = imageFailures.size;

  const report = {
    scrapedAt: nowIso,
    urls_total: counts.urls_total,
    urls_processed: counts.urls_processed,
    urls_failed: counts.urls_failed,
    products_count: productRecords.length,
    categories_count: categoryBySlug.size,
    brands_count: brandBySlug.size,
    news_count: newsWrites.length,
    objects_count: objectWrites.length,
    articles_count: articleWrites.length,
    certificates_count: certificateRecords.length,
    images_downloaded: imagesCount,
    images_failed: imagesFailedCount,
    lists_skipped: counts.lists_skipped,
    other_skipped: counts.other_skipped,
    cli: {
      limit: LIMIT || null,
      only: argv.only || null,
      refresh: REFRESH,
      skipImages: SKIP_IMAGES,
    },
  };
  await writeJson(join(CONTENT_DIR, '_scrape-report.json'), report);

  if (errorLines.length > 0) {
    await writeFile(ERROR_LOG, errorLines.join('\n') + '\n', 'utf8');
  }

  log(`[report] ${JSON.stringify(report)}`);

  const failureRate = counts.urls_total > 0 ? counts.urls_failed / counts.urls_total : 0;
  if (failureRate >= 0.1) {
    log(`[exit] failure rate ${(failureRate * 100).toFixed(1)}% >= 10%, exiting 1`);
    process.exit(1);
  }
}

run().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('[fatal]', err);
  process.exit(1);
});
