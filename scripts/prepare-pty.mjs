import { constants, existsSync, lstatSync, readFileSync, chmodSync, accessSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const defaultPackageDir = resolve(dirname(fileURLToPath(import.meta.url)), '../node_modules/node-pty');

/**
 * node-pty 1.1.0 publishes Darwin spawn-helper files without executable bits.
 * Only the current platform/architecture's pinned helper candidates are changed.
 * This is installation preparation, not a PTY backend or runtime policy change.
 */
export function preparePty({ platform = process.platform, arch = process.arch,
  packageDir = defaultPackageDir } = {}) {
  const result = { platform, arch, skipped: platform !== 'darwin', checked: [], changed: [] };
  if (result.skipped) return result;
  const manifest = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8'));
  if (manifest.name !== 'node-pty' || manifest.version !== '1.1.0')
    throw new Error('PTY preparation only supports pinned node-pty@1.1.0; revalidate before upgrading.');
  const candidates = ['build/Release', 'build/Debug', `prebuilds/${platform}-${arch}`];
  for (const candidate of candidates) {
    const dir = join(packageDir, candidate);
    if (!existsSync(join(dir, 'pty.node'))) continue;
    const helper = join(dir, 'spawn-helper');
    if (!existsSync(helper)) throw new Error(`Missing PTY spawn-helper: ${helper}`);
    const info = lstatSync(helper);
    if (!info.isFile() || info.isSymbolicLink())
      throw new Error(`PTY spawn-helper must be a regular file: ${helper}`);
    result.checked.push(helper);
    if (!(info.mode & 0o100)) {
      try {
        // Only add owner execute. Do not broaden read/write or group/other bits.
        chmodSync(helper, (info.mode & 0o7777) | 0o100);
        result.changed.push(helper);
      } catch (error) {
        throw new Error(`Cannot set PTY spawn-helper owner execute: ${helper}. Reinstall as the current non-root user. ${String(error)}`);
      }
    }
    accessSync(helper, constants.X_OK);
  }
  if (!result.checked.length)
    throw new Error(`No node-pty native module found for ${platform}-${arch}; check installation scripts/native build.`);
  return result;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    const result = preparePty();
    console.log(result.skipped
      ? `[pty-prepare] skipped on ${result.platform}; no permissions changed`
      : `[pty-prepare] checked ${result.checked.length} helper(s), added owner execute to ${result.changed.length}`);
  } catch (error) {
    console.error(`[pty-prepare] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
