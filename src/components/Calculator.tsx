import { useEffect, useRef, useState } from "react";

// A pop-up calculator for the top bar — lets staff/admin work out tip amounts or
// do quick sums without leaving the POS. Shows the running calculation, takes
// keyboard input, and is closed with the ✕ in the top-right corner. It floats
// (no full-screen backdrop) so the till stays visible behind it.
//
// It floats over the CART, top-left, and never over the money. It used to sit
// top-right, which is exactly where the totals and the tender panel are: the
// one thing a cashier must still see while tapping a sum is the total.
//
// And it can be moved: drag it by its title bar to wherever it is in the way
// least. Where it was put is remembered until the page reloads, so it does
// not spring back over the cart every time it is opened.
type Op = "+" | "-" | "×" | "÷";

function apply(a: number, b: number, op: Op): number {
  switch (op) {
    case "+":
      return a + b;
    case "-":
      return a - b;
    case "×":
      return a * b;
    case "÷":
      return b === 0 ? NaN : a / b;
  }
}

// Trim floating-point noise (e.g. 0.1 + 0.2) and keep the display readable.
function fmt(n: number): string {
  if (!Number.isFinite(n)) return "Error";
  return String(Math.round(n * 1e10) / 1e10);
}

type Pos = { x: number; y: number };
let lastPos: Pos | null = null;

const clamp = (n: number, lo: number, hi: number) => Math.min(Math.max(n, lo), Math.max(lo, hi));

