import path from 'node:path';

export const RELEASES_URL = 'https://github.com/dynotable/vscode-dynotable/releases';

/**
 * @typedef {{platform: NodeJS.Platform, arch: string, name: string}} Target
 * `name` is the `<os>-<arch>` part of the platform package name.
 */

/** @type {readonly Target[]} */
export const TARGETS = [
  {platform: 'darwin', arch: 'arm64', name: 'darwin-arm64'},
  {platform: 'linux', arch: 'x64', name: 'linux-x64'},
  {platform: 'win32', arch: 'x64', name: 'win-x64'}
];

/**
 * @param {string} platform
 * @param {string} arch
 */
export const targetOf = (platform, arch) =>
  TARGETS.find((target) => target.platform === platform && target.arch === arch);

/** @param {Target} target */
export const packageOf = (target) => `@dynotable/cli-${target.name}`;

/** @param {string} platform */
export const binaryName = (platform) =>
  platform === 'win32' ? 'dynotable-cli.exe' : 'dynotable-cli';

/**
 * The binary in the platform package of `platform`-`arch`. Throws an error that names the
 * platform and the Releases URL when no package supports it or it is not installed.
 *
 * @param {string} platform
 * @param {string} arch
 * @param {(request: string) => string} resolve `require.resolve` from the wrapper
 */
export function resolveBinary(platform, arch, resolve) {
  const target = targetOf(platform, arch);
  if (!target) {
    throw new Error(
      `dynotable-cli has no binary for ${platform}-${arch}. See ${RELEASES_URL} for the supported platforms.`
    );
  }
  const name = packageOf(target);
  let manifest;
  try {
    manifest = resolve(`${name}/package.json`);
  } catch {
    throw new Error(
      `The package ${name} for ${platform}-${arch} is not installed. Install dynotable-cli again without --omit=optional, or download the binary from ${RELEASES_URL}.`
    );
  }
  return path.join(path.dirname(manifest), 'bin', binaryName(platform));
}
