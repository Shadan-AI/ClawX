/**
 * Main Layout Component
 * TitleBar at top, then sidebar + resize handle + content below.
 */
import { useCallback, useEffect, useState } from 'react';
import { useLocation, useOutlet } from 'react-router-dom';
import { Sidebar } from './Sidebar';
import { TitleBar } from './TitleBar';
import { Chat } from '@/pages/Chat';
import { useSettingsStore } from '@/stores/settings';
import { cn } from '@/lib/utils';

export function MainLayout() {
  const location = useLocation();
  const outlet = useOutlet();
  const isChatRoute = location.pathname === '/';
  const [hasMountedChat, setHasMountedChat] = useState(isChatRoute);

  useEffect(() => {
    if (isChatRoute) {
      setHasMountedChat(true);
    }
  }, [isChatRoute]);

  return (
    <div data-testid="main-layout" className="flex h-screen flex-col overflow-hidden bg-background">
      <TitleBar />
      <div className="flex min-h-0 min-w-0 flex-1 overflow-hidden">
        <Sidebar />
        <ResizeHandle />
        <main data-testid="main-content" className="relative min-h-0 min-w-0 flex-1 overflow-hidden">
          {hasMountedChat ? (
            <div
              className={cn(
                'absolute inset-0 h-full min-h-0 overflow-hidden',
                isChatRoute ? 'block' : 'hidden',
              )}
            >
              <Chat />
            </div>
          ) : null}
          {!isChatRoute ? (
            <div
              key={location.pathname}
              className="h-full min-h-0 overflow-auto p-6"
            >
              {outlet}
            </div>
          ) : null}
        </main>
      </div>
    </div>
  );
}

function ResizeHandle() {
  const sidebarCollapsed = useSettingsStore((s) => s.sidebarCollapsed);
  const sidebarWidth = useSettingsStore((s) => s.sidebarWidth);
  const setSidebarWidth = useSettingsStore((s) => s.setSidebarWidth);
  const [dragging, setDragging] = useState(false);
  const [hovering, setHovering] = useState(false);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    if (sidebarCollapsed) return;
    e.preventDefault();
    setDragging(true);

    const startX = e.clientX;
    const startWidth = Number.isFinite(sidebarWidth)
      ? Math.max(64, Math.min(480, Math.round(sidebarWidth)))
      : 256;

    const onMouseMove = (ev: MouseEvent) => {
      setSidebarWidth(startWidth + ev.clientX - startX);
    };

    const onMouseUp = () => {
      setDragging(false);
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };

    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  }, [sidebarCollapsed, sidebarWidth, setSidebarWidth]);

  if (sidebarCollapsed) return null;

  const showLine = hovering || dragging;

  return (
    <div
      className="relative z-10 shrink-0 flex items-center justify-center"
      style={{ width: 11, cursor: 'col-resize' }}
      onMouseDown={handleMouseDown}
      onMouseEnter={() => setHovering(true)}
      onMouseLeave={() => setHovering(false)}
    >
      {/* 2px vertical line on hover/drag - aligned with dots at left edge */}
      <div
        className={cn(
          'absolute inset-y-0 left-0 w-[2px] transition-colors duration-150',
          dragging ? 'bg-primary/50' : showLine ? 'bg-foreground/12' : 'bg-transparent',
        )}
      />
      {/* Three-dot handle - at left edge (sidebar border) */}
      <div className="absolute left-0 top-1/2 -translate-y-1/2 flex flex-col items-center gap-[3px]">
        <span className="block h-[3px] w-[3px] rounded-full bg-muted-foreground/40" />
        <span className="block h-[3px] w-[3px] rounded-full bg-muted-foreground/40" />
        <span className="block h-[3px] w-[3px] rounded-full bg-muted-foreground/40" />
      </div>
    </div>
  );
}
