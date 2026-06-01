# tinypng-cli

一个零依赖的 TinyPNG 命令行工具，用于批量压缩 PNG 图片。

## 使用

```bash
tinypng-cli ./assets
tinypng-cli "src/**/*.png" --ignore "**/node_modules/**"
tinypng-cli ./images --min-size 10kb --min-rate 15 --concurrency 6
tinypng-cli ./images --out-dir ./compressed
```

本地开发时也可以直接运行：

```bash
node ./bin/tinypng-cli.js ./assets
```

## 参数

- `patterns...`: 文件、目录或 glob，例如 `./assets`、`"src/**/*.png"`。
- `-i, --ignore <pattern>`: 忽略 glob，可重复传入。
- `-s, --min-size <size>`: 小于等于该大小的图片不压缩，支持 `b`、`kb`、`mb`。
- `-r, --min-rate <percent>`: 压缩节省比例大于该值才覆盖本地图片。
- `-c, --concurrency <number>`: 并发数，默认 `6`。
- `-o, --out-dir <dir>`: 将压缩后的图片写到指定目录，不覆盖原文件。
- `--cache-file <path>`: md5 缓存文件，默认 `.tinypng-cache.json`。
- `--no-cache`: 不读取或写入缓存。
- `--dry-run`: 只列出匹配文件，不上传。
- `--retries <number>`: 单张图片失败重试次数，默认 `3`。
- `--timeout <ms>`: 请求超时时间，默认 `30000`。

## Node API

```js
import tinyPng from 'tinypng-cli';

await tinyPng.tinyfy({
  tinyfyConfigs: [
    {
      imageRegExp: ['src/**/*.png'],
      imageIgnoreRegExp: ['**/node_modules/**'],
      minCompressSize: 10 * 1024,
    },
  ],
  minCompressRate: 15,
  concurrents: 6,
  outputDir: 'compressed',
});
```

压缩成功后会写入 `.tinypng-cache.json`，后续相同 md5 的图片会被跳过。
