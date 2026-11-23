"use client";
import { memo, useEffect, useRef, useState } from "react";
import { blurAfterMouseClick } from "./Toolbar";
import {
  BUTTON_SIZE,
  ButtonControl,
  ButtonMode,
  JOY_RADIUS,
  JOY_SIZE,
  Layout,
  MAX_BUTTONS,
  Orientation,
  bindLabel,
  controlCount,
  keyLabel,
} from "@/lib/layout";
import {
  ProfileStore,
  UiSettings,
  activeProfile,
  createProfile,
  deleteProfile,
  describeConflict,
  duplicateProfile,
  exportProfile,
  findConflicts,
  importProfileWithReport,
  renameProfile,
  reservedBinds,
  selectProfile,
} from "@/lib/profiles";
import { MAX_SIMULTANEOUS_BUTTONS } from "@/lib/pointerPool";

export type JoyDir = "up" | "down" | "left" | "right";
/** O que está esperando "pressione uma tecla ou botão do mouse". */
export type CaptureTarget = { kind: "btn"; id: string } | { kind: "joy"; dir: JoyDir } | { kind: "toggle" };
/** Posicionar clicando no vídeo: botão novo ou um controle existente. */
export type Placing = { kind: "new" } | { kind: "move"; id: string };

type Props = {
  store: ProfileStore;
  orientation: Orientation;
  layout: Layout;
  settings: UiSettings;
  selected: string | null;
  capture: CaptureTarget | null;
  placing: Placing | null;
  showGuide: boolean;
  onSelect: (id: string | null) => void;
  onCapture: (t: CaptureTarget | null) => void;
  onPlacing: (p: Placing | null) => void;
  onStore: (s: ProfileStore) => void;
  onLayout: (f: (l: Layout) => Layout) => void;
  onSettings: (s: UiSettings) => void;
  onReset: () => void;
  /** Exclui qualquer controle (botão, joystick, câmera). */
  onRemove: (id: string) => void;
  /** Adiciona de volta o joystick/câmera removidos. */
  onRestore: (id: "joystick" | "look") => void;
  /** Layout vazio (começar do zero). */
  onClear: () => void;
  /** Texto da última exclusão/limpeza/restauração que pode ser desfeita (null = nada a desfazer). */
  undoLabel: string | null;
  onUndo: () => void;
  onClose: () => void;
};

const btn =
  "whitespace-nowrap rounded-md border border-zinc-700 bg-zinc-800 px-2 py-1 hover:bg-zinc-700 disabled:cursor-not-allowed disabled:opacity-40";
const field = "w-full rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1";
const ORIENT = { portrait: "Retrato", landscape: "Paisagem" } as const;
const MODE_TEXT: Record<ButtonMode, string> = { hold: "Segurar", toggle: "Alternar (liga/desliga)", tap: "Toque rápido" };
const MODE_MARK: Record<ButtonMode, string> = { hold: "", toggle: " ⇄", tap: " •" };
const DIRS: [JoyDir, string][] = [
  ["up", "↑ Cima"],
  ["left", "← Esq."],
  ["down", "↓ Baixo"],
  ["right", "→ Dir."],
];

function Section({ title, children, testId }: { title: string; children: React.ReactNode; testId?: string }) {
  return (
    <section data-testid={testId} className="border-b border-zinc-800 px-3 py-3">
      <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-zinc-400">{title}</h3>
      {children}
    </section>
  );
}

function Range(props: { label: string; value: number; min: number; max: number; step: number; onChange: (v: number) => void; fmt?: (v: number) => string; testId?: string }) {
  return (
    <label className="mb-2 block">
      <span className="flex justify-between text-zinc-400">
        <span>{props.label}</span>
        <span className="tabular-nums text-zinc-300">{props.fmt ? props.fmt(props.value) : props.value.toFixed(2)}</span>
      </span>
      <input
        data-testid={props.testId}
        type="range"
        className="w-full"
        min={props.min}
        max={props.max}
        step={props.step}
        value={props.value}
        onChange={(e) => props.onChange(Number(e.target.value))}
      />
    </label>
  );
}

