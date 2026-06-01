---
name: compress-images
description: Use tinypng-cli to batch-compress AVIF, WebP, PNG, and JPEG images in a project or specified folder.
---

Use this skill when the user asks to compress images with TinyPNG or tinypng-cli.

Workflow:

1. Prefer the project-local CLI when the current repository contains `bin/tinypng-cli.js`:

   ```bash
   node ./bin/tinypng-cli.js <folder-or-glob>
   ```

2. Otherwise use the package command if it is installed or available through the package runner:

   ```bash
   tinypng-cli <folder-or-glob>
   npx tinypng-cli <folder-or-glob>
   ```

3. Use `--out-dir <dir>` unless the user explicitly wants source images overwritten.

4. Use `--include <glob>` and `--exclude <glob>` for filtering. The CLI applies the repository `.gitignore` by default; only pass `--no-gitignore` when the user explicitly wants ignored files considered.

5. For verification runs that should not upload images, pass `--dry-run`. For real compression tests, do not pass `--dry-run`.

Examples:

```bash
node ./bin/tinypng-cli.js assets --out-dir compressed
node ./bin/tinypng-cli.js . --include "src/**/*.png" --include "src/**/*.jpg" --exclude "**/*.backup.*" --out-dir .compressed
```
