import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import https from 'node:https';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TINYPNG_ENDPOINT = 'https://tinypng.com/backend/opt/shrink';
const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';
const SUPPORTED_EXTENSIONS = new Set(['.avif', '.jpeg', '.jpg', '.png', '.webp']);

export function parseSize(value) {
  const match = String(value).trim().toLowerCase().match(/^(\d+(?:\.\d+)?)(b|kb|k|mb|m)?$/);
  if (!match) {
    throw new Error(`Invalid size: ${value}`);
  }

  const amount = Number(match[1]);
  const unit = match[2] ?? 'b';
  const multiplier = unit === 'mb' || unit === 'm' ? 1024 * 1024 : unit === 'kb' || unit === 'k' ? 1024 : 1;
  return Math.floor(amount * multiplier);
}

function normalizeSlashes(value) {
  return value.split(path.sep).join('/');
}

function escapeRegExp(value) {
  return value.replace(/[|\\{}()[\]^$+?.]/g, '\\$&');
}

function globToRegExp(pattern) {
  const normalized = normalizeSlashes(pattern);
  let source = '';

  for (let index = 0; index < normalized.length; index += 1) {
    const char = normalized[index];
    const next = normalized[index + 1];
    const afterNext = normalized[index + 2];

    if (char === '*' && next === '*' && afterNext === '/') {
      source += '(?:.*/)?';
      index += 2;
    } else if (char === '*' && next === '*') {
      source += '.*';
      index += 1;
    } else if (char === '*') {
      source += '[^/]*';
    } else if (char === '?') {
      source += '[^/]';
    } else {
      source += escapeRegExp(char);
    }
  }

  return new RegExp(`^${source}$`);
}

