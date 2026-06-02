// Greenside "G" mark — the G ring with a flag on the green. Transparent, scalable.
export function LogoMark({ size = 22, className = "" }: { size?: number; className?: string }) {
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 100 100" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <ellipse cx="50" cy="63" rx="23" ry="8.5" fill="#7eb15a" />
      <path d="M81.4 39.8 A33 33 0 1 0 81.4 60.2 L 58 60.2" fill="none" stroke="#0e3b28" strokeWidth="6" strokeLinecap="round" strokeLinejoin="round" />
      <line x1="50" y1="29" x2="50" y2="62" stroke="#0e3b28" strokeWidth="2.6" strokeLinecap="round" />
      <path d="M50 30 L 69 33 Q 61 36.5 69 40 L 50 40 Z" fill="#7eb15a" />
      <ellipse cx="50" cy="62" rx="3.2" ry="1.4" fill="#0e3b28" />
    </svg>
  );
}

// Full brand lockup: mark + wordmark + tagline.
export function FullLogo() {
  return (
    <div className="fulllogo">
      <LogoMark size={96} className="lk-mark" />
      <div className="lk-word">Green Side Strokes</div>
      <div className="lk-tag">Live Golf Scorecard</div>
    </div>
  );
}
