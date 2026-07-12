/**
 * sampling/point-in-glyph.ts — glyph containment test.
 *
 * Uses the nonzero winding rule (see winding.ts) so self-overlapping outlines
 * (Playfair 'W') fill correctly. Agrees with even-odd on non-overlapping
 * contours, so the ported invariants are unaffected.
 */
import { pointInside } from '../winding.ts';

export function pointInGlyph(
  x: number,
  y: number,
  polygons: Array<Array<[number, number]>>,
): boolean {
  return pointInside(x, y, polygons);
}
