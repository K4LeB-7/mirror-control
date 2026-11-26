/**
 * Transporte abstrato do modo USB: um canal de bytes de/para o celular. A implementação real (ADB sobre WebUSB,
 * lib/adbTransport.ts) é carregada sob demanda; os testes e2e injetam uma falsa (window.__mirrorUsbTestOpener).
 * Este arquivo não importa a biblioteca ADB.
 */
export interface ByteChannel {
  /** Próximo pedaço recebido (qualquer tamanho), ou undefined quando o canal fechou. */
  read(): Promise<Uint8Array | undefined>;
  write(data: Uint8Array): Promise<void>;
  close(): void;
}

export interface ChannelOpener {
  /** Abre uma conexão nova com o app (reconecta o USB/ADB se preciso). Lança UsbConnectError. */
  open(note: (msg: string) => void): Promise<ByteChannel>;
  /** Libera o aparelho (o `adb` do PC volta a poder usá-lo). */
  dispose(): void;
}

export type UsbErrorCode =
  | "NO_WEBUSB" // navegador sem WebUSB
  | "NO_DEVICE" // cabo solto / aparelho sumiu
  | "BUSY" // interface ADB presa por outro programa (adb do PC)
  | "AUTH" // falha na autorização da depuração USB
  | "APP_NOT_RUNNING" // ninguém escutando na porta 27183 do celular
  | "OTHER";

export class UsbConnectError extends Error {
  code: UsbErrorCode;
  fatal: boolean;
  constructor(code: UsbErrorCode, message: string, fatal = false) {
    super(message);
    this.code = code;
    this.fatal = fatal;
  }
}

/** Interface ADB padrão do Google (classe 0xFF, subclasse 0x42, protocolo 1). */
export const ADB_USB_FILTER = { classCode: 0xff, subclassCode: 0x42, protocolCode: 1 };

export const webUsbSupported = () => typeof navigator !== "undefined" && "usb" in navigator;

export const MSG = {
  noWebUsb:
    "Este navegador não tem WebUSB. Use o Google Chrome ou o Microsoft Edge no computador (Firefox/Safari não funcionam), em https:// ou localhost.",
  busy:
    "A interface \"Android ADB Interface\" está em uso por outro programa no PC (normalmente o adb, Android Studio, scrcpy ou Vysor). Feche-os ou rode `adb kill-server` no PC; a conexão tenta de novo sozinha.",
  noDevice: "Celular não encontrado no USB. Confira o cabo (de dados) e se a Depuração USB está ligada; reconectando…",
  auth: "Confirme \"Permitir depuração USB\" no celular (marque \"Sempre permitir deste computador\").",
  appNotRunning:
    "O celular respondeu pelo ADB, mas o app não está em modo USB. Abra o Mirror Control e toque em \"Iniciar modo USB (ADB)\"; tentando de novo…",
};

/**
 * Abre o seletor do Chrome com os aparelhos ADB. Deve ser chamado direto no clique (exige gesto do usuário).
 * Devolve undefined se o usuário cancelar.
 */
export async function requestUsbDevice(): Promise<USBDevice | undefined> {
  if (!webUsbSupported()) throw new UsbConnectError("NO_WEBUSB", MSG.noWebUsb, true);
  try {
    return await navigator.usb.requestDevice({ filters: [ADB_USB_FILTER] });
  } catch (e) {
    if (e instanceof DOMException && e.name === "NotFoundError") return undefined; // cancelou / nenhum aparelho
    if (e instanceof DOMException && e.name === "SecurityError")
      throw new UsbConnectError("NO_WEBUSB", "WebUSB bloqueado nesta página (precisa de HTTPS e de um clique).", true);
    throw new UsbConnectError("OTHER", String(e), true);
  }
}
