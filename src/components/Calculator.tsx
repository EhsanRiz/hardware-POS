import { useEffect, useState } from "react";

// A pop-up calculator for the top bar — lets staff/admin work out tip amounts or
// do quick sums without leaving the POS. Shows the running calculation, takes
// keyboard input, and is closed with the ✕ in the top-right corner. It floats
// (no full-screen backdrop) so the till stays visible behind it.
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

export default function Calculator({ onClose }: { onClose: () => void }) {
  const [display, setDisplay] = useState("0");
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
      op: "bg-brand-light text-brand-dark font-semibold active:bg-brand/20",
      fn: "bg-stone-200 text-stone-700 active:bg-stone-300",
      eq: "bg-brand text-white font-semibold active:bg-brand-dark",
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
    <div className="fixed top-16 right-4 z-[70] w-80 max-w-[calc(100vw-2rem)] bg-white rounded-2xl shadow-2xl border border-stone-200 animate-scale-in">
      <div className="flex items-center justify-between px-4 h-12 border-b border-stone-100">
        <span className="font-semibold text-stone-800">Calculator</span>
        <button
          onClick={onClose}
          aria-label="Close calculator"
          className="w-9 h-9 rounded-full flex items-center justify-center text-stone-500 hover:bg-stone-100 active:bg-stone-200 text-xl leading-none"
        >
          ✕
        </button>
      </div>

      <div className="p-3">
        <div className="mb-3 rounded-xl bg-stone-50 border border-stone-200 px-3 py-2 text-right">
          <div className="h-5 text-sm text-stone-400 truncate">
            {history || " "}
          </div>
          <div className="text-4xl font-semibold text-stone-900 leading-tight overflow-x-auto whitespace-nowrap">
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