/** Painel lateral do mapeador (fica ao lado do vídeo, que continua ao vivo e interativo). */
export default memo(function MapperPanel(p: Props) {
  const prof = activeProfile(p.store);
  const l = p.layout;
  const [msg, setMsg] = useState<{ text: string; ok: boolean } | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [pasting, setPasting] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const rootRef = useRef<HTMLElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  // Com até 22 controles a lista rola sozinha: o selecionado (no vídeo ou na lista) fica visível nela, e o editor
  // dele (abaixo da lista) entra na área visível do painel.
  useEffect(() => {
    const id = p.selected;
    const ul = listRef.current;
    if (!id || !ul) return;
    const li = [...ul.children].find((c) => c.querySelector(`[data-testid="list-${CSS.escape(id)}"]`)) as HTMLElement | undefined;
    if (li) {
      if (li.offsetTop < ul.scrollTop) ul.scrollTop = li.offsetTop;
      else if (li.offsetTop + li.offsetHeight > ul.scrollTop + ul.clientHeight) ul.scrollTop = li.offsetTop + li.offsetHeight - ul.clientHeight;
    }
    const ed = rootRef.current?.querySelector('[data-testid="button-editor"], [data-testid="joystick-editor"], [data-testid="look-editor"]');
    ed?.scrollIntoView?.({ block: "nearest" });
  }, [p.selected]);

  const conflicts = findConflicts(l, reservedBinds(p.settings.toggleKey));
  const conflictBinds = new Set(conflicts.map((c) => c.bind));
  const sel = p.selected;
  const selBtn = l.buttons.find((b) => b.id === sel);
  const full = l.buttons.length >= MAX_BUTTONS;

  const say = (text: string, ok = true) => setMsg({ text, ok });
  const doImport = (text: string) => {
    try {
      const r = importProfileWithReport(p.store, text);
      p.onStore(r.store);
      if (r.warnings.length) say(`Perfil importado e ativado. ${r.warnings.join(" ")}`, false);
      else say("Perfil importado e ativado.");
      setPasting(null);
    } catch (e) {
      say(e instanceof Error ? e.message : String(e), false);
    }
  };
  const updBtn = (id: string, patch: Partial<ButtonControl>) =>
    p.onLayout((x) => ({ ...x, buttons: x.buttons.map((b) => (b.id === id ? { ...b, ...patch } : b)) }));

  const captureBtn = (t: CaptureTarget, current: string, testId: string) => {
    const active =
      p.capture &&
      p.capture.kind === t.kind &&
      (t.kind === "btn" ? p.capture.kind === "btn" && p.capture.id === t.id : t.kind === "joy" ? p.capture.kind === "joy" && p.capture.dir === t.dir : true);
    return (
      <button
        data-testid={testId}
        className={`${btn} min-w-[4.5rem] ${active ? "animate-pulse border-amber-300 bg-amber-700" : ""}`}
        onClick={() => p.onCapture(active ? null : t)}
        title="Clique e pressione a tecla (ou botão do mouse / roda) desejada"
      >
        {active ? "Pressione…" : current || "—"}
      </button>
    );
  };

  return (
    <aside
      ref={rootRef}
      data-testid="mapper-panel"
      onClick={blurAfterMouseClick}
      className="flex max-h-[45vh] w-full shrink-0 flex-col overflow-hidden border-t border-zinc-800 bg-zinc-950 text-xs text-zinc-200 md:max-h-none md:w-[340px] md:border-l md:border-t-0"
    >
      <div className="flex items-center justify-between gap-2 border-b border-zinc-800 px-3 py-2">
        <div>
          <div className="text-sm font-semibold">Mapeamento</div>
          <div className="text-zinc-400">
            Layout de <b data-testid="mapper-orientation">{ORIENT[p.orientation]}</b> (escolhido pela tela do celular)
          </div>
        </div>
        <button className={`${btn} border-emerald-500 bg-emerald-700 hover:bg-emerald-600`} onClick={p.onClose} data-testid="mapper-done">
          Concluir
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {p.showGuide && (
          <div data-testid="mapper-guide" className="m-3 rounded-md border border-sky-700 bg-sky-950/60 p-2 leading-relaxed">
            <div className="mb-1 font-semibold text-sky-200">Primeiro uso: 3 passos</div>
            <ol className="list-decimal space-y-0.5 pl-4 text-sky-100">
              <li>Arraste o joystick e os botões para cima dos controles do jogo no vídeo.</li>
              <li>Clique num controle e em <b>Atalho</b>: aperte a tecla ou o botão do mouse.</li>
              <li><b>+ Botão</b> e clique no vídeo para criar outro (até {MAX_BUTTONS}). <b>Concluir</b> salva.</li>
            </ol>
          </div>
        )}

        {msg && (
          <div className={`mx-3 mt-3 rounded px-2 py-1 ${msg.ok ? "bg-emerald-900 text-emerald-100" : "bg-rose-900 text-rose-100"}`} data-testid="mapper-msg">
            {msg.text}
          </div>
        )}

        <Section title="Perfil" testId="profile-section">
          <div className="mb-2 flex gap-1">
            <select
              aria-label="Perfil ativo"
              data-testid="profile-select"
              className={field}
              value={prof.id}
              onChange={(e) => p.onStore(selectProfile(p.store, e.target.value))}
            >
              {p.store.profiles.map((x) => (
                <option key={x.id} value={x.id}>
                  {x.name}
                </option>
              ))}
            </select>
          </div>
          {renaming !== null ? (
            <div className="mb-2 flex gap-1">
              <input
                aria-label="Novo nome do perfil"
                className={field}
                value={renaming}
                autoFocus
                maxLength={40}
                onChange={(e) => setRenaming(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    p.onStore(renameProfile(p.store, prof.id, renaming));
                    setRenaming(null);
                  }
                }}
              />
              <button
                className={btn}
                onClick={() => {
                  p.onStore(renameProfile(p.store, prof.id, renaming));
                  setRenaming(null);
                }}
              >
                Salvar
              </button>
            </div>
          ) : null}
          <div className="flex flex-wrap gap-1">
            <button className={btn} onClick={() => p.onStore(createProfile(p.store))}>
              Novo
            </button>
            <button className={btn} onClick={() => p.onStore(duplicateProfile(p.store))}>
              Duplicar
            </button>
            <button className={btn} onClick={() => setRenaming(prof.name)}>
              Renomear
            </button>
            {confirmDelete ? (
              <button
                className={`${btn} border-rose-500 bg-rose-800`}
                onClick={() => {
                  p.onStore(deleteProfile(p.store, prof.id));
                  setConfirmDelete(false);
                  say(`Perfil "${prof.name}" excluído.`);
                }}
                onBlur={() => setConfirmDelete(false)}
              >
                Confirmar exclusão
              </button>
            ) : (
              <button className={btn} disabled={p.store.profiles.length <= 1} onClick={() => setConfirmDelete(true)}>
                Excluir
              </button>
            )}
          </div>
          <div className="mt-1 flex flex-wrap gap-1">
            <button
              className={btn}
              onClick={() => {
                const blob = new Blob([exportProfile(prof)], { type: "application/json" });
                const a = document.createElement("a");
                a.href = URL.createObjectURL(blob);
                a.download = `mirror-control-${prof.name.replace(/[^\w-]+/g, "_")}.json`;
                a.click();
                setTimeout(() => URL.revokeObjectURL(a.href), 1000);
              }}
            >
              Exportar
            </button>
            <button className={btn} onClick={() => fileRef.current?.click()}>
              Importar arquivo
            </button>
            <input
              ref={fileRef}
              data-testid="profile-file"
              type="file"
              accept="application/json,.json"
              className="hidden"
              onChange={async (e) => {
                const f = e.target.files?.[0];
                e.target.value = "";
                if (f) doImport(await f.text());
              }}
            />
            <button
              className={btn}
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(exportProfile(prof));
                  say("Perfil copiado (JSON) para a área de transferência.");
                } catch {
                  setPasting(exportProfile(prof));
                  say("Não deu para copiar automaticamente: copie o texto abaixo.", false);
                }
              }}
            >
              Copiar
            </button>
            <button className={btn} onClick={() => setPasting(pasting === null ? "" : null)}>
              Colar
            </button>
          </div>
          {pasting !== null && (
            <div className="mt-2">
              <textarea
                aria-label="JSON do perfil"
                data-testid="profile-paste"
                className={`${field} h-24 font-mono text-[10px]`}
                value={pasting}
                onChange={(e) => setPasting(e.target.value)}
                placeholder="Cole aqui o JSON exportado"
              />
              <button className={`${btn} mt-1`} onClick={() => doImport(pasting)} data-testid="profile-paste-import">
                Importar texto
              </button>
            </div>
          )}
        </Section>

        <Section title={`Controles (${ORIENT[p.orientation].toLowerCase()})`}>
          {p.undoLabel && (
            <div data-testid="undo-bar" className="mb-2 flex items-center justify-between gap-2 rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1">
              <span className="truncate text-zinc-300">{p.undoLabel}</span>
              <button data-testid="undo-button" className={`${btn} border-sky-500`} onClick={p.onUndo} title="Desfazer (Ctrl+Z)">
                Desfazer
              </button>
            </div>
          )}
          <div className="mb-2 flex flex-wrap gap-1">
            <button
              data-testid="add-button"
              className={`${btn} ${p.placing?.kind === "new" ? "border-amber-300 bg-amber-700" : ""}`}
              disabled={full}
              title={full ? `Limite de ${MAX_BUTTONS} botões por layout: exclua um para criar outro` : "Depois clique no vídeo onde o botão deve ficar"}
              onClick={() => p.onPlacing(p.placing?.kind === "new" ? null : { kind: "new" })}
            >
              {p.placing?.kind === "new" ? "Clique no vídeo…" : "+ Botão"}
            </button>
            {!l.joystick.enabled && (
              <button data-testid="restore-joystick" className={btn} onClick={() => p.onRestore("joystick")} title="Adiciona de volta o joystick (mesmas teclas e posição)">
                + Joystick
              </button>
            )}
            {!l.look.enabled && (
              <button data-testid="restore-look" className={btn} onClick={() => p.onRestore("look")} title="Adiciona de volta a câmera do mouse travado">
                + Câmera
              </button>
            )}
          </div>
          <div className="mb-2 flex flex-wrap gap-1">
            <button data-testid="reset-layout" className={btn} onClick={p.onReset} title={`Volta o layout de ${ORIENT[p.orientation].toLowerCase()} ao padrão (dá para desfazer)`}>
              Restaurar padrão
            </button>
            <button
              data-testid="clear-layout"
              className={`${btn} border-rose-700`}
              disabled={controlCount(l) === 0}
              onClick={p.onClear}
              title="Remove todos os controles deste layout (joystick, câmera e botões); dá para desfazer"
            >
              Limpar tudo
            </button>
            <span data-testid="button-count" className={`self-center ${full ? "text-amber-300" : "text-zinc-500"}`}>
              {l.buttons.length}/{MAX_BUTTONS} botões
            </span>
          </div>
          {full && (
            <p data-testid="button-limit" className="mb-2 text-amber-300">
              Limite de {MAX_BUTTONS} botões neste layout: exclua um para criar outro.
            </p>
          )}

          {conflicts.length > 0 && (
            <div data-testid="conflicts" className="mb-2 rounded-md border border-amber-600 bg-amber-950 p-2 text-amber-100">
              <div className="font-semibold">Atalho repetido:</div>
              {conflicts.map((c) => (
                <div key={c.bind}>• {describeConflict(c)}</div>
              ))}
            </div>
          )}

          <ul ref={listRef} className="relative max-h-72 space-y-1 overflow-y-auto overscroll-contain pr-0.5" data-testid="control-list">
            {[
              ...(l.joystick.enabled
                ? [{ id: "joystick", name: "Joystick", info: [l.joystick.up, l.joystick.left, l.joystick.down, l.joystick.right].map(keyLabel).join("") }]
                : []),
              ...(l.look.enabled ? [{ id: "look", name: "Câmera (mouse travado)", info: `sens. ${l.look.sensX.toFixed(1)}/${l.look.sensY.toFixed(1)}` }] : []),
              ...l.buttons.map((b) => ({ id: b.id, name: b.label, info: `${bindLabel(b.bind)}${MODE_MARK[b.mode]}`, warn: !b.bind || conflictBinds.has(b.bind ?? "") })),
            ].map((c) => (
              <li key={c.id} className="flex gap-1">
                <button
                  data-testid={`list-${c.id}`}
                  className={`flex min-w-0 flex-1 items-center justify-between rounded-md border px-2 py-1 text-left ${
                    p.selected === c.id ? "border-amber-300 bg-zinc-800" : "border-zinc-800 hover:bg-zinc-900"
                  }`}
                  onClick={() => p.onSelect(p.selected === c.id ? null : c.id)}
                >
                  <span className="truncate">{c.name}</span>
                  <span className={`ml-2 shrink-0 ${"warn" in c && c.warn ? "text-amber-300" : "text-zinc-400"}`}>{c.info}</span>
                </button>
                <button
                  data-testid={`del-${c.id}`}
                  aria-label={`Excluir ${c.name}`}
                  title={`Excluir ${c.name} (dá para desfazer)`}
                  className="shrink-0 rounded-md border border-zinc-800 px-2 text-zinc-400 hover:border-rose-600 hover:bg-rose-950 hover:text-rose-200"
                  onClick={() => p.onRemove(c.id)}
                >
                  ✕
                </button>
              </li>
            ))}
          </ul>
          {controlCount(l) === 0 && (
            <p data-testid="empty-layout" className="mt-2 rounded-md border border-dashed border-zinc-700 p-2 text-zinc-400">
              Nenhum controle neste layout: as teclas e o mouse travado não tocam nada. Use <b>+ Botão</b>, <b>+ Joystick</b>,{" "}
              <b>+ Câmera</b> ou <b>Restaurar padrão</b>.
            </p>
          )}
          <p className="mt-2 text-zinc-500">
            Arraste no vídeo ou use as setas (Shift = passo maior). Delete (ou ✕) exclui o controle selecionado; Ctrl+Z
            desfaz.
          </p>
          <p data-testid="simultaneous-hint" className="mt-1 text-zinc-500">
            Até {MAX_BUTTONS} botões por layout, mas o Android aceita no máximo {MAX_SIMULTANEOUS_BUTTONS} apertados ao
            mesmo tempo (além do joystick, da câmera e do mouse). Botões <b>Alternar</b> ligados ocupam um desses{" "}
            {MAX_SIMULTANEOUS_BUTTONS} toques. ⇄ = alternar, • = toque rápido.
          </p>
        </Section>

        {selBtn && (
          <Section title={`Botão: ${selBtn.label}`} testId="button-editor">
            <label className="mb-2 block">
              <span className="text-zinc-400">Rótulo</span>
              <input
                aria-label="Rótulo"
                className={field}
                value={selBtn.label}
                maxLength={24}
                onChange={(e) => updBtn(selBtn.id, { label: e.target.value })}
              />
            </label>
            <div className="mb-2 flex items-center gap-2">
              <span className="text-zinc-400">Atalho</span>
              {captureBtn({ kind: "btn", id: selBtn.id }, bindLabel(selBtn.bind), "capture-bind")}
              {selBtn.bind && (
                <button className={btn} onClick={() => updBtn(selBtn.id, { bind: undefined })}>
                  Limpar
                </button>
              )}
            </div>
            {selBtn.bind && conflictBinds.has(selBtn.bind) && (
              <div className="mb-2 text-amber-300" data-testid="bind-conflict">
                ⚠ {bindLabel(selBtn.bind)} também é usado por outro controle.
              </div>
            )}
            {selBtn.bind?.startsWith("mouse:") && (
              <div className="mb-2 text-zinc-500">Botões do mouse só disparam controles com o mouse travado.</div>
            )}
            <label className="mb-2 block">
              <span className="text-zinc-400">Tipo</span>
              <select
                aria-label="Tipo do botão"
                className={field}
                value={selBtn.mode}
                onChange={(e) => updBtn(selBtn.id, { mode: e.target.value as ButtonMode })}
              >
                {(Object.keys(MODE_TEXT) as ButtonMode[]).map((m) => (
                  <option key={m} value={m}>
                    {MODE_TEXT[m]}
                  </option>
                ))}
              </select>
            </label>
            {selBtn.mode === "toggle" && (
              <div data-testid="toggle-note" className="mb-2 text-zinc-500">
                Enquanto ligado, este botão ocupa um dos {MAX_SIMULTANEOUS_BUTTONS} toques simultâneos do Android.
              </div>
            )}
            <Range label="Tamanho" value={selBtn.size} min={BUTTON_SIZE.min} max={BUTTON_SIZE.max} step={0.01} onChange={(v) => updBtn(selBtn.id, { size: v })} />
            <div className="mb-1 text-zinc-500">
              Posição: {(selBtn.x * 100).toFixed(1)}% × {(selBtn.y * 100).toFixed(1)}%
            </div>
            <div className="flex flex-wrap gap-1">
              <button className={btn} onClick={() => p.onPlacing({ kind: "move", id: selBtn.id })}>
                Definir posição clicando no vídeo
              </button>
              <button data-testid="delete-button" className={`${btn} border-rose-600 bg-rose-900`} onClick={() => p.onRemove(selBtn.id)}>
                Excluir botão
              </button>
            </div>
          </Section>
        )}

        {sel === "joystick" && l.joystick.enabled && (
          <Section title="Joystick" testId="joystick-editor">
            <div className="mb-2 grid grid-cols-2 gap-1">
              {DIRS.map(([d, name]) => (
                <div key={d} className="flex items-center justify-between gap-1">
                  <span className="whitespace-nowrap text-zinc-400">{name}</span>
                  {captureBtn({ kind: "joy", dir: d }, keyLabel(l.joystick[d]), `capture-joy-${d}`)}
                </div>
              ))}
            </div>
            <Range
              label="Raio do arrasto"
              value={l.joystick.radius}
              min={JOY_RADIUS.min}
              max={JOY_RADIUS.max}
              step={0.01}
              onChange={(v) => p.onLayout((x) => ({ ...x, joystick: { ...x.joystick, radius: v } }))}
            />
            <Range
              label="Tamanho do círculo"
              value={l.joystick.size}
              min={JOY_SIZE.min}
              max={JOY_SIZE.max}
              step={0.01}
              onChange={(v) => p.onLayout((x) => ({ ...x, joystick: { ...x.joystick, size: v } }))}
            />
            <div className="flex flex-wrap gap-1">
              <button className={btn} onClick={() => p.onPlacing({ kind: "move", id: "joystick" })}>
                Definir posição clicando no vídeo
              </button>
              <button data-testid="delete-joystick" className={`${btn} border-rose-600 bg-rose-900`} onClick={() => p.onRemove("joystick")}>
                Excluir joystick
              </button>
            </div>
          </Section>
        )}

        {sel === "look" && l.look.enabled && (
          <Section title="Câmera (mouse travado)" testId="look-editor">
            <Range label="Sensibilidade X" value={l.look.sensX} min={0.1} max={5} step={0.1} fmt={(v) => v.toFixed(1)} onChange={(v) => p.onLayout((x) => ({ ...x, look: { ...x.look, sensX: v } }))} />
            <Range label="Sensibilidade Y" value={l.look.sensY} min={0.1} max={5} step={0.1} fmt={(v) => v.toFixed(1)} onChange={(v) => p.onLayout((x) => ({ ...x, look: { ...x.look, sensY: v } }))} />
            <label className="mb-2 flex items-center gap-1">
              <input type="checkbox" checked={l.look.invertY} onChange={(e) => p.onLayout((x) => ({ ...x, look: { ...x.look, invertY: e.target.checked } }))} />
              Inverter Y
            </label>
            <div className="mb-2 text-zinc-500">A âncora é onde o dedo da câmera encosta: deixe numa área livre da tela do jogo.</div>
            <div className="flex flex-wrap gap-1">
              <button className={btn} onClick={() => p.onPlacing({ kind: "move", id: "look" })}>
                Definir posição clicando no vídeo
              </button>
              <button data-testid="delete-look" className={`${btn} border-rose-600 bg-rose-900`} onClick={() => p.onRemove("look")}>
                Excluir câmera
              </button>
            </div>
          </Section>
        )}

        <Section title="Opções">
          <label className="mb-2 flex items-center gap-1">
            <input
              type="checkbox"
              data-testid="keys-in-free"
              checked={p.settings.keysInFree}
              onChange={(e) => p.onSettings({ ...p.settings, keysInFree: e.target.checked })}
            />
            Teclas ativas no modo livre
          </label>
          <div className="mb-2 flex items-center gap-2">
            <span className="text-zinc-400">Travar/soltar mouse</span>
            {captureBtn({ kind: "toggle" }, keyLabel(p.settings.toggleKey), "capture-toggle")}
          </div>
          <Range
            label="Opacidade dos controles"
            value={p.settings.opacity}
            min={0.15}
            max={1}
            step={0.05}
            fmt={(v) => `${Math.round(v * 100)}%`}
            onChange={(v) => p.onSettings({ ...p.settings, opacity: v })}
            testId="opacity"
          />
        </Section>
      </div>
    </aside>
  );
});
