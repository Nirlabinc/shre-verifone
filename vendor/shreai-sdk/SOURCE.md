# Vendored @shreai/sdk

Pre-built copy of the Shre AI Platform SDK. Vendored so this repo installs cleanly with `npm install` on any platform without requiring access to the private Shre monorepo.

## Source

- Upstream: `Shreai/shreai` (private monorepo) → `packages/shre-sdk/`
- Synced from commit: `69cabcf44824d0503dcf5b4bd4d21eff73f99faa` (2026-05-13)
- Built with: `npm install && npm run build` (tsc → `dist/`)

## Local patch

`dist/lite.js` has been hand-patched to fix an ESM/CJS bug — the upstream emits `require('node:fs')` and `require('node:path')` calls inside a `"type":"module"` package, which throws `require is not defined` at runtime and breaks `persistPath`. The patch hoists those imports to top-level ESM `import` statements.

If you re-sync the SDK and the upstream still has the bug, reapply by editing `dist/lite.js`:

- Add to the top of the file:
  ```js
  import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
  import { dirname } from 'node:path';
  ```
- Remove the inline `const { … } = require('node:fs')` and `const { dirname } = require('node:path')` lines from `createLiteCortexClient` (in the persist-load and persist-write blocks).

Upstream issue to track: lite cortex client uses CJS `require` in ESM-mode output.

## How to refresh

Sparse-clone the monorepo subdir, build, copy:

```bash
git clone --no-checkout --depth 1 --filter=blob:none --sparse \
  https://github.com/Shreai/shreai.git /tmp/shreai-sparse
cd /tmp/shreai-sparse
git -c core.protectNTFS=false sparse-checkout init --cone
git sparse-checkout set packages/shre-sdk
git -c core.protectNTFS=false checkout
cd packages/shre-sdk
npm install && npm run build
# Then:
cp -r dist package.json README.md <THIS_REPO>/vendor/shreai-sdk/
# Reapply the patch above to dist/lite.js
```

## What's used

This repo currently imports only:
- `@shreai/sdk/logger` — `createLogger`
- `@shreai/sdk/lite` — `createLiteCortexClient`, `createLiteEventBus`

These have zero runtime deps (only Node built-ins). The full SDK has heavier deps (`ioredis`, `pg`, `zod`) that are listed in `vendor/shreai-sdk/package.json` and installed transitively, but are not loaded unless you import non-lite modules.
