import { randomBytes } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';

import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  type Models,
  type Model,
  type Api,
} from '@earendil-works/pi-ai';

import { openKernel } from './kernel.ts';
import { createBridge } from './bridge.ts';
import { parentPid, publishBridge, removeBridge, watchParent } from './host-channel.ts';
import { openAuthentication, withAuthentication, type Authentication } from './auth.ts';
import { openGitHub, withGitHub, type GitHubAuthentication } from './github.ts';
import { installGitTools } from './cli.ts';

const { values } = parseArgs({
  options: {
    demo: { type: 'boolean', default: false },
    state: { type: 'string' },
    workspace: { type: 'string', default: process.cwd() },
    port: { type: 'string', default: '0' },
    shell: { type: 'string' },
    prefix: { type: 'string' },
    'bridge-file': { type: 'boolean', default: false },
    'parent-pid': { type: 'string' },
  },
});

const port = Number(values.port);
if (!Number.isSafeInteger(port) || port < 0 || port > 65535) throw new Error('Invalid port.');

const ownerPid = parentPid(values['parent-pid']);
const stateDir = path.resolve(values.state ?? (values.demo ? '.demo' : '.android-pi'));
await mkdir(stateDir, { recursive: true, mode: 0o700 });

let models: Models;
let auth: Authentication | undefined;
let github: GitHubAuthentication | undefined;
let shellEnv: NodeJS.ProcessEnv | undefined;
let model: Model<Api> | undefined;
if (values.demo) {
  // Demo never opens credential storage or discovers the host's Pi authentication.
  const demoModels = createModels();
  const faux = fauxProvider({ tokensPerSecond: 30 });
  demoModels.setProvider(faux.provider);
  models = demoModels;
  faux.setResponses(
    Array.from({ length: 256 }, () =>
      fauxAssistantMessage([
        fauxText(
          'ローカルデモの応答です。これはUIとdurableの接続確認で、実際のモデルには送信していません。',
        ),
      ]),
    ),
  );
  model = faux.getModel()!;
} else {
  // The provider's lazy OAuth module reads this at first login. Never bind its callback remotely.
  process.env.PI_OAUTH_CALLBACK_HOST = '127.0.0.1';
  ({ models, auth } = await openAuthentication(stateDir));
  model = models.getModel('openai', 'gpt-6.1-sol');
  if (!model) throw new Error('The locked OpenAI catalog lacks the initial model.');
  try {
    github = await openGitHub(stateDir);
    shellEnv = await installGitTools(stateDir, values.prefix);
  } catch (error) {
    await github?.close();
    await auth.close();
    throw error;
  }
}

const kernel = await openKernel({
  stateDir,
  workspace: values.workspace!,
  models,
  demo: Boolean(values.demo),
  shellPath: values.shell,
  shellEnv,
  initialModel: { provider: model.provider, modelId: model.id },
  authorizeModel: auth?.assertModel,
}).catch(async error => {
  await github?.close();
  await auth?.close();
  throw error;
});
const authenticated = auth ? withAuthentication(kernel, auth) : kernel;
const controller = github ? withGitHub(authenticated, github) : authenticated;

const token = randomBytes(32).toString('base64url');
let bridge;
try {
  bridge = await createBridge(controller, token, port, auth, github);
} catch (error) {
  await controller.close();
  throw error;
}

// Private launcher: keep bridge tokens out of command arguments and logs.
const launcher = path.join(stateDir, 'open.html');
await writeFile(
  launcher,
  `<!doctype html><meta name="referrer" content="no-referrer"><meta http-equiv="refresh" content="0;url=${bridge.url}/#token=${token}"><title>Android Pi private launcher</title>`,
  { mode: 0o600 },
);
console.log(
  `Local ${values.demo ? 'demo' : 'runtime'} ready. Open the private launcher: ${launcher}`,
);

let stopping = false;
let unwatchParent: (() => void) | undefined;

async function stop() {
  if (stopping) return;
  stopping = true;
  unwatchParent?.();

  try {
    if (values['bridge-file']) await removeBridge(stateDir, token);
    await github?.close();
    await auth?.close();
  } finally {
    try {
      await bridge!.close();
    } finally {
      await controller.close();
    }
  }
}

const requestStop = () => {
  void stop().catch(() => {
    process.exitCode = 1;
  });
};
process.once('SIGINT', requestStop);
process.once('SIGTERM', requestStop);

try {
  if (ownerPid !== undefined) unwatchParent = watchParent(ownerPid, requestStop);
  if (values['bridge-file']) {
    await publishBridge(stateDir, { port: bridge.port, token, parentPid: ownerPid });
    // A signal during publication must not resurrect readiness after shutdown.
    if (stopping) await removeBridge(stateDir, token);
  }
} catch (error) {
  await stop();
  throw error;
}
