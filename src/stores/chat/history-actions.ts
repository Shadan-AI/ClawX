import { invokeIpc } from '@/lib/api-client';
import { hostApiFetch } from '@/lib/host-api';
import {
  clearHistoryPoll,
  enrichWithCachedImages,
  enrichWithToolResultFiles,
  getMessageText,
  hasNonToolAssistantContent,
  isInternalMessage,
  isToolResultRole,
  loadMissingPreviews,
  toMs,
} from './helpers';
import { buildCronSessionHistoryPath, isCronSessionKey } from './cron-session-utils';
import type { RawMessage } from './types';
import type { ChatGet, ChatSet, SessionHistoryActions } from './store-api';

const GATEWAY_HISTORY_RETRY_MS = 1500;
let gatewayHistoryRetryTimer: ReturnType<typeof setTimeout> | null = null;

function isGatewayDisconnectedError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /Gateway not connected/i.test(message);
}

async function loadCronFallbackMessages(sessionKey: string, limit = 200): Promise<RawMessage[]> {
  if (!isCronSessionKey(sessionKey)) return [];
  try {
    const response = await hostApiFetch<{ messages?: RawMessage[] }>(
      buildCronSessionHistoryPath(sessionKey, limit),
    );
    return Array.isArray(response.messages) ? response.messages : [];
  } catch (error) {
    console.warn('Failed to load cron fallback history:', error);
    return [];
  }
}

