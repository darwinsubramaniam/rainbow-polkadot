/**
 * Marks, inlined.
 *
 * The technology marks are the projects' own current artwork, path-for-path:
 * Polkadot's from the light-background mark it serves at
 * polkadot.com/favicon-light.svg, and Acurast's from the green mark in the
 * lockup at acurast.com. Inlined rather than fetched because the bundle is
 * uploaded against a byte quota and two more network round-trips buy nothing.
 *
 * Each is paired with its name set in this site's own display face rather than
 * a reproduced wordmark — the mark is the part that has to be exact.
 */

/**
 * Rainbow's own mark: the run, and its echo.
 *
 * A double rainbow. The outer arc is solid — the score your browser computed.
 * The inner one is the same arc sampled into dots — the enclave recomputing it
 * from your keypresses alone. They are concentric because they agree, which is
 * the entire claim the project makes, and is literally the panel the app shows
 * you after a run.
 *
 * Both arcs sweep 220° rather than a flat 180°, so the mark fills a square
 * instead of letterboxing itself into the bottom half of one.
 *
 * The outer arc is seven butt-capped segments rather than one gradient stroke.
 * Adjacent segments share an endpoint on the same circle, so their tangents
 * match and the joins are seamless — and unlike a gradient, per-segment fills
 * inherit CSS variables, which is what lets the one-ink cut below be a class
 * rather than a second drawing.
 *
 * The seven colours are not a new palette. Four come out of the game itself
 * (renderer.ts: spike, coin, goal) and three are the site's own cyan, primary,
 * and the violet that used to end the placeholder gradient — so the mark and
 * the world it points at are made of the same pigment.
 *
 * Decorative rather than labelled: both places it appears sit directly beside
 * the word "Rainbow", and a `role="img"` here would make screen readers say the
 * name twice.
 */
export function RainbowMark({ className = "" }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" className={`rainbow-mark ${className}`.trim()} aria-hidden="true" focusable="false">
      {/* Outer: r=12.5 about (16, 21), 200° → -20°, in seven equal segments. */}
      <g fill="none" strokeWidth="3.4">
        <path d="M4.254 25.275 A12.5 12.5 0 0 1 3.748 18.524" stroke="var(--rm-1)" />
        <path d="M3.748 18.524 A12.5 12.5 0 0 1 6.837 12.498" stroke="var(--rm-2)" />
        <path d="M6.837 12.498 A12.5 12.5 0 0 1 12.617 8.966" stroke="var(--rm-3)" />
        <path d="M12.617 8.966 A12.5 12.5 0 0 1 19.383 8.966" stroke="var(--rm-4)" />
        <path d="M19.383 8.966 A12.5 12.5 0 0 1 25.163 12.498" stroke="var(--rm-5)" />
        <path d="M25.163 12.498 A12.5 12.5 0 0 1 28.252 18.524" stroke="var(--rm-6)" />
        <path d="M28.252 18.524 A12.5 12.5 0 0 1 27.746 25.275" stroke="var(--rm-7)" />
      </g>
      {/* Inner: same centre and sweep at r=7.5. Zero-length round dashes are
          dots; the 4.11 gap divides the 28.8 arc length into seven of them, one
          per band of the arc above. */}
      <path
        d="M8.952 23.565 A7.5 7.5 0 1 1 23.048 23.565"
        fill="none"
        stroke="var(--rm-ink)"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeDasharray="0.01 4.11"
      />
    </svg>
  );
}

export function PolkadotMark() {
  return (
    <svg viewBox="0 0 256 256" role="img" aria-label="Polkadot" focusable="false">
      <g fill="#171717">
        <path d="M31.0155 57.7181C14.6547 76.7768 14.2233 103.306 30.0862 116.92C45.9492 130.566 72.0667 126.15 88.4607 107.058C104.821 87.9995 105.253 61.4701 89.3899 47.8567C83.1841 42.511 75.3522 39.9543 67.1884 39.9543C54.5113 39.9543 40.9713 46.1302 31.0155 57.7181Z" />
        <path d="M26.2694 156.332C13.9574 170.941 19.3003 195.744 38.2164 211.715C57.1326 227.686 82.4868 228.815 94.7989 214.205C107.111 199.596 101.768 174.793 82.8518 158.822C72.8296 150.355 61.0153 146.072 50.2962 146.072C40.7718 146.072 32.077 149.459 26.3026 156.332" />
        <path d="M137.343 209.789C115.142 216.795 99.8429 231.072 103.161 241.664C106.513 252.256 127.221 255.178 149.423 248.139C171.625 241.133 186.923 226.856 183.605 216.264C181.481 209.59 172.454 205.938 160.507 205.938C153.505 205.938 145.54 207.166 137.343 209.756" />
        <path d="M102.597 18.5365C98.0176 31.7514 112.553 48.8179 135.12 56.6871C157.686 64.5562 179.689 60.2066 184.268 46.9917C188.848 33.7768 174.313 16.7103 151.746 8.84109C144.146 6.18482 136.58 4.9231 129.744 4.9231C116.303 4.9231 105.617 9.77078 102.597 18.5365Z" />
        <path d="M204.048 45.169C197.51 47.7921 199.07 66.884 207.499 87.7357C215.928 108.621 228.041 123.396 234.579 120.773C241.083 118.15 239.557 99.0912 231.128 78.2063C223.362 58.9484 212.444 44.8702 205.674 44.8702C205.11 44.8702 204.579 44.9698 204.048 45.169Z" />
        <path d="M209.058 172.038C199.766 192.192 196.547 210.553 201.89 213.01C207.233 215.468 219.114 201.124 228.406 180.969C237.731 160.815 240.917 142.453 235.607 139.996C235.209 139.797 234.778 139.731 234.28 139.731C228.472 139.731 217.654 153.411 209.058 172.038Z" />
      </g>
    </svg>
  );
}

