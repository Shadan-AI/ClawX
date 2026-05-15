export function stripGatewayMetadataText(text: string): string {
  let result = text;

  // Strip heartbeat boilerplate if it leaked into a visible transcript/title.
  result = result.replace(
    /^\s*Read HEARTBEAT\.md if it exists \(workspace context\)\.[\s\S]*?(?:Current time:[^\n]*\n?)?/i,
    '',
  );

  // Titles can be derived from a truncated heartbeat prompt, leaving fragments
  // such as "Follow" or "Follow it strictly" in the session list.
  if (
    /^(?:Follow|Follow it strictly\.?|Do not infer(?: or repeat old tasks from prior chats\.)?|If nothing needs attention,\s*reply HEARTBEAT_OK\.?)$/i
      .test(result.trim())
  ) {
    return '';
  }

  result = result.replace(
    /^\s*(?:Follow it strictly\.?\s*)?(?:Do not infer or repeat old tasks from prior chats\.?\s*)?(?:If nothing needs attention,\s*reply HEARTBEAT_OK\.?)?\s*$/i,
    '',
  );

  // Strip rendered exec/process system summaries that should stay internal.
  result = result.replace(
    /^\s*System:\s*\[[^\]]+\]\s*Exec (?:completed|failed|started)[\s\S]*$/i,
    '',
  );

  // Some failed tool executions were echoed back into the next user message
  // before the real sender metadata block. Drop that prefix if present.
  result = result.replace(
    /^System:\s*\[[^\]]+\][\s\S]*?\n\n(?=\s*(?:Conversation info|Sender)\s*\([^)]*\):)/i,
    '',
  );

  // Strip repeated Gateway metadata blocks injected ahead of the real user text.
  const metadataCodeBlockPattern = /^\s*(?:Conversation info|Sender)\s*\([^)]*\):\s*```[a-z]*\n[\s\S]*?```\s*/i;
  const metadataInlinePattern = /^\s*(?:Conversation info|Sender)\s*\([^)]*\):\s*\{[\s\S]*?\}\s*/i;

  let changed = true;
  while (changed) {
    changed = false;
    const next = result
      .trimStart()
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
