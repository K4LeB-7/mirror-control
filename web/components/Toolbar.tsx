"use client";
import { keyLabel } from "@/lib/layout";
import type { MouseMode } from "@/lib/mouseModes";
import type { NavAction, RotateMode } from "@/lib/protocol";

type Props = {
  /** Texto curto da conexão, ex.: "USB conectado". */
  connection: string;
  connectionOk: boolean;
  /** Aviso de reconexão (fica na 2ª linha da barra). */
  warning?: { text: string; testId?: string };
  /** Mensagem do celular (rotação/navegação) ou do site. */
  notice?: { text: string; ok: boolean };
  mode: MouseMode;
  requesting: boolean;
  toggleKey: string;
  onToggleMode: () => void;
  canControl: boolean;
  /** Na pré-visualização (sem celular) Retrato/Paisagem só trocam o layout editado. */
  canRotate: boolean;
  rotation: RotateMode | null;
  onRotate: (m: RotateMode) => void;
  onNav: (a: NavAction) => void;
  editing: boolean;
  onToggleEditor: () => void;
  showControls: boolean;
  onShowControls: (v: boolean) => void;
  quality: { height: number; fps: number };
  onQuality: (height: number, fps: number) => void;
  /** Botão de saída: "Sair do USB" / "Sair da pré-visualização". */
  exit?: { label: string; onClick: () => void };
};

/** Depois de um clique de MOUSE, o botão não fica com o foco: senão Espaço/Enter (teclas do jogo) o "clicariam". */
export function blurAfterMouseClick(e: React.MouseEvent) {
  const b = (e.target as Element).closest?.("button");
  if (b && e.detail > 0) (b as HTMLButtonElement).blur();
}

const btn =
  "whitespace-nowrap rounded-md border border-zinc-700 bg-zinc-800 px-2 py-1 hover:bg-zinc-700 disabled:cursor-not-allowed disabled:opacity-40";
const on = "border-sky-400 bg-sky-700 hover:bg-sky-600";

function Group({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-1" role="group" aria-label={label}>
      <span className="mr-0.5 hidden text-[10px] uppercase tracking-wider text-zinc-500 lg:inline">{label}</span>
      {children}
    </div>
  );
}

/** Barra própria, ACIMA do vídeo (nunca sobre a imagem). Quebra em várias linhas em janelas estreitas. */
export default function Toolbar(p: Props) {
  const locked = p.mode === "locked";
  const tk = keyLabel(p.toggleKey);
  return (
    <header
      data-testid="toolbar"
      onClick={blurAfterMouseClick}
      className="z-10 flex shrink-0 flex-wrap items-center gap-x-4 gap-y-2 border-b border-zinc-800 bg-zinc-950 px-3 py-2 text-xs text-zinc-200"
    >
      <div className="flex items-center gap-2">
        <span className="whitespace-nowrap font-semibold">Mirror Control</span>
        <span
          className={`whitespace-nowrap rounded-full px-2 py-0.5 ${p.connectionOk ? "bg-emerald-900 text-emerald-200" : "bg-amber-900 text-amber-100"}`}
        >
          {p.connection}
        </span>
      </div>

      <Group label="Mouse">
        <span
          data-testid="mouse-mode"
          data-mode={p.mode}
          className={`whitespace-nowrap rounded-full px-2 py-0.5 font-semibold ${locked ? "bg-rose-700 text-white" : "bg-emerald-700 text-white"}`}
          title={
            locked
              ? "Mouse travado: movimento = câmera, botões = controles mapeados. Esc solta."
              : "Mouse livre: clique/arraste = toque, roda = rolar, botão direito = Voltar."
          }
        >
          {locked ? `Mouse travado · Esc solta` : `Mouse livre · ${tk} trava`}
        </span>
        <button className={btn} onClick={p.onToggleMode} disabled={!p.canControl || p.requesting} data-testid="mouse-toggle">
          {locked ? `Soltar mouse (${tk})` : p.requesting ? "Travando…" : `Travar mouse (${tk})`}
        </button>
      </Group>

      <Group label="Tela">
        {(
          [
            ["portrait", "Retrato"],
            ["landscape", "Paisagem"],
            ["auto", "Auto"],
          ] as [RotateMode, string][]
        ).map(([m, label]) => (
          <button
            key={m}
            className={`${btn} ${p.rotation === m ? on : ""}`}
            aria-pressed={p.rotation === m}
            disabled={!p.canRotate}
            onClick={() => p.onRotate(m)}
            title={m === "auto" ? "Volta a girar pelo sensor do celular" : `Gira o celular para ${label.toLowerCase()}`}
          >
            {label}
          </button>
        ))}
      </Group>

      <Group label="Android">
        <button className={btn} disabled={!p.canControl} onClick={() => p.onNav("back")} title="Voltar (botão direito do mouse no modo livre)">
          ◁ Voltar
        </button>
        <button className={btn} disabled={!p.canControl} onClick={() => p.onNav("home")} title="Tela inicial">
          ○ Início
        </button>
        <button className={btn} disabled={!p.canControl} onClick={() => p.onNav("recents")} title="Apps recentes">
          ▢ Recentes
        </button>
      </Group>

      <Group label="Controles">
        <button className={`${btn} ${p.editing ? on : ""}`} aria-pressed={p.editing} onClick={p.onToggleEditor} data-testid="mapper-toggle">
          {p.editing ? "Fechar mapeador" : "Mapear"}
        </button>
        <label className="flex cursor-pointer items-center gap-1 whitespace-nowrap">
          <input type="checkbox" checked={p.showControls} onChange={(e) => p.onShowControls(e.target.checked)} />
          Mostrar controles
        </label>
      </Group>

      <div className="flex items-center gap-2">
        <select
          aria-label="Qualidade"
          className="rounded-md border border-zinc-700 bg-zinc-800 p-1"
          value={`${p.quality.height}p${p.quality.fps}`}
          onChange={(e) => {
            const m = /(\d+)p(\d+)/.exec(e.target.value)!;
            p.onQuality(Number(m[1]), Number(m[2]));
          }}
        >
          {[720, 1080].flatMap((h) =>
            [30, 60].map((f) => (
              <option key={`${h}${f}`} value={`${h}p${f}`}>
                {h}p {f}fps
              </option>
            ))
          )}
        </select>
        {p.exit && (
          <button className={btn} onClick={p.exit.onClick}>
            {p.exit.label}
          </button>
        )}
      </div>

      {/* Linha de status sempre presente (altura fixa): avisos não empurram o vídeo. */}
      <div className="flex h-5 w-full min-w-0 items-center gap-2 overflow-hidden" data-testid="status-line">
        {p.warning && (
          <span data-testid={p.warning.testId} className="shrink-0 truncate rounded bg-amber-700 px-2 py-0.5 text-white">
            {p.warning.text}
          </span>
        )}
        {p.notice ? (
          <span
            data-testid="phone-notice"
            title={p.notice.text}
            className={`min-w-0 truncate rounded px-2 py-0.5 ${p.notice.ok ? "bg-zinc-800 text-zinc-200" : "bg-rose-900 text-rose-100"}`}
          >
            {p.notice.text}
          </span>
        ) : (
          <span className="min-w-0 truncate text-zinc-500">
            {locked
              ? `Movimento = câmera · botões/roda = controles mapeados · Esc ou ${tk} soltam o mouse`
              : `Clique/arraste no vídeo = toque · roda = rolar · botão direito = Voltar · ${tk} trava o mouse para jogar`}
          </span>
        )}
      </div>
    </header>
  );
}
