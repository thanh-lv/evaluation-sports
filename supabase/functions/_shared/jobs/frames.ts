/**
 * Key frames in Storage (DESIGN.md §6.6): `analysis-inputs/{uid}/{aid}/frames/F1..F5.jpg`, uploaded by the app after
 * prepare, checked by submit, read by the job as base64 and deleted at finalize (72 h cap otherwise).
 */
import { UPLOAD_FRAME_IDS, type UploadFrameId } from '@shared/contracts/index.ts';
import type { FrameImage } from '@shared/claude/index.ts';
import { BUCKET_INPUTS, framePath, framesPrefix, type StorageService } from '../storage.ts';

/** Frame ids the prepare response asked the app to upload (none in pose_only). */
export function expectedFrameIds(prepared: unknown): UploadFrameId[] {
  const p = prepared as { frameMode?: unknown; frameRequests?: { frameId?: unknown; upload?: unknown }[] } | null;
  if (!p || p.frameMode === 'pose_only' || !Array.isArray(p.frameRequests)) return [];
  return UPLOAD_FRAME_IDS.filter((id) => p.frameRequests!.some((f) => f.frameId === id && f.upload === true));
}

/** Frame ids present in Storage (one list call). */
export async function uploadedFrameIds(
  storage: StorageService,
  userId: string,
  analysisId: string,
): Promise<Set<string>> {
  const entries = await storage.list(BUCKET_INPUTS, framesPrefix(userId, analysisId));
  const ids = new Set<string>();
  for (const e of entries) {
    const m = /^(F[1-5])\.jpg$/.exec(e.name);
    if (!e.isFolder && m) ids.add(m[1]);
  }
  return ids;
}

/** Standard base64 (the Messages API image `data` field), in chunks to stay clear of argument limits. */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

/** Bucket limit of `analysis-inputs` (2 MiB); the Messages API takes at most 5 MB per image. */
export const MAX_FRAME_BYTES = 2 * 1024 * 1024;

/** JPEG SOI marker: the bucket checks only the declared MIME type, and a non-JPEG would turn into a 400. */
export function looksLikeJpeg(bytes: Uint8Array): boolean {
  return bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
}

/**
 * Downloads the expected frames that exist; missing, oversized and non-JPEG objects are skipped (the request labels
 * only what is sent).
 */
export async function loadFrames(
  storage: StorageService,
  userId: string,
  analysisId: string,
  ids: readonly UploadFrameId[],
): Promise<FrameImage[]> {
  const out: FrameImage[] = [];
  for (const frameId of ids) {
    const bytes = await storage.download(BUCKET_INPUTS, framePath(userId, analysisId, frameId));
    if (bytes && bytes.length <= MAX_FRAME_BYTES && looksLikeJpeg(bytes)) {
      out.push({ frameId, jpegBase64: bytesToBase64(bytes) });
    }
  }
  return out;
}

/** Removes the analysis' frames folder; idempotent. */
export function deleteFrames(storage: StorageService, userId: string, analysisId: string): Promise<number> {
  return storage.removePrefix(BUCKET_INPUTS, framesPrefix(userId, analysisId));
}
