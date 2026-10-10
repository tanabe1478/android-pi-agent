import { createHash } from 'node:crypto';
import { lstat, mkdir, open, readFile, rmdir, symlink, unlink } from 'node:fs/promises';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { spawn } from 'node:child_process';

import { readPrivate, writePrivate } from './credentials.ts';

const BASE = 'https://packages.termux.dev/apt/termux-main/';
const TERMUX_PREFIX = 'data/data/com.termux/files/usr';
const MAX_ARCHIVE = 256 * 1024 * 1024;
const NAME = /^[a-z0-9][a-z0-9+.-]{0,79}$/;
const protectedPackages = new Set([
  'apt',
  'dpkg',
  'nodejs',
  'nodejs-lts',
  'npm',
  'termux-exec',
  'termux-tools',
  'termux-core',
]);

type Package = Record<string, string>;
interface Installed {
  package: string;
  version: string;
  bundled: boolean;
  sha256?: string;
  source?: string;
  installedAt?: string;
  files?: string[];
}
interface TarEntry {
  name: string;
  type: '0' | '2' | '5';
  mode: number;
  link: string;
  data: Buffer;
}
interface PrefixEntry extends TarEntry {
  relative: string;
}

export function parsePackageIndex(text: string): Map<string, Package> {
  const packages = new Map<string, Package>();
  for (const paragraph of text.split(/\n\s*\n/)) {
    const fields: Package = Object.create(null);
    for (const line of paragraph.split('\n')) {
      const match = line.match(/^([\w-]+): (.*)$/);
      if (match) fields[match[1]!] = match[2]!;
    }
    if (
      NAME.test(fields.Package ?? '') &&
      fields.Version &&
      fields.Version.length <= 128 &&
      /^\S+$/.test(fields.Version) &&
      ['aarch64', 'all'].includes(fields.Architecture ?? '')
    )
      packages.set(fields.Package!, fields);
  }
  return packages;
}

// Debian version ordering: epoch, upstream, revision, and '~' before everything.
export function compareVersions(left: string, right: string): number {
  function split(version: string): [number, string, string] {
    const colon = version.indexOf(':');
    const epoch = colon < 0 ? 0 : Number(version.slice(0, colon));
    const rest = colon < 0 ? version : version.slice(colon + 1);
    const dash = rest.lastIndexOf('-');
    return [epoch, dash < 0 ? rest : rest.slice(0, dash), dash < 0 ? '0' : rest.slice(dash + 1)];
  }
  function part(a: string, b: string): number {
    let i = 0;
    let j = 0;
    const digit = (c?: string) => c !== undefined && /[0-9]/.test(c);
    const order = (c?: string): number =>
      c === '~'
        ? -1
        : c === undefined || digit(c)
          ? 0
          : /[a-zA-Z]/.test(c)
            ? c.charCodeAt(0)
            : c.charCodeAt(0) + 256;
    while (i < a.length || j < b.length) {
      while ((i < a.length && !digit(a[i])) || (j < b.length && !digit(b[j]))) {
        const difference = order(a[i]) - order(b[j]);
        if (difference) return Math.sign(difference);
        if (i < a.length) i++;
        if (j < b.length) j++;
      }
      while (a[i] === '0') i++;
      while (b[j] === '0') j++;
      let aa = '';
      let bb = '';
      while (digit(a[i])) aa += a[i++];
      while (digit(b[j])) bb += b[j++];
      if (aa.length !== bb.length) return Math.sign(aa.length - bb.length);
      if (aa !== bb) return aa < bb ? -1 : 1;
    }
    return 0;
  }
  const a = split(left);
  const b = split(right);
  return Math.sign(a[0] - b[0]) || part(a[1], b[1]) || part(a[2], b[2]);
}

function satisfies(version: string, operator?: string, required?: string): boolean {
  if (!operator) return true;
  const comparison = compareVersions(version, required!);
  return (
    (
      {
        '=': comparison === 0,
        '>=': comparison >= 0,
        '<=': comparison <= 0,
        '>>': comparison > 0,
        '<<': comparison < 0,
      } as Record<string, boolean>
    )[operator] ?? false
  );
}

