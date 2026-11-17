/**
 * Perfis de mapeamento (módulo PURO, testado em tests/ui.test.ts).
 *
 * Um perfil tem um layout para RETRATO e outro para PAISAGEM; o site escolhe pela proporção atual do vídeo.
 * Tudo fica no localStorage do navegador (chave `mirror-control.profiles.v2`). O formato antigo
 * (`mirror-control.layout.v1`, um único layout pensado para paisagem) é migrado para o layout de paisagem do perfil
 * "Padrão", sem apagar a chave antiga.
 */
import type { Bind, ButtonControl, ButtonMode, Joystick, Layout, Look, Orientation } from "./layout.ts";
import {
  BUTTON_SIZE,
  JOY_RADIUS,
  JOY_SIZE,
  MAX_BUTTONS,
  bindLabel,
  clamp01,
  clampTo,
  defaultLayout,
  keyBind,
  keyLabel,
  mouseBind,
} from "./layout.ts";

export type Profile = { id: string; name: string; landscape: Layout; portrait: Layout };
export type ProfileStore = { version: 2; activeId: string; profiles: Profile[] };

export const STORE_KEY = "mirror-control.profiles.v2";
export const LEGACY_KEY = "mirror-control.layout.v1";
export const SETTINGS_KEY = "mirror-control.settings.v1";
export const EXPORT_TAG = "mirror-control-profile";

type KV = { getItem(k: string): string | null; setItem(k: string, v: string): void };

let idCounter = 0;
export function newId(prefix = "p"): string {
  idCounter = (idCounter + 1) % 1e6;
  return `${prefix}${Date.now().toString(36)}${idCounter.toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`;
}

export function newProfile(name = "Padrão", id = newId()): Profile {
  return { id, name, landscape: defaultLayout("landscape"), portrait: defaultLayout("portrait") };
}

export function defaultStore(): ProfileStore {
  const p = newProfile("Padrão", "default");
  return { version: 2, activeId: p.id, profiles: [p] };
}

// ---------------------------------------------------------------- saneamento

const num = (v: unknown, fallback: number) => (typeof v === "number" && Number.isFinite(v) ? v : fallback);
const str = (v: unknown, fallback: string, max = 40) =>
  typeof v === "string" && v.trim() ? v.trim().slice(0, max) : fallback;
const MODES: ButtonMode[] = ["hold", "toggle", "tap"];
const BIND_RE = /^(key:[A-Za-z0-9]{1,32}|mouse:[0-2]|wheel:(up|down))$/;

export function isValidBind(b: unknown): b is Bind {
  return typeof b === "string" && BIND_RE.test(b);
}

function sanitizeJoystick(raw: unknown, d: Joystick): Joystick {
  const j = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const radius = clampTo(num(j.radius, d.radius), JOY_RADIUS.min, JOY_RADIUS.max);
  const code = (v: unknown, f: string) => (typeof v === "string" && /^[A-Za-z0-9]{1,32}$/.test(v) ? v : f);
  return {
    // Campo novo (0.3.1): ausente nos perfis antigos = habilitado (nada some na migração).
    enabled: j.enabled !== false,
    x: clamp01(num(j.x, d.x)),
    y: clamp01(num(j.y, d.y)),
    radius,
    // Formato antigo não tinha "size": o círculo desenhado acompanha o raio do arrasto.
    size: clampTo(num(j.size, Math.max(d.size, radius * 2 + 0.04)), JOY_SIZE.min, JOY_SIZE.max),
    up: code(j.up, d.up),
    down: code(j.down, d.down),
    left: code(j.left, d.left),
    right: code(j.right, d.right),
  };
}

function sanitizeLook(raw: unknown, d: Look): Look {
  const l = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const legacy = num(l.sensitivity, NaN); // formato v1: uma só sensibilidade
  const sx = num(l.sensX, Number.isNaN(legacy) ? d.sensX : legacy);
  const sy = num(l.sensY, Number.isNaN(legacy) ? d.sensY : legacy);
  return {
    enabled: l.enabled !== false,
    x: clamp01(num(l.x, d.x)),
    y: clamp01(num(l.y, d.y)),
    sensX: clampTo(sx, 0.1, 5),
    sensY: clampTo(sy, 0.1, 5),
    invertY: l.invertY === true,
  };
}

/**
 * Botões: aceita o formato novo (bind/mode/pointer/size) e o antigo (key/mouse, ponteiro = índice + 1).
 * Garante no máximo 7, ids únicos e ponteiros únicos em 1..7 (os válidos são mantidos; os demais recebem o menor livre).
 */
