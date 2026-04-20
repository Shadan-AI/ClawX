/**
 * MentionInput - 支持技能提及的输入框
 * 类似微信 @ 功能,显示带样式的技能标签
 */
import { useRef, useState, useEffect, useCallback } from 'react';
import { X } from 'lucide-react';
import { cn } from '@/lib/utils';

export interface Mention {
  id: string;
  name: string;
  startIndex: number;
  endIndex: number;
}

interface MentionInputProps {
  value: string;
  onChange: (value: string) => void;
  mentions: Mention[];
  onMentionsChange: (mentions: Mention[]) => void;
  placeholder?: string;
  disabled?: boolean;
  className?: string;
  onKeyDown?: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void;
  onFocus?: () => void;
  onBlur?: () => void;
  onPaste?: (e: React.ClipboardEvent<HTMLTextAreaElement>) => void;
  rows?: number;
}

export function MentionInput({
  value,
  onChange,
  mentions,
  onMentionsChange,
  placeholder,
  disabled,
  className,
  onKeyDown,
  onFocus,
  onBlur,
  onPaste,
  rows = 1,
}: MentionInputProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const displayRef = useRef<HTMLDivElement>(null);

  // 渲染带样式的文本
  const renderStyledText = useCallback(() => {
    if (!value) return null;

    const parts: React.ReactNode[] = [];
    let lastIndex = 0;

    // 按照 startIndex 排序
    const sortedMentions = [...mentions].sort((a, b) => a.startIndex - b.startIndex);

    sortedMentions.forEach((mention, idx) => {
      // 添加提及之前的普通文本
      if (mention.startIndex > lastIndex) {
        parts.push(
          <span key={`text-${idx}`} className="whitespace-pre-wrap">
            {value.substring(lastIndex, mention.startIndex)}
          </span>
        );
      }

      // 添加提及标签
      parts.push(
        <span
          key={`mention-${mention.id}`}
          className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-primary/15 text-primary font-medium border border-primary/30 mx-0.5"
          contentEditable={false}
        >
          <span>@{mention.name}</span>
        </span>
      );

      lastIndex = mention.endIndex;
    });

    // 添加最后的普通文本
    if (lastIndex < value.length) {
      parts.push(
        <span key="text-end" className="whitespace-pre-wrap">
          {value.substring(lastIndex)}
        </span>
      );
    }

    return parts;
  }, [value, mentions]);

  // 同步滚动
  const handleScroll = useCallback(() => {
    if (textareaRef.current && displayRef.current) {
      displayRef.current.scrollTop = textareaRef.current.scrollTop;
      displayRef.current.scrollLeft = textareaRef.current.scrollLeft;
    }
  }, []);

  return (
    <div className="relative">
      {/* 显示层 - 带样式的文本 */}
      <div
        ref={displayRef}
        className={cn(
          "absolute inset-0 pointer-events-none overflow-hidden whitespace-pre-wrap break-words",
          className,
          "text-base leading-relaxed px-1 py-1.5"
        )}
        style={{
          color: value ? 'transparent' : undefined, // 有内容时隐藏,让下面的 textarea 显示
        }}
      >
        {value && (
          <div className="relative">
            {renderStyledText()}
          </div>
        )}
      </div>

      {/* 输入层 - 实际的 textarea */}
      <textarea
        ref={textareaRef}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={onKeyDown}
        onFocus={onFocus}
        onBlur={onBlur}
        onPaste={onPaste}
        onScroll={handleScroll}
        placeholder={placeholder}
        disabled={disabled}
        rows={rows}
        className={cn(
          "relative resize-none border-0 focus-visible:ring-0 focus-visible:ring-offset-0 shadow-none bg-transparent",
          "placeholder:text-muted-foreground/60 text-base leading-relaxed w-full px-1 py-1.5",
          mentions.length > 0 && "text-transparent caret-black dark:caret-white", // 有提及时文本透明,只显示光标
          className
        )}
        style={{
          caretColor: mentions.length > 0 ? 'currentColor' : undefined,
        }}
      />
    </div>
  );
}

// 辅助函数:插入提及
export function insertMention(
  currentValue: string,
  currentMentions: Mention[],
  mention: { id: string; name: string },
  cursorPosition: number
): { value: string; mentions: Mention[] } {
  // 插入提及文本
  const mentionText = `@${mention.name}`;
  const before = currentValue.substring(0, cursorPosition);
  const after = currentValue.substring(cursorPosition);
  const newValue = before + mentionText + ' ' + after;

  // 创建新的提及对象
  const newMention: Mention = {
    id: mention.id,
    name: mention.name,
    startIndex: cursorPosition,
    endIndex: cursorPosition + mentionText.length,
  };

  // 更新其他提及的位置
  const updatedMentions = currentMentions.map((m) => {
    if (m.startIndex >= cursorPosition) {
      return {
        ...m,
        startIndex: m.startIndex + mentionText.length + 1,
        endIndex: m.endIndex + mentionText.length + 1,
      };
    }
    return m;
  });

  return {
    value: newValue,
    mentions: [...updatedMentions, newMention],
  };
}

// 辅助函数:移除提及
export function removeMention(
  currentValue: string,
  currentMentions: Mention[],
  mentionId: string
): { value: string; mentions: Mention[] } {
  const mention = currentMentions.find((m) => m.id === mentionId);
  if (!mention) return { value: currentValue, mentions: currentMentions };

  // 移除提及文本
  const before = currentValue.substring(0, mention.startIndex);
  const after = currentValue.substring(mention.endIndex);
  const newValue = before + after;

  // 移除提及对象并更新其他提及的位置
  const mentionLength = mention.endIndex - mention.startIndex;
  const updatedMentions = currentMentions
    .filter((m) => m.id !== mentionId)
    .map((m) => {
      if (m.startIndex > mention.startIndex) {
        return {
          ...m,
          startIndex: m.startIndex - mentionLength,
          endIndex: m.endIndex - mentionLength,
        };
      }
      return m;
    });

  return {
    value: newValue,
    mentions: updatedMentions,
  };
}

// 辅助函数:提取纯文本(移除提及标记)
export function extractPlainText(value: string, mentions: Mention[]): string {
  // 简单版本:直接返回原文本
  // AI 会识别 @skillname 格式
  return value;
}
