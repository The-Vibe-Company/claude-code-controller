import { useState, useEffect, useRef } from "react";
import { useStore } from "../store.js";
import { api } from "../api.js";
import type { TunnelStatusResponse } from "../api.js";

export function TunnelIndicator() {
  const tunnelStatus = useStore((s) => s.tunnelStatus);
  const [showPanel, setShowPanel] = useState(false);
  const [initialStatus, setInitialStatus] = useState<TunnelStatusResponse | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  // Fetch initial tunnel status on mount
  useEffect(() => {
    api.getTunnelStatus().then(setInitialStatus).catch(() => {});
  }, []);

  // Close panel on outside click
  useEffect(() => {
    if (!showPanel) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setShowPanel(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [showPanel]);

  const configured = initialStatus?.configured ?? false;
  const installed = initialStatus?.cloudflaredInstalled ?? false;
  const status = tunnelStatus?.status ?? initialStatus?.status ?? "stopped";
  const hostname = tunnelStatus?.hostname ?? initialStatus?.hostname ?? null;

  // Don't show indicator if cloudflared isn't even installed
  if (!installed && !configured) return null;

  const statusDot: Record<string, string> = {
    connected: "bg-cc-success",
    starting: "bg-cc-warning animate-pulse",
    reconnecting: "bg-cc-warning animate-pulse",
    error: "bg-cc-error",
    stopped: "bg-cc-muted opacity-40",
  };

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setShowPanel(!showPanel)}
        className="flex items-center gap-1.5 text-[11px] text-cc-muted hover:text-cc-fg cursor-pointer transition-colors"
        title="Tunnel status"
      >
        <span className={`w-1.5 h-1.5 rounded-full ${statusDot[status] ?? statusDot.stopped}`} />
        <svg viewBox="0 0 20 20" fill="currentColor" className="w-3.5 h-3.5">
          <path d="M5.5 16a3.5 3.5 0 01-.369-6.98 4 4 0 117.753-1.977A4.5 4.5 0 1113.5 16h-8z" />
        </svg>
      </button>

      {showPanel && (
        <TunnelDropdown
          status={status}
          hostname={hostname}
          configured={configured}
          installed={installed}
          error={tunnelStatus?.error ?? null}
          connections={tunnelStatus?.connections ?? 0}
          onClose={() => setShowPanel(false)}
        />
      )}
    </div>
  );
}

function TunnelDropdown({
  status,
  hostname,
  configured,
  installed,
  error,
  connections,
  onClose,
}: {
  status: string;
  hostname: string | null;
  configured: boolean;
  installed: boolean;
  error: string | null;
  connections: number;
  onClose: () => void;
}) {
  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState(false);

  async function handleStart() {
    setLoading(true);
    try {
      await api.startTunnel();
    } catch (e) {
      console.error("Failed to start tunnel:", e);
    } finally {
      setLoading(false);
    }
  }

  async function handleStop() {
    setLoading(true);
    try {
      await api.stopTunnel();
    } catch (e) {
      console.error("Failed to stop tunnel:", e);
    } finally {
      setLoading(false);
    }
  }

  function handleCopy() {
    if (!hostname) return;
    navigator.clipboard.writeText(`https://${hostname}`);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <div className="absolute right-0 top-full mt-1.5 w-72 bg-cc-card border border-cc-border rounded-xl shadow-lg z-50 overflow-hidden">
      <div className="px-3 py-2.5 border-b border-cc-border">
        <div className="flex items-center justify-between">
          <span className="text-[12px] font-medium text-cc-fg">Cloudflare Tunnel</span>
          <StatusBadge status={status} />
        </div>
      </div>

      <div className="px-3 py-2.5 space-y-2.5">
        {!installed && (
          <div className="text-[11px] text-cc-muted">
            <p>cloudflared is not installed.</p>
            <a
              href="https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/"
              target="_blank"
              rel="noreferrer"
              className="text-cc-primary hover:underline"
            >
              Install cloudflared
            </a>
          </div>
        )}

        {installed && !configured && (
          <div className="text-[11px] text-cc-muted">
            <p>No tunnel configured.</p>
            <p className="mt-1">
              Run <code className="bg-cc-hover px-1 py-0.5 rounded text-[10px]">the-vibe-companion --tunnel-setup</code> to set up.
            </p>
          </div>
        )}

        {configured && status === "connected" && hostname && (
          <>
            <button
              onClick={handleCopy}
              className="w-full flex items-center justify-between gap-2 bg-cc-hover rounded-lg px-2.5 py-1.5 text-[11px] text-cc-fg hover:bg-cc-active transition-colors cursor-pointer"
            >
              <span className="truncate font-mono">https://{hostname}</span>
              <span className="shrink-0 text-cc-muted">{copied ? "Copied!" : "Copy"}</span>
            </button>
            <div className="flex items-center justify-between text-[10px] text-cc-muted">
              <span>{connections} connection{connections !== 1 ? "s" : ""}</span>
            </div>
          </>
        )}

        {configured && status === "error" && error && (
          <div className="text-[11px] text-cc-error bg-cc-error/10 rounded-lg px-2.5 py-1.5">
            {error}
          </div>
        )}

        {configured && (
          <div className="pt-1">
            {status === "connected" || status === "starting" || status === "reconnecting" ? (
              <button
                onClick={handleStop}
                disabled={loading}
                className="w-full text-[11px] font-medium text-cc-error bg-cc-error/10 hover:bg-cc-error/20 rounded-lg px-3 py-1.5 transition-colors cursor-pointer disabled:opacity-50"
              >
                {loading ? "Stopping..." : "Stop Tunnel"}
              </button>
            ) : (
              <button
                onClick={handleStart}
                disabled={loading}
                className="w-full text-[11px] font-medium text-cc-primary bg-cc-primary/10 hover:bg-cc-primary/20 rounded-lg px-3 py-1.5 transition-colors cursor-pointer disabled:opacity-50"
              >
                {loading ? "Starting..." : "Start Tunnel"}
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const config: Record<string, { label: string; color: string }> = {
    connected: { label: "Connected", color: "text-cc-success bg-cc-success/10" },
    starting: { label: "Starting", color: "text-cc-warning bg-cc-warning/10" },
    reconnecting: { label: "Reconnecting", color: "text-cc-warning bg-cc-warning/10" },
    error: { label: "Error", color: "text-cc-error bg-cc-error/10" },
    stopped: { label: "Stopped", color: "text-cc-muted bg-cc-hover" },
  };

  const { label, color } = config[status] ?? config.stopped;

  return (
    <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded-full ${color}`}>
      {label}
    </span>
  );
}
