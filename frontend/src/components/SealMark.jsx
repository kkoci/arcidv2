// The Seal — arcid2's signature element.
// Bonded collateral is "under seal": TEE attestation is the wax stamp that
// proves authorship, the bond is the wax itself. A verified breach doesn't
// change a badge color — it physically breaks the seal. This is the one
// place the design spends its boldness; everywhere else stays quiet.

export default function SealMark({ state = "sealed", size = 28 }) {
  const broken = state === "broken";
  const color  = broken ? "var(--breach)" : "var(--accent)";

  return (
    <svg
      width={size} height={size} viewBox="0 0 40 40"
      style={{ flexShrink: 0, transition: "filter .4s" }}
      aria-hidden="true"
    >
      {/* Outer ring — embossed brass, or the two fractured arcs */}
      {broken ? (
        <>
          <path d="M 20 3 A 17 17 0 1 1 6.8 30.5" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" />
          <path d="M 14.5 33.5 A 17 17 0 0 1 8.1 27.8" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" />
          {/* crack line through the middle */}
          <path d="M 12 8 L 20 20 L 11 29" fill="none" stroke={color} strokeWidth="1.4" strokeLinecap="round" opacity="0.85" />
        </>
      ) : (
        <circle cx="20" cy="20" r="17" fill="none" stroke={color} strokeWidth="2" />
      )}

      {/* Inner sigil — the ArcID mark (triangle + eye), embossed */}
      <g opacity={broken ? 0.55 : 1} transform="translate(20 21)">
        <path d="M0 -8.5L7 8.5H-7L0 -8.5Z" fill="none" stroke={color} strokeWidth="1.6" strokeLinejoin="round" />
        <circle cx="0" cy="3.5" r="1.4" fill={color} />
      </g>
    </svg>
  );
}
