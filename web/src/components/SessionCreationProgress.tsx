import type { CreationProgressEvent } from "../api.js";

interface Props {
  steps: CreationProgressEvent[];
  error?: string | null;
}

export function SessionCreationProgress({ steps, error }: Props) {
  if (steps.length === 0) return null;

  return (
    <div className="w-full max-w-md mx-auto mt-4 mb-2">
      <div className="space-y-1.5">
        {steps.map((step) => (
          <div key={step.step} className="flex items-center gap-2.5 py-1">
            {/* Status icon */}
            <div className="w-4 h-4 flex items-center justify-center shrink-0">
              {step.status === "in_progress" && (
                <span className="w-3.5 h-3.5 border-2 border-cc-primary/30 border-t-cc-primary rounded-full animate-spin" />
              )}
              {step.status === "done" && (
                <svg viewBox="0 0 16 16" fill="none" className="w-3.5 h-3.5 text-cc-success">
                  <path
                    d="M13.25 4.75L6 12 2.75 8.75"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              )}
              {step.status === "error" && (
                <svg viewBox="0 0 16 16" fill="none" className="w-3.5 h-3.5 text-cc-error">
                  <path
                    d="M4 4l8 8M12 4l-8 8"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                  />
                </svg>
              )}
            </div>

            {/* Label */}
            <span
              className={`text-sm ${
                step.status === "in_progress"
                  ? "text-cc-fg font-medium"
                  : step.status === "done"
                    ? "text-cc-muted"
                    : "text-cc-error"
              }`}
            >
              {step.label}
            </span>
          </div>
        ))}
      </div>

      {error && (
        <div className="mt-2.5 px-3 py-2 rounded-lg bg-cc-error/5 border border-cc-error/20">
          <p className="text-xs text-cc-error whitespace-pre-wrap">{error}</p>
        </div>
      )}
    </div>
  );
}