export function resolvePackages(
  index: Map<string, Package>,
  installed: Map<string, Installed>,
  name: string,
): Package[] {
  if (!NAME.test(name)) throw new Error('Invalid package name.');
  const selected = new Map<string, Package>();
  function resolve(expression: string) {
    for (const alternative of expression.split('|')) {
      const match = alternative
        .trim()
        .match(/^([a-z0-9][a-z0-9+.-]*)(?::\w+)?(?:\s*\((<<|<=|=|>=|>>)\s*([^\)]+)\))?$/);
      if (!match) throw new Error(`Unsupported dependency: ${expression}`);
      const [, dependency, operator, version] = match;
      const present = installed.get(dependency!);
      if (present && satisfies(present.version, operator, version)) return;
      if (present) continue; // Never upgrade bundled or already installed packages.
      const pkg = index.get(dependency!);
      if (!pkg || !satisfies(pkg.Version!, operator, version)) continue;
      if (protectedPackages.has(dependency!)) {
        throw new Error(
          `${dependency} requires a bundled-runtime update; it cannot be installed here.`,
        );
      }
      if (selected.has(dependency!)) return;
      if (selected.size >= 64) throw new Error('Too many package dependencies.');
      selected.set(dependency!, pkg);
      for (const field of ['Pre-Depends', 'Depends']) {
        for (const item of (pkg[field] || '').split(',')) if (item.trim()) resolve(item);
      }
      return;
    }
    throw new Error(
      `Cannot satisfy ${expression} without updating the runtime. Virtual packages are not supported.`,
    );
  }
  resolve(name);
  return [...selected.values()];
}

export function debMembers(buffer: Buffer): Map<string, Buffer> {
  if (buffer.subarray(0, 8).toString() !== '!<arch>\n') throw new Error('Invalid Debian archive.');
  const result = new Map<string, Buffer>();
  for (let offset = 8; offset < buffer.length; ) {
    const header = buffer.subarray(offset, offset + 60);
    const sizeText = header.subarray(48, 58).toString().trim();
    const size = Number(sizeText);
    if (
      header.length !== 60 ||
      header.subarray(58).toString() !== '`\n' ||
      !/^\d+$/.test(sizeText) ||
      !Number.isSafeInteger(size) ||
      offset + 60 + size > buffer.length
    ) {
      throw new Error('Invalid archive member.');
    }
    const name = header.subarray(0, 16).toString().trim().replace(/\/$/, '');
    if (result.has(name)) throw new Error('Duplicate Debian archive member.');
    result.set(name, buffer.subarray(offset + 60, offset + 60 + size));
    offset += 60 + size + (size % 2);
  }
  return result;
}

