/**
 * ConfirmDialog - In-DOM confirmation dialog (replaces window.confirm)
 * Keeps focus within the renderer to avoid Windows focus loss after native dialogs.
 * Enhanced with better animations and visual styling.
 */
import { useEffect, useRef, useState } from 'react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { AlertCircle, AlertTriangle } from 'lucide-react';

interface ConfirmDialogProps {
  open: boolean;
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  variant?: 'default' | 'destructive';
  onConfirm: () => void | Promise<void>;
  onCancel: () => void;
  onError?: (error: unknown) => void;
}

export function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel = 'OK',
  cancelLabel = 'Cancel',
  variant = 'default',
  onConfirm,
  onCancel,
  onError,
}: ConfirmDialogProps) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  const [confirming, setConfirming] = useState(false);
  const [prevOpen, setPrevOpen] = useState(open);

  // Reset confirming when dialog closes (during render to avoid setState-in-effect)
  if (prevOpen !== open) {
    setPrevOpen(open);
    if (!open) {
      setConfirming(false);
    }
  }

  useEffect(() => {
    if (open && cancelRef.current) {
      cancelRef.current.focus();
    }
  }, [open]);

  if (!open) return null;

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape' && !confirming) {
      e.preventDefault();
      onCancel();
    }
  };

  const handleConfirm = () => {
    if (confirming) return;
    const result = onConfirm();
    if (result instanceof Promise) {
      setConfirming(true);
      result.catch((error) => {
        if (onError) {
          onError(error);
        }
      }).finally(() => {
        setConfirming(false);
      });
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm animate-in fade-in duration-200"
      role="dialog"
      aria-modal="true"
      aria-labelledby="confirm-dialog-title"
      onKeyDown={handleKeyDown}
      onClick={(e) => {
        if (e.target === e.currentTarget && !confirming) {
          onCancel();
        }
      }}
    >
      <div
        className={cn(
          'mx-4 w-full max-w-md rounded-xl border bg-card p-6 shadow-2xl',
          'focus:outline-none animate-in zoom-in-95 duration-200',
          'dark:border-border/50'
        )}
        tabIndex={-1}
      >
        <div className="flex items-start gap-4">
          {variant === 'destructive' ? (
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-destructive/10">
              <AlertTriangle className="h-5 w-5 text-destructive" />
            </div>
          ) : (
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-primary/10">
              <AlertCircle className="h-5 w-5 text-primary" />
            </div>
          )}
          <div className="flex-1 space-y-2">
            <h2 id="confirm-dialog-title" className="text-lg font-semibold leading-tight">
              {title}
            </h2>
            <p className="text-sm text-muted-foreground leading-relaxed">{message}</p>
          </div>
        </div>
        <div className="mt-6 flex justify-end gap-3">
          <Button
            ref={cancelRef}
            variant="outline"
            onClick={onCancel}
            disabled={confirming}
            className="min-w-[80px]"
          >
            {cancelLabel}
          </Button>
          <Button
            variant={variant === 'destructive' ? 'destructive' : 'default'}
            onClick={handleConfirm}
            disabled={confirming}
            className="min-w-[80px]"
          >
            {confirming ? 'Processing...' : confirmLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}