export default function Calculator({ onClose }: { onClose: () => void }) {
  const [display, setDisplay] = useState("0");
  // Where it has been dragged to; null is its resting place over the cart.
  const [pos, setPos] = useState<Pos | null>(lastPos);
  const box = useRef<HTMLDivElement>(null);
  // The grip: how far into the title bar the pointer went down, so the panel
  // moves with the finger rather than jumping to it.
  const grip = useRef<{ dx: number; dy: number } | null>(null);

  const startDrag = (e: React.PointerEvent<HTMLDivElement>) => {
    if ((e.target as HTMLElement).closest("button")) return;
    const r = box.current?.getBoundingClientRect();
    if (!r) return;
    grip.current = { dx: e.clientX - r.left, dy: e.clientY - r.top };
    e.currentTarget.setPointerCapture(e.pointerId);
    e.preventDefault();
  };
  const moveDrag = (e: React.PointerEvent<HTMLDivElement>) => {
    const g = grip.current;
    const r = box.current?.getBoundingClientRect();
    if (!g || !r) return;
    // Kept on the screen: the title bar can always be reached again.
    const next = {
      x: clamp(e.clientX - g.dx, 0, window.innerWidth - r.width),
      y: clamp(e.clientY - g.dy, 0, window.innerHeight - 48),
    };
    lastPos = next;
    setPos(next);
  };
  const endDrag = () => {
    grip.current = null;
  };
  const [acc, setAcc] = useState<number | null>(null);
  const [op, setOp] = useState<Op | null>(null);
  // The calculation so far, shown above the current entry (e.g. "12 + 3").
  const [history, setHistory] = useState("");
  // True when the next digit should start a fresh number.
  const [fresh, setFresh] = useState(true);

  const inputDigit = (d: string) => {
    setDisplay((cur) => {
      if (fresh) return d;
      return cur === "0" ? d : cur + d;
    });
    setFresh(false);
  };

  const inputDot = () => {
    setDisplay((cur) => {
      if (fresh) return "0.";
      return cur.includes(".") ? cur : cur + ".";
    });
    setFresh(false);
  };

  const chooseOp = (next: Op) => {
    const cur = parseFloat(display);
    let base = cur;
    if (acc == null) {
      setAcc(cur);
    } else if (!fresh && op) {
      base = apply(acc, cur, op);
      setAcc(base);
      setDisplay(fmt(base));
    } else {
      base = acc;
    }
    setOp(next);
    setHistory(`${fmt(base)} ${next}`);
    setFresh(true);
  };

  const equals = () => {
    if (op != null && acc != null) {
      const cur = parseFloat(display);
      const r = apply(acc, cur, op);
      setHistory(`${fmt(acc)} ${op} ${fmt(cur)} =`);
      setDisplay(fmt(r));
      setAcc(null);
      setOp(null);
      setFresh(true);
    }
  };

  const clearAll = () => {
    setDisplay("0");
    setAcc(null);
    setOp(null);
    setHistory("");
    setFresh(true);
  };

  const backspace = () => {
    setDisplay((cur) => {
      if (fresh) return cur;
      const next = cur.slice(0, -1);
      return next === "" || next === "-" ? "0" : next;
    });
  };

  const percent = () => {
    setDisplay((cur) => fmt(parseFloat(cur) / 100));
    setFresh(true);
  };

  // Keyboard support — typing works just like tapping.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const k = e.key;
      if (k === "Escape") return onClose();
      if (k >= "0" && k <= "9") inputDigit(k);
      else if (k === ".") inputDot();
      else if (k === "+") chooseOp("+");
      else if (k === "-") chooseOp("-");
      else if (k === "*" || k === "x" || k === "X") chooseOp("×");
      else if (k === "/") chooseOp("÷");
      else if (k === "Enter" || k === "=") equals();
      else if (k === "Backspace") backspace();
      else if (k === "%") percent();
      else if (k === "c" || k === "C") clearAll();
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [display, acc, op, fresh]);

  const Btn = ({
    label,
    onClick,
    variant = "num",
    wide = false,
  }: {
    label: string;
    onClick: () => void;
    variant?: "num" | "op" | "fn" | "eq";
    wide?: boolean;
  }) => {
    const styles: Record<string, string> = {
      num: "bg-stone-100 text-stone-800 active:bg-stone-200",
      op: "bg-gold-100 text-gold-700 font-semibold active:bg-surface",
      fn: "bg-stone-200 text-stone-700 active:bg-stone-300",
      eq: "bg-gold-400 text-colophon font-semibold active:bg-gold",
    };
    return (
      <button
        onClick={onClick}
        className={`h-14 rounded-xl text-xl transition-transform active:scale-95 ${
          styles[variant]
        } ${wide ? "col-span-2" : ""}`}
      >
        {label}
      </button>
    );
  };

  return (
    <div
      ref={box}
      className={`fixed z-[70] w-80 max-w-[calc(100vw-2rem)] bg-white rounded-2xl shadow-2xl border border-stone-200 animate-scale-in${
        pos ? "" : " top-16 left-4"
      }`}
      style={pos ? { left: pos.x, top: pos.y } : undefined}
      data-testid="calculator"
      role="dialog"
      aria-label="Calculator"
    >
      <div
        className="flex items-center justify-between px-4 h-12 rounded-t-2xl bg-colophon cursor-move select-none touch-none"
        data-testid="calc-grip"
        onPointerDown={startDrag}
        onPointerMove={moveDrag}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
      >
        <span className="font-semibold text-paper">Calculator</span>
        <button
          onClick={onClose}
          aria-label="Close calculator"
          className="w-9 h-9 rounded-full flex items-center justify-center text-white/70 hover:bg-white/10 active:bg-white/20 text-xl leading-none"
        >
          ✕
        </button>
      </div>

      <div className="p-3">
        <div className="mb-3 rounded-xl bg-stone-50 border border-stone-200 px-3 py-2 text-right">
          <div className="h-5 text-sm text-stone-400 truncate">
            {history || " "}
          </div>
          <div
            data-testid="calc-display"
            className="text-4xl font-semibold text-stone-900 leading-tight overflow-x-auto whitespace-nowrap tabular-nums"
          >
            {display}
          </div>
        </div>

        <div className="grid grid-cols-4 gap-2">
          <Btn label="C" variant="fn" onClick={clearAll} />
          <Btn label="⌫" variant="fn" onClick={backspace} />
          <Btn label="%" variant="fn" onClick={percent} />
          <Btn label="÷" variant="op" onClick={() => chooseOp("÷")} />

          <Btn label="7" onClick={() => inputDigit("7")} />
          <Btn label="8" onClick={() => inputDigit("8")} />
          <Btn label="9" onClick={() => inputDigit("9")} />
          <Btn label="×" variant="op" onClick={() => chooseOp("×")} />

          <Btn label="4" onClick={() => inputDigit("4")} />
          <Btn label="5" onClick={() => inputDigit("5")} />
          <Btn label="6" onClick={() => inputDigit("6")} />
          <Btn label="-" variant="op" onClick={() => chooseOp("-")} />

          <Btn label="1" onClick={() => inputDigit("1")} />
          <Btn label="2" onClick={() => inputDigit("2")} />
          <Btn label="3" onClick={() => inputDigit("3")} />
          <Btn label="+" variant="op" onClick={() => chooseOp("+")} />

          <Btn label="0" wide onClick={() => inputDigit("0")} />
          <Btn label="." onClick={inputDot} />
          <Btn label="=" variant="eq" onClick={equals} />
        </div>
      </div>
    </div>
  );
}
