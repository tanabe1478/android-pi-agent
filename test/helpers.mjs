import { mkdtemp, mkdir, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createModels, fauxProvider } from '@earendil-works/pi-ai';

import { openKernel } from '../runtime/kernel.ts';

export async function fixture(t, options = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'android-pi-test-'));
  await mkdir(path.join(directory, 'work'));
  const workspace = await realpath(path.join(directory, 'work'));
  const stateDir = path.join(directory, 'state');

  const faux = fauxProvider({
    tokensPerSecond: options.tokensPerSecond,
    models: [
      { id: 'first', reasoning: true },
      { id: 'second', reasoning: false },
    ],
  });
  const models = createModels();
  models.setProvider(faux.provider);
  const model = faux.getModel('first');

  const openOptions = {
    stateDir,
    workspace,
    models,
    initialModel: { provider: model.provider, modelId: model.id },
    demo: true,
    ...options,
  };
  let kernel = await openKernel(openOptions);
  t.after(async () => {
    await kernel.close();
    await rm(directory, { recursive: true, force: true });
  });

  return {
    get kernel() {
      return kernel;
    },
    faux,
    models,
    directory,
    workspace,
    stateDir,

    async reopen() {
      await kernel.close();
      kernel = await openKernel(openOptions);
      return kernel;
    },
  };
}

export async function eventually(read, predicate, timeout = 8000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await read();
    if (predicate(value)) return value;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error('Timed out waiting for fixture state');
}

export function busy(view) {
  const live = view.conversation.docs['pi.live'] ?? {};
  return Boolean(
    live.run || live.compactions?.length || view.conversation.docs['pi.inbox']?.items?.length,
  );
}

export function messages(view) {
  return view.conversation.entries.flatMap(entry => entry.model ?? []);
}
