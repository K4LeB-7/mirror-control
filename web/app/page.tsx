"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import ConnectPanel from "@/components/ConnectPanel";
import MapperOverlay from "@/components/MapperOverlay";
import UsbPanel from "@/components/UsbPanel";
import { InputController } from "@/lib/inputController";
import { DEFAULT_LAYOUT, Layout, loadLayout, saveLayout } from "@/lib/layout";
import { RemoteSession, SessionState } from "@/lib/session";
import type { UsbSession, UsbSessionState } from "@/lib/usbSession";
import { ChannelOpener, UsbConnectError, requestUsbDevice } from "@/lib/usbTransport";

const ROOM_KEY = "mirror-control.room";

function newRoomId() {
  const alphabet = "abcdefghijkmnpqrstuvwxyz23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(10));
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join("");
}

export default function Page() {
  const [roomId, setRoomId] = useState("");
  const [state, setState] = useState<SessionState>({ signaling: "connecting", peer: "waiting", log: [] });
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [layout, setLayout] = useState<Layout>(DEFAULT_LAYOUT);
  const [editing, setEditing] = useState(false);
  const [preview, setPreview] = useState(false); // editor de teclas sem celular conectado
  const [locked, setLocked] = useState(false);
  const [aspect, setAspect] = useState(16 / 9);
  const [quality, setQuality] = useState({ height: 720, fps: 60 });
  // Modo USB (ADB via WebUSB). Em modo USB a sessão WebRTC fica fechada (um modo por vez, como no app).
  const [mode, setMode] = useState<"webrtc" | "usb">("webrtc");
  const [usbSession, setUsbSession] = useState<UsbSession | null>(null);
  const [usbState, setUsbState] = useState<UsbSessionState | null>(null);
  const [usbPin, setUsbPin] = useState("");
  const [usbNote, setUsbNote] = useState<string | undefined>();
  const [usbBusy, setUsbBusy] = useState(false);

  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const sessionRef = useRef<RemoteSession | null>(null);
  const layoutRef = useRef(layout);
  const aspectRef = useRef(aspect);
  const lockedRef = useRef(false);
  layoutRef.current = layout;
  aspectRef.current = aspect;

  // Sala estável entre recarregamentos (o QR continua válido).
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
    setLayout(loadLayout());
  }, []);

  // Sessão WebRTC + controlador de entrada.
  useEffect(() => {
    if (!roomId || mode !== "webrtc") return;
    const session = new RemoteSession(roomId, { onState: setState, onStream: setStream });
    sessionRef.current = session;
    const input = new InputController(
      session,
      () => layoutRef.current,
      () => aspectRef.current,
      () => lockedRef.current
    );
    input.attach();
    const onLockChange = () => {
      const isLocked = document.pointerLockElement === videoRef.current && !!videoRef.current;
      lockedRef.current = isLocked;
      setLocked(isLocked);
      if (!isLocked) input.releaseAll();
    };
    document.addEventListener("pointerlockchange", onLockChange);
    return () => {
      document.removeEventListener("pointerlockchange", onLockChange);
      input.detach();
      session.close();
      sessionRef.current = null;
    };
  }, [roomId, mode]);

  // Sessão USB: mesmo controlador de entrada, com o <canvas> como alvo do Pointer Lock.
  useEffect(() => {
    if (!usbSession) return;
    const input = new InputController(
      usbSession,
      () => layoutRef.current,
      () => aspectRef.current,
      () => lockedRef.current
    );
    input.attach();
    const onLockChange = () => {
      const isLocked = !!canvasRef.current && document.pointerLockElement === canvasRef.current;
      lockedRef.current = isLocked;
      setLocked(isLocked);
      if (!isLocked) input.releaseAll();
    };
    document.addEventListener("pointerlockchange", onLockChange);
    return () => {
      document.removeEventListener("pointerlockchange", onLockChange);
      input.detach();
      usbSession.close();
    };
  }, [usbSession]);

  // Proporção do canvas = a do vídeo que o celular anunciou (INFO).
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
  }, [stream]);

  // Reenvia a qualidade quando o celular (re)conecta.
  useEffect(() => {
    if (state.peer === "connected") {
      const t = setTimeout(() => sessionRef.current?.sendCtrl({ type: "quality", ...quality }), 500);
      return () => clearTimeout(t);
    }
  }, [state.peer, quality]);

  const updateLayout = useCallback((l: Layout) => {
    setLayout(l);
    saveLayout(l);
  }, []);

  const changeQuality = (height: number, fps: number) => setQuality({ height, fps });

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
      const s = new UsbSession(opener, usbPin, { onState: setUsbState });
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

  const requestLock = () => {
    if (editing) return;
    const el: HTMLElement | null = mode === "usb" ? canvasRef.current : videoRef.current;
    // @ts-expect-error unadjustedMovement é suportado no Chromium (mouse sem aceleração)
    el?.requestPointerLock({ unadjustedMovement: true })?.catch?.(() => el?.requestPointerLock());
  };

  if (!roomId) return null;

  const usbMode = mode === "usb" && !!usbState;
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

  return (
    <div className="flex h-screen w-screen items-center justify-center bg-black">
      <div
        className="relative"
        style={{ aspectRatio: String(aspect), width: `min(100vw, calc(100vh * ${aspect}))` }}
      >
        {usbMode && (
          <canvas
            ref={(el) => {
              canvasRef.current = el;
              usbSession?.setCanvas(el);
            }}
            data-testid="usb-canvas"
            onClick={requestLock}
            className="absolute inset-0 h-full w-full cursor-pointer bg-black"
          />
        )}
        {!stream && !usbMode && (
          <div className="absolute inset-0 flex items-center justify-center bg-zinc-800 text-sm text-zinc-400">
            Pré-visualização (sem celular conectado)
          </div>
        )}
        <video
          ref={videoRef}
          autoPlay
          playsInline
          muted
          onClick={requestLock}
          onResize={(e) => {
            const v = e.currentTarget;
            if (v.videoWidth && v.videoHeight) setAspect(v.videoWidth / v.videoHeight);
          }}
          onLoadedMetadata={(e) => {
            const v = e.currentTarget;
            if (v.videoWidth && v.videoHeight) setAspect(v.videoWidth / v.videoHeight);
          }}
          className={`absolute inset-0 h-full w-full cursor-pointer ${stream && !usbMode ? "" : "hidden"}`}
        />
        <MapperOverlay layout={layout} editing={editing} onChange={updateLayout} />

        <div className="absolute right-2 top-2 flex items-center gap-2 text-xs">
          {!locked && !editing && (
            <span className="rounded bg-black/70 px-2 py-1">Clique no vídeo para capturar o mouse (ESC solta)</span>
          )}
          {stream && !usbMode && state.peer !== "connected" && (
            <span className="rounded bg-amber-700 px-2 py-1">Reconectando…</span>
          )}
          {usbMode && usbState.peer !== "connected" && (
            <span data-testid="usb-reconnecting" className="max-w-xs rounded bg-amber-700 px-2 py-1">
              {usbState.peer === "failed" ? usbState.error ?? "USB desconectado" : "USB: reconectando…"}
            </span>
          )}
          {usbMode && (
            <button className="rounded bg-black/70 px-2 py-1 hover:bg-black" onClick={leaveUsb}>
              Sair do USB
            </button>
          )}
          <button
            className="rounded bg-black/70 px-2 py-1 hover:bg-black"
            onClick={() => {
              if (document.pointerLockElement) document.exitPointerLock();
              setEditing((v) => !v);
            }}
          >
            {editing ? "Concluir" : "Mapear teclas"}
          </button>
          {preview && !stream && (
            <button
              className="rounded bg-black/70 px-2 py-1 hover:bg-black"
              onClick={() => {
                setEditing(false);
                setPreview(false);
              }}
            >
              Voltar
            </button>
          )}
          {editing && (
            <button className="rounded bg-black/70 px-2 py-1" onClick={() => updateLayout(structuredClone(DEFAULT_LAYOUT))}>
              Restaurar
            </button>
          )}
          <select
            className="rounded bg-black/70 p-1"
            value={`${quality.height}p${quality.fps}`}
            onChange={(e) => {
              const m = /(\d+)p(\d+)/.exec(e.target.value)!;
              changeQuality(Number(m[1]), Number(m[2]));
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
        </div>
      </div>
    </div>
  );
}