export function tarEntries(buffer: Buffer): TarEntry[] {
  const result: TarEntry[] = [];
  for (let offset = 0; offset + 512 <= buffer.length; ) {
    const header = buffer.subarray(offset, offset + 512);
    if (header.every(byte => byte === 0)) {
      if (buffer.length - offset < 1024 || !buffer.subarray(offset).every(byte => byte === 0)) {
        throw new Error('Invalid tar terminator.');
      }
      return result;
    }
    const string = (start: number, size: number) =>
      header
        .subarray(start, start + size)
        .toString()
        .split('\0')[0]!;
    const octal = (start: number, size: number) => {
      const value = string(start, size).trim() || '0';
      if (!/^[0-7]+$/.test(value)) throw new Error('Unsupported tar number.');
      return parseInt(value, 8);
    };
    const sum = [...header].reduce(
      (total, value, index) => total + (index >= 148 && index < 156 ? 32 : value),
      0,
    );
    if (sum !== octal(148, 8)) throw new Error('Invalid tar checksum.');
    const size = octal(124, 12);
    if (!Number.isSafeInteger(size) || offset + 512 + size > buffer.length)
      throw new Error('Invalid tar size.');
    const prefix = string(345, 155);
    const name = (prefix ? `${prefix}/` : '') + string(0, 100);
    const type = string(156, 1) || '0';
    if (!['0', '2', '5'].includes(type) || (type !== '0' && size)) {
      throw new Error('Unsupported tar entry; this package cannot be installed safely.');
    }
    result.push({
      name,
      type: type as TarEntry['type'],
      mode: octal(100, 8) & 0o755,
      link: string(157, 100),
      data: buffer.subarray(offset + 512, offset + 512 + size),
    });
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  throw new Error('Truncated tar archive.');
}

export function prefixEntry(entry: TarEntry): PrefixEntry | null {
  const normalized = entry.name.replace(/^\.\//, '').replace(/\/$/, '');
  if (
    [
      '.',
      '',
      'data',
      'data/data',
      'data/data/com.termux',
      'data/data/com.termux/files',
      TERMUX_PREFIX,
    ].includes(normalized)
  ) {
    if (entry.type !== '5') throw new Error('Invalid package root directory.');
    return null;
  }
  if (!normalized.startsWith(`${TERMUX_PREFIX}/`))
    throw new Error('Package writes outside the Termux prefix.');
  const relative = normalized.slice(TERMUX_PREFIX.length + 1);
  if (
    /[\x00-\x1f\x7f]/.test(relative) ||
    relative.split('/').some(part => !part || part === '..' || part === '.')
  ) {
    throw new Error('Unsafe package path.');
  }
  let link = entry.link;
  if (entry.type === '2') {
    if (link.startsWith(`/${TERMUX_PREFIX}/`)) {
      link = path.posix.relative(
        path.posix.dirname(relative),
        link.slice(TERMUX_PREFIX.length + 2),
      );
    }
    const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(relative), link));
    if (
      !link ||
      /[\x00-\x1f\x7f]/.test(link) ||
      path.posix.isAbsolute(link) ||
      resolved === '..' ||
      resolved.startsWith('../')
    ) {
      throw new Error('Unsafe package symlink.');
    }
  }
  return { ...entry, relative, link };
}

async function decompress(name: string, data: Buffer, prefix: string): Promise<Buffer> {
  if (name.endsWith('.gz')) return gunzipSync(data, { maxOutputLength: MAX_ARCHIVE });
  if (name.endsWith('.tar')) return data;
  if (!name.endsWith('.xz')) throw new Error('Unsupported package compression.');
  return new Promise((resolve, reject) => {
    const child = spawn(path.join(prefix, 'bin/xz'), ['-dc'], {
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    const chunks: Buffer[] = [];
    let size = 0;
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('Decompression timed out.'));
    }, 60_000);
    child.on('error', () => {
      clearTimeout(timer);
      reject(new Error('xz is unavailable.'));
    });
    child.stdin.on('error', () => {});
    child.stdout.on('data', chunk => {
      size += chunk.length;
      if (size > MAX_ARCHIVE) {
        child.kill();
        reject(new Error('Package expands beyond size limit.'));
      } else chunks.push(chunk);
    });
    child.on('close', code => {
      clearTimeout(timer);
      if (code === 0) resolve(Buffer.concat(chunks));
      else reject(new Error('Package decompression failed.'));
    });
    child.stdin.end(data);
  });
}

async function download(
  url: string,
  fetcher: typeof fetch,
  maximum = MAX_ARCHIVE,
): Promise<Buffer> {
  const response = await fetcher(url, { redirect: 'error', signal: AbortSignal.timeout(120_000) });
  if (!response.ok || !response.body)
    throw new Error(`Package download failed (${response.status}).`);
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > maximum) throw new Error('Package download exceeds size limit.');
      chunks.push(Buffer.from(value));
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return Buffer.concat(chunks);
}

