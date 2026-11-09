// Compiles dynotable-cli with Bun.
//
//   node cli/scripts/build.mjs        the host target, for the binary lane (pnpm cli:build)
//   node cli/scripts/build.mjs --all  the release build: every target, with its platform package
//                                     and its archive (pnpm cli:build:all)
//
// --min-app-version <x.y.z> overrides the app version floor, for the dev live lane. A release
// build refuses a floor lower than CLI_MIN_APP_VERSION.
import {spawnSync} from 'node:child_process';
import {
  copyFileSync,
  linkSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {parseArgs} from 'node:util';
import {
  binaryName,
  packageOf,
  targetOf,
  TARGETS
} from '../npm/dynotable-cli/lib/resolve-platform.mjs';
import {releaseFloor} from '../src/version.ts';

/** The Bun target of each platform package. Baseline builds run on x64 CPUs without AVX2. */
const BUN_TARGETS = {
  'darwin-arm64': 'bun-darwin-arm64',
  'linux-x64': 'bun-linux-x64-baseline',
  'win-x64': 'bun-windows-x64-baseline'
};

const cli = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const root = path.dirname(cli);
const dist = path.join(cli, 'dist');

const {values} = parseArgs({
  options: {all: {type: 'boolean'}, 'min-app-version': {type: 'string'}},
  strict: true
});
const release = values.all === true;
const override = values['min-app-version'];
const floor = release ? checkedFloor(override) : override;

/** @param {string | undefined} given */
function checkedFloor(given) {
  try {
    return releaseFloor(given);
  } catch (error) {
    return fail(/** @type {Error} */ (error).message);
  }
}

/** @param {string} file */
const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));
/**
 * @param {string} message
 * @returns {never}
 */
function fail(message) {
  console.error(`cli build: ${message}`);
  process.exit(1);
}

const pinned = readJson(path.join(cli, 'package.json')).engines.bun;
const bun = spawnSync('bun', ['--version'], {encoding: 'utf8'});
if (bun.error || bun.status !== 0) fail(`Bun ${pinned} is required to compile dynotable-cli.`);
if (bun.stdout.trim() !== pinned) fail(`Bun ${pinned} is required; found ${bun.stdout.trim()}.`);

const wrapper = readJson(path.join(cli, 'npm', 'dynotable-cli', 'package.json'));
/** @type {string} */
const version = wrapper.version;
for (const target of TARGETS) {
  if (wrapper.optionalDependencies?.[packageOf(target)] !== version) {
    fail(`The wrapper must depend on ${packageOf(target)} at its own version ${version}.`);
  }
}

const host = targetOf(process.platform, process.arch);
if (!release && !host) fail(`No target for this host (${process.platform}-${process.arch}).`);
const targets = release
  ? TARGETS
  : [/** @type {import('../npm/dynotable-cli/lib/resolve-platform.mjs').Target} */ (host)];

const template = readFileSync(path.join(cli, 'npm', 'platform.package.json'), 'utf8');
const license = path.join(root, 'LICENSE');

for (const target of targets) {
  const out = path.join(dist, target.name);
  rmSync(out, {recursive: true, force: true});
  const binary = path.join(out, 'bin', binaryName(target.platform));
  compile(BUN_TARGETS[/** @type {keyof typeof BUN_TARGETS} */ (target.name)], binary);
  stamp(target, out);
  if (release) archive(target, binary);
  console.log(`cli build: ${path.relative(root, binary)} ${version}`);
}

/**
 * @param {string} bunTarget
 * @param {string} outfile
 */
function compile(bunTarget, outfile) {
  const defines = {
    DYNOTABLE_CLI_VERSION: version,
    ...(floor === undefined ? {} : {DYNOTABLE_CLI_MIN_APP_VERSION: floor})
  };
  // Bun leaves a `.<hash>.bun-build` file in its working directory when it fails, or when the
  // outfile is on another device.
  const before = new Set(leftovers());
  const result = spawnSync(
    'bun',
    [
      'build',
      path.join(cli, 'src', 'main.ts'),
      '--compile',
      `--target=${bunTarget}`,
      `--outfile=${outfile}`,
      '--minify',
      // The binary runs in the user's directories: it must not load their .env or bunfig.toml.
      '--no-compile-autoload-dotenv',
      '--no-compile-autoload-bunfig',
      ...Object.entries(defines).flatMap(([name, value]) => [
        '--define',
        `${name}=${JSON.stringify(value)}`
      ])
    ],
    {cwd: root, stdio: 'inherit'}
  );
  for (const file of leftovers()) if (!before.has(file)) rmSync(path.join(root, file));
  // An import that does not resolve (for example `vscode`) fails here.
  if (result.error || result.status !== 0) fail(`bun build failed for ${bunTarget}.`);
}

function leftovers() {
  return readdirSync(root).filter((file) => file.endsWith('.bun-build'));
}

/**
 * Writes the platform package around the binary: `cli/dist/<os>-<arch>/`.
 *
 * @param {import('../npm/dynotable-cli/lib/resolve-platform.mjs').Target} target
 * @param {string} out
 */
function stamp(target, out) {
  const manifest = template
    .replaceAll('{{target}}', target.name)
    .replaceAll('{{version}}', version)
    .replaceAll('{{os}}', target.platform)
    .replaceAll('{{cpu}}', target.arch);
  if (manifest.includes('{{')) fail('platform.package.json has a placeholder that is not stamped.');
  if (JSON.parse(manifest).name !== packageOf(target)) fail('platform package name drift.');
  writeFileSync(path.join(out, 'package.json'), manifest);
  copyFileSync(license, path.join(out, 'LICENSE'));
}

/**
 * The GitHub release archive: the binary, a `dynotable-lsp` hard link to it (the editor bridge)
 * and the licence. tar keeps the hard link, so the archive holds the binary once.
 *
 * @param {import('../npm/dynotable-cli/lib/resolve-platform.mjs').Target} target
 * @param {string} binary
 */
function archive(target, binary) {
  const base = `dynotable-cli-${version}-${target.name}`;
  const staging = path.join(dist, 'archive');
  const folder = path.join(staging, base);
  rmSync(staging, {recursive: true, force: true});
  mkdirSync(folder, {recursive: true});
  const exe = target.platform === 'win32' ? '.exe' : '';
  copyFileSync(binary, path.join(folder, `dynotable-cli${exe}`));
  linkSync(path.join(folder, `dynotable-cli${exe}`), path.join(folder, `dynotable-lsp${exe}`));
  copyFileSync(license, path.join(folder, 'LICENSE'));
  const file = path.join(dist, `${base}.tar.gz`);
  const tar = spawnSync('tar', ['-czf', file, '-C', staging, base], {stdio: 'inherit'});
  rmSync(staging, {recursive: true, force: true});
  if (tar.error || tar.status !== 0) fail(`tar failed for ${base}.`);
}
