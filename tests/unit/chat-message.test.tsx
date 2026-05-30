import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { ChatMessage } from '@/pages/Chat/ChatMessage';
import type { RawMessage } from '@/stores/chat';

const invokeIpcMock = vi.hoisted(() => vi.fn());

vi.mock('@/lib/api-client', () => ({
  invokeIpc: (...args: unknown[]) => invokeIpcMock(...args),
}));

describe('ChatMessage attachment dedupe', () => {
  it('keeps attachment-only assistant replies visible even when process attachments are suppressed', () => {
    const message: RawMessage = {
      role: 'assistant',
      content: [],
      _attachedFiles: [
        {
          fileName: 'artifact.png',
          mimeType: 'image/png',
          fileSize: 0,
          preview: '/tmp/artifact.png',
          filePath: '/tmp/artifact.png',
          source: 'tool-result',
        },
      ],
    };

    render(
      <ChatMessage
        message={message}
        showThinking={false}
        suppressProcessAttachments
      />,
    );

    expect(screen.getByAltText('artifact.png')).toBeInTheDocument();
  });

  it('opens assistant file cards', () => {
    const message: RawMessage = {
      role: 'assistant',
      content: [
        {
          type: 'text',
          text: 'Done! **steve-jobs.html** is in your workspace.',
        },
      ],
      _attachedFiles: [
        {
          fileName: 'steve-jobs.html',
          mimeType: 'text/html',
          fileSize: 7006,
          preview: null,
          filePath: 'C:\\Users\\Med\\.openclaw\\workspace-bot-mpqbmj4q68lq\\steve-jobs.html',
          source: 'message-ref',
        },
      ],
    };

    render(<ChatMessage message={message} showThinking={false} />);

    fireEvent.click(screen.getByRole('button', { name: /steve-jobs\.html/i }));

    expect(invokeIpcMock).toHaveBeenCalledWith(
      'shell:openPath',
      'C:\\Users\\Med\\.openclaw\\workspace-bot-mpqbmj4q68lq\\steve-jobs.html',
    );
  });
});