export function createPackageManager(options: {
  prefix: string;
  stateDir: string;
  baselineFile: string;
  fetcher?: typeof fetch;
}) {
  const { prefix, stateDir, baselineFile, fetcher = fetch } = options;
  const registryFile = path.join(stateDir, 'packages.json');

  async function installed(): Promise<Map<string, Installed>> {
    const map = new Map<string, Installed>();
    try {
      const baseline = JSON.parse(await readFile(baselineFile, 'utf8')) as {
        rootfsSha256: string;
        packages: Installed[];
      };
      const receipt = (await readFile(path.join(prefix, '../.rootfs-sha256'), 'utf8')).trim();
      if (
        !/^[a-f0-9]{64}$/.test(baseline.rootfsSha256) ||
        receipt !== baseline.rootfsSha256 ||
        !Array.isArray(baseline.packages)
      ) {
        throw new Error();
      }
      let additions: unknown;
      try {
        additions = await readPrivate(registryFile);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        additions = [];
      }
      if (!Array.isArray(additions)) throw new Error();
      for (const [items, bundled] of [
        [baseline.packages, true],
        [additions, false],
      ] as const) {
        for (const pkg of items as Installed[]) {
          if (
            !pkg ||
            typeof pkg.package !== 'string' ||
            !NAME.test(pkg.package) ||
            typeof pkg.version !== 'string' ||
            !pkg.version ||
            pkg.version.length > 128 ||
            map.has(pkg.package)
          )
            throw new Error();
          map.set(pkg.package, { ...pkg, bundled });
        }
      }
    } catch {
      throw new Error(
        'Package registry or native baseline receipt is unreadable/mismatched. Do not replace it automatically.',
      );
    }
    return map;
  }

  async function plan(name: string) {
    if (!NAME.test(name)) throw new Error('Invalid package name.');
    const current = await installed();
    const bytes = await download(
      `${BASE}dists/stable/main/binary-aarch64/Packages.gz`,
      fetcher,
      16 * 1024 * 1024,
    );
    const index = parsePackageIndex(
      gunzipSync(bytes, { maxOutputLength: 32 * 1024 * 1024 }).toString(),
    );
    return { name, packages: resolvePackages(index, current, name), current };
  }

  async function install(name: string, output: (text: string) => void = () => {}) {
    if (!NAME.test(name)) throw new Error('Invalid package name.');
    if (!(await lstat(prefix)).isDirectory()) throw new Error('Unsafe native prefix.');
    await mkdir(stateDir, { recursive: true, mode: 0o700 });
    const lockFile = path.join(stateDir, 'package-install.lock');
    let lock;
    try {
      lock = await open(lockFile, 'wx', 0o600);
    } catch {
      throw new Error(
        'Another installation is active, or an interrupted install left a lock. Inspect package-install.lock before retrying.',
      );
    }
    const created: string[] = [];
    const directories: string[] = [];
    let committed = false;
    try {
      await lock.writeFile(
        JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }),
      );
      const result = await plan(name);
      const prepared: { pkg: Package; entries: PrefixEntry[] }[] = [];
      let total = 0;
      for (const pkg of result.packages) {
        const size = Number(pkg.Size);
        if (
          !/^pool\/[a-zA-Z0-9/+_.-]+\.deb$/.test(pkg.Filename ?? '') ||
          pkg.Filename!.includes('..') ||
          !/^[a-f0-9]{64}$/.test(pkg.SHA256 ?? '') ||
          !Number.isSafeInteger(size) ||
          size <= 0 ||
          size > MAX_ARCHIVE
        ) {
          throw new Error('Invalid package source or size.');
        }
        output(`Downloading ${pkg.Package} ${pkg.Version}`);
        const archive = await download(BASE + pkg.Filename, fetcher, size);
        if (
          archive.length !== size ||
          createHash('sha256').update(archive).digest('hex') !== pkg.SHA256
        ) {
          throw new Error(`Checksum mismatch: ${pkg.Package}`);
        }
        const members = debMembers(archive);
        const data = [...members].filter(([key]) => key.startsWith('data.tar'));
        const control = [...members].filter(([key]) => key.startsWith('control.tar'));
        if (
          data.length !== 1 ||
          control.length !== 1 ||
          members.get('debian-binary')?.toString() !== '2.0\n'
        ) {
          throw new Error('Package payload missing or ambiguous.');
        }
        const scripts = tarEntries(await decompress(...control[0]!, prefix)).filter(entry =>
          /(?:^|\/)(preinst|postinst|prerm|postrm|config)$/.test(entry.name),
        );
        if (scripts.length)
          output(
            `Note: maintainer scripts are NOT executed (${pkg.Package}). Manual setup may be necessary.`,
          );
        const expanded = await decompress(...data[0]!, prefix);
        total += expanded.length;
        if (total > 2 * MAX_ARCHIVE)
          throw new Error('Package plan expands beyond total size limit.');
        prepared.push({
          pkg,
          entries: tarEntries(expanded)
            .map(prefixEntry)
            .filter(entry => entry !== null),
        });
      }

      // Validate every destination before writing. Existing native/user files are never replaced.
      const seen = new Map<string, TarEntry['type']>();
      for (const { entries } of prepared) {
        for (const entry of entries) {
          const destination = path.join(prefix, entry.relative);
          let parent = prefix;
          for (const part of entry.relative.split('/').slice(0, -1)) {
            parent = path.join(parent, part);
            const stats = await absentStat(parent);
            if (stats && !stats.isDirectory())
              throw new Error('Package path traverses a non-directory.');
            const planned = seen.get(path.relative(prefix, parent));
            if (planned && planned !== '5')
              throw new Error('Package path traverses a planned file/link.');
          }
          const existing = await absentStat(destination);
          const planned = seen.get(entry.relative);
          if (entry.type === '5' && (existing?.isDirectory() || planned === '5')) continue;
          if (existing || planned) throw new Error(`Refusing to overwrite ${entry.relative}.`);
          seen.set(entry.relative, entry.type);
        }
      }
      async function ensureDirectory(directory: string): Promise<void> {
        if (directory === prefix) return;
        const exists = await absentStat(directory);
        if (exists) {
          if (!exists.isDirectory()) throw new Error('Unsafe directory.');
          return;
        }
        await ensureDirectory(path.dirname(directory));
        await mkdir(directory, { mode: 0o700 });
        directories.push(directory);
      }
      const ordered = prepared
        .flatMap(({ entries }) => entries)
        .sort((a, b) => Number(a.type === '2') - Number(b.type === '2'));
      for (const entry of ordered) {
        const destination = path.join(prefix, entry.relative);
        await ensureDirectory(path.dirname(destination));
        if (entry.type === '5') {
          await ensureDirectory(destination);
          continue;
        }
        if (entry.type === '2') {
          await symlink(entry.link, destination);
          created.push(destination);
          continue;
        }
        let data = entry.data;
        if (data.subarray(0, 2).toString() === '#!') {
          const newline = data.indexOf(10);
          if (newline >= 0 && newline < 1024) {
            const firstLine = data
              .subarray(0, newline)
              .toString()
              .replace(`/${TERMUX_PREFIX}`, prefix);
            data = Buffer.concat([Buffer.from(firstLine), data.subarray(newline)]);
          }
        }
        const file = await open(destination, 'wx', entry.mode & 0o755);
        created.push(destination);
        try {
          await file.writeFile(data);
          await file.sync();
        } finally {
          await file.close();
        }
      }
      const records = [...result.current.values()]
        .filter(pkg => !pkg.bundled)
        .map(({ bundled, ...pkg }) => pkg);
      for (const { pkg, entries } of prepared)
        records.push({
          package: pkg.Package!,
          version: pkg.Version!,
          sha256: pkg.SHA256,
          source: BASE + pkg.Filename,
          installedAt: new Date().toISOString(),
          files: entries.filter(entry => entry.type !== '5').map(entry => entry.relative),
        });
      if (result.packages.length) await writePrivate(registryFile, records);
      committed = true;
      output(
        result.packages.length
          ? `Installed: ${result.packages.map(pkg => pkg.Package).join(', ')}`
          : `${name} is already installed.`,
      );
      return records;
    } catch (error) {
      if (!committed) {
        for (const file of created.reverse()) await unlink(file).catch(() => {});
        for (const directory of directories.reverse()) await rmdir(directory).catch(() => {});
      }
      throw error;
    } finally {
      await lock.close();
      await unlink(lockFile).catch(() => {});
    }
  }
  return { installed, plan, install };
}

async function absentStat(file: string) {
  try {
    return await lstat(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return undefined;
  }
}