function globPatternToMatcher(pattern) {
  if (path.isAbsolute(pattern)) {
    const matcher = globToRegExp(pattern);
    return absolutePath => matcher.test(normalizeSlashes(path.resolve(absolutePath)));
  }

  const matcher = globToRegExp(normalizeSlashes(pattern).replace(/^\.\//, ''));
  return absolutePath => matcher.test(normalizeSlashes(path.relative(process.cwd(), absolutePath)));
}

function createPathMatchers(patterns) {
  return patterns.filter(Boolean).map(pattern => globPatternToMatcher(pattern));
}

function hasGlobMagic(pattern) {
  return /[*?]/.test(pattern);
}

async function exists(targetPath) {
  try {
    await fsp.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function walkDirectory(dir, shouldIgnore = () => false) {
  const files = [];
  const entries = await fsp.readdir(dir, { withFileTypes: true });

  for (const entry of entries) {
    const entryPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      if (!shouldIgnore(entryPath, true)) {
        files.push(...(await walkDirectory(entryPath, shouldIgnore)));
      }
    } else if (entry.isFile()) {
      if (!shouldIgnore(entryPath, false)) {
        files.push(entryPath);
      }
    }
  }

  return files;
}

function getSearchRoot(pattern) {
  const normalized = normalizeSlashes(pattern);
  const firstMagic = normalized.search(/[*?]/);

  if (firstMagic === -1) {
    return pattern;
  }

  const slashBeforeMagic = normalized.lastIndexOf('/', firstMagic);
  const root = slashBeforeMagic === -1 ? '.' : normalized.slice(0, slashBeforeMagic);
  return root || '.';
}

async function expandPattern(pattern, options = {}) {
  const absolutePattern = path.resolve(pattern);

  if (!hasGlobMagic(pattern)) {
    const targetExists = await exists(absolutePattern);
    if (!targetExists) {
      return [];
    }

    const stat = await fsp.stat(absolutePattern);
    if (stat.isDirectory()) {
      return walkDirectory(absolutePattern, options.shouldIgnore);
    }

    return stat.isFile() ? [absolutePattern] : [];
  }

  const root = path.resolve(getSearchRoot(pattern));
  if (!(await exists(root))) {
    return [];
  }

  const matcher = globToRegExp(absolutePattern);
  const candidates = await walkDirectory(root, options.shouldIgnore);
  return candidates.filter(candidate => matcher.test(normalizeSlashes(path.resolve(candidate))));
}

function parseGitIgnoreLine(line) {
  const trimmed = line.trim();

  if (!trimmed || trimmed.startsWith('#')) {
    return null;
  }

  const negated = trimmed.startsWith('!');
  let pattern = negated ? trimmed.slice(1) : trimmed;

  if (!pattern) {
    return null;
  }

  pattern = normalizeSlashes(pattern);
  const directoryOnly = pattern.endsWith('/');
  pattern = pattern.replace(/\/+$/, '');

  if (!pattern) {
    return null;
  }

  const anchored = pattern.startsWith('/');
  pattern = anchored ? pattern.slice(1) : pattern;
  const source = globToRegExp(pattern).source.slice(1, -1);
  const matcher = anchored
    ? new RegExp(`^${source}(?:/.*)?$`)
    : new RegExp(`(?:^|.*/)${source}(?:/.*)?$`);

  return { matcher, negated, directoryOnly };
}

async function loadGitIgnore(rootDir) {
  const gitIgnorePath = path.join(rootDir, '.gitignore');

  try {
    const raw = await fsp.readFile(gitIgnorePath, 'utf8');
    return raw.split(/\r?\n/).map(parseGitIgnoreLine).filter(Boolean);
  } catch (error) {
    if (error.code === 'ENOENT') {
      return [];
    }

    throw error;
  }
}

function createGitIgnoreMatcher(rootDir, rules) {
  return (absolutePath, isDirectory = false) => {
    const relativePath = normalizeSlashes(path.relative(rootDir, absolutePath));

    if (!relativePath || relativePath.startsWith('..')) {
      return false;
    }

    if (relativePath === '.git' || relativePath.startsWith('.git/')) {
      return true;
    }

    let ignored = false;

    for (const rule of rules) {
      if (rule.directoryOnly && !isDirectory && !relativePath.includes('/')) {
        continue;
      }

      if (rule.matcher.test(relativePath)) {
        ignored = !rule.negated;
      }
    }

    return ignored;
  };
}

async function hashFile(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('md5');
    const stream = fs.createReadStream(filePath);

    stream.on('data', chunk => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

async function readCache(cacheFile) {
  try {
    const raw = await fsp.readFile(cacheFile, 'utf8');
    const data = JSON.parse(raw);

    if (Array.isArray(data)) {
      return new Set(data);
    }

    if (Array.isArray(data.md5)) {
      return new Set(data.md5);
    }

    return new Set();
  } catch (error) {
    if (error.code === 'ENOENT') {
      return new Set();
    }

    throw error;
  }
}

async function writeCache(cacheFile, md5Set) {
  const payload = {
    version: 1,
    md5: [...md5Set].sort(),
    updatedAt: new Date().toISOString(),
  };

  await fsp.writeFile(cacheFile, `${JSON.stringify(payload, null, 2)}\n`);
}

function randomIp() {
  return Array.from({ length: 4 }, () => Math.floor(Math.random() * 256)).join('.');
}

function requestJson(url, bodyPath, timeout) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      url,
      {
        method: 'POST',
        timeout,
        headers: {
          'Cache-Control': 'no-cache',
          'Content-Type': 'application/x-www-form-urlencoded',
          'Postman-Token': String(Date.now()),
          'User-Agent': DEFAULT_USER_AGENT,
          'X-Forwarded-For': randomIp(),
        },
      },
      res => {
        let raw = '';
        res.setEncoding('utf8');
        res.on('data', chunk => {
          raw += chunk;
        });
        res.on('end', () => {
          try {
            const payload = JSON.parse(raw);
            if (res.statusCode < 200 || res.statusCode >= 300) {
              reject(new Error(payload?.message || `TinyPNG responded with HTTP ${res.statusCode}`));
              return;
            }

            resolve(payload);
          } catch {
            reject(new Error(`TinyPNG returned an invalid response: ${raw.slice(0, 120)}`));
          }
        });
      },
    );

    req.on('timeout', () => {
      req.destroy(new Error(`Request timed out after ${timeout}ms`));
    });
    req.on('error', reject);
    fs.createReadStream(bodyPath).on('error', reject).pipe(req);
  });
}

function downloadFile(url, targetPath, timeout) {
  const tempPath = `${targetPath}.tinypng-${process.pid}-${Date.now()}.tmp`;

  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout, headers: { 'User-Agent': DEFAULT_USER_AGENT } }, res => {
      if (res.statusCode < 200 || res.statusCode >= 300) {
        reject(new Error(`Download responded with HTTP ${res.statusCode}`));
        res.resume();
        return;
      }

      const writer = fs.createWriteStream(tempPath);
      writer.on('finish', async () => {
        try {
          await fsp.rename(tempPath, targetPath);
          resolve();
        } catch (error) {
          reject(error);
        }
      });
      writer.on('error', reject);
      res.pipe(writer);
    });

    req.on('timeout', () => {
      req.destroy(new Error(`Download timed out after ${timeout}ms`));
    });
    req.on('error', reject);
  }).catch(async error => {
    await fsp.rm(tempPath, { force: true });
    throw error;
  });
}

