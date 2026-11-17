"use client";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import ConnectPanel from "@/components/ConnectPanel";
import ControlsOverlay from "@/components/ControlsOverlay";
import MapperPanel, { CaptureTarget, Placing } from "@/components/MapperPanel";
import Toolbar from "@/components/Toolbar";
import UsbPanel from "@/components/UsbPanel";
import { InputController, InputSink } from "@/lib/inputController";
import {
  Layout,
  clamp01,
  defaultLayout,
  fitContain,
  keyBind,
  mouseBind,
  orientationFor,
  toNormalized,
  wheelBind,
} from "@/lib/layout";
import { INITIAL_MODE, ModeEvent, ModeState, isEditableTarget, nextMode } from "@/lib/mouseModes";
import {
  ProfileStore,
  UiSettings,
  DEFAULT_SETTINGS,
  activeProfile,
  addButton,
  defaultStore,
  loadSettings,
  loadStore,
  saveSettings,
  saveStore,
  updateLayout,
} from "@/lib/profiles";
import { CtrlMessage, NavAction, RotateMode, parsePhoneCtrl } from "@/lib/protocol";
import { RemoteSession, SessionState } from "@/lib/session";
import type { UsbSession, UsbSessionState } from "@/lib/usbSession";
import { ChannelOpener, UsbConnectError, requestUsbDevice } from "@/lib/usbTransport";

const ROOM_KEY = "mirror-control.room";
/** Margem entre o vídeo e as bordas do palco (px). */
const STAGE_PAD = 8;

function newRoomId() {
  const alphabet = "abcdefghijkmnpqrstuvwxyz23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(10));
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join("");
}

const storage = () => {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
};

