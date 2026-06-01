import { describe, expect, it } from 'vitest';
import {
  initialNativeCliTerminalState,
  nativeCliTerminalCanSend,
  nativeCliTerminalLoadingLabel,
  nativeCliTerminalReducer,
} from '@/lib/native-cli-terminal-state';

describe('native CLI terminal state machine', () => {
  it('models create to ready lifecycle explicitly', () => {
    let state = initialNativeCliTerminalState;
    state = nativeCliTerminalReducer(state, { type: 'connect_requested', phase: 'starting' });
    expect(state).toMatchObject({
      status: 'connecting',
      phase: 'starting',
      awaitingInitialOutput: true,
    });
    expect(nativeCliTerminalLoadingLabel(state)).toBe('正在创建会话');
    expect(nativeCliTerminalCanSend(state)).toBe(false);

    state = nativeCliTerminalReducer(state, { type: 'websocket_opened' });
    expect(state.status).toBe('connected');
    expect(state.awaitingInitialOutput).toBe(true);
    expect(nativeCliTerminalCanSend(state)).toBe(false);

    state = nativeCliTerminalReducer(state, { type: 'ready_without_initial_output' });
    expect(state).toMatchObject({
      status: 'connected',
      phase: 'idle',
      awaitingInitialOutput: false,
    });
    expect(nativeCliTerminalLoadingLabel(state)).toBe('');
    expect(nativeCliTerminalCanSend(state)).toBe(true);
  });

  it('models resume and reconnect transitions', () => {
    let state = nativeCliTerminalReducer(initialNativeCliTerminalState, {
      type: 'connect_requested',
      phase: 'resuming',
    });
    expect(nativeCliTerminalLoadingLabel(state)).toBe('正在恢复会话');

    state = nativeCliTerminalReducer(state, { type: 'websocket_opened' });
    state = nativeCliTerminalReducer(state, { type: 'initial_output_settled' });
    expect(nativeCliTerminalLoadingLabel(state)).toBe('');

    state = nativeCliTerminalReducer(state, { type: 'websocket_closed' });
    expect(state).toMatchObject({
      status: 'disconnected',
      phase: 'reconnecting',
      awaitingInitialOutput: true,
    });
    expect(nativeCliTerminalLoadingLabel(state)).toBe('正在重新连接');
  });
});