function sanitizeButtons(raw: unknown, legacyPointers: boolean): ButtonControl[] {
  const list = Array.isArray(raw) ? raw.slice(0, MAX_BUTTONS) : [];
  const out: ButtonControl[] = [];
  const ids = new Set<string>();
  const used = new Set<number>();
  const pending: { b: ButtonControl; want: number }[] = [];
  list.forEach((r, i) => {
    if (!r || typeof r !== "object") return;
    const o = r as Record<string, unknown>;
    let bind: Bind | undefined;
    if (isValidBind(o.bind)) bind = o.bind;
    else if (typeof o.key === "string" && /^[A-Za-z0-9]{1,32}$/.test(o.key)) bind = keyBind(o.key);
    else if (typeof o.mouse === "number" && [0, 1, 2].includes(o.mouse)) bind = mouseBind(o.mouse);
    let id = str(o.id, "", 64) || newId("b");
    while (ids.has(id)) id = newId("b");
    ids.add(id);
    const b: ButtonControl = {
      id,
      label: str(o.label, "Botão", 24),
      ...(bind ? { bind } : {}),
      mode: MODES.includes(o.mode as ButtonMode) ? (o.mode as ButtonMode) : "hold",
      pointer: 0,
      x: clamp01(num(o.x, 0.5)),
      y: clamp01(num(o.y, 0.5)),
      size: clampTo(num(o.size, BUTTON_SIZE.default), BUTTON_SIZE.min, BUTTON_SIZE.max),
    };
    const want = legacyPointers ? i + 1 : num(o.pointer, 0);
    pending.push({ b, want });
  });
  for (const p of pending) {
    if (Number.isInteger(p.want) && p.want >= 1 && p.want <= MAX_BUTTONS && !used.has(p.want)) {
      p.b.pointer = p.want;
      used.add(p.want);
    }
  }
  for (const p of pending) {
    if (!p.b.pointer) {
      p.b.pointer = freePointer(used);
      used.add(p.b.pointer);
    }
    out.push(p.b);
  }
  return out;
}

function freePointer(used: Set<number>): number {
  for (let i = 1; i <= MAX_BUTTONS; i++) if (!used.has(i)) return i;
  return 0;
}

export function sanitizeLayout(raw: unknown, o: Orientation): Layout {
  const d = defaultLayout(o);
  if (!raw || typeof raw !== "object") return d;
  const r = raw as Record<string, unknown>;
  const legacy = Array.isArray(r.buttons) && r.buttons.some((b) => b && typeof b === "object" && !("pointer" in b));
  return {
    joystick: sanitizeJoystick(r.joystick, d.joystick),
    look: sanitizeLook(r.look, d.look),
    buttons: "buttons" in r ? sanitizeButtons(r.buttons, legacy) : d.buttons,
    ...(r.confirmed === true ? { confirmed: true } : {}),
  };
}

export function sanitizeProfile(raw: unknown, fallbackName = "Importado"): Profile {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  return {
    id: str(r.id, "", 64) || newId(),
    name: str(r.name, fallbackName, 40),
    landscape: sanitizeLayout(r.landscape, "landscape"),
    portrait: sanitizeLayout(r.portrait, "portrait"),
  };
}

// ---------------------------------------------------------------- armazenamento

/** Lê o armazenamento; migra o formato antigo; nunca lança. */
export function loadStore(kv: KV | null | undefined): ProfileStore {
  let raw: string | null = null;
  let legacy: string | null = null;
  try {
    raw = kv?.getItem(STORE_KEY) ?? null;
    if (!raw) legacy = kv?.getItem(LEGACY_KEY) ?? null;
  } catch {}
  if (raw) {
    try {
      const j = JSON.parse(raw);
      const profiles = (Array.isArray(j?.profiles) ? j.profiles : []).map((p: unknown) => sanitizeProfile(p));
      const unique: Profile[] = [];
      for (const p of profiles) if (!unique.some((u) => u.id === p.id)) unique.push(p);
      if (unique.length) {
        const activeId = unique.some((p) => p.id === j.activeId) ? j.activeId : unique[0].id;
        return { version: 2, activeId, profiles: unique };
      }
    } catch {}
  }
  if (legacy) {
    try {
      return migrateLegacy(JSON.parse(legacy));
    } catch {}
  }
  return defaultStore();
}

/**
 * Formato v1 → v2: o layout antigo (feito para paisagem) vira o layout de PAISAGEM do perfil "Padrão" e conta como
 * personalizado; o de retrato começa no padrão novo. Ponteiros = índice + 1, como o app antigo enviava.
 */
export function migrateLegacy(old: unknown): ProfileStore {
  const store = defaultStore();
  const p = store.profiles[0];
  const merged = { ...(old && typeof old === "object" ? old : {}) } as Record<string, unknown>;
  p.landscape = { ...sanitizeLayout(merged, "landscape"), confirmed: true };
  return store;
}

