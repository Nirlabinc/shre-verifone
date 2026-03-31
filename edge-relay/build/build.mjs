/**
 * Edge Relay Build Script
 *
 * 1. Bundle with esbuild → single relay.cjs
 * 2. Inline admin UI as static assets
 * 3. Package with Node.js SEA (Single Executable Application)
 *
 * Usage: node build/build.mjs [--platform win|linux] [--no-package]
 */

import { build } from 'esbuild';
import { readFileSync, writeFileSync, mkdirSync, existsSync, cpSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const DIST = join(ROOT, 'dist');

const args = process.argv.slice(2);
const targetPlatform =
  args.find((a) => a.startsWith('--platform='))?.split('=')[1] || process.platform;
const noPackage = args.includes('--no-package');

async function main() {
  console.log(`Building edge relay for ${targetPlatform}...`);

  // Clean dist
  if (existsSync(DIST)) {
    execSync(`rm -rf "${DIST}"`);
  }
  mkdirSync(DIST, { recursive: true });

  // 1. Bundle with esbuild
  console.log('Bundling with esbuild...');
  await build({
    entryPoints: [join(ROOT, 'src/main.mjs')],
    bundle: true,
    platform: 'node',
    target: 'node20',
    format: 'cjs',
    outfile: join(DIST, 'relay.cjs'),
    minify: true,
    sourcemap: false,
    external: ['better-sqlite3'], // Native addon — ship separately
    define: {
      'process.env.RELAY_VERSION': JSON.stringify(getVersion()),
    },
  });

  console.log('Bundle created: dist/relay.cjs');

  // 2. Copy admin UI
  const uiDist = join(DIST, 'admin-ui');
  mkdirSync(uiDist, { recursive: true });
  cpSync(join(ROOT, 'admin-ui'), uiDist, { recursive: true });
  console.log('Admin UI copied');

  // 3. Copy better-sqlite3 native addon
  const nativeDir = join(DIST, 'native');
  mkdirSync(nativeDir, { recursive: true });

  try {
    const sqliteBinding = await findNativeAddon('better-sqlite3');
    if (sqliteBinding) {
      cpSync(sqliteBinding, join(nativeDir, 'better_sqlite3.node'));
      console.log('Native addon copied');
    }
  } catch (err) {
    console.warn('Warning: Could not copy native addon:', err.message);
  }

  if (noPackage) {
    console.log('Build complete (--no-package). Output: dist/');
    return;
  }

  // 4. Package as SEA (Node.js 20+)
  console.log('Creating standalone binary...');
  try {
    await packageSEA(targetPlatform);
  } catch (err) {
    console.warn('SEA packaging failed:', err.message);
    console.log('Falling back to distributable directory. Run: node dist/relay.cjs');
  }

  console.log('Build complete!');
}

function getVersion() {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  return pkg.version || '1.0.0';
}

async function findNativeAddon(name) {
  const paths = [
    join(ROOT, 'node_modules', name, 'build', 'Release'),
    join(ROOT, 'node_modules', name, 'prebuilds', `${process.platform}-${process.arch}`),
  ];

  for (const dir of paths) {
    if (!existsSync(dir)) continue;
    const { readdirSync } = await import('fs');
    const files = readdirSync(dir);
    const node = files.find((f) => f.endsWith('.node'));
    if (node) return join(dir, node);
  }
  return null;
}

async function packageSEA(platform) {
  const ext = platform === 'win32' ? '.exe' : '';
  const binaryName = `verifone-edge-relay${ext}`;
  const binaryPath = join(DIST, binaryName);

  // Create SEA config
  const seaConfig = {
    main: join(DIST, 'relay.cjs'),
    output: join(DIST, 'sea-prep.blob'),
    disableExperimentalSEAWarning: true,
    useSnapshot: false,
    useCodeCache: true,
    assets: {
      'admin-ui/index.html': join(DIST, 'admin-ui/index.html'),
      'admin-ui/setup.html': join(DIST, 'admin-ui/setup.html'),
      'admin-ui/status.html': join(DIST, 'admin-ui/status.html'),
    },
  };

  writeFileSync(join(DIST, 'sea-config.json'), JSON.stringify(seaConfig, null, 2));

  // Generate SEA blob
  execSync(`node --experimental-sea-config "${join(DIST, 'sea-config.json')}"`, {
    stdio: 'inherit',
  });

  // Copy node binary
  execSync(`cp "$(which node)" "${binaryPath}"`, { stdio: 'inherit' });

  // Inject blob
  if (process.platform === 'darwin') {
    execSync(`codesign --remove-signature "${binaryPath}"`, { stdio: 'inherit' });
    execSync(
      `npx postject "${binaryPath}" NODE_SEA_BLOB "${join(DIST, 'sea-prep.blob')}" --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2 --macho-segment-name NODE_SEA`,
      { stdio: 'inherit' },
    );
    execSync(`codesign --sign - "${binaryPath}"`, { stdio: 'inherit' });
  } else {
    execSync(
      `npx postject "${binaryPath}" NODE_SEA_BLOB "${join(DIST, 'sea-prep.blob')}" --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2`,
      { stdio: 'inherit' },
    );
  }

  console.log(`Standalone binary: dist/${binaryName}`);
}

main().catch((err) => {
  console.error('Build failed:', err);
  process.exit(1);
});
