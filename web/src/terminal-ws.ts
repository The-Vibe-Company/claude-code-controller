let socket: WebSocket | null = null;
let onDataCallback: ((data: Uint8Array) => void) | null = null;
let onExitCallback: ((exitCode: number) => void) | null = null;
let onErrorCallback: ((message: string) => void) | null = null;

export function connectTerminal(
  terminalId: string,
  onData: (data: Uint8Array) => void,
  onExit: (exitCode: number) => void,
  onError?: (message: string) => void,
  onOpen?: () => void,
): void {
  disconnectTerminal();

  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const wsUrl = `${protocol}//${window.location.host}/ws/terminal/${terminalId}`;

  onDataCallback = onData;
  onExitCallback = onExit;
  onErrorCallback = onError ?? null;

  socket = new WebSocket(wsUrl);
  socket.binaryType = "arraybuffer";

  socket.onopen = () => {
    onOpen?.();
  };

  socket.onmessage = (event) => {
    if (event.data instanceof ArrayBuffer) {
      onDataCallback?.(new Uint8Array(event.data));
    } else {
      try {
        const msg = JSON.parse(event.data);
        if (msg.type === "exit") {
          onExitCallback?.(msg.exitCode);
        }
      } catch {
        // not JSON, ignore
      }
    }
  };

  socket.onerror = () => {
    onErrorCallback?.("Terminal WebSocket connection error");
  };

  socket.onclose = (event) => {
    if (!event.wasClean) {
      onErrorCallback?.("Terminal connection lost");
    }
  };
}

export function sendTerminalInput(data: string): void {
  if (socket?.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({ type: "input", data }));
  }
}

export function sendTerminalResize(cols: number, rows: number): void {
  if (socket?.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({ type: "resize", cols, rows }));
  }
}

export function disconnectTerminal(): void {
  socket?.close();
  socket = null;
  onDataCallback = null;
  onExitCallback = null;
  onErrorCallback = null;
}
