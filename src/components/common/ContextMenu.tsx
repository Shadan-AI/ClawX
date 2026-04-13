import { useEffect, useState, useCallback, useRef } from 'react';
import { Scissors, Copy, ClipboardPaste, CheckSquare, RefreshCw, Check } from 'lucide-react';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';

interface MenuItem {
  label: string;
  icon: React.ReactNode;
  successIcon?: React.ReactNode;
  successLabel?: string;
  action: () => void;
  divider?: boolean;
}

function execElectron(cmd: string) {
  try {
    const { ipcRenderer } = window.require('electron');
    ipcRenderer.invoke('context-menu-action', cmd);
  } catch {
    document.execCommand(cmd);
  }
}

export function ContextMenu() {
  const [state, setState] = useState<'hidden' | 'open' | 'closing'>('hidden');
  const [pos, setPos] = useState({ x: 0, y: 0 });
  const [items, setItems] = useState<MenuItem[]>([]);
  const [flashIdx, setFlashIdx] = useState<number | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const close = useCallback(() => {
    setState('closing');
    setTimeout(() => { setState('hidden'); setFlashIdx(null); }, 120);
  }, []);

  const handleAction = useCallback((item: MenuItem, idx: number) => {
    item.action();
    if (item.successLabel) {
      toast.success(item.successLabel);
    }
    close();
  }, [close]);

  useEffect(() => {
    const handleContext = (e: MouseEvent) => {
      e.preventDefault();
      const target = e.target as HTMLElement;
      const isEditable = target.tagName === 'TEXTAREA' || target.tagName === 'INPUT' || target.isContentEditable;
      const hasSelection = !!window.getSelection()?.toString();

      const menuItems: MenuItem[] = [];

      if (isEditable) {
        menuItems.push(
          { label: '剪切', icon: <Scissors className="h-3.5 w-3.5" />, action: () => execElectron('cut'), successLabel: '已剪切', successIcon: <Check className="h-3.5 w-3.5" /> },
          { label: '复制', icon: <Copy className="h-3.5 w-3.5" />, action: () => execElectron('copy'), successLabel: '已复制', successIcon: <Check className="h-3.5 w-3.5" /> },
          { label: '粘贴', icon: <ClipboardPaste className="h-3.5 w-3.5" />, action: () => execElectron('paste') },
          { label: '全选', icon: <CheckSquare className="h-3.5 w-3.5" />, action: () => execElectron('selectAll'), divider: true },
        );
      } else if (hasSelection) {
        menuItems.push(
          { label: '复制', icon: <Copy className="h-3.5 w-3.5" />, action: () => execElectron('copy'), successLabel: '已复制', successIcon: <Check className="h-3.5 w-3.5" />, divider: true },
        );
      }

      menuItems.push(
        { label: '刷新', icon: <RefreshCw className="h-3.5 w-3.5" />, action: () => window.location.reload() },
      );

      const x = Math.min(e.clientX, window.innerWidth - 180);
      const y = Math.min(e.clientY, window.innerHeight - menuItems.length * 36 - 20);

      setItems(menuItems);
      setPos({ x, y });
      setFlashIdx(null);
      setState('open');
    };

    const handleClick = () => { if (state === 'open') close(); };
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && state === 'open') close();
      // Ctrl+C / Ctrl+X toast
      if ((e.ctrlKey || e.metaKey) && !e.repeat) {
        if (e.key === 'c' && window.getSelection()?.toString()) {
          setTimeout(() => toast.success('已复制'), 50);
        }
        if (e.key === 'x') {
          setTimeout(() => toast.success('已剪切'), 50);
        }
      }
    };

    document.addEventListener('contextmenu', handleContext);
    document.addEventListener('click', handleClick);
    document.addEventListener('keydown', handleKey);
    return () => {
      document.removeEventListener('contextmenu', handleContext);
      document.removeEventListener('click', handleClick);
      document.removeEventListener('keydown', handleKey);
    };
  }, [state, close]);

  if (state === 'hidden') return null;

  return (
    <div
      ref={menuRef}
      className={cn(
        'fixed z-[99999] min-w-[160px] py-1.5 rounded-xl',
        'bg-white/80 dark:bg-neutral-900/80 backdrop-blur-xl',
        'border border-black/10 dark:border-white/15',
        'shadow-xl shadow-black/10 dark:shadow-black/40',
        state === 'open' && 'animate-in fade-in-0 zoom-in-95 duration-100',
        state === 'closing' && 'opacity-0 scale-95 transition-all duration-100',
      )}
      style={{ left: pos.x, top: pos.y }}
    >
      {items.map((item, i) => {
        const isFlashed = flashIdx === i;
        return (
          <div key={i}>
            <button
              className={cn(
                'flex items-center gap-2.5 w-full px-3 py-1.5 text-[13px] rounded-lg mx-0',
                'transition-all duration-100 cursor-default',
                isFlashed
                  ? 'bg-green-500/15 text-green-600 dark:text-green-400'
                  : 'text-foreground/90 hover:bg-black/15 dark:hover:bg-white/15 active:scale-[0.97] active:bg-black/20 dark:active:bg-white/20',
              )}
              onClick={() => handleAction(item, i)}
            >
              <span className={cn(
                'transition-all duration-150',
                isFlashed ? 'text-green-500 scale-110' : 'text-foreground/50',
              )}>
                {isFlashed && item.successIcon ? item.successIcon : item.icon}
              </span>
              <span className="transition-all duration-150">
                {isFlashed && item.successLabel ? item.successLabel : item.label}
              </span>
            </button>
            {item.divider && <div className="my-1 mx-2.5 h-px bg-black/8 dark:bg-white/10" />}
          </div>
        );
      })}
    </div>
  );
}
