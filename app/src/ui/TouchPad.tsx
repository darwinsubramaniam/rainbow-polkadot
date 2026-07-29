import type { PointerEvent as ReactPointerEvent } from "react";

interface Props {
  onPress: (key: "left" | "right" | "jump", down: boolean) => void;
}

/**
 * Touch controls.
 *
 * A Product runs on a phone as its primary target, where there is no keyboard,
 * so without these the game is simply unplayable on the platform it is being
 * published to.
 *
 * Pointer events rather than click: a platformer needs press-and-hold, and
 * `onPointerUp` alone would strand a key held down if the finger slid off the
 * button — which would keep writing that button into the input log.
 */
export function TouchPad({ onPress }: Props) {
  const bind = (key: "left" | "right" | "jump") => ({
    onPointerDown: (e: ReactPointerEvent<HTMLButtonElement>) => {
      e.preventDefault();
      // Keep receiving events even if the finger leaves the button's bounds.
      e.currentTarget.setPointerCapture(e.pointerId);
      onPress(key, true);
    },
    onPointerUp: (e: ReactPointerEvent<HTMLButtonElement>) => {
      e.preventDefault();
      onPress(key, false);
    },
    onPointerCancel: () => onPress(key, false),
    onLostPointerCapture: () => onPress(key, false),
    onContextMenu: (e: ReactPointerEvent<HTMLButtonElement>) => e.preventDefault(),
  });

  return (
    <div className="touchpad" aria-hidden="false">
      <div className="dpad">
        <button {...bind("left")} aria-label="move left">◀</button>
        <button {...bind("right")} aria-label="move right">▶</button>
      </div>
      <button className="jump" {...bind("jump")} aria-label="jump">
        JUMP
      </button>
    </div>
  );
}
