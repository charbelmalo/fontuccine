/**
 * Minimal ambient types for opentype.js (no @types package shipped).
 * Only the surface the parser uses is declared.
 */
declare module 'opentype.js' {
  export interface PathCommandLike {
    type: 'M' | 'L' | 'Q' | 'C' | 'Z';
    x?: number;
    y?: number;
    x1?: number;
    y1?: number;
    x2?: number;
    y2?: number;
  }
  export interface BoundingBox {
    x1: number;
    y1: number;
    x2: number;
    y2: number;
  }
  export class Path {
    commands: PathCommandLike[];
    moveTo(x: number, y: number): void;
    lineTo(x: number, y: number): void;
    quadraticCurveTo(x1: number, y1: number, x: number, y: number): void;
    closePath(): void;
    getBoundingBox(): BoundingBox;
  }
  /** Raw TrueType outline point (glyf-flavoured fonts only). */
  export interface GlyfPoint {
    x: number;
    y: number;
    onCurve: boolean;
    lastPointOfContour: boolean;
  }
  export interface GlyfComponent {
    glyphIndex: number;
    xScale: number;
    scale01: number;
    scale10: number;
    yScale: number;
    dx: number;
    dy: number;
    matchedPoints?: [number, number];
  }
  export interface Glyph {
    index: number;
    advanceWidth?: number;
    /** Accessing it forces the lazy glyf parse (fills `points`/`components`). */
    readonly path: Path;
    points?: GlyfPoint[];
    isComposite?: boolean;
    components?: GlyfComponent[];
    getPath(x: number, y: number, fontSize: number): Path;
  }
  export interface GlyphSet {
    get(index: number): Glyph;
  }
  export interface Font {
    unitsPerEm: number;
    names?: { fullName?: { en?: string } };
    glyphs: GlyphSet;
    charToGlyph(char: string): Glyph;
    getKerningValue(left: Glyph, right: Glyph): number;
  }
  export function parse(buffer: ArrayBuffer): Font;
  const _default: { parse(buffer: ArrayBuffer): Font; Path: typeof Path };
  export default _default;
}