async function retry(task, retries) {
  let lastError;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return await task(attempt);
    } catch (error) {
      lastError = error;
      if (attempt < retries) {
        await new Promise(resolve => setTimeout(resolve, 500 * (attempt + 1)));
      }
    }
  }

  throw lastError;
}

async function collectImagePaths(configs, tinyfiedMd5, options = {}) {
  const imagePaths = [];
  const seen = new Set();
  const includeMatchers = createPathMatchers(options.includePatterns ?? []);
  const excludeMatchers = createPathMatchers(options.excludePatterns ?? []);
  const gitIgnoreRules = options.useGitIgnore ? await loadGitIgnore(process.cwd()) : [];
  const isGitIgnored = createGitIgnoreMatcher(process.cwd(), gitIgnoreRules);
  const shouldIgnore = (absolutePath, isDirectory = false) => isGitIgnored(absolutePath, isDirectory);

  for (const config of configs) {
    const patterns = Array.isArray(config.imageRegExp) ? config.imageRegExp : [config.imageRegExp];
    const ignorePatterns = Array.isArray(config.imageIgnoreRegExp)
      ? config.imageIgnoreRegExp
      : config.imageIgnoreRegExp
        ? [config.imageIgnoreRegExp]
        : [];
    const ignoreMatchers = ignorePatterns.map(pattern => globToRegExp(path.resolve(pattern)));

    for (const pattern of patterns) {
      const files = await expandPattern(pattern, { shouldIgnore });

      for (const filePath of files) {
        const absolutePath = path.resolve(filePath);
        if (shouldIgnore(absolutePath, false)) {
          continue;
        }

        if (seen.has(absolutePath) || !SUPPORTED_EXTENSIONS.has(path.extname(absolutePath).toLowerCase())) {
          continue;
        }

        const normalized = normalizeSlashes(absolutePath);
        if (ignoreMatchers.some(matcher => matcher.test(normalized))) {
          continue;
        }

        if (includeMatchers.length > 0 && !includeMatchers.some(matcher => matcher(absolutePath))) {
          continue;
        }

        if (excludeMatchers.some(matcher => matcher(absolutePath))) {
          continue;
        }

        const stat = await fsp.stat(absolutePath);
        if (stat.size <= (config.minCompressSize ?? 0)) {
          continue;
        }

        const md5 = await hashFile(absolutePath);
        if (tinyfiedMd5.has(md5)) {
          continue;
        }

        seen.add(absolutePath);
        imagePaths.push({ path: absolutePath, md5, size: stat.size });
      }
    }
  }

  return imagePaths;
}

