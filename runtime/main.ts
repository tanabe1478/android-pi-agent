import { randomBytes } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { createModels, fauxAssistantMessage, fauxProvider, fauxText } from '@earendil-works/pi-ai';
import { openKernel } from './kernel.ts';
import { createBridge } from './bridge.ts';

const { values } = parseArgs({ options: {
  demo: { type: 'boolean', default: false },
  state: { type: 'string', default: '.demo' },
  workspace: { type: 'string', default: process.cwd() },
  port: { type: 'string', default: '0' },
} });
if (!values.demo) throw new Error('This checkpoint provides --demo only. Real-provider authentication is not implemented yet.');
const port = Number(values.port);
if (!Number.isSafeInteger(port) || port < 0 || port > 65535) throw new Error('Invalid port.');
const stateDir = path.resolve(values.state!);
await mkdir(stateDir, { recursive: true, mode: 0o700 });
const models = createModels(); // No built-in providers, ambient API keys or host Pi auth.
const faux = fauxProvider({ tokensPerSecond: 30 });
models.setProvider(faux.provider);
faux.setResponses(Array.from({ length: 256 }, () => fauxAssistantMessage([
  fauxText('ローカルデモの応答です。これはUIとdurableの接続確認で、実際のモデルには送信していません。'),
])));
const model = faux.getModel()!;
const kernel = await openKernel({
  stateDir, workspace: values.workspace!, models, demo: true,
  initialModel: { provider: model.provider, modelId: model.id },
});
const token = randomBytes(32).toString('base64url');
let bridge;
try { bridge = await createBridge(kernel, token, port); }
catch (error) { await kernel.close(); throw error; }
// Private launcher: keep bridge tokens out of command arguments and logs.
const launcher = path.join(stateDir, 'open.html');
await writeFile(launcher, `<!doctype html><meta name="referrer" content="no-referrer"><meta http-equiv="refresh" content="0;url=${bridge.url}/#token=${token}"><title>Android Pi local demo</title>`, { mode: 0o600 });
console.log(`Local demo ready. Open the private launcher: ${launcher}`);
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  await bridge!.close();
  await kernel.close();
}
process.once('SIGINT', () => void stop());
process.once('SIGTERM', () => void stop());
