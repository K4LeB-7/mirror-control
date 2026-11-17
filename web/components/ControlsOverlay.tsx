"use client";
import { useRef } from "react";
import { Layout, bindLabel, clamp01, controlBoxes, keyLabel } from "@/lib/layout";

type Props = {
  layout: Layout;
  /** Tamanho em px da área do vídeo (medida): os controles escalam com ela. */
  width: number;
  height: number;
  editing: boolean;
  show: boolean;
  opacity: number;
  locked: boolean;
  selected: string | null;
  /** Posicionando (novo botão ou "definir posição"): um clique no vídeo escolhe o ponto. */
  placing: boolean;
  onSelect: (id: string) => void;
  onMove: (id: string, x: number, y: number) => void;
  onPlace: (x: number, y: number) => void;
};

const MODE_MARK = { hold: "", toggle: " ⇄", tap: " •" } as const;

/**
 * Controles desenhados sobre o vídeo. Fora do editor não recebem cliques (o mouse livre toca o celular através
 * deles). No editor, cada controle pode ser selecionado e arrastado; o resto do vídeo continua interativo.
 */
export default function ControlsOverlay({
  layout, width, height, editing, show, opacity, locked, selected, placing, onSelect, onMove, onPlace,
}: Props) {
  const root = useRef<HTMLDivElement>(null);
  const drag = useRef<{ id: string; pointerId: number; moved: boolean } | null>(null);
  if (!width || !height) return null;
  if (!show && !editing) return null;

  const toPct = (e: React.PointerEvent | React.MouseEvent) => {
    const r = root.current!.getBoundingClientRect();
    return { x: clamp01((e.clientX - r.left) / r.width), y: clamp01((e.clientY - r.top) / r.height) };
  };

  const boxes = controlBoxes(layout, width, height);
  const byId = new Map(boxes.map((b) => [b.id, b]));

  const handlers = (id: string) =>
    editing && !placing
      ? {
          onPointerDown: (e: React.PointerEvent) => {
            if (e.button !== 0) return;
            e.stopPropagation();
            e.preventDefault();
            (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
            drag.current = { id, pointerId: e.pointerId, moved: false };
            onSelect(id);
          },
          onPointerMove: (e: React.PointerEvent) => {
            const d = drag.current;
            if (!d || d.id !== id || d.pointerId !== e.pointerId) return;
            d.moved = true;
            const p = toPct(e);
            onMove(id, p.x, p.y);
          },
          onPointerUp: () => {
            drag.current = null;
          },
          onPointerCancel: () => {
            drag.current = null;
          },
        }
      : {};

  const ring = (id: string) => (editing && selected === id ? "ring-2 ring-amber-300 ring-offset-1 ring-offset-black/40" : "");
  const style = (id: string): React.CSSProperties => {
    const r = byId.get(id)!.rect;
    return { left: r.left, top: r.top, width: r.width, height: r.height };
  };
  const font = (d: number) => Math.max(9, Math.min(15, d * 0.2));
  /** Fonte que faz o texto caber na largura do círculo (rótulos longos encolhem até 8 px). */
  const fit = (d: number, text: string) => Math.max(8, Math.min(15, d * 0.22, (d * 0.8) / (Math.max(1, text.length) * 0.62)));

  const j = layout.joystick;
  const joyBox = byId.get("joystick")!.rect;
  const lookBox = byId.get("look")!.rect;
  const showLook = editing || locked;

  return (
    <div
      ref={root}
      data-testid="controls-overlay"
      className={`absolute inset-0 select-none ${placing ? "cursor-crosshair" : ""}`}
      style={{ pointerEvents: placing ? "auto" : "none", opacity: editing ? 1 : opacity }}
      onClick={(e) => {
        if (!placing) return;
        e.stopPropagation();
        const p = toPct(e);
        onPlace(p.x, p.y);
      }}
    >
      {placing && (
        <div className="pointer-events-none absolute inset-x-0 top-2 mx-auto w-fit rounded bg-amber-400 px-2 py-1 text-xs font-semibold text-black shadow">
          Clique no vídeo para posicionar (Esc cancela)
        </div>
      )}

      {/* Joystick: círculo de verdade (largura = altura em px) */}
      <div
        data-control="joystick"
        data-testid="ctl-joystick"
        {...handlers("joystick")}
        className={`absolute flex items-center justify-center rounded-full border-2 border-white/60 bg-white/10 ${ring("joystick")} ${
          editing && !placing ? "pointer-events-auto cursor-move" : ""
        }`}
        style={style("joystick")}
        title={editing ? "Joystick — arraste para mover" : undefined}
      >
        <div className="absolute rounded-full border border-dashed border-white/40" style={{
          width: Math.max(8, (j.radius * 2 * Math.min(width, height))),
          height: Math.max(8, (j.radius * 2 * Math.min(width, height))),
        }} />
        <span className="relative font-semibold text-white drop-shadow" style={{ fontSize: font(joyBox.width * 0.6) }}>
          {keyLabel(j.up)}
          {keyLabel(j.left)}
          {keyLabel(j.down)}
          {keyLabel(j.right)}
        </span>
      </div>

      {/* Âncora da câmera (modo travado) */}
      {showLook && (
        <div
          data-control="look"
          data-testid="ctl-look"
          {...handlers("look")}
          className={`absolute flex items-center justify-center rounded-full border-2 border-dashed border-sky-300/80 bg-sky-400/10 text-sky-100 ${ring("look")} ${
            editing && !placing ? "pointer-events-auto cursor-move" : ""
          }`}
          style={{ ...style("look"), fontSize: font(lookBox.width) }}
          title={editing ? "Câmera (mouse travado) — arraste para mover" : undefined}
        >
          câmera
        </div>
      )}

      {layout.buttons.map((b) => {
        const r = byId.get(b.id)!.rect;
        return (
          <div
            key={b.id}
            data-control={b.id}
            data-testid={`ctl-${b.id}`}
            {...handlers(b.id)}
            className={`absolute flex flex-col items-center justify-center overflow-hidden rounded-full border-2 text-center leading-tight text-white ${
              b.bind ? "border-white/70 bg-white/15" : "border-red-300/80 bg-red-500/20"
            } ${ring(b.id)} ${editing && !placing ? "pointer-events-auto cursor-move" : ""}`}
            style={style(b.id)}
            title={editing ? `${b.label} — arraste para mover` : undefined}
          >
            <span className="max-w-full truncate px-0.5 font-semibold drop-shadow" style={{ fontSize: fit(r.width, b.label) }}>
              {b.label}
            </span>
            <span className="max-w-full truncate px-0.5 opacity-80" style={{ fontSize: fit(r.width, bindLabel(b.bind) + MODE_MARK[b.mode]) }}>
              {bindLabel(b.bind)}
              {MODE_MARK[b.mode]}
            </span>
          </div>
        );
      })}
    </div>
  );
}
