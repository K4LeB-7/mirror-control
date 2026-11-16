"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import ConnectPanel from "@/components/ConnectPanel";
import MapperOverlay from "@/components/MapperOverlay";
import { InputController } from "@/lib/inputController";
import { DEFAULT_LAYOUT, Layout, loadLayout, saveLayout } from "@/lib/layout";
import { RemoteSession, SessionState } from "@/lib/session";

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

  const videoRef = useRef<HTMLVideoElement>(null);
  const sessionRef = useRef<RemoteSession | null>(null);
  const layoutRef = useRef(layout);
  const aspectRef = useRef(aspect);
  const lockedRef = useRef(false);
  layoutRef.current = layout;
  aspectRef.current = aspect;

  // Sala estável entre recarregamentos (o QR continua válido).
  useEffect(() => {
    let id = "";
    try {
      id = localStorage.getItem(ROOM_KEY) || "";
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
    if (!roomId) return;
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
  }, [roomId]);

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

  const newRoom = () => {
    const id = newRoomId();
    try {
      localStorage.setItem(ROOM_KEY, id);
    } catch {}
    setStream(null);
    setState({ signaling: "connecting", peer: "waiting", log: [] });
    setRoomId(id);
  };

  const requestLock = () => {
    if (editing) return;
    // @ts-expect-error unadjustedMovement é suportado no Chromium (mouse sem aceleração)
    videoRef.current?.requestPointerLock({ unadjustedMovement: true })?.catch?.(() =>
      videoRef.current?.requestPointerLock()
    );
  };

  if (!roomId) return null;

  if (!stream && !preview) {
    return (
      <ConnectPanel
        roomId={roomId}
        state={state}
        height={quality.height}
        fps={quality.fps}
        onQuality={changeQuality}
        onNewRoom={newRoom}
        onOpenMapper={() => {
          setAspect(20 / 9);
          setEditing(true);
          setPreview(true);
        }}
      />
    );
  }

  return (
    <div className="flex h-screen w-screen items-center justify-center bg-black">
      <div
        className="relative"
        style={{ aspectRatio: String(aspect), width: `min(100vw, calc(100vh * ${aspect}))` }}
      >
        {!stream && (
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
          className={`absolute inset-0 h-full w-full cursor-pointer ${stream ? "" : "hidden"}`}
        />
        <MapperOverlay layout={layout} editing={editing} onChange={updateLayout} />

        <div className="absolute right-2 top-2 flex items-center gap-2 text-xs">
          {!locked && !editing && (
            <span className="rounded bg-black/70 px-2 py-1">Clique no vídeo para capturar o mouse (ESC solta)</span>
          )}
          {stream && state.peer !== "connected" && (
            <span className="rounded bg-amber-700 px-2 py-1">Reconectando…</span>
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
