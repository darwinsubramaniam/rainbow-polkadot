/**
 * An address, shortened for display.
 *
 * Both ends are kept. A prefix alone is not identifying — every H160 on this
 * chain starts `0x` and mapped Substrate accounts cluster — so a player checking
 * whether a row is theirs needs the tail as much as the head.
 */
export const short = (address: string): string =>
  address.length <= 13 ? address : `${address.slice(0, 6)}…${address.slice(-4)}`;