function resolveOutputPath(imagePath, outputDir) {
  if (!outputDir) {
    return imagePath;
  }

  return path.join(path.resolve(outputDir), path.relative(process.cwd(), imagePath));
}

async function compressOne(imagePath, minCompressRate, timeout, outputPath = imagePath) {
  const payload = await requestJson(TINYPNG_ENDPOINT, imagePath, timeout);
  const output = payload?.output;

  if (!output?.url || typeof output.ratio !== 'number') {
    throw new Error('TinyPNG response did not include output.url and output.ratio');
  }

  const savedPercent = (1 - output.ratio) * 100;
  if (savedPercent <= minCompressRate) {
    return { tinyfied: false, savedPercent, url: output.url };
  }

  await fsp.mkdir(path.dirname(outputPath), { recursive: true });
  await downloadFile(output.url, outputPath, timeout);
  return { tinyfied: true, savedPercent, url: output.url };
}

async function runQueue(items, concurrency, worker) {
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async (_, workerIndex) => {
    for (let index = workerIndex; index < items.length; index += concurrency) {
      await worker(items[index], index);
    }
  });

  await Promise.all(workers);
}

export async function tinyPng(param) {
  const {
    tinyfyConfigs,
    tinyfiedMd5 = [],
    minCompressRate = 0,
    concurrents = 6,
    onProgress,
    cacheFile = '.tinypng-cache.json',
    useCache = true,
    dryRun = false,
    retries = 3,
    timeout = 30000,
    outputDir,
    includePatterns = [],
    excludePatterns = [],
    useGitIgnore = true,
    compressImage = compressOne,
  } = param;

  if (!Array.isArray(tinyfyConfigs) || tinyfyConfigs.length === 0) {
    throw new Error('tinyfyConfigs is required');
  }

  const cachePath = path.resolve(cacheFile);
  const md5Cache = useCache ? await readCache(cachePath) : new Set();
  for (const md5 of tinyfiedMd5) {
    md5Cache.add(md5);
  }

  const imagePaths = await collectImagePaths(tinyfyConfigs, md5Cache, {
    includePatterns,
    excludePatterns,
    useGitIgnore,
  });
  console.log(`[tinyPng] matched ${imagePaths.length} image(s)`);

  if (dryRun) {
    for (const item of imagePaths) {
      console.log(`[tinyPng] dry-run: ${item.path}`);
    }

    return { tinyfied: [], untiny: imagePaths.map(item => item.path), failed: [] };
  }

  const result = {
    tinyfied: [],
    untiny: [],
    failed: [],
  };
  let completed = 0;

  await runQueue(imagePaths, concurrents, async item => {
    const outputPath = resolveOutputPath(item.path, outputDir);

    try {
      const compressed = await retry(() => compressImage(item.path, minCompressRate, timeout, outputPath), retries);
      completed += 1;

      if (compressed.tinyfied) {
        const newMd5 = outputDir ? item.md5 : await hashFile(outputPath);
        md5Cache.add(newMd5);
        result.tinyfied.push(outputPath);
      } else {
        result.untiny.push(item.path);
      }

      onProgress?.(completed, imagePaths.length, {
        path: item.path,
        outputPath,
        savedPercent: compressed.savedPercent,
        tinyfied: compressed.tinyfied,
      });
    } catch (error) {
      completed += 1;
      result.failed.push({ path: item.path, error: error.message });
      console.error(`[tinyPng] failed: ${item.path} - ${error.message}`);
      onProgress?.(completed, imagePaths.length, { path: item.path, error });
    }
  });

  if (useCache) {
    await writeCache(cachePath, md5Cache);
  }

  return result;
}

export const tinyPngCli = {
  tinyfy: tinyPng,
};

export default tinyPngCli;

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  console.log('This module is intended to be imported. Use bin/tinypng-cli.js for the CLI.');
}
