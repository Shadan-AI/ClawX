/**
 * First-launch initialization progress screen.
 * Shown when .openclaw directory does not exist yet.
 */
import { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { CheckCircle2, Loader2, FolderOpen } from 'lucide-react';
import { invokeIpc } from '@/lib/api-client';
import clawxIcon from '@/assets/logo.svg';

interface ProgressEvent {
  total: number;
  current: number;
  label: string;
}

interface LogEntry {
  id: number;
  label: string;
  done: boolean;
}

export function InitProgress() {
  const navigate = useNavigate();
  const [progress, setProgress] = useState(0);
  const [total, setTotal] = useState(6);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [done, setDone] = useState(false);
  const nextId = useRef(0);

  function applyEvent(ev: ProgressEvent) {
    setTotal(ev.total);
    setProgress(ev.current);
    const id = nextId.current++;
    setLogs((prev) => {
      const updated = prev.map((l) => ({ ...l, done: true }));
      return [...updated, { id, label: ev.label, done: false }];
    });
  }

  useEffect(() => {
    const ipc = window.electron?.ipcRenderer;
    if (!ipc) return;

    let cancelled = false;

    // 1. Pull buffered events from main process
    invokeIpc<{ isFirstLaunch: boolean; events: ProgressEvent[] }>('init:getProgress')
      .then(({ isFirstLaunch, events }) => {
        if (cancelled) return;
        if (!isFirstLaunch) {
          // Not first launch — shouldn't be here, go home
          navigate('/', { replace: true });
          return;
        }
        events.forEach(applyEvent);
      })
      .catch(() => {
        // Handler not registered (non-first-launch build) — go home
        if (!cancelled) navigate('/', { replace: true });
      });

    // 2. Subscribe to future progress pushes
    const unsubProgress = ipc.on('init:progress', (payload: unknown) => {
      if (!cancelled) applyEvent(payload as ProgressEvent);
    });

    // 3. Subscribe to completion
    const unsubComplete = ipc.on('init:complete', () => {
      if (cancelled) return;
      setDone(true);
      setLogs((prev) => prev.map((l) => ({ ...l, done: true })));
      setTimeout(() => navigate('/', { replace: true }), 1200);
    });

    return () => {
      cancelled = true;
      if (typeof unsubProgress === 'function') unsubProgress();
      if (typeof unsubComplete === 'function') unsubComplete();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const pct = total > 0 ? Math.round((progress / total) * 100) : 0;

  return (
    <div className="flex flex-col items-center justify-center min-h-screen bg-background text-foreground select-none px-8">
      <motion.img
        src={clawxIcon}
        alt="ClawX"
        className="w-16 h-16 mb-6"
        initial={{ opacity: 0, scale: 0.8 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ duration: 0.4 }}
      />

      <motion.h1
        className="text-xl font-semibold mb-1"
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.1 }}
      >
        正在初始化工作目录
      </motion.h1>
      <motion.p
        className="text-sm text-muted-foreground mb-8"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ delay: 0.2 }}
      >
        首次启动，正在生成{' '}
        <code className="font-mono text-xs bg-muted px-1 py-0.5 rounded">~/.openclaw</code>{' '}
        目录结构...
      </motion.p>

      {/* Progress bar */}
      <div className="w-full max-w-md mb-6">
        <div className="flex justify-between text-xs text-muted-foreground mb-1.5">
          <span>{done ? '初始化完成' : '初始化中...'}</span>
          <span>{pct}%</span>
        </div>
        <div className="h-2 w-full bg-muted rounded-full overflow-hidden">
          <motion.div
            className="h-full bg-primary rounded-full"
            initial={{ width: '0%' }}
            animate={{ width: `${pct}%` }}
            transition={{ duration: 0.5, ease: 'easeOut' }}
          />
        </div>
      </div>

      {/* Log list */}
      <div className="w-full max-w-md space-y-1.5 max-h-52 overflow-y-auto">
        <AnimatePresence initial={false}>
          {logs.map((entry) => (
            <motion.div
              key={entry.id}
              className="flex items-center gap-2 text-sm"
              initial={{ opacity: 0, x: -10 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.25 }}
            >
              {entry.done ? (
                <CheckCircle2 className="w-4 h-4 text-green-500 shrink-0" />
              ) : (
                <Loader2 className="w-4 h-4 text-primary shrink-0 animate-spin" />
              )}
              <span className={entry.done ? 'text-muted-foreground' : 'text-foreground'}>
                {entry.label}
              </span>
            </motion.div>
          ))}
        </AnimatePresence>
        {logs.length === 0 && (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <FolderOpen className="w-4 h-4 shrink-0" />
            <span>等待初始化开始...</span>
          </div>
        )}
      </div>
    </div>
  );
}
