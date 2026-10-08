import { chmod, open, readFile, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const FILE = 'bridge.json';

export function parentPid(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;

  const pid = Number(value);
  if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(pid) || pid > 2_147_483_647) {
    throw new Error('Invalid parent process ID.');
  }

  return pid;
}

export async function publishBridge(
  stateDir: string,
  bridge: { port: number; token: string; parentPid?: number },
): Promise<void> {
  const temporary = path.join(stateDir, `.bridge-${randomUUID()}.tmp`);
  const destination = path.join(stateDir, FILE);

  try {
    const file = await open(temporary, 'wx', 0o600);
    try {
      await file.writeFile(JSON.stringify({ version: 1, pid: process.pid, ...bridge }));
      await file.sync();
    } finally {
      await file.close();
    }

    await rename(temporary, destination);
    await chmod(destination, 0o600);
  } finally {
    await unlink(temporary).catch(error => {
      if (error.code !== 'ENOENT') throw error;
    });
  }
}

export async function removeBridge(stateDir: string, token: string): Promise<void> {
  const destination = path.join(stateDir, FILE);
  let content: string;

  try {
    content = await readFile(destination, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }

  // A late shutdown must not remove the readiness record of a newer process.
  let record: { token?: string };
  try {
    record = JSON.parse(content);
  } catch {
    return;
  }

  if (record?.token === token) {
    await unlink(destination).catch(error => {
      if (error.code !== 'ENOENT') throw error;
    });
  }
}

export function watchParent(
  pid: number,
  onMissing: () => void,
  interval = 1000,
  probe: (pid: number) => void = pid => process.kill(pid, 0),
): () => void {
  const timer = setInterval(() => {
    try {
      probe(pid);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') onMissing();
    }
  }, interval);

  return () => clearInterval(timer);
}
