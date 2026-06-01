#!/usr/bin/env node

import process from 'node:process';
import { tinyPng, parseSize } from '../src/index.js';

const helpText = `
tinypng-cli

Usage:
  tinypng-cli [patterns...] [options]

Examples:
  tinypng-cli ./assets
  tinypng-cli ./assets --include "icons/**/*.png" --exclude "**/*.tmp.png"
  tinypng-cli ./images --min-size 10kb --min-rate 15 --concurrency 6

Options:
      --include <pattern>      Only compress images matching this glob. Can be used more than once.
      --exclude <pattern>      Exclude images matching this glob. Can be used more than once.
  -i, --ignore <pattern>       Alias for --exclude.
  -s, --min-size <size>        Skip images at or below this size. Supports b/kb/mb.
  -r, --min-rate <percent>     Only replace files when savings are above this percent.
  -c, --concurrency <number>   Parallel upload count. Default: 6.
  -o, --out-dir <dir>          Write compressed files into this directory instead of overwriting.
      --cache-file <path>      Cache file path. Default: .tinypng-cache.json.
      --no-cache              Do not read or write the md5 cache.
      --no-gitignore          Do not apply .gitignore filters.
      --dry-run               List matched images without uploading.
      --retries <number>      Retry count per image. Default: 3.
      --timeout <ms>          Request timeout in milliseconds. Default: 30000.
  -h, --help                  Show help.
  -v, --version               Show version.
`;

function readPackageVersion() {
  return '0.1.0';
}

function readValue(args, index, option) {
  const value = args[index + 1];
  if (!value || value.startsWith('-')) {
    throw new Error(`${option} requires a value`);
  }
  return value;
}

function parseInteger(value, option) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0) {
    throw new Error(`${option} must be a non-negative integer`);
  }
  return number;
}

function parseArgs(argv) {
  const options = {
    patterns: [],
    include: [],
    exclude: [],
    minSize: 0,
    minRate: 0,
    concurrency: 6,
    cacheFile: '.tinypng-cache.json',
    useCache: true,
    dryRun: false,
    useGitIgnore: true,
    retries: 3,
    timeout: 30000,
    outputDir: undefined,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === '-h' || arg === '--help') {
      options.help = true;
    } else if (arg === '-v' || arg === '--version') {
      options.version = true;
    } else if (arg === '--include') {
      const value = readValue(argv, index, arg);
      options.include.push(value);
      index += 1;
    } else if (arg === '--exclude' || arg === '-i' || arg === '--ignore') {
      const value = readValue(argv, index, arg);
      options.exclude.push(value);
      index += 1;
    } else if (arg === '-s' || arg === '--min-size') {
      const value = readValue(argv, index, arg);
      options.minSize = parseSize(value);
      index += 1;
    } else if (arg === '-r' || arg === '--min-rate') {
      const value = readValue(argv, index, arg);
      options.minRate = Number(value);
      if (!Number.isFinite(options.minRate) || options.minRate < 0 || options.minRate > 100) {
        throw new Error(`${arg} must be a number between 0 and 100`);
      }
      index += 1;
    } else if (arg === '-c' || arg === '--concurrency') {
      const value = readValue(argv, index, arg);
      options.concurrency = parseInteger(value, arg);
      if (options.concurrency === 0) {
        throw new Error(`${arg} must be greater than 0`);
      }
      index += 1;
    } else if (arg === '-o' || arg === '--out-dir') {
      options.outputDir = readValue(argv, index, arg);
      index += 1;
    } else if (arg === '--cache-file') {
      options.cacheFile = readValue(argv, index, arg);
      index += 1;
    } else if (arg === '--no-cache') {
      options.useCache = false;
    } else if (arg === '--no-gitignore') {
      options.useGitIgnore = false;
    } else if (arg === '--dry-run') {
      options.dryRun = true;
    } else if (arg === '--retries') {
      const value = readValue(argv, index, arg);
      options.retries = parseInteger(value, arg);
      index += 1;
    } else if (arg === '--timeout') {
      const value = readValue(argv, index, arg);
      options.timeout = parseInteger(value, arg);
      index += 1;
    } else if (arg.startsWith('-')) {
      throw new Error(`Unknown option: ${arg}`);
    } else {
      options.patterns.push(arg);
    }
  }

  if (options.patterns.length === 0) {
    options.patterns.push('.');
  }

  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));

  if (options.help) {
    console.log(helpText.trim());
    return;
  }

  if (options.version) {
    console.log(readPackageVersion());
    return;
  }

  const result = await tinyPng({
    tinyfyConfigs: [
      {
        imageRegExp: options.patterns,
        imageIgnoreRegExp: options.exclude,
        minCompressSize: options.minSize,
      },
    ],
    minCompressRate: options.minRate,
    concurrents: options.concurrency,
    cacheFile: options.cacheFile,
    useCache: options.useCache,
    useGitIgnore: options.useGitIgnore,
    dryRun: options.dryRun,
    retries: options.retries,
    timeout: options.timeout,
    outputDir: options.outputDir,
    includePatterns: options.include,
    excludePatterns: options.exclude,
    onProgress(current, total, item) {
      const output = item?.outputPath && item.outputPath !== item.path ? ` -> ${item.outputPath}` : '';
      const suffix = item?.savedPercent == null ? '' : ` saved ${item.savedPercent.toFixed(2)}%`;
      console.log(`[tinyPng] progress ${current}/${total}: ${item.path}${output}${suffix}`);
    },
  });

  console.log(`[tinyPng] done: compressed ${result.tinyfied.length}, skipped ${result.untiny.length}, failed ${result.failed.length}`);

  if (result.failed.length > 0) {
    process.exitCode = 1;
  }
}

main().catch(error => {
  console.error(`[tinyPng] ${error.message}`);
  process.exitCode = 1;
});