export function saveStore(kv: KV | null | undefined, s: ProfileStore) {
  try {
    kv?.setItem(STORE_KEY, JSON.stringify(s));
  } catch {}
}

export function activeProfile(s: ProfileStore): Profile {
  return s.profiles.find((p) => p.id === s.activeId) ?? s.profiles[0];
}

// ---------------------------------------------------------------- operações (imutáveis)

export function updateLayout(s: ProfileStore, o: Orientation, f: (l: Layout) => Layout): ProfileStore {
  const a = activeProfile(s);
  return {
    ...s,
    profiles: s.profiles.map((p) => (p.id === a.id ? { ...p, [o]: f(p[o]) } : p)),
  };
}

function uniqueName(s: ProfileStore, base: string): string {
  const names = new Set(s.profiles.map((p) => p.name));
  if (!names.has(base)) return base;
  for (let i = 2; ; i++) if (!names.has(`${base} (${i})`)) return `${base} (${i})`;
}

export function createProfile(s: ProfileStore, name = "Novo perfil"): ProfileStore {
  const p = newProfile(uniqueName(s, name.trim() || "Novo perfil"));
  return { ...s, activeId: p.id, profiles: [...s.profiles, p] };
}

export function duplicateProfile(s: ProfileStore, id = s.activeId): ProfileStore {
  const src = s.profiles.find((p) => p.id === id);
  if (!src) return s;
  const copy: Profile = { ...structuredClone(src), id: newId(), name: uniqueName(s, `${src.name} (cópia)`) };
  return { ...s, activeId: copy.id, profiles: [...s.profiles, copy] };
}

export function renameProfile(s: ProfileStore, id: string, name: string): ProfileStore {
  const n = name.trim().slice(0, 40);
  if (!n) return s;
  return { ...s, profiles: s.profiles.map((p) => (p.id === id ? { ...p, name: n } : p)) };
}

/** Não apaga o último perfil. */
export function deleteProfile(s: ProfileStore, id: string): ProfileStore {
  if (s.profiles.length <= 1) return s;
  const profiles = s.profiles.filter((p) => p.id !== id);
  return { ...s, profiles, activeId: s.activeId === id ? profiles[0].id : s.activeId };
}

export function selectProfile(s: ProfileStore, id: string): ProfileStore {
  return s.profiles.some((p) => p.id === id) ? { ...s, activeId: id } : s;
}

/** JSON de um perfil para baixar/copiar. */
export function exportProfile(p: Profile): string {
  const { id: _id, ...rest } = p;
  return JSON.stringify({ format: EXPORT_TAG, version: 2, profile: rest }, null, 2);
}

/**
 * Importa o texto de exportProfile (ou só o objeto do perfil, ou um layout v1 antigo). O perfil importado ganha id
 * novo, nome único e vira o ativo. Lança Error com mensagem em português se o texto não servir.
 */
export function importProfile(s: ProfileStore, text: string): ProfileStore {
  let j: unknown;
  try {
    j = JSON.parse(text);
  } catch {
    throw new Error("O texto não é um JSON válido.");
  }
  if (!j || typeof j !== "object") throw new Error("JSON sem perfil.");
  const o = j as Record<string, unknown>;
  let raw: Record<string, unknown>;
  if (o.format === EXPORT_TAG && o.profile && typeof o.profile === "object") raw = o.profile as Record<string, unknown>;
  else if ("landscape" in o || "portrait" in o) raw = o;
  else if ("joystick" in o || "buttons" in o) raw = { name: "Importado (v1)", landscape: o };
  else throw new Error("JSON não parece um perfil do Mirror Control.");
  const p = sanitizeProfile({ ...raw, id: newId() }, "Importado");
  p.name = uniqueName(s, p.name);
  return { ...s, activeId: p.id, profiles: [...s.profiles, p] };
}

// ---------------------------------------------------------------- botões

/** Menor ponteiro livre (1..7) do layout, ou 0 se já há 7 botões. */
export function nextPointer(l: Layout): number {
  return freePointer(new Set(l.buttons.map((b) => b.pointer)));
}

export function addButton(l: Layout, x: number, y: number, label = "Novo"): { layout: Layout; id?: string } {
  const pointer = nextPointer(l);
  if (!pointer || l.buttons.length >= MAX_BUTTONS) return { layout: l };
  const id = newId("b");
  const b: ButtonControl = { id, label, mode: "tap", pointer, x: clamp01(x), y: clamp01(y), size: BUTTON_SIZE.default };
  return { layout: { ...l, buttons: [...l.buttons, b] }, id };
}

