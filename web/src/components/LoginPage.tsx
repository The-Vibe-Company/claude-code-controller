import { useState, useCallback, useEffect } from "react";
import { useStore } from "../store.js";
import { verifyAuthToken } from "../api.js";

export function LoginPage() {
  const [token, setToken] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const setAuthToken = useStore((s) => s.setAuthToken);

  const handleSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      const trimmed = token.trim();
      if (!trimmed) {
        setError("Please enter a token");
        return;
      }
      setLoading(true);
      setError(null);
      const valid = await verifyAuthToken(trimmed);
      if (valid) {
        setAuthToken(trimmed);
      } else {
        setError("Invalid token");
      }
      setLoading(false);
    },
    [token, setAuthToken],
  );

  // Auto-login from ?token= URL param
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const urlToken = params.get("token");
    if (urlToken) {
      setLoading(true);
      verifyAuthToken(urlToken).then((valid) => {
        if (valid) {
          setAuthToken(urlToken);
          // Strip token from URL to avoid leaking it
          const url = new URL(window.location.href);
          url.searchParams.delete("token");
          window.history.replaceState({}, "", url.toString());
        } else {
          setError("Invalid token from URL");
          setLoading(false);
        }
      });
    }
  }, [setAuthToken]);

  const [showToken, setShowToken] = useState(false);

  return (
    <div className="h-[100dvh] flex items-center justify-center bg-cc-bg text-cc-fg font-sans-ui antialiased">
      <div className="w-full max-w-sm px-6">
        <div className="text-center mb-8">
          <h1 className="text-xl font-semibold text-cc-fg mb-2">The Companion</h1>
          <p className="text-sm text-cc-muted">Enter your auth token to continue</p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label htmlFor="auth-token" className="block text-xs text-cc-muted mb-1.5">
              Auth Token
            </label>
            <div className="relative">
              <input
                id="auth-token"
                type={showToken ? "text" : "password"}
                value={token}
                onChange={(e) => {
                  setToken(e.target.value);
                  setError(null);
                }}
                placeholder="Paste your token here"
                className="w-full px-3 py-2 pr-16 text-sm bg-cc-hover border border-cc-border rounded-md text-cc-fg placeholder:text-cc-muted/50 focus:outline-none focus:ring-1 focus:ring-cc-primary focus:border-cc-primary font-mono"
                autoFocus
                autoComplete="off"
                disabled={loading}
              />
              <button
                type="button"
                onClick={() => setShowToken(!showToken)}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-[11px] text-cc-muted hover:text-cc-fg transition-colors cursor-pointer px-1.5 py-0.5 rounded hover:bg-cc-hover"
                tabIndex={-1}
              >
                {showToken ? "Hide" : "Show"}
              </button>
            </div>
          </div>

          {error && (
            <p className="text-xs text-cc-error" role="alert">{error}</p>
          )}

          <button
            type="submit"
            disabled={loading || !token.trim()}
            className="w-full py-2 px-4 text-sm font-medium bg-cc-primary text-white rounded-md hover:opacity-90 disabled:opacity-50 transition-opacity cursor-pointer disabled:cursor-not-allowed"
          >
            {loading ? "Verifying..." : "Login"}
          </button>
        </form>

        <p className="mt-6 text-[11px] text-cc-muted text-center leading-relaxed">
          Find your token in the server console output, or scan the QR code from an authenticated device.
        </p>
      </div>
    </div>
  );
}
