/**
 * Transporte real do modo USB: ADB direto pelo cabo via WebUSB (Tango / @yume-chan/adb), sem instalar nada no PC.
 * Abre o serviço ADB `tcp:27183`, que o adbd do celular liga ao ServerSocket 127.0.0.1:27183 do app.
 *
 * Só é carregado por import() dinâmico (não pesa o modo WebRTC nem roda no SSR).
 */
import { Adb, AdbDaemonTransport } from "@yume-chan/adb";
import AdbWebCredentialStore from "@yume-chan/adb-credential-web";
import { AdbDaemonWebUsbDevice, AdbDaemonWebUsbDeviceManager } from "@yume-chan/adb-daemon-webusb";
import { ADB_USB_FILTER, ByteChannel, ChannelOpener, MSG, UsbConnectError } from "./usbTransport";
import { USB_PORT } from "./usbWire";

/** Chave RSA do "computador" guardada no IndexedDB deste site; o celular pede para autorizá-la uma vez. */
const credentialStore = new AdbWebCredentialStore("Mirror Control");

function isName(e: unknown, name: string) {
  return typeof e === "object" && e !== null && (e as { name?: string }).name === name;
}

export function createAdbOpener(device: USBDevice): ChannelOpener {
  const serial = device.serialNumber ?? "";
  let adb: Adb | null = null;
  let alive = false;
  let disposed = false;

  const ensureAdb = async (note: (m: string) => void): Promise<Adb> => {
    if (adb && alive) return adb;
    if (adb) {
      void Promise.resolve(adb.close()).catch(() => {});
      adb = null;
    }
    const manager = AdbDaemonWebUsbDeviceManager.BROWSER;
    if (!manager) throw new UsbConnectError("NO_WEBUSB", MSG.noWebUsb, true);
    // Depois de soltar e recolocar o cabo, o Chrome devolve o mesmo aparelho (permissão já dada) com outro objeto.
    const devices = await manager.getDevices({ filters: [ADB_USB_FILTER] });
    const dev = devices.find((d) => d.serial === serial) ?? (serial ? undefined : devices[0]);
    if (!dev) throw new UsbConnectError("NO_DEVICE", MSG.noDevice);

    let connection;
    try {
      connection = await dev.connect();
    } catch (e) {
      if (e instanceof AdbDaemonWebUsbDevice.DeviceBusyError) throw new UsbConnectError("BUSY", MSG.busy);
      if (isName(e, "NotFoundError") || isName(e, "NetworkError")) throw new UsbConnectError("NO_DEVICE", MSG.noDevice);
      if (isName(e, "SecurityError"))
        throw new UsbConnectError("BUSY", "O Windows/Chrome negou acesso ao aparelho. " + MSG.busy);
      throw new UsbConnectError("OTHER", `Falha ao abrir o USB: ${String(e)}`);
    }

    note("ADB: autenticando… " + MSG.auth);
    const slow = setTimeout(
      () => note("Ainda aguardando a autorização no celular. Desbloqueie a tela e toque em Permitir. Se recusou, solte e recoloque o cabo."),
      8000
    );
    let transport: AdbDaemonTransport;
    try {
      transport = await AdbDaemonTransport.authenticate({ serial: dev.serial, connection, credentialStore });
    } catch (e) {
      throw new UsbConnectError("AUTH", `Autorização ADB falhou: ${String(e)}. ${MSG.auth}`);
    } finally {
      clearTimeout(slow);
    }
    if (disposed) {
      void Promise.resolve(transport.close()).catch(() => {});
      throw new UsbConnectError("OTHER", "cancelado", true);
    }
    const a = new Adb(transport);
    adb = a;
    alive = true;
    a.disconnected.then(
      () => adb === a && (alive = false),
      () => adb === a && (alive = false)
    );
    note(`ADB conectado: ${dev.name || dev.serial}`);
    return a;
  };

  return {
    async open(note) {
      const a = await ensureAdb(note);
      let socket;
      try {
        socket = await a.createSocket(`tcp:${USB_PORT}`);
      } catch (e) {
        if (!alive) throw new UsbConnectError("NO_DEVICE", MSG.noDevice);
        // O adbd recusa (CLSE) quando nada escuta na porta: o app não está em modo USB.
        throw new UsbConnectError("APP_NOT_RUNNING", MSG.appNotRunning);
      }
      const reader = socket.readable.getReader();
      const writer = socket.writable.getWriter();
      let closed = false;
      const channel: ByteChannel = {
        async read() {
          if (closed) return undefined;
          try {
            const r = await reader.read();
            return r.done ? undefined : r.value;
          } catch {
            return undefined;
          }
        },
        async write(data) {
          if (closed) throw new Error("canal fechado");
          await writer.write(data);
        },
        close() {
          if (closed) return;
          closed = true;
          // Fechar o socket ADB encerra os dois sentidos; uma leitura pendente termina com done.
          void Promise.resolve(socket.close()).catch(() => {});
        },
      };
      return channel;
    },
    dispose() {
      disposed = true;
      alive = false;
      if (adb) void Promise.resolve(adb.close()).catch(() => {});
      adb = null;
    },
  };
}
