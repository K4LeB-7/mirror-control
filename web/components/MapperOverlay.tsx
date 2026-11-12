"use client";
import { useRef, useState } from "react";
import { Layout, MAX_BUTTONS, TapButton, keyLabel } from "@/lib/layout";

type Props = {
  layout: Layout;
  editing: boolean;
  onChange: (l: Layout) => void;
};

type Target = { kind: "btn"; id: string } | { kind: "joy" } | { kind: "look" };

/**
 * Overlay sobre o vídeo. As posições são salvas em % da tela do celular, então
 * o mapeamento vale para qualquer proporção. Em modo de edição os itens podem
 * ser arrastados; clicar em um botão e apertar uma tecla/mouse o reatribui.
 */
export default function MapperOverlay({ layout, editing, onChange }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const drag = useRef<Target | null>(null);
  const [binding, setBinding] = useState<string | null>(null);

  const toPct = (e: React.PointerEvent) => {
    const r = ref.current!.getBoundingClientRect();
    return {
      x: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)),
      y: Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)),
    };
  };

  const move = (e: React.PointerEvent) => {
    const t = drag.current;
    if (!t) return;
    const { x, y } = toPct(e);
    if (t.kind === "joy") onChange({ ...layout, joystick: { ...layout.joystick, x, y } });
    else if (t.kind === "look") onChange({ ...layout, look: { ...layout.look, x, y } });
    else
      onChange({
        ...layout,
        buttons: layout.buttons.map((b) => (b.id === t.id ? { ...b, x, y } : b)),
      });
  };

  const startDrag = (t: Target) => (e: React.PointerEvent) => {
    if (!editing) return;
    e.stopPropagation();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    drag.current = t;
  };

  const rebind = (b: TapButton, e: React.KeyboardEvent | React.MouseEvent) => {
    e.preventDefault();
    const next: TapButton = { ...b };
    if ("code" in e) {
      next.key = e.code;
      next.mouse = undefined;
    } else {
      next.mouse = e.button;
      next.key = undefined;
    }
    onChange({ ...layout, buttons: layout.buttons.map((x) => (x.id === b.id ? next : x)) });
    setBinding(null);
  };

  const pos = (x: number, y: number): React.CSSProperties => ({
    left: `${x * 100}%`,
    top: `${y * 100}%`,
    transform: "translate(-50%, -50%)",
  });

  const j = layout.joystick;
  const mouseNames = ["Mouse E", "Mouse M", "Mouse D"];

  return (
    <div
      ref={ref}
      className={`absolute inset-0 ${editing ? "bg-black/40" : "pointer-events-none"}`}
      onPointerMove={move}
      onPointerUp={() => (drag.current = null)}
    >
      {/* Joystick (WASD) */}
      <div
        onPointerDown={startDrag({ kind: "joy" })}
        className={`absolute flex items-center justify-center rounded-full border-2 border-white/40 bg-white/10 text-xs ${editing ? "cursor-move" : ""}`}
        style={{ ...pos(j.x, j.y), width: `${j.radius * 2 * 100}vh`, height: `${j.radius * 2 * 100}vh`, maxWidth: "40%", aspectRatio: "1" }}
      >
        <span className="opacity-70">
          {keyLabel(j.up)}{keyLabel(j.left)}{keyLabel(j.down)}{keyLabel(j.right)}
        </span>
      </div>

      {/* Âncora da câmera */}
      <div
        onPointerDown={startDrag({ kind: "look" })}
        className={`absolute rounded-full border-2 border-dashed border-sky-300/60 px-3 py-2 text-xs text-sky-200 ${editing ? "cursor-move" : ""}`}
        style={pos(layout.look.x, layout.look.y)}
      >
        câmera
      </div>

      {layout.buttons.map((b) => (
        <button
          key={b.id}
          tabIndex={-1}
          onPointerDown={startDrag({ kind: "btn", id: b.id })}
          onClick={() => editing && setBinding(b.id)}
          onKeyDown={(e) => binding === b.id && rebind(b, e)}
          onMouseDown={(e) => binding === b.id && e.button !== 0 && rebind(b, e)}
          className={`absolute h-14 w-14 rounded-full border-2 text-[10px] leading-tight ${
            binding === b.id ? "border-amber-300 bg-amber-300/30" : "border-white/50 bg-white/15"
          } ${editing ? "pointer-events-auto cursor-move" : ""}`}
          style={pos(b.x, b.y)}
        >
          <div>{b.label}</div>
          <div className="opacity-70">
            {binding === b.id ? "…" : b.key ? keyLabel(b.key) : b.mouse !== undefined ? mouseNames[b.mouse] : "—"}
          </div>
        </button>
      ))}

      {editing && (
        <div className="pointer-events-auto absolute left-1/2 top-3 flex -translate-x-1/2 gap-2 rounded bg-zinc-900/90 p-2 text-xs">
          <span className="self-center text-zinc-300">
            Arraste • clique num botão e aperte tecla/mouse para reatribuir
          </span>
          <button
            className="rounded bg-zinc-700 px-2 py-1 disabled:opacity-40"
            disabled={layout.buttons.length >= MAX_BUTTONS}
            onClick={() =>
              onChange({
                ...layout,
                buttons: [
                  ...layout.buttons,
                  { id: `b${Date.now()}`, label: "Novo", x: 0.5, y: 0.5 },
                ],
              })
            }
          >
            + Botão
          </button>
          {binding && (
            <button
              className="rounded bg-red-800 px-2 py-1"
              onClick={() => {
                onChange({ ...layout, buttons: layout.buttons.filter((b) => b.id !== binding) });
                setBinding(null);
              }}
            >
              Excluir
            </button>
          )}
        </div>
      )}
    </div>
  );
}
