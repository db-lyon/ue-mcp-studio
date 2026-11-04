/** Files on a session: where one is served, which are pictures, and their size in words. */

export const attachmentUrl = (sessionId: string, id: string): string =>
  `/v1/ext/studio/sessions/${encodeURIComponent(sessionId)}/attachments/${encodeURIComponent(id)}`;

export const isImage = (type: string): boolean => /^image\/(png|jpeg|gif|webp)$/.test(type);

/** 3 KB, 1.2 MB. */
export function formatBytes(n: number): string {
  if (n < 1024 * 1024) return `${Math.max(1, Math.round(n / 1024))} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** The largest file the agent accepts; matches MAX_ATTACHMENT_BYTES there. */
export const MAX_BYTES = 100 * 1024 * 1024;
