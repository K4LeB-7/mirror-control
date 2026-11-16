"use client";
import QRCode from "qrcode";
import { useEffect, useState } from "react";
import type { SessionState } from "@/lib/session";
import { UsbConnectCard } from "./UsbPanel";

const APK_URL = process.env.NEXT_PUBLIC_APK_URL ||
  "https://github.com/K4LeB-7/mirror-control/raw/main/apk/mirror-control.apk";

type Props = {
  roomId: string;
  state: SessionState;
  height: number;
  fps: number;
  onQuality: (height: number, fps: number) => void;
  onNewRoom: () => void;
  onOpenMapper: () => void;
  /** Usa o ID digitado (por exemplo o que já está no app Android). */
  onSetRoom: (id: string) => void;
  /** Modo USB (ADB/WebUSB): PIN digitado, clique em conectar e erro antes da sessão existir. */
  usbPin: string;
  onUsbPin: (pin: string) => void;
  onUsbConnect: () => void;
  usbNote?: string;
};

const peerText: Record<SessionState["peer"], string> = {
  waiting: "Aguardando o celular…",
  connecting: "Conectando ao celular…",
  connected: "Conectado",
  disconnected: "Conexão instável, tentando recuperar…",
  failed: "Conexão perdida. O app tentará reconectar.",
};

export default function ConnectPanel({
  roomId, state, height, fps, onQuality, onNewRoom, onOpenMapper, onSetRoom, usbPin, onUsbPin, onUsbConnect, usbNote,
}: Props) {
  const [qr, setQr] = useState("");
  const [typed, setTyped] = useState("");
  const typedId = typed.trim().toLowerCase();
  const typedOk = /^[a-z0-9]{6,32}$/.test(typedId);

  useEffect(() => {
    QRCode.toDataURL(roomId, { margin: 1, width: 240 }).then(setQr).catch(() => setQr(""));
  }, [roomId]);

  return (
    <main className="mx-auto flex min-h-screen max-w-xl flex-col items-center justify-center gap-6 p-6">
      <h1 className="text-2xl font-bold">Mirror Control</h1>
      <p className="text-center text-sm text-zinc-400">
        Abra o app Android, toque em <b>Escanear QR</b> (ou digite o ID) e inicie o espelhamento.
      </p>

      <a
        href={APK_URL}
        download
        className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold hover:bg-emerald-500"
      >
        ⬇ Baixar app Android (APK)
      </a>

      <div className="rounded-xl bg-white p-3">
        {qr ? <img src={qr} alt="QR da sala" width={240} height={240} /> : <div className="h-60 w-60" />}
      </div>

      <div className="text-center">
        <div className="text-xs uppercase tracking-wider text-zinc-500">ID da sala</div>
        <code className="select-all text-3xl font-mono tracking-widest">{roomId}</code>
      </div>

      <div className="flex w-full max-w-sm items-center gap-2 text-sm">
        <input
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          placeholder="ID que já está no app (opcional)"
          autoCapitalize="none"
          spellCheck={false}
          className="min-w-0 flex-1 rounded bg-zinc-800 px-2 py-1 font-mono"
        />
        <button
          className="rounded bg-emerald-700 px-3 py-1 disabled:opacity-40"
          disabled={!typedOk || typedId === roomId}
          onClick={() => onSetRoom(typedId)}
        >
          Usar este ID
        </button>
      </div>

      <div className="flex gap-4 text-sm">
        <span>Sinalização: <b>{state.signaling}</b></span>
        <span>Celular: <b>{peerText[state.peer]}</b></span>
      </div>
      {state.error && <p className="text-sm text-red-400">{state.error}</p>}

      <div className="flex flex-wrap items-center justify-center gap-4 text-sm">
        <label className="flex items-center gap-2">
          Resolução
          <select
            className="rounded bg-zinc-800 p-1"
            value={height}
            onChange={(e) => onQuality(Number(e.target.value), fps)}
          >
            <option value={720}>720p</option>
            <option value={1080}>1080p</option>
          </select>
        </label>
        <label className="flex items-center gap-2">
          FPS
          <select
            className="rounded bg-zinc-800 p-1"
            value={fps}
            onChange={(e) => onQuality(height, Number(e.target.value))}
          >
            <option value={30}>30</option>
            <option value={60}>60</option>
          </select>
        </label>
        <button className="rounded bg-zinc-800 px-3 py-1 hover:bg-zinc-700" onClick={onNewRoom}>
          Novo ID
        </button>
        <button className="rounded bg-sky-700 px-3 py-1 hover:bg-sky-600" onClick={onOpenMapper}>
          Mapear teclas e mouse
        </button>
      </div>

      <UsbConnectCard pin={usbPin} onPin={onUsbPin} onConnect={onUsbConnect} note={usbNote} />

      <details className="w-full rounded bg-zinc-900 p-3 text-xs text-zinc-300">
        <summary className="cursor-pointer select-none text-zinc-400">Cabo USB por tethering (rede pelo cabo, modo WebRTC)</summary>
        <ol className="mt-2 list-decimal space-y-1 pl-5">
          <li>Ligue o celular ao PC com um cabo USB <b>de dados</b>.</li>
          <li>
            No celular: <b>Configurações → Conexão e compartilhamento → Ponto de acesso portátil → Tethering USB</b>.
          </li>
          <li>No Windows, se perguntar sobre a rede nova, escolha <b>Rede privada</b>.</li>
          <li>No app, a linha <b>Cabo USB</b> deve mostrar um IP (ex.: 192.168.42.x). Depois é só iniciar o espelhamento.</li>
        </ol>
      </details>

      <details className="w-full rounded bg-zinc-900 p-3 text-xs text-zinc-300" open={state.peer !== "connected"}>
        <summary className="cursor-pointer select-none text-zinc-400">Diagnóstico da conexão</summary>
        <pre className="mt-2 whitespace-pre-wrap font-mono">
          {state.log.length ? state.log.join("\n") : "Sem eventos ainda."}
        </pre>
      </details>
    </main>
  );
}