export default function Page() {
  const [roomId, setRoomId] = useState("");
  const [state, setState] = useState<SessionState>({ signaling: "connecting", peer: "waiting", log: [] });
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [videoReady, setVideoReady] = useState(false);
  const [preview, setPreview] = useState(false); // editor de teclas sem celular conectado
  const [aspect, setAspect] = useState(16 / 9);
  const [quality, setQuality] = useState({ height: 720, fps: 60 });
  // Modo USB (ADB via WebUSB). Em modo USB a sessão WebRTC fica fechada (um modo por vez, como no app).
  const [mode, setMode] = useState<"webrtc" | "usb">("webrtc");
  const [usbSession, setUsbSession] = useState<UsbSession | null>(null);
  const [usbState, setUsbState] = useState<UsbSessionState | null>(null);
  const [usbPin, setUsbPin] = useState("");
  const [usbNote, setUsbNote] = useState<string | undefined>();
  const [usbBusy, setUsbBusy] = useState(false);

  // Mapeamento, preferências e modos do mouse.
  const [store, setStore] = useState<ProfileStore>(defaultStore);
  const [settings, setSettings] = useState<UiSettings>(DEFAULT_SETTINGS);
  const [editing, setEditing] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [capture, setCapture] = useState<CaptureTarget | null>(null);
  const [placing, setPlacing] = useState<Placing | null>(null);
  const [modeState, setModeState] = useState<ModeState>(INITIAL_MODE);
  const [rotation, setRotation] = useState<RotateMode | null>(null);
  const [notice, setNotice] = useState<{ text: string; ok: boolean; at: number } | null>(null);
  const [stage, setStage] = useState({ w: 0, h: 0 });

  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const stageRef = useRef<HTMLElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const sessionRef = useRef<RemoteSession | null>(null);
  const sinkRef = useRef<(InputSink & { sendCtrl(m: CtrlMessage): void }) | null>(null);
  const inputRef = useRef<InputController | null>(null);
  const autoOpened = useRef(new Set<string>());

  const orientation = orientationFor(aspect);
  const profile = activeProfile(store);
  const layout = profile[orientation];

  // Refs lidos pelos listeners (o InputController vive fora do ciclo do React).
  const r = useRef({ layout, aspect, settings, mode: modeState, editing, capture, placing, orientation });
  r.current = { layout, aspect, settings, mode: modeState, editing, capture, placing, orientation };
  const modeRef = useRef<ModeState>(INITIAL_MODE);

  // Sala estável entre recarregamentos (o QR continua válido) + perfis/preferências salvos.
  useEffect(() => {
    let id = "";
    const fromUrl = new URLSearchParams(window.location.search).get("room")?.trim().toLowerCase();
    if (fromUrl && /^[a-z0-9]{6,32}$/.test(fromUrl)) id = fromUrl;
    try {
      if (!id) id = localStorage.getItem(ROOM_KEY) || "";
      else localStorage.setItem(ROOM_KEY, id);
    } catch {}
    if (!id) {
      id = newRoomId();
      try {
        localStorage.setItem(ROOM_KEY, id);
      } catch {}
    }
    setRoomId(id);
    const loaded = loadStore(storage());
    saveStore(storage(), loaded); // grava já a migração do formato antigo / o perfil padrão
    setStore(loaded);
    setSettings(loadSettings(storage()));
  }, []);

  const notify = useCallback((text: string, ok = true) => setNotice({ text, ok, at: Date.now() }), []);
  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice((n) => (n === notice ? null : n)), 9000);
    return () => clearTimeout(t);
  }, [notice]);

  const onPhoneCtrl = useCallback(
    (text: string) => {
      const s = parsePhoneCtrl(text);
      if (s) notify(s.text, s.ok);
    },
    [notify]
  );

  // ---------------------------------------------------------------- modos do mouse

  const surface = () => (mode === "usb" ? canvasRef.current : videoRef.current);
  const surfaceRef = useRef(surface);
  surfaceRef.current = surface;

  const requestLock = useCallback(() => {
    const el = surfaceRef.current();
    if (!el) {
      dispatchRef.current("lockError");
      return;
    }
    const fail = () => {
      dispatchRef.current("lockError");
      notify("O navegador não travou o mouse. Clique na página e tente de novo (após o Esc o Chrome pede ~1 s).", false);
    };
    try {
      // @ts-expect-error unadjustedMovement é suportado no Chromium (mouse sem aceleração)
      const p = el.requestPointerLock({ unadjustedMovement: true }) as Promise<void> | undefined;
      p?.catch?.(() => {
        try {
          const p2 = el.requestPointerLock() as unknown as Promise<void> | undefined;
          p2?.catch?.(fail);
        } catch {
          fail();
        }
      });
    } catch {
      fail();
    }
  }, [notify]);

  const dispatchMode = useCallback(
    (ev: ModeEvent) => {
      const res = nextMode(modeRef.current, ev);
      modeRef.current = res.state;
      setModeState(res.state);
      for (const eff of res.effects) {
        if (eff === "releaseAll") inputRef.current?.releaseAll();
        else if (eff === "exitLock") {
          if (document.pointerLockElement) document.exitPointerLock();
        } else if (eff === "requestLock") requestLock();
      }
    },
    [requestLock]
  );
  const dispatchRef = useRef(dispatchMode);
  dispatchRef.current = dispatchMode;

  // ---------------------------------------------------------------- perfis

  const commitStore = useCallback((f: (s: ProfileStore) => ProfileStore) => {
    setStore((s) => {
      const n = f(s);
      if (n !== s) saveStore(storage(), n);
      return n;
    });
  }, []);

  /** Edita o layout da orientação atual (marca como personalizado: o mapeador não abre mais sozinho). */
  const editLayout = useCallback(
    (f: (l: Layout) => Layout) => commitStore((s) => updateLayout(s, r.current.orientation, (l) => ({ ...f(l), confirmed: true }))),
    [commitStore]
  );

  const commitSettings = useCallback((s: UiSettings) => {
    setSettings(s);
    saveSettings(storage(), s);
  }, []);

  const closeEditor = useCallback(() => {
    if (!r.current.editing) return;
    // Ref atualizado já: uma tecla no mesmo evento (ex.: logo após travar o mouse) não pode cair no editor.
    r.current = { ...r.current, editing: false, capture: null, placing: null };
    setEditing(false);
    setSelected(null);
    setCapture(null);
    setPlacing(null);
    if (!r.current.layout.confirmed) editLayout((l) => l);
  }, [editLayout]);

  const openEditor = useCallback(() => {
    if (modeRef.current.mode === "locked") dispatchMode("escape");
    inputRef.current?.releaseAll();
    r.current = { ...r.current, editing: true };
    setEditing(true);
  }, [dispatchMode]);

  // ---------------------------------------------------------------- entrada

  const pointAt = useCallback((e: MouseEvent, clampIt: boolean) => {
    const box = boxRef.current;
    if (!box) return null;
    if (!clampIt) {
      const t = e.target;
      if (!(t instanceof Node) || !box.contains(t)) return null; // barra, painel, faixa fora do vídeo
      if (r.current.editing && t instanceof Element && t.closest("[data-control]")) return null; // editando um controle
    }
    const b = box.getBoundingClientRect();
    const c = fitContain(b.width, b.height, r.current.aspect);
    return toNormalized({ ...c, left: b.left + c.left, top: b.top + c.top }, e.clientX, e.clientY, clampIt, 1);
  }, []);

  const makeInput = useCallback(
    (sink: InputSink & { sendCtrl(m: CtrlMessage): void }) => {
      modeRef.current = INITIAL_MODE;
      setModeState(INITIAL_MODE);
      sinkRef.current = sink;
      const input = new InputController(sink, {
        getLayout: () => r.current.layout,
        getAspect: () => r.current.aspect,
        getMode: () => modeRef.current.mode,
        getSettings: () => r.current.settings,
        keysSuspended: () => r.current.editing || !!r.current.capture,
        capturing: () => !!r.current.capture,
        mouseSuspended: () => !!r.current.capture || !!r.current.placing,
        pointAt,
        onToggleMode: () => {
          if (modeRef.current.mode !== "locked" && r.current.editing) closeEditorRef.current();
          dispatchRef.current("toggle");
        },
        onEscape: () => dispatchRef.current("escape"),
      });
      inputRef.current = input;
      input.attach();
      return input;
    },
    [pointAt]
  );
  const closeEditorRef = useRef(closeEditor);
  closeEditorRef.current = closeEditor;

  // Pointer Lock: o navegador decide (Esc solta sempre). Nunca travamos de novo sozinhos.
  useEffect(() => {
    const onChange = () => {
      const el = document.pointerLockElement;
      if (el && stageRef.current?.contains(el)) {
        if (modeRef.current.mode !== "locked") {
          closeEditorRef.current();
          dispatchRef.current("lockAcquired");
        }
      } else if (modeRef.current.mode === "locked" || modeRef.current.requesting) {
        dispatchRef.current("lockLost");
      }
    };
    const onError = () => dispatchRef.current("lockError");
    document.addEventListener("pointerlockchange", onChange);
    document.addEventListener("pointerlockerror", onError);
    return () => {
      document.removeEventListener("pointerlockchange", onChange);
      document.removeEventListener("pointerlockerror", onError);
    };
  }, []);

  // Sessão WebRTC + controlador de entrada.
  useEffect(() => {
    if (!roomId || mode !== "webrtc") return;
    const session = new RemoteSession(roomId, { onState: setState, onStream: setStream, onCtrl: onPhoneCtrl });
    sessionRef.current = session;
    const input = makeInput(session);
    return () => {
      input.detach();
      inputRef.current = null;
      sinkRef.current = null;
      session.close();
      sessionRef.current = null;
    };
  }, [roomId, mode, makeInput, onPhoneCtrl]);

  // Sessão USB: mesmo controlador de entrada, com o <canvas> como alvo do Pointer Lock.
  useEffect(() => {
    if (!usbSession) return;
    const input = makeInput(usbSession);
    return () => {
      input.detach();
      inputRef.current = null;
      sinkRef.current = null;
      usbSession.close();
    };
  }, [usbSession, makeInput]);

  // Proporção do canvas = a do vídeo que o celular anunciou (INFO; muda ao girar).
  const usbInfo = usbState?.info;
  useEffect(() => {
    if (usbInfo) setAspect(usbInfo.width / usbInfo.height);
  }, [usbInfo]);

  // Qualidade no modo USB: a sessão guarda e reenvia a cada (re)conexão.
  useEffect(() => {
    usbSession?.sendCtrl({ type: "quality", ...quality });
  }, [usbSession, quality]);

  useEffect(() => {
    const v = videoRef.current;
    if (v) v.srcObject = stream;
    if (!stream) setVideoReady(false);
  }, [stream]);

  // Reenvia a qualidade quando o celular (re)conecta.
  useEffect(() => {
    if (state.peer === "connected") {
      const t = setTimeout(() => sessionRef.current?.sendCtrl({ type: "quality", ...quality }), 500);
      return () => clearTimeout(t);
    }
  }, [state.peer, quality]);

  // Girou (retrato ↔ paisagem): os controles mudam de lugar → nenhum dedo pode ficar preso na posição antiga.
  const lastOrientation = useRef(orientation);
  useEffect(() => {
    if (lastOrientation.current === orientation) return;
    lastOrientation.current = orientation;
    inputRef.current?.releaseAll();
    setPlacing(null);
  }, [orientation]);

  // Palco medido: o vídeo ocupa o maior retângulo possível ("contain") e os controles escalam com ele.
  const usbMode = mode === "usb" && !!usbState;
  const showStage = (usbMode && !!usbState.info) || (!usbMode && (!!stream || preview));
  useLayoutEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const measure = () => setStage({ w: el.clientWidth, h: el.clientHeight });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [showStage]);
  const box = useMemo(() => {
    const f = fitContain(Math.max(0, stage.w - 2 * STAGE_PAD), Math.max(0, stage.h - 2 * STAGE_PAD), aspect);
    return { ...f, left: f.left + STAGE_PAD, top: f.top + STAGE_PAD };
  }, [stage, aspect]);

  // Mapeador abre sozinho no 1º uso (perfil/orientação ainda não personalizado), assim que o vídeo começa.
  const videoActive = usbMode ? !!usbState.info : !!stream && videoReady;
  useEffect(() => {
    if (!videoActive || editing) return;
    const key = `${profile.id}:${orientation}`;
    if (layout.confirmed || autoOpened.current.has(key)) return;
    autoOpened.current.add(key);
    if (modeRef.current.mode === "locked") return; // jogando: não interrompe
    setEditing(true);
  }, [videoActive, editing, profile.id, orientation, layout.confirmed]);

  // ---------------------------------------------------------------- editor: captura, posicionamento, teclado

  const applyCapture = useCallback(
    (t: CaptureTarget, bind: string) => {
      if (t.kind === "btn") editLayout((l) => ({ ...l, buttons: l.buttons.map((b) => (b.id === t.id ? { ...b, bind } : b)) }));
      else if (t.kind === "joy") editLayout((l) => ({ ...l, joystick: { ...l.joystick, [t.dir]: bind.slice(4) } }));
      else commitSettings({ ...r.current.settings, toggleKey: bind.slice(4) });
      setCapture(null);
    },
    [editLayout, commitSettings]
  );

  useEffect(() => {
    if (!capture) return;
    const keysOnly = capture.kind !== "btn";
    const isCaptureButton = (e: Event) => e.target instanceof Element && !!e.target.closest('[data-testid^="capture-"]');
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopImmediatePropagation();
      if (e.repeat) return;
      if (e.code === "Escape") return setCapture(null);
      if (!e.code) return;
      applyCapture(capture, keyBind(e.code));
    };
    const onMouse = (e: MouseEvent) => {
      if (isCaptureButton(e)) return; // clicar de novo no botão cancela
      if (keysOnly) return setCapture(null);
      e.preventDefault();
      e.stopImmediatePropagation();
      if (e.button <= 2) applyCapture(capture, mouseBind(e.button));
    };
    const onWheel = (e: WheelEvent) => {
      if (keysOnly || e.deltaY === 0) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      applyCapture(capture, wheelBind(e.deltaY < 0 ? "up" : "down"));
    };
    const onContext = (e: Event) => e.preventDefault();
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("mousedown", onMouse, true);
    window.addEventListener("wheel", onWheel, { capture: true, passive: false });
    window.addEventListener("contextmenu", onContext, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("mousedown", onMouse, true);
      window.removeEventListener("wheel", onWheel, true);
      window.removeEventListener("contextmenu", onContext, true);
    };
  }, [capture, applyCapture]);

  const moveControl = useCallback(
    (id: string, x: number, y: number) =>
      editLayout((l) => {
        if (id === "joystick") return { ...l, joystick: { ...l.joystick, x, y } };
        if (id === "look") return { ...l, look: { ...l.look, x, y } };
        return { ...l, buttons: l.buttons.map((b) => (b.id === id ? { ...b, x, y } : b)) };
      }),
    [editLayout]
  );

  const onPlace = (x: number, y: number) => {
    const pl = placing;
    setPlacing(null);
    if (!pl) return;
    if (pl.kind === "move") return moveControl(pl.id, x, y);
    const res = addButton(r.current.layout, x, y);
    if (!res.id) return;
    editLayout(() => res.layout);
    setSelected(res.id);
    setCapture({ kind: "btn", id: res.id }); // já pede a tecla do botão novo
  };

  // Setas movem o controle selecionado (Shift = passo maior); Delete apaga o botão; Esc cancela.
  useEffect(() => {
    if (!editing) return;
    const onKey = (e: KeyboardEvent) => {
      if (r.current.capture || isEditableTarget(e.target)) return;
      if (e.code === "Escape") {
        if (r.current.placing) setPlacing(null);
        else setSelected(null);
        return;
      }
      const id = selectedRef.current;
      if (!id) return;
      const step = e.shiftKey ? 0.02 : 0.004;
      const d = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.code];
      if (d) {
        e.preventDefault();
        const l = r.current.layout;
        const cur = id === "joystick" ? l.joystick : id === "look" ? l.look : l.buttons.find((b) => b.id === id);
        if (cur) moveControl(id, clamp01(cur.x + d[0]), clamp01(cur.y + d[1]));
      } else if ((e.code === "Delete" || e.code === "Backspace") && id !== "joystick" && id !== "look") {
        e.preventDefault();
        editLayout((l) => ({ ...l, buttons: l.buttons.filter((b) => b.id !== id) }));
        setSelected(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [editing, moveControl, editLayout]);
  const selectedRef = useRef(selected);
  selectedRef.current = selected;

  // ---------------------------------------------------------------- ações da barra

  const changeQuality = (height: number, fps: number) => setQuality({ height, fps });

  const rotate = (m: RotateMode) => {
    if (!usbMode && !stream) {
      // Pré-visualização sem celular: só troca a proporção para editar o outro layout.
      setAspect(m === "portrait" ? 9 / 20 : 20 / 9);
      setRotation(m);
      return;
    }
    sinkRef.current?.sendCtrl({ type: "rotate", mode: m });
    setRotation(m);
    notify(m === "auto" ? "Rotação automática pedida ao celular…" : `Pedido para girar em ${m === "portrait" ? "retrato" : "paisagem"}…`);
  };

  const nav = (a: NavAction) => sinkRef.current?.sendCtrl({ type: "nav", action: a });

  /** Clique em "Conectar por USB (ADB)": o seletor do WebUSB precisa ser aberto aqui, no gesto do usuário. */
  const connectUsb = async () => {
    if (usbBusy) return;
    setUsbNote(undefined);
    // Testes e2e injetam um transporte falso (sem USB real).
    const fake = (window as unknown as { __mirrorUsbTestOpener?: () => ChannelOpener }).__mirrorUsbTestOpener;
    let opener: ChannelOpener;
    setUsbBusy(true);
    try {
      if (fake) opener = fake();
      else {
        const device = await requestUsbDevice();
        if (!device) {
          setUsbNote(
            "Nenhum aparelho escolhido. Se a lista estava vazia: cabo de dados, Depuração USB ligada no celular e o adb do PC fechado (adb kill-server)."
          );
          return;
        }
        const { createAdbOpener } = await import("@/lib/adbTransport"); // carregado só agora
        opener = createAdbOpener(device);
      }
      const { UsbSession } = await import("@/lib/usbSession");
      const s = new UsbSession(opener, usbPin, { onState: setUsbState, onCtrl: onPhoneCtrl });
      if (document.pointerLockElement) document.exitPointerLock();
      setStream(null);
      setPreview(false);
      setEditing(false);
      setUsbState(s.snapshot);
      setUsbSession(s); // o efeito acima fecha a sessão anterior
      setMode("usb");
    } catch (e) {
      setUsbNote(e instanceof UsbConnectError ? e.message : `Falha ao iniciar o modo USB: ${String(e)}`);
    } finally {
      setUsbBusy(false);
    }
  };

  const leaveUsb = () => {
    if (document.pointerLockElement) document.exitPointerLock();
    setUsbSession(null);
    setUsbState(null);
    setEditing(false);
    setMode("webrtc");
    setRotation(null);
    setState({ signaling: "connecting", peer: "waiting", log: [] });
  };

  const newRoom = (given?: string) => {
    const id = given ?? newRoomId();
    try {
      localStorage.setItem(ROOM_KEY, id);
    } catch {}
    setStream(null);
    setState({ signaling: "connecting", peer: "waiting", log: [] });
    setRoomId(id);
  };

  if (!roomId) return null;

  if (usbMode && !usbState.info) {
    return (
      <UsbPanel
        state={usbState}
        onBack={leaveUsb}
        pin={usbPin}
        onPin={setUsbPin}
        onConnect={connectUsb}
        note={usbNote}
        busy={usbBusy}
      />
    );
  }

  if (!usbMode && !stream && !preview) {
    return (
      <ConnectPanel
        roomId={roomId}
        state={state}
        height={quality.height}
        fps={quality.fps}
        onQuality={changeQuality}
        onNewRoom={() => newRoom()}
        onSetRoom={(id) => newRoom(id)}
        onOpenMapper={() => {
          setAspect(20 / 9);
          setEditing(true);
          setPreview(true);
        }}
        usbPin={usbPin}
        onUsbPin={setUsbPin}
        onUsbConnect={connectUsb}
        usbNote={usbNote}
      />
    );
  }

  const connected = usbMode ? usbState.peer === "connected" : !!stream && state.peer === "connected";
  const canControl = usbMode ? connected : !!stream;
  const connection = usbMode
    ? connected
      ? "USB conectado"
      : "USB desconectado"
    : stream
      ? connected
        ? "Wi-Fi conectado"
        : "Wi-Fi instável"
      : "Pré-visualização (sem celular)";
  const warning = usbMode
    ? usbState.peer !== "connected"
      ? { text: usbState.peer === "failed" ? usbState.error ?? "USB desconectado" : "USB: reconectando…", testId: "usb-reconnecting" }
      : undefined
    : stream && state.peer !== "connected"
      ? { text: "Reconectando…" }
      : undefined;

  return (
    <div className="flex h-screen w-screen flex-col overflow-hidden bg-black text-zinc-200">
      <Toolbar
        connection={connection}
        connectionOk={connected || (!usbMode && !stream)}
        warning={warning}
        notice={notice ?? undefined}
        mode={modeState.mode}
        requesting={modeState.requesting}
        toggleKey={settings.toggleKey}
        onToggleMode={() => {
          if (modeState.mode !== "locked" && editing) closeEditor();
          dispatchMode("toggle");
        }}
        canControl={canControl}
        canRotate={canControl || (!usbMode && !stream)}
        rotation={rotation}
        onRotate={rotate}
        onNav={nav}
        editing={editing}
        onToggleEditor={() => (editing ? closeEditor() : openEditor())}
        showControls={settings.showControls}
        onShowControls={(v) => commitSettings({ ...settings, showControls: v })}
        quality={quality}
        onQuality={changeQuality}
        exit={
          usbMode
            ? { label: "Sair do USB", onClick: leaveUsb }
            : !stream
              ? {
                  label: "Sair da pré-visualização",
                  onClick: () => {
                    closeEditor();
                    setPreview(false);
                  },
                }
              : undefined
        }
      />
      <div className="flex min-h-0 flex-1 flex-col md:flex-row">
        <main ref={stageRef} data-testid="stage" className="relative min-h-0 min-w-0 flex-1 overflow-hidden bg-black">
          <div
            ref={boxRef}
            data-testid="video-box"
            className="absolute"
            style={{ left: box.left, top: box.top, width: box.width, height: box.height }}
          >
            {usbMode && (
              <canvas
                ref={(el) => {
                  canvasRef.current = el;
                  usbSession?.setCanvas(el);
                }}
                data-testid="usb-canvas"
                className="absolute inset-0 h-full w-full bg-black"
              />
            )}
            {!stream && !usbMode && (
              <div className="absolute inset-0 flex items-center justify-center bg-zinc-800 text-center text-sm text-zinc-400">
                Pré-visualização (sem celular)
                <br />
                Retrato/Paisagem na barra trocam o layout editado
              </div>
            )}
            <video
              ref={videoRef}
              autoPlay
              playsInline
              muted
              onResize={(e) => {
                const v = e.currentTarget;
                if (v.videoWidth && v.videoHeight) {
                  setAspect(v.videoWidth / v.videoHeight);
                  setVideoReady(true);
                }
              }}
              onLoadedMetadata={(e) => {
                const v = e.currentTarget;
                if (v.videoWidth && v.videoHeight) {
                  setAspect(v.videoWidth / v.videoHeight);
                  setVideoReady(true);
                }
              }}
              className={`absolute inset-0 h-full w-full object-contain ${stream && !usbMode ? "" : "hidden"}`}
            />
            <ControlsOverlay
              layout={layout}
              width={box.width}
              height={box.height}
              editing={editing}
              show={settings.showControls}
              opacity={settings.opacity}
              locked={modeState.mode === "locked"}
              selected={selected}
              placing={!!placing}
              onSelect={setSelected}
              onMove={moveControl}
              onPlace={onPlace}
            />
          </div>
        </main>
        {editing && (
          <MapperPanel
            store={store}
            orientation={orientation}
            layout={layout}
            settings={settings}
            selected={selected}
            capture={capture}
            placing={placing}
            showGuide={!layout.confirmed}
            onSelect={setSelected}
            onCapture={setCapture}
            onPlacing={setPlacing}
            onStore={(s) => commitStore(() => s)}
            onLayout={editLayout}
            onSettings={commitSettings}
            onReset={() => {
              editLayout(() => defaultLayout(orientation));
              setSelected(null);
            }}
            onClose={closeEditor}
          />
        )}
      </div>
    </div>
  );
}
