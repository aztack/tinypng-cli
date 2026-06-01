import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const fixtureDir = path.join(rootDir, 'tests/fixtures');
const outputDir = path.join(rootDir, 'tests/output/compress-integration');
const cliPath = path.join(rootDir, 'bin/tinypng-cli.js');
const fixtureNames = [
  'opm_ep01_v2_frame_1.png',
  'opm_ep01_v2_frame_2.png',
  'opm_ep01_v2_frame_3.png',
];

async function hashFile(filePath) {
  const data = await fsp.readFile(filePath);
  return crypto.createHash('md5').update(data).digest('hex');
}

async function fileSize(filePath) {
  const stat = await fsp.stat(filePath);
  return stat.size;
}

test('compresses fixture pngs through TinyPNG without overwriting originals', async () => {
  await fsp.rm(outputDir, { recursive: true, force: true });
  await fsp.mkdir(outputDir, { recursive: true });

  const fixtures = await Promise.all(
    fixtureNames.map(async name => {
      const filePath = path.join(fixtureDir, name);
      return {
        name,
        filePath,
        md5: await hashFile(filePath),
        size: await fileSize(filePath),
      };
    }),
  );

  const { stdout } = await execFileAsync(
    process.execPath,
    [
      cliPath,
      'tests/fixtures',
      '--out-dir',
      path.relative(rootDir, outputDir),
      '--no-cache',
      '--concurrency',
      '2',
      '--timeout',
      '60000',
    ],
    {
      cwd: rootDir,
      timeout: 180000,
      maxBuffer: 1024 * 1024,
    },
  );

  assert.match(stdout, /\[tinyPng\] matched 3 image\(s\)/);
  assert.match(stdout, /\[tinyPng\] done: compressed 3, skipped 0, failed 0/);

  for (const fixture of fixtures) {
    const outputPath = path.join(outputDir, 'tests/fixtures', fixture.name);
    const outputSize = await fileSize(outputPath);

    assert.equal(await hashFile(fixture.filePath), fixture.md5);
    assert.ok(outputSize > 0, `${fixture.name} should produce a non-empty compressed file`);
    assert.ok(
      outputSize < fixture.size,
      `${fixture.name} should be smaller after compression: ${outputSize} >= ${fixture.size}`,
    );
  }
});
