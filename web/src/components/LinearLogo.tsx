interface LinearLogoProps {
  className?: string;
}

export function LinearLogo({ className }: LinearLogoProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
      className={className}
    >
      <circle cx="12" cy="12" r="10" fill="currentColor" />
      <path d="M7.2 15.2l6.6-6.6" stroke="white" strokeWidth="2" strokeLinecap="round" />
      <circle cx="16.4" cy="8.8" r="1.8" fill="white" />
    </svg>
  );
}