export function createHistoryActions(
  set: ChatSet,
  get: ChatGet,
): Pick<SessionHistoryActions, 'loadHistory'> {
  return {
    loadHistory: async (quiet = false) => {
      const { currentSessionKey } = get();
      if (!quiet) set({ loading: true, error: null });

      const isCurrentSession = () => get().currentSessionKey === currentSessionKey;
      const scheduleGatewayHistoryRetry = () => {
        if (gatewayHistoryRetryTimer) return;
        gatewayHistoryRetryTimer = setTimeout(() => {
          gatewayHistoryRetryTimer = null;
          if (!isCurrentSession()) return;
          void get().loadHistory(true);
        }, GATEWAY_HISTORY_RETRY_MS);
      };
      const getPreviewMergeKey = (message: RawMessage): string => (
        `${message.id ?? ''}|${message.role}|${message.timestamp ?? ''}|${getMessageText(message.content)}`
      );
      const normalizeComparableText = (message: RawMessage): string => (
        getMessageText(message.content)
          .replace(/\[media attached:[^\]]+\]/g, '')
          .replace(/\s+/g, ' ')
          .trim()
      );
      const isSameUserMessage = (a: RawMessage, b: RawMessage, options: { allowTextOnly?: boolean } = {}): boolean => {
        if (a.role !== 'user' || b.role !== 'user') return false;
        if (a.id && b.id && a.id === b.id) return true;
        const aText = normalizeComparableText(a);
        const bText = normalizeComparableText(b);
        if (options.allowTextOnly && aText && bText && aText === bText) return true;
        if (a.timestamp && b.timestamp && Math.abs(toMs(a.timestamp) - toMs(b.timestamp)) < 5000) {
          return true;
        }
        return false;
      };
      const mergeUserAttachmentPreview = (gatewayMessage: RawMessage, localMessage: RawMessage): RawMessage => {
        if (gatewayMessage._attachedFiles?.length || !localMessage._attachedFiles?.length) {
          return gatewayMessage;
        }
        return { ...gatewayMessage, _attachedFiles: localMessage._attachedFiles.map((file) => ({ ...file })) };
      };
      const insertMessageByTimestamp = (sourceMessages: RawMessage[], message: RawMessage): RawMessage[] => {
        if (!message.timestamp) return [...sourceMessages, message];
        const messageMs = toMs(message.timestamp);
        const insertAt = sourceMessages.findIndex((candidate) => (
          candidate.timestamp ? toMs(candidate.timestamp) > messageMs : false
        ));
        if (insertAt === -1) return [...sourceMessages, message];
        return [
          ...sourceMessages.slice(0, insertAt),
          message,
          ...sourceMessages.slice(insertAt),
        ];
      };
      const dedupeMessages = (sourceMessages: RawMessage[]): RawMessage[] => {
        const result: RawMessage[] = [];
        for (const message of sourceMessages) {
          const duplicateIndex = result.findIndex((existing) => {
            if (message.id && existing.id && message.id === existing.id) return true;
            return isSameUserMessage(existing, message);
          });
          if (duplicateIndex === -1) {
            result.push(message);
            continue;
          }
          const existing = result[duplicateIndex];
          if (existing.role === 'user' && message.role === 'user') {
            result[duplicateIndex] = message.id
              ? mergeUserAttachmentPreview(message, existing)
              : mergeUserAttachmentPreview(existing, message);
          }
        }
        return result;
      };
      const mergeHydratedMessages = (
        currentMessages: RawMessage[],
        hydratedMessages: RawMessage[],
      ): RawMessage[] => {
        const hydratedFilesByKey = new Map(
          hydratedMessages
            .filter((message) => message._attachedFiles?.length)
            .map((message) => [
              getPreviewMergeKey(message),
              message._attachedFiles!.map((file) => ({ ...file })),
            ]),
        );

        return currentMessages.map((message) => {
          const attachedFiles = hydratedFilesByKey.get(getPreviewMergeKey(message));
          return attachedFiles
            ? { ...message, _attachedFiles: attachedFiles }
            : message;
        });
      };

      const applyLoadFailure = (errorMessage: string | null) => {
        if (!isCurrentSession()) return;
        set((state) => {
          const hasMessages = state.messages.length > 0;
          return {
            loading: false,
            error: !quiet && errorMessage ? errorMessage : state.error,
            ...(hasMessages ? {} : { messages: [] as RawMessage[] }),
          };
        });
      };

      const applyLoadedMessages = (rawMessages: RawMessage[], thinkingLevel: string | null) => {
        if (!isCurrentSession()) return;
        // Before filtering: attach images/files from tool_result messages to the next assistant message
        const messagesWithToolImages = enrichWithToolResultFiles(rawMessages);
        const filteredMessages = messagesWithToolImages.filter((msg) => !isToolResultRole(msg.role) && !isInternalMessage(msg));
        // Restore file attachments for user/assistant messages (from cache + text patterns)
        const enrichedMessages = enrichWithCachedImages(filteredMessages);

        // Preserve the optimistic user message during an active send.
        // The Gateway may not include the user's message in chat.history
        // until the run completes, causing it to flash out of the UI.
        let finalMessages = enrichedMessages;
        const userMsgAt = get().lastUserMessageAt;
        if (get().sending && userMsgAt) {
          const userMsMs = toMs(userMsgAt);
          const currentMsgs = get().messages;
          const optimistic = [...currentMsgs].reverse().find(
            (m) => m.role === 'user' && m.timestamp && Math.abs(toMs(m.timestamp) - userMsMs) < 5000,
          );
          if (optimistic) {
            const matchingHistoryIndex = enrichedMessages.findIndex((m) => isSameUserMessage(m, optimistic, { allowTextOnly: true }));
            if (matchingHistoryIndex >= 0) {
              finalMessages = enrichedMessages.map((message, index) => (
                index === matchingHistoryIndex
                  ? mergeUserAttachmentPreview(message, optimistic)
                  : message
              ));
            } else {
              finalMessages = insertMessageByTimestamp(enrichedMessages, optimistic);
            }
          }
        }

        finalMessages = dedupeMessages(finalMessages);
        set({ messages: finalMessages, thinkingLevel, loading: false });

        // Extract first user message text as a session label for display in the toolbar.
        // Skip main sessions (key ends with ":main") — they rely on the Gateway-provided
        // displayName (e.g. the configured agent name "ClawX") instead.
        const isMainSession = currentSessionKey.endsWith(':main');
        if (!isMainSession) {
          const firstUserMsg = finalMessages.find((m) => m.role === 'user');
          if (firstUserMsg) {
            const labelText = getMessageText(firstUserMsg.content).trim();
            if (labelText) {
              const truncated = labelText.length > 50 ? `${labelText.slice(0, 50)}…` : labelText;
              set((s) => ({
                sessionLabels: { ...s.sessionLabels, [currentSessionKey]: truncated },
              }));
            }
          }
        }

        // Record last activity time from the last message in history
        const lastMsg = finalMessages[finalMessages.length - 1];
        if (lastMsg?.timestamp) {
          const lastAt = toMs(lastMsg.timestamp);
          set((s) => ({
            sessionLastActivity: { ...s.sessionLastActivity, [currentSessionKey]: lastAt },
          }));
        }

        // Async: load missing image previews from disk (updates in background)
        loadMissingPreviews(finalMessages).then((updated) => {
          if (!isCurrentSession()) return;
          if (updated) {
            set((state) => ({
              messages: mergeHydratedMessages(state.messages, finalMessages),
            }));
          }
        });
        const { pendingFinal, lastUserMessageAt, sending: isSendingNow } = get();

        // If we're sending but haven't received streaming events, check
        // whether the loaded history reveals intermediate tool-call activity.
        // This surfaces progress via the pendingFinal → ActivityIndicator path.
        const userMsTs = lastUserMessageAt ? toMs(lastUserMessageAt) : 0;
        const isAfterUserMsg = (msg: RawMessage): boolean => {
          if (!userMsTs || !msg.timestamp) return true;
          return toMs(msg.timestamp) >= userMsTs;
        };

        if (isSendingNow && !pendingFinal) {
          const hasRecentAssistantActivity = [...filteredMessages].reverse().some((msg) => {
            if (msg.role !== 'assistant') return false;
            return isAfterUserMsg(msg);
          });
          if (hasRecentAssistantActivity) {
            set({ pendingFinal: true });
          }
        }

        // If pendingFinal, check whether the AI produced a final text response.
        if (pendingFinal || get().pendingFinal) {
          const recentAssistant = [...filteredMessages].reverse().find((msg) => {
            if (msg.role !== 'assistant') return false;
            if (!hasNonToolAssistantContent(msg)) return false;
            return isAfterUserMsg(msg);
          });
          if (recentAssistant) {
            clearHistoryPoll();
            set({ sending: false, activeRunId: null, pendingFinal: false });
          }
        }
      };

      try {
        const result = await invokeIpc(
          'gateway:rpc',
          'chat.history',
          { sessionKey: currentSessionKey, limit: 200 },
          60000  // 60 秒超时，适应大会话历史
        ) as { success: boolean; result?: Record<string, unknown>; error?: string };

        if (result.success && result.result) {
          const data = result.result;
          let rawMessages = Array.isArray(data.messages) ? data.messages as RawMessage[] : [];
          const thinkingLevel = data.thinkingLevel ? String(data.thinkingLevel) : null;
          if (rawMessages.length === 0 && isCronSessionKey(currentSessionKey)) {
            rawMessages = await loadCronFallbackMessages(currentSessionKey, 200);
          }
          applyLoadedMessages(rawMessages, thinkingLevel);
        } else {
          if (isGatewayDisconnectedError(result.error)) {
            applyLoadFailure(null);
            scheduleGatewayHistoryRetry();
            return;
          }
          const fallbackMessages = await loadCronFallbackMessages(currentSessionKey, 200);
          if (fallbackMessages.length > 0) {
            applyLoadedMessages(fallbackMessages, null);
          } else {
            applyLoadFailure(result.error || 'Failed to load chat history');
          }
        }
      } catch (err) {
        if (isGatewayDisconnectedError(err)) {
          applyLoadFailure(null);
          scheduleGatewayHistoryRetry();
          return;
        }
        console.warn('Failed to load chat history:', err);
        const errorMsg = String(err);
        
        // 如果是超时错误，尝试 fallback
        if (errorMsg.includes('timeout')) {
          const fallbackMessages = await loadCronFallbackMessages(currentSessionKey, 200);
          if (fallbackMessages.length > 0) {
            applyLoadedMessages(fallbackMessages, null);
          } else {
            // 新会话超时：直接显示空会话，不报错
            applyLoadedMessages([], null);
          }
        } else {
          // 其他错误：尝试 fallback
          const fallbackMessages = await loadCronFallbackMessages(currentSessionKey, 200);
          if (fallbackMessages.length > 0) {
            applyLoadedMessages(fallbackMessages, null);
          } else {
            applyLoadFailure(errorMsg);
          }
        }
      }
    },
  };
}
