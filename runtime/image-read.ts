import { wrapTool } from '@earendil-works/pi-durable';
import { createReadTool } from '@earendil-works/pi-durable/tools';
import { getOrThrow } from '@earendil-works/pi-durable/env';

export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

export function imageMimeType(bytes: Uint8Array): string | undefined {
  const data = Buffer.from(bytes);
  if (
    data.length >= 8 &&
    data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  )
    return 'image/png';
  if (data.length >= 3 && data[0] === 255 && data[1] === 216 && data[2] === 255)
    return 'image/jpeg';
  if (
    data.length >= 12 &&
    data.toString('ascii', 0, 4) === 'RIFF' &&
    data.toString('ascii', 8, 12) === 'WEBP'
  )
    return 'image/webp';
  return undefined;
}

// Decorate the existing durable read tool; no separate image tool or agent loop.
export function imageReadWrap() {
  return wrapTool(createReadTool(), tool => ({
    ...tool,
    description:
      tool.description +
      ' Also reads PNG/JPEG/WebP images up to 8 MiB as model image content. Never read credentials or private screenshots without permission.',
    async execute(args, api, context) {
      if (!/\.(png|jpe?g|webp)$/i.test(args.path)) return tool.execute(args, api, context);
      const env = api.env;
      if (!env) throw new Error('File environment is unavailable.');
      const normalized = args.path
        .replace(/[\u00a0\u2000-\u200a\u202f\u205f\u3000]/g, ' ')
        .replace(/^@/, '');
      const absolute = getOrThrow(await env.absolutePath(normalized, context));
      const variants = [
        absolute,
        absolute.replace(/ (AM|PM)\./gi, '\u202f$1.'),
        absolute.normalize('NFD'),
        absolute.replace(/'/g, '\u2019'),
        absolute.normalize('NFD').replace(/'/g, '\u2019'),
      ];
      let file = absolute;
      for (const variant of new Set(variants)) {
        if (getOrThrow(await env.exists(variant, context))) {
          file = variant;
          break;
        }
      }
      file = getOrThrow(await env.canonicalPath(file, context));
      const info = getOrThrow(await env.fileInfo(file, context));
      if (info.kind !== 'file') throw new Error('Image must be a regular file.');
      if (info.size > MAX_IMAGE_BYTES)
        throw new Error('Image exceeds 8 MiB. Resize or capture a viewport first.');
      const bytes = getOrThrow(await env.readBinaryFile(file, context));
      // Recheck after reading: stat and read are not atomic in the portable environment.
      if (bytes.byteLength > MAX_IMAGE_BYTES) throw new Error('Image exceeds 8 MiB.');
      const mimeType = imageMimeType(bytes);
      if (!mimeType) return tool.execute(args, api, context);
      return {
        content: [{ type: 'image', mimeType, data: Buffer.from(bytes).toString('base64') }],
        diagnostics: [],
      };
    },
  }));
}
