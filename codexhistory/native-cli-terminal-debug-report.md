# Native CLI Terminal Debug Report

Date: 2026-06-03

## Problem Trail

- Initial issue: Claude Code startup banner was removed, but xterm still showed a large blank top area.
- Log proved the blank was not React/CSS spacing. Claude emitted a full-screen terminal frame and later placed conversation rows lower with absolute cursor positioning.
- CSS/visual crop attempts made the blank look better briefly, but broke xterm row geometry and caused stacking/disappearing text. That path was removed.
- Row-count cap also made output worse and was removed.

## Current Working Direction

Only mutate the terminal stream before xterm receives it.

Current stream behavior:

- Strip Claude startup banner chunk.
- Suppress post-banner chrome/status chunks until real conversation content is found.
- Reset xterm with `ESC[2J ESC[H` before writing the first real conversation frame.

## Latest Log Findings

Blank top is now gone, but Claude UI chrome still appears in xterm rows:

- horizontal separator lines
- `bypass permissions on ...`
- `high /effort`
- duplicate prompt/history rows

This means the filter currently starts at `❯ hi`, but the same chunk can still include footer/status chrome after that line. Follow-up fix should sanitize the first normalized frame and later redraw chunks by removing Claude chrome lines, not by using CSS.

## Avoid Regressions

- Do not reintroduce CSS transforms or visual cropping.
- Do not cap terminal rows.
- Do not edit xterm row DOM for layout.
- Keep fixes in stream parsing/filtering only.

## 2026-06-03 Follow-up

After filtering later Claude UI chrome, the screenshot improved but animation broke. The log showed why: Claude sends spinner/status animation as terminal redraw chunks like `CR + spinner`, `tokens)` and tiny numeric token counter updates. Removing redraw controls made those fragments printable, so xterm rendered every animation frame as a new row.

Rejected patch direction:

- suppress bare spinner glyph chunks as Claude UI chrome
- suppress token counter fragments and `Visual Studio Code disconnected` status rows
- keep the banner strip and first conversation clear/home reset unchanged
- keep all changes in stream parsing/filtering, not CSS or xterm DOM layout

This should not be used now. It broke Claude's normal redraw/animation stream by turning TUI updates into visible output rows.

## 2026-06-03 Latest Repeating Cause

The latest screenshot/log showed two separate Claude TUI frames retained in xterm:

- first frame: `hi` plus `Deliberating...`
- later frame: `hi` plus final answer

The log still contained `claude-clear-screen-control-sent-before-first-input`, but that Ctrl+L code had already been removed from the source. The current source still had another local-only reset on first user input: `term.clear(); term.write('\x1b[H')`.

That is unsafe for this Claude TUI because it changes only the browser xterm screen. Claude's PTY process still keeps its own full-screen cursor/layout state and later sends absolute row redraws. This mismatch is why temporary/final frames can append instead of repainting cleanly.

Current fix:

- removed `resetLocalTerminalForFirstUserInput`
- no Ctrl+L is sent
- no local xterm clear happens on first input
- added `first-user-input-no-local-terminal-reset` trace so future logs prove the safe path is running

Current rule:

- strip only the initial startup banner/header at stream entry
- suppress startup tail chunks only before first user input
- do not filter/rewrite Claude response/status/animation chunks after the user starts interacting
- do not use CSS, xterm DOM row edits, row caps, Ctrl+L, or local xterm clears to fix this

## 2026-06-03 Remaining Empty Rows Cause

Fresh log after removing first-input local clear showed:

- no `first-user-input-terminal-reset-clear-home`
- no `claude-clear-screen-control-sent-before-first-input`
- `first-user-input-no-local-terminal-reset` was present
- xterm DOM still had rows 0-12 empty and first text at row 13

This proves the remaining empty `<div>` rows are xterm's normal terminal rows, not leftover banner DOM. Claude's TUI is still sending absolute cursor positions based on the full startup screen after the startup header was stripped. The stream writes conversation content lower on the terminal grid.

Current fix:

- keep Claude's normal response/status/animation stream intact
- shift only Claude absolute cursor row commands (`ESC[row;colH`, `ESC[row;colf`, `ESC[rowd`) upward after startup strip
- add `claude-cursor-rows-shifted-after-startup-strip` trace with before/after row numbers

This is a stream-level coordinate fix, not CSS or xterm DOM editing.

## 2026-06-03 Row Shift Regression

The row-coordinate shift fixed the startup blank area, but the next log showed it was still active much later:

- `claude-cursor-rows-shifted-after-startup-strip` appeared on chunks for later prompts such as `❯ jijij`
- it also shifted token counters, spinner/status rows, and final redraw frames
- this caused the same old stacking/repaint corruption class again

Root cause:

- the row shift was treated as a session-wide correction
- it must be a startup/first-turn correction only
- Claude's later redraw coordinates are valid for the current TUI layout and must not be rewritten

Rejected fix:

- keep the startup row shift for the first startup/first-turn layout
- disable it before the second and later user inputs
- added `claude-startup-cursor-row-shift-disabled-before-next-input`

This caused a new visual gap: the first turn was compacted by the row shift, then the second turn used Claude's original lower full-screen rows, leaving empty rows between turns.

This was still unsafe. The latest log showed the global row shift was active on live Claude redraw chunks such as `ESC[16;25H2`, token counter updates, spinner/status rows, and final answer redraws. Those row numbers are part of Claude's current TUI repaint state, so rewriting them moves valid updates into the wrong rows and causes text stacking/garbage.

Final correction for this regression:

- removed the row offset constant/ref/helper entirely
- removed the `claude-cursor-rows-shifted-after-startup-strip` write path
- kept the startup/header stripper guarded with `!claudeStartupChromeStrippedRef.current`
- kept first-input behavior as passthrough: no Ctrl+L and no local xterm clear

Rule:

- never rewrite Claude cursor row coordinates after startup
- never let the startup/banner stripper run again after the first strip
- do not fix later stacking with text filtering, CSS, DOM edits, row caps, Ctrl+L, or local xterm clear
- if the blank top rows return, investigate PTY startup size or Claude CLI mode/flags instead of rewriting the live stream

## 2026-06-03 Startup Blank Rows Follow-up

The top blank rows came back after removing the global row shift, but the stacking problem was caused by shifting live Claude cursor coordinates after user interaction. The safe distinction is:

- do not rewrite cursor rows for normal Claude chunks after startup
- it is acceptable to normalize only the first banner-stripped startup frame, because that frame is already being rebuilt by ClawX before xterm sees it

Current fix:

- added `normalizeClaudeStartupFrameAtHome`
- it removes absolute cursor positioning only from the first stripped startup frame when `resetDisplay` is true
- later Claude output, response animation, spinner/status redraws, token counters, and final answer frames remain untouched
- added startup trace field `startupFrameNormalizedAtHome`

Also added a PTY startup-size fix:

- the UI sends initial `cols` and `rows` in the `/terminal` WebSocket URL before opening the socket
- the gateway pre-launch repair patches OpenClaw so `resolveNativeCliLaunch(req)` uses those query dimensions as `nativeCli.config.cols/rows`
- this prevents Claude from drawing startup layout against stale default PTY dimensions before the first resize message arrives

Runtime note:

- the frontend startup-frame normalization can take effect with the UI bundle/HMR
- the gateway initial-size patch takes effect after the gateway/app restarts and runs `repairOpenClawRuntimeBeforeLaunch`
