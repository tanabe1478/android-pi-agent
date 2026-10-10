import { chmod, lstat, mkdir, open, rename, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { writePrivate } from './credentials.ts';

// These executables deliberately use the app's Node shebang, not Termux's fixed shell path.
// stdout contains a token only inside git's credential transport; never invoke askpass as a tool.
function credentialSource(file: string): string {
  return `const fs = require('node:fs');
function credential() {
  let fd;
  try {
    fd = fs.openSync(${JSON.stringify(file)}, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > 32768) return;
    const buffer = Buffer.alloc(32769);
    let size = 0;
    while (size < buffer.length) {
      const count = fs.readSync(fd, buffer, size, buffer.length - size, size);
      if (!count) break;
      size += count;
    }
    if (size > 32768) return;
    const value = JSON.parse(buffer.subarray(0, size).toString('utf8'));
    if (value.version !== 1 || typeof value.token !== 'string' ||
        !/^[A-Za-z0-9_]{16,4096}$/.test(value.token) || typeof value.user !== 'string' ||
        !/^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/.test(value.user)) return;
    return value;
  } catch {
    return;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}
`;
}

export function gitAskpassSource(node: string, file: string): string {
  return `#!${node}
${credentialSource(file)}
const prompt = process.argv[2] || '';
const match = prompt.match(/'(https:\\/\\/[^']+)'/);
if (!match) process.exit(1);
let url;
try {
  url = new URL(match[1]);
} catch {
  process.exit(1);
}
if (url.protocol !== 'https:' || url.hostname !== 'github.com' || url.password ||
    (url.port && url.port !== '443')) process.exit(1);
const saved = credential();
if (!saved) process.exit(1);
if (/^Username/i.test(prompt)) process.stdout.write('x-access-token\\n');
else if (/^Password/i.test(prompt)) process.stdout.write(saved.token + '\\n');
else process.exit(1);
`;
}

export function githubCLISource(
  node: string,
  native: string,
  file: string,
  config: string,
): string {
  return `#!${node}
${credentialSource(file)}
const { spawn } = require('node:child_process');
const args = process.argv.slice(2);
function reject(message) {
  console.error(message);
  process.exit(1);
}
const authIndex = args.indexOf('auth');
if ((authIndex >= 0 && !['status', 'help'].includes(args[authIndex + 1])) ||
    args.some(value => value.startsWith('--show-token')) ||
    (authIndex >= 0 && args.some(value => /^-[^-]*t/.test(value))) ||
    args.includes('alias') || args.includes('extension')) {
  reject('Credential display, other auth storage and extensions are disabled. Use Android Pi → GitHub.');
}
function host(value) {
  if (value !== 'github.com') reject('This credential is restricted to github.com.');
}
function url(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    reject('Invalid GitHub URL.');
  }
  if (parsed.protocol !== 'https:' || !['github.com', 'api.github.com'].includes(parsed.hostname) ||
      parsed.username || parsed.password || parsed.port) {
    reject('Use official GitHub HTTPS endpoints.');
  }
}
function repo(value) {
  if (/^https?:\\/\\//i.test(value || '')) return url(value);
  const parts = (value || '').split('/');
  if (parts.length === 3) host(parts[0]);
  else if (parts.length !== 2) reject('Use OWNER/REPO or a github.com repository.');
}
for (let index = 0; index < args.length; index++) {
  const value = args[index];
  if (value === '--hostname') host(args[index + 1]);
  if (value.startsWith('--hostname=')) host(value.slice(11));
  if (value === '--repo' || value === '-R') repo(args[index + 1]);
  if (value.startsWith('--repo=')) repo(value.slice(7));
  if (value.startsWith('-R') && value.length > 2) repo(value.slice(2));
  if (/^https?:\\/\\//i.test(value)) url(value);
}
const env = { ...process.env, GH_HOST: 'github.com', GH_PROMPT_DISABLED: '1',
  GH_CONFIG_DIR: ${JSON.stringify(config)} };
for (const key of ['GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN',
                   'GH_DEBUG', 'GH_HTTP_UNIX_SOCKET', 'GH_TLS_NO_VERIFY']) delete env[key];
const saved = credential();
if (!saved && !args.some(value => ['--version', '--help', '-h', 'help'].includes(value))) {
  reject('GitHub PAT is unavailable. Configure it in Android Pi → GitHub.');
}
if (saved) env.GH_TOKEN = saved.token;
const child = spawn(${JSON.stringify(native)}, args, { env, stdio: 'inherit' });
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
child.on('error', () => {
  console.error('GitHub CLI is unavailable. Install it with: pi-pkg install gh --yes');
  process.exitCode = 1;
});
child.on('exit', (code, signal) => {
  process.exitCode = code ?? (signal ? 1 : 0);
});
`;
}

export async function writeExecutable(file: string, source: string): Promise<void> {
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    const handle = await open(temporary, 'wx', 0o700);
    try {
      await handle.writeFile(source);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, file);
  } finally {
    await unlink(temporary).catch(() => {});
  }
}

