/**
 * engine/index.ts — the `.` (`fontuccine`) public entry.
 *
 * Exposes `Fontuccine.attach` (README Public API sketch) + the named `attach`
 * and the public config/instance types. This entry STATICALLY imports all three
 * render tiers (auto dispatch may pick any); opentype.js stays out of the base
 * bundle because font parsing is dynamically imported (see engine/font-load).
 */
import { attach } from './attach.ts';

export { attach };
export type {
  FontuccineConfig,
  Instance,
  FontSource,
  StretchAxis,
  Trigger,
  Tier,
  ResolvedTier,
} from './types.ts';

/** README-style namespace object: `import { Fontuccine } from 'fontuccine'`. */
export const Fontuccine = { attach };
export default Fontuccine;
