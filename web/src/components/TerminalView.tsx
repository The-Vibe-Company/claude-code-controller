import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { useStore } from "../store.js";
import { api } from "../api.js";
import {
  connectTerminal,
  sendTerminalInput,
  sendTerminalResize,
  disconnectTerminal,
} from "../terminal-ws.js";

interface TerminalViewProps {
  cwd: string;
  onClose?: () => void;
  embedded?: boolean;
}

function getTerminalTheme(dark: boolean) {
  return {
    background: dark ? "#141413" : "#1e1e1e",
    foreground: "#d4d4d4",
    cursor: "#d4d4d4",
    selectionBackground: "rgba(255, 255, 255, 0.2)",
  };
}

export function TerminalView({ cwd, onClose, embedded = false }: TerminalViewProps) {
  const terminalRef = useRef<HTMLDivElement>(null);
  const xtermRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const darkMode = useStore((s) => s.darkMode);

  // Main effect: create xterm + spawn PTY — only depends on cwd
  useEffect(() => {
    if (!terminalRef.current) return;

    let cancelled = false;

    const xterm = new Terminal({
      cursorBlink: true,
      fontSize: 13,
      fontFamily:
        "'SF Mono', 'Monaco', 'Menlo', 'Courier New', monospace",
      theme: getTerminalTheme(useStore.getState().darkMode),
    });

    const fit = new FitAddon();
    xterm.loadAddon(fit);
    xterm.open(terminalRef.current);

    xtermRef.current = xterm;
    fitRef.current = fit;

    // Spawn terminal on server then connect WebSocket
    api
      .spawnTerminal(cwd, xterm.cols, xterm.rows)
      .then(({ terminalId }) => {
        if (cancelled) return;
        useStore.getState().setTerminalId(terminalId);

        connectTerminal(
          terminalId,
          (data) => xterm.write(data),
          (exitCode) => {
            xterm.writeln(`\r\n[Process exited with code ${exitCode}]`);
          },
          (errMsg) => {
            xterm.writeln(`\r\n[${errMsg}]`);
          },
          () => {
            // WebSocket is now open — send the actual fitted dimensions
            // (ResizeObserver may have fired before the socket was ready)
            fit.fit();
            sendTerminalResize(xterm.cols, xterm.rows);
          },
        );
      })
      .catch((err) => {
        if (cancelled) return;
        xterm.writeln(`\r\n[Failed to start terminal: ${err.message}]`);
      });

    // Forward xterm input to server
    const inputDisposable = xterm.onData((data) => sendTerminalInput(data));

    // Handle resize — also handles initial sizing once layout is ready
    const container = terminalRef.current;
    const resizeObserver = new ResizeObserver(() => {
      fit.fit();
      sendTerminalResize(xterm.cols, xterm.rows);
    });
    resizeObserver.observe(container);

    return () => {
      cancelled = true;
      resizeObserver.disconnect();
      inputDisposable.dispose();
      disconnectTerminal();
      xterm.dispose();
      xtermRef.current = null;
      fitRef.current = null;
      api.killTerminal().catch(() => {});
    };
  }, [cwd]);

  // Separate effect: update theme without recreating the terminal
  useEffect(() => {
    if (xtermRef.current) {
      xtermRef.current.options.theme = getTerminalTheme(darkMode);
    }
  }, [darkMode]);

  const terminalFrame = (
    <div
      className={`flex flex-col rounded-[14px] shadow-2xl overflow-hidden border border-cc-border ${
        embedded ? "h-full" : "w-[90vw] max-w-4xl h-[70vh]"
      }`}
      style={{ background: darkMode ? "#141413" : "#1e1e1e" }}
      onClick={(e) => e.stopPropagation()}
    >
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-2 border-b border-cc-border bg-cc-sidebar shrink-0">
        <div className="flex items-center gap-2 min-w-0">
          <svg
            viewBox="0 0 16 16"
            fill="currentColor"
            className="w-4 h-4 text-cc-muted shrink-0"
          >
            <path d="M2 3a1 1 0 011-1h10a1 1 0 011 1v10a1 1 0 01-1 1H3a1 1 0 01-1-1V3zm2 1.5l3 2.5-3 2.5V4.5zM8.5 10h3v1h-3v-1z" />
          </svg>
          <span className="text-xs text-cc-muted font-mono-code truncate">
            {cwd}
          </span>
        </div>
        {onClose && (
          <button
            onClick={onClose}
            className="w-6 h-6 flex items-center justify-center rounded-md text-cc-muted hover:text-cc-fg hover:bg-cc-hover transition-colors cursor-pointer shrink-0"
          >
            <svg
              viewBox="0 0 16 16"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              className="w-3.5 h-3.5"
            >
              <path d="M4 4l8 8M12 4l-8 8" strokeLinecap="round" />
            </svg>
          </button>
        )}
      </div>

      {/* Terminal container */}
      <div ref={terminalRef} className="flex-1 min-h-0 p-1" />
    </div>
  );

  if (embedded) {
    return (
      <div className="h-full">
        {terminalFrame}
      </div>
    );
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      {terminalFrame}
    </div>
  );
}
