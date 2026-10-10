import type { Page } from 'playwright-core';
import { imageMimeType, MAX_IMAGE_BYTES } from './image-read.ts';

// Desktop transport only. Android uses an owner-bound native WebView draw request.
export async function captureViewport(page: Page, timeoutMs = 10000): Promise<Buffer> {
  const bytes = await page.screenshot({ type: 'png', timeout: timeoutMs });
  if (bytes.length > MAX_IMAGE_BYTES || imageMimeType(bytes) !== 'image/png')
    throw new Error('Preview must return a PNG up to 8 MiB.');
  return bytes;
}
