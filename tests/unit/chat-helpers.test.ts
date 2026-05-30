import { describe, expect, it, vi } from 'vitest';
import {
  enrichWithToolResultFiles,
} from '@/stores/chat/helpers';
import type { RawMessage } from '@/stores/chat';

vi.mock('@/lib/api-client', () => ({
  invokeIpc: vi.fn(),
}));

describe('chat helper file attachments', () => {
  it('attaches files created by tool calls to the next assistant message', () => {
    const messages: RawMessage[] = [
      {
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: 'toolu_write',
            name: 'Write',
            input: { file_path: 'D:\\Codes\\A_Work\\ClawX\\report.pdf' },
          },
        ],
      },
      {
        role: 'toolresult',
        toolCallId: 'toolu_write',
        content: 'File created successfully.',
      },
      {
        role: 'assistant',
        content: 'Created the report.',
      },
    ];

    const enriched = enrichWithToolResultFiles(messages);

    expect(enriched[2]?._attachedFiles).toMatchObject([
      {
        fileName: 'report.pdf',
        mimeType: 'application/pdf',
        filePath: 'D:\\Codes\\A_Work\\ClawX\\report.pdf',
        source: 'tool-result',
      },
    ]);
  });

  it('does not attach read-only tool paths as created files', () => {
    const messages: RawMessage[] = [
      {
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: 'toolu_read',
            name: 'Read',
            input: { file_path: 'D:\\Codes\\A_Work\\ClawX\\existing.pdf' },
          },
        ],
      },
      {
        role: 'toolresult',
        toolCallId: 'toolu_read',
        content: 'File content...',
      },
      {
        role: 'assistant',
        content: 'I read the file.',
      },
    ];

    const enriched = enrichWithToolResultFiles(messages);

    expect(enriched[2]?._attachedFiles).toBeUndefined();
  });
});
