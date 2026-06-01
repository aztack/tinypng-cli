import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { parseSize, tinyPng } from '../src/index.js';

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const fixtureDir = path.join(rootDir, 'tests/fixtures');
const outputDir = path.join(rootDir, 'tests/output');
const cliPath = path.join(rootDir, 'bin/tinypng-cli.js');
const fixtureNames = [
  'opm_ep01_v2_frame_1.png',
  'opm_ep01_v2_frame_2.png',
  'opm_ep01_v2_frame_3.png',
];
const fixturePaths = fixtureNames.map(name => path.join(fixtureDir, name));

async function hashFile(filePath) {
  const data = await fsp.readFile(filePath);
  return crypto.createHash('md5').update(data).digest('hex');
}

async function resetOutputDir() {
  await fsp.rm(outputDir, { recursive: true, force: true });
  await fsp.mkdir(outputDir, { recursive: true });
}

test('parseSize supports bytes, kb, and mb', () => {
  assert.equal(parseSize('512'), 512);
  assert.equal(parseSize('10kb'), 10 * 1024);
  assert.equal(parseSize('1.5mb'), 1.5 * 1024 * 1024);
});

test('minCompressSize filters small-enough images before compression', async () => {
  const result = await tinyPng({
    tinyfyConfigs: [{ imageRegExp: ['tests/fixtures'], minCompressSize: parseSize('10mb') }],
    useCache: false,
  });

  assert.deepEqual(result.tinyfied, []);
  assert.deepEqual(result.untiny, []);
  assert.deepEqual(result.failed, []);
});

test('compression flow writes outputs without overwriting fixture pngs', async () => {
  await resetOutputDir();

  const beforeHashes = new Map(await Promise.all(fixturePaths.map(async filePath => [filePath, await hashFile(filePath)])));
  const progress = [];
  const calls = [];

  const result = await tinyPng({
    tinyfyConfigs: [{ imageRegExp: ['tests/fixtures/*.png'] }],
    useCache: false,
    outputDir,
    minCompressRate: 0,
    compressImage: async (imagePath, minCompressRate, timeout, outputPath) => {
      calls.push({ imagePath, minCompressRate, timeout, outputPath });
      await fsp.mkdir(path.dirname(outputPath), { recursive: true });
      await fsp.writeFile(outputPath, Buffer.from(`compressed:${path.basename(imagePath)}`));
      return { tinyfied: true, savedPercent: 42, url: 'https://example.test/compressed.png' };
    },
    onProgress(current, total, item) {
      progress.push({ current, total, item });
    },
  });

  const expectedOutputs = fixtureNames.map(name => path.join(outputDir, 'tests/fixtures', name));

  assert.equal(calls.length, 3);
  assert.deepEqual(result.tinyfied.sort(), expectedOutputs.sort());
  assert.deepEqual(result.failed, []);
  assert.deepEqual(result.untiny, []);
  assert.equal(progress.length, 3);

  for (const filePath of fixturePaths) {
    assert.equal(await hashFile(filePath), beforeHashes.get(filePath));
  }

  for (const outputPath of expectedOutputs) {
    const output = await fsp.readFile(outputPath, 'utf8');
    assert.match(output, /^compressed:opm_ep01_v2_frame_[123]\.png$/);
  }
});

test('include and exclude filters narrow batch mode matches', async () => {
  const calls = [];

  const result = await tinyPng({
    tinyfyConfigs: [{ imageRegExp: ['tests/fixtures'] }],
    useCache: false,
    includePatterns: ['tests/fixtures/opm_ep01_v2_frame_*.png'],
    excludePatterns: ['**/opm_ep01_v2_frame_2.png', '**/opm_ep01_v2_frame_3.png'],
    minCompressRate: 10,
    compressImage: async imagePath => {
      calls.push(imagePath);
      return { tinyfied: false, savedPercent: 5, url: 'https://example.test/compressed.png' };
    },
  });

  assert.deepEqual(calls, [path.join(fixtureDir, 'opm_ep01_v2_frame_1.png')]);
  assert.deepEqual(result.tinyfied, []);
  assert.deepEqual(result.untiny, [path.join(fixtureDir, 'opm_ep01_v2_frame_1.png')]);
  assert.deepEqual(result.failed, []);
});

test('batch mode respects project .gitignore by default', async () => {
  await resetOutputDir();
  await fsp.writeFile(path.join(outputDir, 'ignored-by-gitignore.png'), 'not a real png but has a supported extension');

  const calls = [];

  await tinyPng({
    tinyfyConfigs: [{ imageRegExp: ['tests'] }],
    useCache: false,
    compressImage: async imagePath => {
      calls.push(imagePath);
      return { tinyfied: false, savedPercent: 0, url: 'https://example.test/compressed.png' };
    },
  });

  assert.equal(calls.length, 3);
  assert.ok(calls.every(filePath => filePath.startsWith(fixtureDir)));
});

test('cli defaults to non-dry-run and can skip all fixtures without uploading', async () => {
  const { stdout } = await execFileAsync(process.execPath, [cliPath, 'tests/fixtures', '--min-size', '10mb', '--no-cache'], {
    cwd: rootDir,
  });

  assert.match(stdout, /\[tinyPng\] matched 0 image\(s\)/);
  assert.doesNotMatch(stdout, /dry-run/);
  assert.match(stdout, /\[tinyPng\] done: compressed 0, skipped 0, failed 0/);
});
