"use client";
import { keyLabel } from "@/lib/layout";
import type { MouseMode } from "@/lib/mouseModes";
import { FLUIDITY_PROFILES, VIDEO_MODES } from "@/lib/protocol";
import type { FluidityProfile, NavAction, RotateMode, VideoMode } from "@/lib/protocol";
import { linkText } from "@/lib/linkProbe";
import type { LinkSummary } from "@/lib/linkProbe";

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
  /** Perfil de fluidez escolhido (salvo no navegador). */
  fluidity: FluidityProfile;
  onFluidity: (p: FluidityProfile) => void;
  /**
   * O que o celular respondeu: perfil aplicado (app 0.3.3+), "pending" (pedido, sem resposta ainda), "old" (app sem
   * perfis) ou null (sem conexão).
   */
  phoneFluidity: { profile: FluidityProfile; frameMs: number } | "pending" | "old" | null;
  /** Medição do enlace (ping/pong); null = sem conexão ou app antigo. */
  link: LinkSummary | null;
  /**
   * Latência do vídeo (modo USB, site 0.3.4): perfil, linha de métricas, teste de 1 clique e diagnóstico copiável.
   * Ausente fora do modo USB.
   */
  video?: {
    mode: VideoMode;
    onMode: (m: VideoMode) => void;
    /** "Vídeo: idade na tela 52/70 ms · …" (ou "Vídeo: —"). */
    line: string;
    flash: { state: "idle" | "running" | "done" | "error"; text: string };
    onFlash: () => void;
    onCopyDiag: () => void;
    /** Resultado do último "Copiar diagnóstico" (texto curto). */
    copyNote: string;
  };
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

      <Group label="Fluidez">
        <select
          aria-label="Fluidez"
          data-testid="fluidity-select"
          className="rounded-md border border-zinc-700 bg-zinc-800 p-1"
          value={p.fluidity}
          title={FLUIDITY_PROFILES.find((f) => f.id === p.fluidity)?.hint}
          onChange={(e) => p.onFluidity(e.target.value as FluidityProfile)}
        >
          {FLUIDITY_PROFILES.map((f) => (
            <option key={f.id} value={f.id} title={f.hint}>
              {f.label}
            </option>
          ))}
        </select>
        {p.phoneFluidity && (
          <span
            data-testid="fluidity-status"
            data-state={typeof p.phoneFluidity === "string" ? p.phoneFluidity : p.phoneFluidity.profile}
            className="whitespace-nowrap text-[11px] text-zinc-400"
            title="Perfil que o app do celular confirmou (Diagnóstico de toque no app mostra as latências medidas lá)"
          >
            {p.phoneFluidity === "old"
              ? "app sem perfis (atualize p/ 0.3.3)"
              : p.phoneFluidity === "pending"
                ? "aplicando…"
                : `✔ no celular${p.phoneFluidity.frameMs ? ` · quadro ${p.phoneFluidity.frameMs} ms` : ""}`}
          </span>
        )}
      </Group>

      {p.video && (
        <Group label="Vídeo">
          <select
            aria-label="Perfil de vídeo"
            data-testid="video-mode"
            className="rounded-md border border-zinc-700 bg-zinc-800 p-1"
            value={p.video.mode}
            title={VIDEO_MODES.find((m) => m.id === p.video!.mode)?.hint}
            onChange={(e) => p.video!.onMode(e.target.value as VideoMode)}
          >
            {VIDEO_MODES.map((m) => (
              <option key={m.id} value={m.id} title={m.hint}>
                {m.label}
              </option>
            ))}
          </select>
          <button
            className={btn}
            data-testid="flash-btn"
            disabled={p.video.flash.state === "running"}
            onClick={p.video.onFlash}
            title="O app pisca um quadrado no canto da tela (exige acessibilidade ligada) e o site mede quanto tempo o pulso leva até aparecer no vídeo"
          >
            {p.video.flash.state === "running" ? "Medindo…" : "Medir latência do vídeo"}
          </button>
          <button className={btn} data-testid="copy-diag" onClick={p.video.onCopyDiag} title="Copia todas as métricas (entrada, vídeo, perfis, versões) para colar numa conversa">
            Copiar diagnóstico
          </button>
          {p.video.copyNote && (
            <span data-testid="copy-note" className="whitespace-nowrap text-[11px] text-zinc-400">
              {p.video.copyNote}
            </span>
          )}
        </Group>
      )}

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
        {p.connectionOk && p.canControl && (
          <span
            data-testid="link-stats"
            className="shrink-0 whitespace-nowrap rounded bg-zinc-900 px-2 py-0.5 font-mono text-[11px] text-zinc-400"
            title="Ping a cada 1 s (últimos 20). tecla→celular ≈ RTT/2 + tempo do app; celular→toque = espera medida no celular até o dispatchGesture (mediana). Sem resposta = app antigo."
          >
            {linkText(p.link)}
          </span>
        )}
        {p.video && (
          <span
            data-testid="video-stats"
            className="min-w-0 shrink truncate rounded bg-zinc-900 px-2 py-0.5 font-mono text-[11px] text-zinc-400"
            title="Idade do quadro no desenho = agora − offset de relógio − pts (captura no celular). cod. = captura+codificação no celular (mediana); cabo+dec. = cabo+fila+decodificação (mediana). Sem app 0.3.4 mostra —."
          >
            {p.video.line}
          </span>
        )}
        {p.video && p.video.flash.text && (
          <span
            data-testid="flash-result"
            data-state={p.video.flash.state}
            title={p.video.flash.text}
            className={`min-w-0 shrink truncate rounded px-2 py-0.5 text-[11px] ${p.video.flash.state === "error" ? "bg-rose-900 text-rose-100" : "bg-emerald-900 text-emerald-100"}`}
          >
            {p.video.flash.text}
          </span>
        )}
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
