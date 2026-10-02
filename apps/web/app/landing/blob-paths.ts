/**
 * The two shapes of the liquid drip menu (reference spec §4.1a).
 *
 * The closed shape is a 140x48 drop hanging from the top edge of the
 * viewport; the open shape is a 340-wide panel whose drip has moved to the
 * bottom centre. motion morphs between them by interpolating the path's
 * `d` attribute, which only works when both strings have the SAME
 * commands in the SAME order, so that every command has a partner. The
 * closed state therefore carries zero-length `C0 0 0 0 0 0` placeholder
 * segments where the open state has curves. A test pins this.
 *
 * The spec's open panel is 320 tall for three links. This menu has six,
 * so everything at or below the body's bottom edge (y >= 252) is shifted
 * down by 96 and the top edge is untouched. The result is 416 tall.
 */
export const BLOB_CLOSED_PATH =
  "M0 0 H140 V0 C0 0 0 0 0 0 L140 0 C140 0 140 8 130 18 C120 28 115 38 100 42 C90 44.5 80 46 70 46 C60 46 50 44.5 40 42 C25 38 20 28 10 18 C0 8 0 0 0 0 L0 0 C0 0 0 0 0 0 V0 Z";

export const BLOB_OPEN_PATH =
  "M 0 0 H 340 V 348 C 340 362 332 368 320 368 L 240 368 C 240 368 240 376 230 386 C 220 396 215 406 200 410 C 190 412.5 180 414 170 414 C 160 414 150 412.5 140 410 C 125 406 120 396 110 386 C 100 376 100 368 100 368 L 20 368 C 8 368 0 362 0 348 V 0 Z";

export const BLOB = {
  closed: { width: 140, height: 48 },
  open: { width: 340, height: 416 },
  /** Height of the toggle strip at the top of the shape; the links start
   *  directly below it. */
  header: 44,
} as const;
