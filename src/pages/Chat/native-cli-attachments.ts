import type { FileAttachment } from './ChatInput';

export function formatNativeCliTextWithAttachments(text: string, attachments?: FileAttachment[]): string {
  const trimmed = text.trim();
  const readyAttachments = (attachments ?? []).filter((attachment) => (
    attachment.status === 'ready' && attachment.stagedPath.trim()
  ));
  if (readyAttachments.length === 0) return trimmed;

  const attachmentLines = readyAttachments.map((attachment, index) => {
    const name = attachment.fileName.trim() || `file-${index + 1}`;
    const mime = attachment.mimeType.trim() || 'application/octet-stream';
    return `- ${name}: ${attachment.stagedPath} (${mime})`;
  });
  const attachmentBlock = [
    'Selected file(s) from ClawX. Use these full local paths when reading them:',
    ...attachmentLines,
  ].join('\n');

  return [trimmed || 'Please inspect the selected file(s).', attachmentBlock].join('\n\n');
}
