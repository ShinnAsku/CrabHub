import { useState, useRef } from "react";

interface TooltipProps {
  content: string;
  children: React.ReactNode;
  delay?: number;
}

/** Custom tooltip — soft rounded corners, subtle shadow, compact text. */
export function Tooltip({ content, children, delay = 400 }: TooltipProps) {
  const [show, setShow] = useState(false);
  const timer = useRef<number | null>(null);

  const onEnter = () => {
    timer.current = window.setTimeout(() => setShow(true), delay);
  };
  const onLeave = () => {
    if (timer.current != null) window.clearTimeout(timer.current);
    setShow(false);
  };

  return (
    <div className="relative inline-block" onMouseEnter={onEnter} onMouseLeave={onLeave}>
      {children}
      {show && (
        <div
          className="absolute z-50 bottom-full left-1/2 -translate-x-1/2 mb-1 px-2 py-1 text-[11px] leading-relaxed text-white rounded-lg shadow-md whitespace-nowrap max-w-[360px]"
          style={{ backgroundColor: "hsl(var(--tab-active))", pointerEvents: "none" }}
        >
          {content}
        </div>
      )}
    </div>
  );
}
