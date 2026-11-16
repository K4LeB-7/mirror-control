"use client";
import type { UsbSessionState } from "@/lib/usbSession";

const PIN_RE = /^\d{6}$/;

type CardProps = {
  pin: string;
  onPin: (pin: string) => void;
  onConnect: () => void;
  /** Erro antes de existir sessão (WebUSB indisponível, seletor cancelado…). */
  note?: string;
  busy?: boolean;
};

/** Cartão da tela inicial: PIN + botão (o clique é o gesto que o WebUSB exige para abrir o seletor). */
export function UsbConnectCard({ pin, onPin, onConnect, note, busy }: CardProps) {
  const ok = PIN_RE.test(pin);
  return (
    <section className="w-full rounded-xl border border-indigo-700/60 bg-indigo-950/40 p-4 text-sm">
      <h2 className="font-semibold">Conectar por cabo USB (ADB) — sem Wi-Fi e sem instalar nada</h2>
      <p className="mt-1 text-xs text-zinc-400">
        Chrome ou Edge no computador. No celular: Depuração USB ligada e, no app, <b>Iniciar modo USB (ADB)</b>.
        Digite o PIN que o app mostra.
      </p>
      <div className="mt-3 flex items-center gap-2">
        <input
          value={pin}
          onChange={(e) => onPin(e.target.value.replace(/\D/g, "").slice(0, 6))}
          onKeyDown={(e) => e.key === "Enter" && ok && !busy && onConnect()}
          inputMode="numeric"
          autoComplete="off"
          placeholder="PIN do app"
          aria-label="PIN do modo USB"
          className="w-32 rounded bg-zinc-800 px-2 py-1 text-center font-mono text-lg tracking-widest"
        />
        <button
          className="rounded bg-indigo-600 px-3 py-2 font-semibold hover:bg-indigo-500 disabled:opacity-40"
          disabled={!ok || busy}
          onClick={onConnect}
        >
          Conectar por USB (ADB)
        </button>
      </div>
      {note && <p className="mt-2 text-red-400">{note}</p>}
    </section>
  );
}

const peerText: Record<UsbSessionState["peer"], string> = {
  waiting: "Aguardando…",
  connecting: "Conectando pelo cabo USB…",
  connected: "Conectado",
  disconnected: "Conexão USB perdida; tentando de novo…",
  failed: "Não conectado",
};

type PanelProps = CardProps & { state: UsbSessionState; onBack: () => void };

/** Tela do modo USB enquanto ainda não há vídeo (conectando, PIN errado, app parado…). */
export default function UsbPanel({ state, onBack, ...card }: PanelProps) {
  return (
    <main className="mx-auto flex min-h-screen max-w-xl flex-col items-center justify-center gap-5 p-6">
      <h1 className="text-2xl font-bold">Mirror Control — modo USB</h1>
      <p data-testid="usb-peer" className="text-sm">
        Estado: <b>{peerText[state.peer]}</b>
      </p>
      {state.error && (
        <p data-testid="usb-error" className="w-full rounded bg-red-950/60 p-3 text-sm text-red-300">
          {state.error}
        </p>
      )}
      {state.peer === "failed" && <UsbConnectCard {...card} />}
      <button className="rounded bg-zinc-800 px-3 py-1 text-sm hover:bg-zinc-700" onClick={onBack}>
        Voltar (modo Wi-Fi / QR)
      </button>
      <details className="w-full rounded bg-zinc-900 p-3 text-xs text-zinc-300" open>
        <summary className="cursor-pointer select-none text-zinc-400">Diagnóstico da conexão USB</summary>
        <pre data-testid="usb-log" className="mt-2 whitespace-pre-wrap font-mono">
          {state.log.length ? state.log.join("\n") : "Sem eventos ainda."}
        </pre>
        <ul className="mt-2 list-disc space-y-1 pl-5 text-zinc-400">
          <li>Seletor vazio: use cabo de dados, ligue a Depuração USB e feche o adb do PC (<code>adb kill-server</code>).</li>
          <li>&quot;Interface em uso&quot;: Android Studio, scrcpy, Vysor ou o adb estão abertos no PC — feche-os.</li>
          <li>Nada acontece após escolher o aparelho: desbloqueie o celular e aceite &quot;Permitir depuração USB&quot;.</li>
        </ul>
      </details>
    </main>
  );
}
