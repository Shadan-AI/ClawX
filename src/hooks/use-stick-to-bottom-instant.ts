import { useEffect, useRef } from "react";
import { useStickToBottom } from "use-stick-to-bottom";

/**
 * A wrapper around useStickToBottom that ensures the initial scroll
 * to bottom happens instantly without any visible animation.
 *
 * Enhanced with better performance and smoother behavior for streaming messages.
 *
 * @param resetKey - When this key changes, the scroll position will be reset to bottom instantly.
 *                   Typically this should be the conversation ID.
 */
export function useStickToBottomInstant(resetKey?: string) {
  const lastKeyRef = useRef(resetKey);
  const hasInitializedRef = useRef(false);
  const scrollTimeoutRef = useRef<number | null>(null);

  const result = useStickToBottom({
    initial: "instant",
    resize: "instant", // Changed from "smooth" to "instant" for better streaming experience
  });

  const { scrollRef } = result;

  // Reset initialization when key changes
  useEffect(() => {
    if (resetKey !== lastKeyRef.current) {
      hasInitializedRef.current = false;
      lastKeyRef.current = resetKey;
    }
  }, [resetKey]);

  // Scroll to bottom instantly on mount or when key changes
  useEffect(() => {
    if (hasInitializedRef.current) return;

    const scrollElement = scrollRef.current;
    if (!scrollElement) return;

    // Clear any pending scroll timeout
    if (scrollTimeoutRef.current !== null) {
      clearTimeout(scrollTimeoutRef.current);
      scrollTimeoutRef.current = null;
    }

    // Hide, scroll, reveal pattern to avoid visible animation
    scrollElement.style.visibility = "hidden";

    // Use double RAF to ensure content is rendered
    const frame1 = requestAnimationFrame(() => {
      const frame2 = requestAnimationFrame(() => {
        // Direct scroll to bottom
        scrollElement.scrollTop = scrollElement.scrollHeight;

        // Small delay to ensure scroll is applied
        scrollTimeoutRef.current = window.setTimeout(() => {
          scrollElement.style.visibility = "";
          hasInitializedRef.current = true;
          scrollTimeoutRef.current = null;
        }, 0);
      });
      
      // Cleanup for frame2 is not needed here as it's already executed
      void frame2;
    });

    return () => {
      cancelAnimationFrame(frame1);
      if (scrollTimeoutRef.current !== null) {
        clearTimeout(scrollTimeoutRef.current);
        scrollTimeoutRef.current = null;
      }
    };
  }, [scrollRef, resetKey]);

  return result;
}
