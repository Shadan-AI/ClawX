export type NativeCliTerminalStatus = 'disconnected' | 'connecting' | 'connected';
export type NativeCliTerminalPhase =
  | 'idle'
  | 'preparing'
  | 'starting'
  | 'resuming'
  | 'reconnecting';

export type NativeCliTerminalState = {
  status: NativeCliTerminalStatus;
  phase: NativeCliTerminalPhase;
  awaitingInitialOutput: boolean;
};

export type NativeCliTerminalEvent =
  | { type: 'connect_requested'; phase: Exclude<NativeCliTerminalPhase, 'idle' | 'reconnecting'> }
  | { type: 'gateway_unavailable' }
  | { type: 'websocket_opened' }
  | { type: 'initial_output_settled' }
  | { type: 'ready_without_initial_output' }
  | { type: 'websocket_closed' }
  | { type: 'websocket_error' }
  | { type: 'disposed' };

export const initialNativeCliTerminalState: NativeCliTerminalState = {
  status: 'disconnected',
  phase: 'idle',
  awaitingInitialOutput: false,
};

export function nativeCliTerminalReducer(
  state: NativeCliTerminalState,
  event: NativeCliTerminalEvent,
): NativeCliTerminalState {
  switch (event.type) {
    case 'connect_requested':
      return {
        status: 'connecting',
        phase: event.phase,
        awaitingInitialOutput: true,
      };
    case 'gateway_unavailable':
    case 'websocket_closed':
    case 'websocket_error':
      return {
        status: 'disconnected',
        phase: 'reconnecting',
        awaitingInitialOutput: true,
      };
    case 'websocket_opened':
      return {
        ...state,
        status: 'connected',
      };
    case 'initial_output_settled':
    case 'ready_without_initial_output':
      return {
        status: 'connected',
        phase: 'idle',
        awaitingInitialOutput: false,
      };
    case 'disposed':
      return initialNativeCliTerminalState;
    default:
      return state;
  }
}

export function nativeCliTerminalLoadingLabel(state: NativeCliTerminalState): string {
  if (state.status === 'connected' && !state.awaitingInitialOutput) return '';
  if (state.phase === 'resuming') return '正在恢复会话';
  if (state.phase === 'preparing') return '正在准备会话';
  if (state.phase === 'reconnecting') return '正在重新连接';
  return '正在创建会话';
}

export function nativeCliTerminalCanSend(state: NativeCliTerminalState): boolean {
  return state.status === 'connected';
}
