import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, mkdir, rm, stat, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';

import {
  parsePackageIndex,
  compareVersions,
  resolvePackages,
  prefixEntry,
  debMembers,
  tarEntries,
  createPackageManager,
} from '../runtime/packages.ts';
import { installGitTools } from '../runtime/cli.ts';

function tar(entries) {
  const parts = [];
  for (const entry of entries) {
    const data = Buffer.from(entry.text ?? '');
    const header = Buffer.alloc(512);
    const field = (start, size, value) => header.write(value, start, size, 'ascii');
    field(0, 100, entry.name);
    field(100, 8, '0000755\0');
    field(124, 12, data.length.toString(8).padStart(11, '0') + '\0');
    header.fill(32, 148, 156);
    field(156, 1, entry.type ?? '0');
    field(157, 100, entry.link ?? '');
    field(257, 6, 'ustar\0');
    const checksum = [...header].reduce((a, b) => a + b, 0);
    field(148, 8, checksum.toString(8).padStart(6, '0') + '\0 ');
    parts.push(header, data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  return Buffer.concat([...parts, Buffer.alloc(1024)]);
}

function deb(members) {
  const parts = [Buffer.from('!<arch>\n')];
  for (const [name, data] of members) {
    const header =
      (name + '/').padEnd(16) +
      '0'.padEnd(12) +
      '0'.padEnd(6) +
      '0'.padEnd(6) +
      '100644'.padEnd(8) +
      String(data.length).padEnd(10) +
      '`\n';
    parts.push(Buffer.from(header), data);
    if (data.length % 2) parts.push(Buffer.from('\n'));
  }
  return Buffer.concat(parts);
}

function packageFixture(
  name = 'sample',
  entries = [
    {
      name: `data/data/com.termux/files/usr/bin/${name}`,
      text: '#!/data/data/com.termux/files/usr/bin/bash\necho TEST_ONLY\n',
    },
  ],
  scripts = [],
) {
  const archive = deb([
    ['debian-binary', Buffer.from('2.0\n')],
    [
      'control.tar.gz',
      gzipSync(tar([{ name: './control', text: `Package: ${name}\n` }, ...scripts])),
    ],
    ['data.tar.gz', gzipSync(tar(entries))],
  ]);
  const index = `Package: ${name}\nVersion: 1.0\nArchitecture: aarch64\nFilename: pool/main/s/sample.deb\nSize: ${archive.length}\nSHA256: ${crypto.createHash('sha256').update(archive).digest('hex')}\n`;
  return { archive, index };
}

async function fixture(t, pkg = packageFixture()) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'android-pi-package-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const prefix = path.join(root, 'usr');
  const stateDir = path.join(root, 'state');
  const baselineFile = path.join(root, 'baseline.json');
  await mkdir(prefix);
  await writeFile(path.join(root, '.rootfs-sha256'), '0'.repeat(64));
  await writeFile(baselineFile, JSON.stringify({ rootfsSha256: '0'.repeat(64), packages: [] }));
  const requests = [];
  const fetcher = async (url, options) => {
    requests.push(url);
    assert.equal(options.redirect, 'error');
    return new Response(url.endsWith('Packages.gz') ? gzipSync(pkg.index) : pkg.archive);
  };
  const options = { prefix, stateDir, baselineFile, fetcher };
  return { ...options, root, requests, manager: createPackageManager(options), options };
}

test('Debian versions, alternatives, cycles and installed packages do not silently upgrade the runtime', () => {
  for (const [a, b, result] of [
    ['1.0', '1.0-0', 0],
    ['1.0~rc1', '1.0', -1],
    ['1:1', '2.0', 1],
    ['1.0-10', '1.0-2', 1],
    ['1.01', '1.1', 0],
  ]) {
    assert.equal(compareVersions(a, b), result);
  }
  const index = parsePackageIndex(
    'Package: sample\nArchitecture: aarch64\nVersion: 1\nDepends: base (>= 2)\n\nPackage: base\nArchitecture: aarch64\nVersion: 3\n',
  );
  assert.throws(
    () => resolvePackages(index, new Map([['base', { version: '1' }]]), 'sample'),
    /without updating/,
  );
  assert.equal(resolvePackages(index, new Map([['base', { version: '2' }]]), 'sample').length, 1);
  assert.throws(
    () =>
      resolvePackages(
        parsePackageIndex('Package: nodejs\nArchitecture: aarch64\nVersion: 26\n'),
        new Map(),
        'nodejs',
      ),
    /bundled-runtime/,
  );
  index.get('sample').Depends = 'missing | base';
  index.get('base').Depends = 'sample';
  assert.equal(resolvePackages(index, new Map(), 'sample').length, 2);
  assert.throws(() => resolvePackages(index, new Map(), '../escape'), /Invalid/);
});

test('archives reject traversal, unsafe links, duplicates, truncation and unsupported tar types', () => {
  const pkg = packageFixture();
  assert.equal(debMembers(pkg.archive).size, 3);
  const sample = tar([{ name: './control', text: 'test' }]);
  assert.equal(tarEntries(sample).length, 1);
  const bad = Buffer.from(sample);
  bad[0] = 120;
  assert.throws(() => tarEntries(bad), /checksum/);
  assert.throws(() => tarEntries(sample.subarray(0, 900)), /tar/);
  assert.throws(() => tarEntries(tar([{ name: 'hard-link', type: '1' }])), /Unsupported/);
  assert.throws(
    () =>
      debMembers(
        deb([
          ['same', Buffer.from('a')],
          ['same', Buffer.from('b')],
        ]),
      ),
    /Duplicate/,
  );
  for (const name of [
    '../../escape',
    'data/data/com.termux/files/usr/bin/../../escape',
    '/etc/passwd',
  ]) {
    assert.throws(() => prefixEntry({ name, type: '0' }));
  }
  assert.throws(
    () =>
      prefixEntry({ name: 'data/data/com.termux/files/usr/bin/link', type: '2', link: '../..' }),
    /symlink/,
  );
  assert.throws(() => prefixEntry({ name: 'data', type: '0' }), /root directory/);
});

test('additive installation verifies checksums, relocates scripts and keeps existing native files', async t => {
  const f = await fixture(t);
  await f.manager.install('sample');
  const file = path.join(f.prefix, 'bin/sample');
  assert.ok((await readFile(file, 'utf8')).startsWith(`#!${f.prefix}/bin/bash\n`));
  assert.equal((await f.manager.installed()).get('sample').version, '1.0');
  assert.equal((await stat(path.join(f.stateDir, 'packages.json'))).mode & 0o777, 0o600);
  await f.manager.install('sample');
  assert.equal(f.requests.filter(url => url.endsWith('.deb')).length, 1);
  await writeFile(path.join(f.prefix, 'bin/existing'), 'KEEP');
  const collision = packageFixture('existing');
  const other = createPackageManager({
    ...f.options,
    fetcher: async url =>
      new Response(url.endsWith('Packages.gz') ? gzipSync(collision.index) : collision.archive),
  });
  await assert.rejects(other.install('existing'), /overwrite/);
  assert.equal(await readFile(path.join(f.prefix, 'bin/existing'), 'utf8'), 'KEEP');
});

test('corrupt downloads never write payloads or registry and normal failure releases owned lock', async t => {
  const pkg = packageFixture();
  const f = await fixture(t);
  const corrupted = Buffer.from(pkg.archive);
  corrupted[15] ^= 1;
  const manager = createPackageManager({
    ...f.options,
    fetcher: async url =>
      new Response(url.endsWith('Packages.gz') ? gzipSync(pkg.index) : corrupted),
  });
  await assert.rejects(manager.install('sample'), /Checksum/);
  await assert.rejects(readFile(path.join(f.prefix, 'bin/sample')));
  assert.equal((await manager.installed()).size, 0);
  await assert.rejects(
    readFile(path.join(f.stateDir, 'package-install.lock')),
    error => error.code === 'ENOENT',
  );
});

test('interrupted install locks, corrupted registry and changed baseline require inspection, not automatic repair', async t => {
  const f = await fixture(t);
  await mkdir(f.stateDir);
  const lock = path.join(f.stateDir, 'package-install.lock');
  await writeFile(lock, 'KEEP_INTERRUPTED_INSTALL');
  await assert.rejects(f.manager.install('sample'), /interrupted install/);
  assert.equal(await readFile(lock, 'utf8'), 'KEEP_INTERRUPTED_INSTALL');
  await rm(lock);
  const registry = path.join(f.stateDir, 'packages.json');
  await writeFile(registry, 'BROKEN');
  await assert.rejects(f.manager.plan('sample'), /registry/);
  assert.equal(await readFile(registry, 'utf8'), 'BROKEN');
  assert.equal(f.requests.length, 0);
  await rm(registry);
  await writeFile(path.join(f.root, '.rootfs-sha256'), '1'.repeat(64));
  await assert.rejects(f.manager.plan('sample'), /baseline receipt/);
  assert.equal(f.requests.length, 0);
});

test('package writes cannot traverse an existing symlink or a planned symlink parent', async t => {
  const linkPkg = packageFixture('sample', [
    { name: 'data/data/com.termux/files/usr/bin/link', type: '2', link: '../lib' },
    { name: 'data/data/com.termux/files/usr/bin/link/tool', text: 'TEST_ONLY' },
  ]);
  const f = await fixture(t, linkPkg);
  await assert.rejects(f.manager.install('sample'), /planned file\/link/);
  const outside = path.join(f.root, 'outside');
  await mkdir(outside);
  await mkdir(path.join(f.prefix, 'bin'));
  await symlink(outside, path.join(f.prefix, 'bin/link'));
  const childPkg = packageFixture('sample', [
    { name: 'data/data/com.termux/files/usr/bin/link/tool', text: 'TEST_ONLY' },
  ]);
  const throughExisting = createPackageManager({
    ...f.options,
    fetcher: async url =>
      new Response(url.endsWith('Packages.gz') ? gzipSync(childPkg.index) : childPkg.archive),
  });
  await assert.rejects(throughExisting.install('sample'), /non-directory/);
  await assert.rejects(readFile(path.join(outside, 'tool')));
});

test('maintainer scripts are not executed and write failures roll back only newly created files', async t => {
  const pkg = packageFixture(
    'sample',
    [
      { name: 'data/data/com.termux/files/usr/bin/new', text: 'TEST_ONLY' },
      // A later collision after an implied parent directory forces a write-time failure.
      { name: 'data/data/com.termux/files/usr/lib/child', text: 'TEST_ONLY' },
      { name: 'data/data/com.termux/files/usr/lib', text: 'TEST_ONLY_FILE_CONFLICT' },
    ],
    [{ name: './postinst', text: '#!/bin/sh\nexit 77\n' }],
  );
  const f = await fixture(t, pkg);
  const notes = [];
  await assert.rejects(f.manager.install('sample', text => notes.push(text)));
  assert.ok(notes.some(note => note.includes('NOT executed')));
  await assert.rejects(readFile(path.join(f.prefix, 'bin/new')));
  assert.equal((await f.manager.installed()).size, 0);
});

test('private pi-pkg launcher does not replace usr binaries and requires explicit install intent', async t => {
  const f = await fixture(t);
  await mkdir(path.join(f.prefix, 'bin'));
  await writeFile(path.join(f.prefix, 'bin/gh'), 'KEEP_NATIVE');
  await writeFile(path.join(f.root, 'package.json'), JSON.stringify({ type: 'module' }));
  const env = await installGitTools(f.stateDir, f.prefix);
  assert.equal(await readFile(path.join(f.prefix, 'bin/gh'), 'utf8'), 'KEEP_NATIVE');
  const run = promisify(execFile);
  const launcher = path.join(f.stateDir, 'bin/pi-pkg');
  assert.match(
    (await run(launcher, ['--help'], { env: { ...process.env, ...env } })).stdout,
    /pi-pkg/,
  );
  await assert.rejects(
    run(launcher, ['install', 'gh'], { env: { ...process.env, ...env } }),
    /explicit --yes/,
  );
  await assert.rejects(
    run(launcher, ['install', 'gh', '--yes', '--other'], { env: { ...process.env, ...env } }),
    /explicit --yes/,
  );
  assert.equal((await stat(launcher)).mode & 0o777, 0o700);
});
