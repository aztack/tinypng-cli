# AGENTS.md — tinypng-cli

该文件为 AI 编码代理提供项目上下文、约定和约束。修改此项目前请先阅读。

## 项目概述

一个零依赖的 TinyPNG 命令行工具，用于批量压缩 AVIF、WebP、PNG、JPEG 图片。通过 `https://tinypng.com/backend/opt/shrink` 端点压缩后，将压缩结果下载到本地。

- **语言**: JavaScript (ESM, Node.js >=18)
- **包管理**: npm
- **类型检查**: TypeScript (`tsconfig.json` 开启 `allowJs` + `strict`，但 `checkJs: false`，JSDoc 非必须)
- **许可证**: MIT

## 源码结构

```
tinypng-cli/
  bin/tinypng-cli.js        # CLI 入口，参数解析 + main 函数
  src/index.js              # 核心逻辑：压缩、缓存、glob 展开、gitignore
  tests/
    tinypng-cli.test.js      # 单元测试 + CLI 集成测试
    compress.integration.test.js  # 真实 TinyPNG 压缩集成测试
    fixtures/                # 测试用 PNG 图片
    output/                  # 测试输出（被 .gitignore 排除）
  AGENTS.md
  README.md
  .tinypng-cache.json        # MD5 缓存文件（被 .gitignore 排除）
```

- 只有两个源文件：`bin/tinypng-cli.js` (CLI 层) 和 `src/index.js` (库层)。
- `src/index.js` 导出 `tinyPng` 函数和 `parseSize` 工具函数。`tinyPngCli` 是带 `.tinyfy` 别名的默认导出。
- `bin/tinypng-cli.js` 通过 `import { tinyPng, parseSize } from '../src/index.js'` 使用库层。

## 重要约定与约束

### 零依赖

项目依赖为零（除 `@types/node` 作为 devDependency）。**不要引入 npm 依赖**。所有功能用 Node.js 内置模块实现：`node:crypto`、`node:fs`、`node:fs/promises`、`node:https`、`node:path`、`node:process`、`node:url`、`node:child_process`、`node:test`。

### ESM

所有文件使用 ESM (`type: "module"`)。`import`/`export` 语法，不使用 `require`。测试使用 `node:test` 内置测试运行器。

### API 层职责

- **`src/index.js`** 是库层。导出 `tinyPng()` 执行压缩流程，不直接读写 `process.argv` 或 `process.stdout`（除内部 `console.log` 进度/调试日志外）。上层可以注入 `compressImage`、`onProgress` 等函数覆盖其行为。
- **`bin/tinypng-cli.js`** 是 CLI 层。负责从 `process.argv` 解析参数，调用 `tinyPng()`，输出结果。不应实现压缩逻辑。

### `tinyPng()` 核心参数

调用 `tinyPng(param)` 时，`param` 对象包含：

- `tinyfyConfigs` (必填): 数组，每项含 `imageRegExp`（glob 数组）、`imageIgnoreRegExp`（可选）、`minCompressSize`（可选）。
- `minCompressRate`: 压缩节省比例最小值（0-100），不满足则不覆盖。
- `concurrents`: 并发数，默认 6。
- `useCache` / `cacheFile`: MD5 缓存控制。
- `useGitIgnore`: 是否应用 `.gitignore` 规则，默认 true。
- `dryRun`: 仅列出不上传。
- `retries`: 每张图片重试次数，默认 3。
- `timeout`: 请求超时（毫秒），默认 30000。
- `outputDir`: 压缩后写入目录，不覆盖原文件。
- `includePatterns` / `excludePatterns`: 额外 include/exclude glob 过滤。
- `compressImage`: 可注入的压缩函数，用于测试。
- `onProgress`: 进度回调。

### 测试约定

- 测试文件放在 `tests/` 目录，用 `node:test` 编写。
- 运行 `npm test` 执行 `tests/tinypng-cli.test.js`（单元 + CLI 集成）。
- 运行 `npm run test:compress` 执行 `tests/compress.integration.test.js`（真实压缩，依赖网络）。
- **不要修改测试固件** (`tests/fixtures/` 下的 PNG 文件)。集成测试会校验原始固件的 md5 不变。
- 测试输出写入 `tests/output/`，该目录被 `.gitignore` 排除。
- 注入 `compressImage` 替换真实 HTTP 请求以进行单元测试。