/** GitHub's Octicon mark-github, their own published glyph. */
export function GitHubMark() {
  return (
    <svg viewBox="0 0 16 16" role="img" aria-label="GitHub" focusable="false" fill="currentColor">
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.012 8.012 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
    </svg>
  );
}

/**
 * Recentre: put the whole picture back in the frame.
 *
 * Four corner brackets closing on a dot — the standard "fit to view" idea
 * rather than a house or an arrow, because that is what the button does: it
 * does not go home, it reframes what is already there.
 */
export function RecentreMark() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false" fill="none" stroke="currentColor">
      <g strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
        <path d="M5.6 2H3.3A1.3 1.3 0 0 0 2 3.3v2.3" />
        <path d="M10.4 2h2.3A1.3 1.3 0 0 1 14 3.3v2.3" />
        <path d="M14 10.4v2.3a1.3 1.3 0 0 1-1.3 1.3h-2.3" />
        <path d="M2 10.4v2.3A1.3 1.3 0 0 0 3.3 14h2.3" />
      </g>
      <circle cx="8" cy="8" r="1.7" fill="currentColor" stroke="none" />
    </svg>
  );
}

/**
 * The tunnel between the app and the Processor.
 *
 * A tunnel mouth: an outer arch on a ground line with a second arch set inside
 * it, which is the depth cue that stops it reading as a plain doorway. Same
 * hairline and `currentColor` as the other two drawn glyphs here, so it takes
 * the colour of whatever it is labelling — and, unlike the brand marks, is
 * nobody's artwork to get wrong.
 */
export function TunnelMark() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false" fill="none" stroke="currentColor">
      <path d="M1.2 13.4h13.6" strokeWidth="1.3" strokeLinecap="round" />
      <path d="M2.6 13.4V8a5.4 5.4 0 0 1 10.8 0v5.4" strokeWidth="1.3" strokeLinejoin="round" />
      <path d="M6.4 13.4V9.2a1.6 1.6 0 0 1 3.2 0v4.2" strokeWidth="1.2" strokeLinejoin="round" />
    </svg>
  );
}

/**
 * The player.
 *
 * The only actor in the system that is not a machine, and the one step of the
 * six that is *theirs* — the run itself. Head and shoulders, in the same
 * hairline as the window below, so the rail reads as one drawing.
 */
export function UserMark() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false" fill="none" stroke="currentColor">
      <circle cx="8" cy="5" r="2.6" strokeWidth="1.3" />
      <path d="M2.9 14a5.1 5.1 0 0 1 10.2 0" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  );
}

/**
 * The machine the player is sitting at.
 *
 * A browser window, drawn in the line weight of the marks above rather than
 * filled: it stands beside two brand marks in the proof rail and must not
 * out-shout them. `currentColor` because unlike the others it is nobody's
 * artwork — it should take the colour of whatever text it labels.
 */
export function DeviceMark() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false" fill="none" stroke="currentColor">
      <rect x="1.75" y="2.75" width="12.5" height="10.5" rx="1.5" strokeWidth="1.3" />
      <path d="M1.75 5.75h12.5" strokeWidth="1.3" />
      <circle cx="3.9" cy="4.25" r=".62" fill="currentColor" stroke="none" />
      <circle cx="5.8" cy="4.25" r=".62" fill="currentColor" stroke="none" />
    </svg>
  );
}

export function AcurastMark() {
  return (
    <svg viewBox="0 0 40.179 25.376" role="img" aria-label="Acurast" focusable="false">
      <g fill="#C0E700">
        <path d="M25.376 0h-14.8L0 21.147h14.8z" />
        <path d="M76.931 46.159h12.688l6.344 12.688H83.275z" transform="translate(-55.784 -33.471)" />
      </g>
    </svg>
  );
}