async function privateDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if (!(await lstat(directory)).isDirectory()) throw new Error('Unsafe managed CLI directory.');
  await chmod(directory, 0o700);
}

export async function installGitTools(
  stateDir: string,
  prefix?: string,
): Promise<NodeJS.ProcessEnv> {
  if (!path.isAbsolute(stateDir) || (prefix && !path.isAbsolute(prefix))) {
    throw new Error('CLI paths must be absolute.');
  }
  const node = process.execPath;
  if (/\s/.test(node)) throw new Error('The executable path is not suitable for a Node shebang.');
  const bin = path.join(stateDir, 'bin');
  await privateDirectory(bin);
  // Extensionless Node launchers must also work below a host ESM package directory.
  await writePrivate(path.join(bin, 'package.json'), { type: 'commonjs' });
  const file = path.join(stateDir, 'github.json');
  const askpass = path.join(bin, 'git-askpass.cjs');
  await writeExecutable(askpass, gitAskpassSource(node, file));
  const env: NodeJS.ProcessEnv = {
    GIT_ASKPASS: askpass,
    GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_COUNT: '2',
    GIT_CONFIG_KEY_0: 'credential.helper',
    GIT_CONFIG_VALUE_0: '',
    GIT_CONFIG_KEY_1: 'credential.useHttpPath',
    GIT_CONFIG_VALUE_1: 'true',
    GH_TOKEN: undefined,
    GITHUB_TOKEN: undefined,
    GH_ENTERPRISE_TOKEN: undefined,
    GITHUB_ENTERPRISE_TOKEN: undefined,
    GIT_TRACE: undefined,
    GIT_TRACE_CURL: undefined,
    GIT_CURL_VERBOSE: undefined,
  };
  if (prefix) {
    const config = path.join(stateDir, 'gh');
    await privateDirectory(config);
    await writeExecutable(
      path.join(bin, 'gh'),
      githubCLISource(node, path.join(prefix, 'bin/gh'), file, config),
    );
    const packageCLI = fileURLToPath(new URL('./package-cli.ts', import.meta.url));
    await writeExecutable(
      path.join(bin, 'pi-pkg'),
      `#!${node}
const { spawn } = require('node:child_process');
const child = spawn(${JSON.stringify(node)}, [${JSON.stringify(packageCLI)}, ...process.argv.slice(2)], {
  env: { ...process.env, PREFIX: ${JSON.stringify(prefix)}, PI_ANDROID_STATE: ${JSON.stringify(stateDir)} },
  stdio: 'inherit',
});
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
child.on('error', () => {
  console.error('Package CLI could not start.');
  process.exitCode = 1;
});
child.on('exit', code => {
  process.exitCode = code ?? 1;
});
`,
    );
    const browserCLI = fileURLToPath(new URL('./browser-cli.ts', import.meta.url));
    await writeExecutable(
      path.join(bin, 'pi-browser'),
      `#!${node}
const { spawn } = require('node:child_process');
const child = spawn(${JSON.stringify(node)}, [${JSON.stringify(browserCLI)}, ...process.argv.slice(2)], {
  env: { ...process.env, PI_ANDROID_STATE: ${JSON.stringify(stateDir)} }, stdio: 'inherit',
});
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
child.on('error', () => { console.error('Preview CLI could not start.'); process.exitCode = 1; });
child.on('exit', code => { process.exitCode = code ?? 1; });
`,
    );
    env.PATH = `${bin}:${prefix}/bin:${process.env.PATH ?? '/system/bin'}`;
    env.PREFIX = prefix;
    env.PI_ANDROID_STATE = stateDir;
    // Git's compiled Termux paths still point at a different package identity.
    env.GIT_EXEC_PATH = path.join(prefix, 'libexec/git-core');
    env.GIT_SSL_CAINFO = path.join(prefix, 'etc/tls/cert.pem');
  }
  return env;
}
