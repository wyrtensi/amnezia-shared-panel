/**
 * Shared Panel logo — the same mark as the app favicon (apps/web/app/icon.svg)
 * with the wordmark, kept in sync with docs/assets/logo.svg. Self-contained
 * brand colours (amber / cream / teal) so it reads on any sidebar or header,
 * light or dark. Size it with a height class, e.g. <Logo className="h-9 w-auto" />.
 */
export function Logo({ className }: { className?: string }) {
  return (
    <svg
      viewBox="6 12 310 72"
      className={className}
      role="img"
      aria-label="amnezia Shared Panel"
      xmlns="http://www.w3.org/2000/svg"
    >
      <g transform="translate(12,16) scale(2)">
        <rect width="32" height="32" rx="7" fill="#cc7328" />
        <path
          d="M16 5l8 3v6.5c0 5-3.4 8.9-8 10.5-4.6-1.6-8-5.5-8-10.5V8l8-3z"
          fill="none"
          stroke="#fffaf2"
          strokeWidth="2"
          strokeLinejoin="round"
        />
        <circle cx="16" cy="14.5" r="2.4" fill="#fffaf2" />
        <path d="M16 16.5v4.5" stroke="#fffaf2" strokeWidth="2" strokeLinecap="round" />
      </g>
      <text
        x="94"
        y="34"
        fontFamily="'Onest', 'Segoe UI', system-ui, sans-serif"
        fontSize="14"
        fontWeight="600"
        letterSpacing="4"
        fill="#9a8f7d"
      >
        amnezia
      </text>
      <text
        x="92"
        y="66"
        fontFamily="'Onest', 'Segoe UI', system-ui, sans-serif"
        fontSize="32"
        fontWeight="700"
        letterSpacing="-0.5"
      >
        <tspan fill="#9a8f7d">Shared</tspan>
        <tspan dx="10" fill="#cc7328">Panel</tspan>
      </text>
      <rect x="93" y="76" width="66" height="4" rx="2" fill="#17917d" />
    </svg>
  );
}
