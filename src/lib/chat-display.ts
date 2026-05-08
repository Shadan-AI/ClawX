export function stripGatewayMetadataText(text: string): string {
  let result = text;

  // Some failed tool executions were echoed back into the next user message
  // before the real sender metadata block. Drop that prefix if present.
  result = result.replace(
    /^System:\s*\[[^\]]+\][\s\S]*?\n\n(?=(?:Conversation info|Sender)\s*\([^)]*\):)/i,
    '',
  );

  // Strip repeated Gateway metadata blocks injected ahead of the real user text.
  const metadataCodeBlockPattern = /^(?:Conversation info|Sender)\s*\([^)]*\):\s*```[a-z]*\n[\s\S]*?```\s*/i;
  const metadataInlinePattern = /^(?:Conversation info|Sender)\s*\([^)]*\):\s*\{[\s\S]*?\}\s*/i;

  let changed = true;
  while (changed) {
    changed = false;
    const next = result
      .replace(metadataCodeBlockPattern, '')
      .replace(metadataInlinePattern, '');
    if (next !== result) {
      result = next;
      changed = true;
    }
  }

  return result
    .replace(/\s*\[media attached:[^\]]*\]/g, '')
    .replace(/\s*\[message_id:\s*[^\]]+\]/g, '')
    .replace(/^\[(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}\s+[^\]]+\]\s*/i, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function sanitizeSessionLabelText(text: string): string {
  const cleaned = stripGatewayMetadataText(text);
  if (!cleaned) return '';

  // Titles work better as a single concise line.
  return cleaned
    .replace(/\s+/g, ' ')
    .trim();
}