### 关键实现细节

#### Glob 路径匹配

- `globToRegExp(pattern)` 自行实现 glob → RegExp，支持 `**`（跨目录）、`*`（单段）、`?`（单字符），不使用第三方库。
- `globPatternToMatcher(pattern)` 根据 pattern 是否绝对路径决定匹配方式：绝对路径直接测试绝对路径；相对路径以 `process.cwd()` 为基准计算相对路径再匹配。
- `expandPattern(pattern, options)` 实现 glob 展开。对无 glob 魔字符的路径直接 stat；对含 `**/*?` 的 pattern，用 `getSearchRoot()` 找到搜索根目录，`walkDirectory()` 递归收集文件后再过滤。

#### Gitignore 处理

- `loadGitIgnore(rootDir)` 解析 `.gitignore`，`createGitIgnoreMatcher()` 生成判定函数。
- 默认会自动应用 `.gitignore`（`useGitIgnore: true`），可用 `--no-gitignore` 关闭。
- `.git` 目录和 `.git/` 下的文件始终被忽略（硬编码在 `createGitIgnoreMatcher` 中）。

#### MD5 缓存

- 缓存文件默认 `.tinypng-cache.json`，结构为 `{ version: 1, md5: string[], updatedAt: ISOString }`。
- 旧格式（顶层数组）也兼容。
- 同名文件仅在上次压缩后内容变化（md5 不同）时重新上传压缩。

#### 并发控制

- `runQueue(items, concurrency, worker)` 用 round-robin 分配实现固定并发，不使用第三方库。

#### 重试机制

- `retry(task, retries)` 在失败时指数退避等待（500ms, 1000ms, 1500ms...），最多重试 `retries` 次。

#### 请求伪装

- `randomIp()` 生成随机 IP 用于 `X-Forwarded-For` 头。
- User-Agent 伪装成 Chrome 浏览器。

#### 输出路径

- `resolveOutputPath(imagePath, outputDir)` 当指定 `outputDir` 时，保持相对于 `cwd` 的目录结构。
- 下载文件先写入临时文件（添加 `.tinypng-<pid>-<timestamp>.tmp` 后缀），下载完成后再 `rename` 到目标路径。

### CLI 参数解析

- 手动解析 `process.argv`（无第三方库），支持长选项和短选项。
- `parseArgs(argv)` 返回结构化的 options 对象。
- 当 `patterns` 为空时默认使用 `.`（当前目录）。
- 支持 `--help` / `-h` 和 `--version` / `-v` 快速退出。
- 未知选项抛错。

### 错误处理

- CLI 层在 `main()` 中用 `.catch()` 捕获所有未处理异常，设 `process.exitCode = 1` 后退出。
- 压缩失败的单张图片不会中断整体流程，失败信息记录在 `result.failed` 数组中。
- 网络请求超时、HTTP 错误、JSON 解析错误分别有明确的错误消息。

### TypeScript 配置

- `tsconfig.json` 使用 `strict: true`、`target: ES2022`、`module: NodeNext`。
- `allowJs: true` 但 `checkJs: false`，不强制类型注解。
- `tests/output/` 被 tsconfig 的 `exclude` 排除。

## 修改原则

1. **保持零依赖** — 不添加 npm 依赖。
2. **不破坏 ESM** — 不使用 `require()`，不改 `type: module`。
3. **测试要更新** — 修改 `src/index.js` 中的逻辑时，同步更新 `tests/tinypng-cli.test.js`。
4. **不修改测试固件** — `tests/fixtures/` 下的 PNG 文件是共享测试资源。
5. **缓存格式向后兼容** — 修改 `.tinypng-cache.json` 格式时需兼容旧格式（纯数组）。
6. **CLI 和库层分离** — CLI 层不做压缩逻辑，库层不直接读写 `process.argv`。
