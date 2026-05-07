# ClawX Optimization Plan

## Goal

This document prioritizes the next stage of ClawX improvements, with digital employees as the main focus.

The guiding principle is:

Stabilize the digital employee core workflow before expanding feature scope.

## P0

These are the highest-priority items. They directly affect correctness, testability, and production stability.

### 1. Unify the digital employee workflow

Current problems:

- Employee creation, deletion, template application, skill sync, profile sync, and channel sync are split across UI, stores, and Electron utilities.
- Partial failures can leave local OpenClaw state and ai-im state inconsistent.

Actions:

- Introduce a single digital employee orchestration/service layer.
- Treat create, delete, sync, and apply-template as explicit workflows with defined steps.
- Add per-step success, retry, and failure reporting.

Expected result:

- Fewer inconsistent states after user actions.
- Easier debugging when tester feedback comes back.

### 2. Separate local state from remote state

Current problems:

- ClawX often assumes local OpenClaw config and ai-im cloud state are already the same.
- In reality, they may temporarily diverge after network issues or partial sync.

Actions:

- Model local state and remote state separately for digital employees.
- Add explicit sync states such as `idle`, `syncing`, `synced`, `conflict`, and `partial_failure`.
- Reflect those states in the UI.

Expected result:

- Users and testers can understand what is actually wrong instead of seeing vague failures.

### 3. Unify ai-im API access

Current problems:

- Some ai-im requests are sent directly from renderer code.
- Others go through Electron-side helpers.
- Timeout, auth, logging, and error behavior are inconsistent.

Actions:

- Centralize ai-im API calls behind a shared client layer.
- Standardize Token-Key auth, timeout handling, error mapping, and logging.
- Make request IDs and agent identifiers appear in logs.

Expected result:

- Lower integration risk.
- Easier diagnosis of cloud/API failures.

### 4. Harden key digital employee identifiers

Current problems:

- `employee.id`, `botId`, `openclawAgentId`, and `agentId` are easy to mix up.

Actions:

- Define canonical meanings for each identifier.
- Use `openclawAgentId` as the local/OpenClaw identity.
- Use `employee.id` as the ai-im database identity.
- Audit UI/store/service code for cross-usage mistakes.

Expected result:

- Lower risk of updating or deleting the wrong entity.

### 5. Build an internal diagnostics surface

Current problems:

- When something breaks, it is hard to see local agent state, remote bot state, template state, profile state, and sync state together.

Actions:

- Add a developer-facing digital employee diagnostics panel.
- Show key IDs, local/remote state, sync timestamps, and recent failures.

Expected result:

- Faster debugging and better tester support.

## P1

These are the next most valuable improvements after the core workflow is stabilized.

### 6. Improve delete and cleanup transparency

Actions:

- Show staged deletion progress for:
  local agent removal,
  ai-im bot deletion,
  channel binding cleanup,
  workspace cleanup.
- Distinguish complete success from partial success.

### 7. Clarify source-of-truth in the UI

Actions:

- Show where model, template, skills, and profile content come from:
  local,
  template,
  cloud,
  inherited/default.
- Show last sync time where applicable.

### 8. Improve organization editing behavior

Actions:

- Keep auto-save, but make it more visible and understandable.
- Add better conflict messaging.
- Consider explicit save/undo support if tester feedback shows confusion.

### 9. Add idempotency and retry policy to sync operations

Actions:

- Ensure repeated create/sync/update requests are safe.
- Add retry rules for transient failures in:
  employee sync,
  template sync,
  profile upload/download,
  organization save.

### 10. Reduce page-level complexity in Agents

Actions:

- Split `src/pages/Agents/index.tsx` into smaller page containers and view-model hooks.
- Move orchestration logic out of the page component.

## P2

These items are valuable, but should follow after the main stability work above.

### 11. Expand test coverage around digital employees

Priority scenarios:

- Create digital employee -> refresh -> visible in list/chat/channels.
- Apply template -> skills/profile remain consistent after refresh/restart.
- Delete digital employee -> no stale organization/channel records remain.
- Organization version conflict handling.
- Model sync behavior between ai-im and local OpenClaw config.

### 12. Refine profile editing UX

Actions:

- Make local/template/cloud source transitions more obvious.
- Improve reset and sync language.
- Better explain what gets saved locally versus uploaded remotely.

### 13. Review background sync timing and race conditions

Actions:

- Audit gateway startup sync, bot sync, model sync, and organization polling.
- Reduce hidden state changes that surprise users.

## Dependency Notes

ClawX digital employee behavior depends on both local OpenClaw runtime state and ai-im APIs.

High-risk dependency surfaces:

- Token-Key authentication in ai-im
- `/bot/*` endpoints
- `/organization/*` endpoints
- `/employee/profile/*` endpoints
- template/profile APIs in ai-im

Changes to those APIs should be reviewed together with ClawX.

## Recommended Execution Order

1. Build the digital employee orchestration layer.
2. Separate local and remote state modeling.
3. Centralize ai-im API access and logging.
4. Normalize identifier usage.
5. Add diagnostics UI and structured logs.
6. Improve cleanup, source visibility, and organization UX.
7. Expand integration coverage.

## Success Criteria

This optimization plan should be considered successful when:

- Digital employee create/delete/apply/sync flows are deterministic.
- Local and cloud state mismatches are visible and diagnosable.
- Tester feedback can be traced to a concrete workflow step.
- New digital employee features can be added without spreading more cross-layer sync logic.
