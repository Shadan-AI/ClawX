import { describe, expect, it } from 'vitest';
import {
  formatNativeCliTextWithAttachments,
} from '@/pages/Chat/native-cli-attachments';
import type { FileAttachment } from '@/pages/Chat/ChatInput';

function attachment(overrides: Partial<FileAttachment> = {}): FileAttachment {
  return {
    id: 'file-1',
    fileName: 'report.pdf',
    mimeType: 'application/pdf',
    fileSize: 1234,
    stagedPath: 'C:\\Users\\Med\\.openclaw\\media\\outbound\\abc.pdf',
    preview: null,
    status: 'ready',
    ...overrides,
  };
}

describe('formatNativeCliTextWithAttachments', () => {
  it('adds selected file full paths to native CLI input text', () => {
    const text = formatNativeCliTextWithAttachments('Summarize this', [
      attachment(),
    ]);

    expect(text).toContain('Summarize this');
    expect(text).toContain('Use these full local paths');
    expect(text).toContain('report.pdf: C:\\Users\\Med\\.openclaw\\media\\outbound\\abc.pdf');
    expect(text).toContain('(application/pdf)');
  });

  it('keeps attachment-only sends usable in native CLI sessions', () => {
    const text = formatNativeCliTextWithAttachments('', [
      attachment({ fileName: 'data.csv', mimeType: 'text/csv', stagedPath: 'D:\\tmp\\data.csv' }),
    ]);

    expect(text).toContain('Please inspect the selected file(s).');
    expect(text).toContain('data.csv: D:\\tmp\\data.csv (text/csv)');
  });

  it('ignores attachments that are not ready', () => {
    const text = formatNativeCliTextWithAttachments('Hello', [
      attachment({ status: 'staging', stagedPath: '' }),
    ]);

    expect(text).toBe('Hello');
  });
});
