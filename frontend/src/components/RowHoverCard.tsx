import { useCallback, useEffect, useRef, useState } from "react";

const DELAY_MS = 400;
const WIDTH = 300;

type Fact = [string, string];
type Shown = { title: string; facts: Fact[]; x: number; y: number };

/** A card of facts beside the hovered table row, after a short pause. It only shows what the
 *  row already has; nothing is fetched. */
export function useRowHover() {
  const [shown, setShown] = useState<Shown | null>(null);
  const timer = useRef<number>();

  const hide = useCallback(() => {
    window.clearTimeout(timer.current);
    setShown(null);
  }, []);

  useEffect(() => {
    window.addEventListener("scroll", hide, true);
    return () => { window.removeEventListener("scroll", hide, true); window.clearTimeout(timer.current); };
  }, [hide]);

  const bind = (title: string, facts: () => Fact[]) => ({
    onMouseEnter: (e: React.MouseEvent<HTMLElement>) => {
      const rect = e.currentTarget.getBoundingClientRect();
      const x = e.clientX;
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setShown({ title, facts: facts(), x, y: rect.bottom }), DELAY_MS);
    },
    onMouseLeave: hide,
    onMouseDown: hide,
  });

  const card = shown && <HoverCard {...shown} />;
  return { bind, card, hide };
}

function HoverCard({ title, facts, x, y }: Shown) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: x + 12, top: y + 4 });
  useEffect(() => {
    // Keep it on screen: flip above the row when there's no room below.
    const h = ref.current?.offsetHeight ?? 0;
    const left = Math.max(8, Math.min(x + 12, window.innerWidth - WIDTH - 12));
    const top = y + 4 + h > window.innerHeight - 8 ? Math.max(8, y - h - 40) : y + 4;
    setPos({ left, top });
  }, [x, y]);
  return (
    <div ref={ref} role="tooltip" style={{
      position: "fixed", left: pos.left, top: pos.top, width: WIDTH, zIndex: 200, pointerEvents: "none",
      background: "#fff", border: "1px solid var(--gray-200)", borderRadius: "var(--radius)",
      boxShadow: "var(--shadow-lg)", padding: "10px 12px", fontSize: 12,
    }}>
      <div style={{ fontWeight: 600, color: "var(--gray-900)", marginBottom: 6, overflow: "hidden",
        textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{title}</div>
      <div style={{ display: "grid", gridTemplateColumns: "auto 1fr", gap: "3px 10px" }}>
        {facts.map(([k, v]) => (
          <div key={k} style={{ display: "contents" }}>
            <span style={{ color: "var(--gray-500)", whiteSpace: "nowrap" }}>{k}</span>
            <span style={{ color: "var(--gray-900)", wordBreak: "break-word" }}>{v}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
