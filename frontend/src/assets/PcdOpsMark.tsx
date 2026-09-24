interface Props {
  size?: number;
}

export default function PcdOpsMark({ size = 36 }: Props) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 200 200"
      xmlns="http://www.w3.org/2000/svg"
      aria-label="PCD Ops"
    >
      <defs>
        <radialGradient id="pm-bg" cx="50%" cy="40%" r="58%">
          <stop offset="0%"   stopColor="#16253E" />
          <stop offset="100%" stopColor="#0B1526" />
        </radialGradient>
        <linearGradient id="pm-shine" x1="0%" y1="0%" x2="0%" y2="100%">
          <stop offset="0%"  stopColor="#ffffff" stopOpacity="0.07" />
          <stop offset="50%" stopColor="#ffffff" stopOpacity="0" />
        </linearGradient>
        <filter id="pm-glow" x="-30%" y="-60%" width="160%" height="220%">
          <feGaussianBlur in="SourceGraphic" stdDeviation="3" result="blur" />
          <feMerge>
            <feMergeNode in="blur" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
        <pattern id="pm-dots" x="0" y="0" width="26" height="26" patternUnits="userSpaceOnUse">
          <circle cx="13" cy="13" r="1.3" fill="white" opacity="0.055" />
        </pattern>
        <clipPath id="pm-clip">
          <rect width="200" height="200" rx="42" />
        </clipPath>
      </defs>

      {/* Background */}
      <rect width="200" height="200" rx="42" fill="url(#pm-bg)" />
      {/* Dot grid texture */}
      <rect width="200" height="200" fill="url(#pm-dots)" clipPath="url(#pm-clip)" />
      {/* Top-light shine */}
      <rect width="200" height="200" rx="42" fill="url(#pm-shine)" />

      {/* Infrastructure layer bars: base → compute → active */}
      <rect x="41" y="126" width="118" height="11" rx="5.5" fill="white" opacity="0.20" />
      <rect x="52" y="111" width="96"  height="11" rx="5.5" fill="white" opacity="0.48" />
      <rect x="63" y="96"  width="74"  height="11" rx="5.5" fill="#41ADFF" opacity="0.92" />

      {/* Ops pulse line */}
      <path
        d="M 47 76 L 75 76 L 87 62 L 93 88 L 100 76 L 108 71 L 116 76 L 153 76"
        fill="none"
        stroke="#41ADFF"
        strokeWidth="2.4"
        strokeLinecap="round"
        strokeLinejoin="round"
        filter="url(#pm-glow)"
      />
    </svg>
  );
}