export function removeButton(l: Layout, id: string): Layout {
  return { ...l, buttons: l.buttons.filter((b) => b.id !== id) };
}

/**
 * Remove QUALQUER controle: botão (padrão ou extra) sai da lista; joystick e câmera ficam desabilitados (guardam
 * posição/teclas para "adicionar de volta"). Devolve o mesmo objeto se o id não existe.
 */
export function removeControl(l: Layout, id: string): Layout {
  if (id === "joystick") return l.joystick.enabled ? { ...l, joystick: { ...l.joystick, enabled: false } } : l;
  if (id === "look") return l.look.enabled ? { ...l, look: { ...l.look, enabled: false } } : l;
  return l.buttons.some((b) => b.id === id) ? removeButton(l, id) : l;
}

/** Adiciona de volta o joystick ou a câmera removidos (com as configurações que tinham). */
export function restoreControl(l: Layout, id: "joystick" | "look"): Layout {
  if (id === "joystick") return { ...l, joystick: { ...l.joystick, enabled: true } };
  return { ...l, look: { ...l.look, enabled: true } };
}

/** "Limpar tudo / começar do zero": nenhum controle (joystick e câmera desabilitados, sem botões). */
export function clearLayout(l: Layout): Layout {
  return { ...l, joystick: { ...l.joystick, enabled: false }, look: { ...l.look, enabled: false }, buttons: [] };
}

// ---------------------------------------------------------------- conflitos de atalho

export type Conflict = { bind: Bind; owners: string[] };

/** Atalhos reservados pelo próprio site (configuráveis ou fixos). */
export function reservedBinds(toggleKey: string): { bind: Bind; owner: string }[] {
  return [
    { bind: keyBind(toggleKey), owner: "Travar/soltar mouse" },
    { bind: keyBind("Escape"), owner: "Soltar mouse (Esc)" },
  ];
}

/** Atalhos usados por mais de um controle (ou por um controle e um atalho do site). */
export function findConflicts(l: Layout, reserved: { bind: Bind; owner: string }[] = []): Conflict[] {
  const map = new Map<Bind, string[]>();
  const add = (bind: Bind | undefined, owner: string) => {
    if (!bind) return;
    map.set(bind, [...(map.get(bind) ?? []), owner]);
  };
  const j = l.joystick;
  if (j.enabled) {
    add(keyBind(j.up), "Joystick ↑");
    add(keyBind(j.down), "Joystick ↓");
    add(keyBind(j.left), "Joystick ←");
    add(keyBind(j.right), "Joystick →");
  }
  for (const b of l.buttons) add(b.bind, b.label);
  for (const r of reserved) add(r.bind, r.owner);
  return [...map.entries()].filter(([, o]) => o.length > 1).map(([bind, owners]) => ({ bind, owners }));
}

export function describeConflict(c: Conflict): string {
  return `${bindLabel(c.bind)} usado por: ${c.owners.join(", ")}`;
}

// ---------------------------------------------------------------- preferências

export type UiSettings = {
  /** Teclas mapeadas (joystick/botões) também funcionam com o mouse livre. */
  keysInFree: boolean;
  /** KeyboardEvent.code que alterna livre/travado. */
  toggleKey: string;
  showControls: boolean;
  /** Opacidade dos controles sobre o vídeo (0.15..1). */
  opacity: number;
};

export const DEFAULT_SETTINGS: UiSettings = { keysInFree: true, toggleKey: "F8", showControls: true, opacity: 0.7 };

export function loadSettings(kv: KV | null | undefined): UiSettings {
  try {
    const raw = kv?.getItem(SETTINGS_KEY);
    if (raw) {
      const j = JSON.parse(raw) as Partial<UiSettings>;
      return {
        keysInFree: typeof j.keysInFree === "boolean" ? j.keysInFree : DEFAULT_SETTINGS.keysInFree,
        toggleKey:
          typeof j.toggleKey === "string" && /^[A-Za-z0-9]{1,32}$/.test(j.toggleKey) && j.toggleKey !== "Escape"
            ? j.toggleKey
            : DEFAULT_SETTINGS.toggleKey,
        showControls: typeof j.showControls === "boolean" ? j.showControls : DEFAULT_SETTINGS.showControls,
        opacity: clampTo(num(j.opacity, DEFAULT_SETTINGS.opacity), 0.15, 1),
      };
    }
  } catch {}
  return { ...DEFAULT_SETTINGS };
}

export function saveSettings(kv: KV | null | undefined, s: UiSettings) {
  try {
    kv?.setItem(SETTINGS_KEY, JSON.stringify(s));
  } catch {}
}

export { keyLabel };
