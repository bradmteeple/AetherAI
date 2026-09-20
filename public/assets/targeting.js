/**
 * Doubles move targeting, ported from the engine so the UI offers exactly the
 * targets it will accept:
 *   sim/battle-actions.ts  CHOOSABLE_TARGETS
 *   sim/battle.ts          validTargetLoc()
 *
 * Locations are the engine's: foes are +1..+n left to right, your own side is
 * -1..-n. Anything not in CHOOSABLE_TARGETS resolves its own targets and must
 * be sent without a location.
 */
export const CHOOSABLE_TARGETS = new Set(['normal', 'any', 'adjacentAlly', 'adjacentAllyOrSelf', 'adjacentFoe']);

export const needsTarget = (targetType, activeCount) => activeCount > 1 && CHOOSABLE_TARGETS.has(targetType);

/** Faithful port of Battle#validTargetLoc for a non-free-for-all game. */
export function validTargetLoc(targetLoc, sourceLoc, numSlots, targetType) {
  if (targetLoc === 0) return true;
  if (Math.abs(targetLoc) > numSlots) return false;
  const isSelf = sourceLoc === targetLoc;
  const isFoe = targetLoc > 0;
  const acrossFromTargetLoc = -(numSlots + 1 - targetLoc);
  const isAdjacent = targetLoc > 0
    ? Math.abs(acrossFromTargetLoc - sourceLoc) <= 1
    : Math.abs(targetLoc - sourceLoc) === 1;

  switch (targetType) {
    case 'randomNormal':
    case 'scripted':
    case 'normal':
      return isAdjacent;
    case 'adjacentAlly':
      return isAdjacent && !isFoe;
    case 'adjacentAllyOrSelf':
      return (isAdjacent && !isFoe) || isSelf;
    case 'adjacentFoe':
      return isAdjacent && isFoe;
    case 'any':
      return !isSelf;
    default:
      return false;
  }
}

/**
 * Every location this move may be aimed at from `slotIndex`, in board order:
 * the opposing slots first, then your own.
 */
export function targetOptions({ slotIndex, activeCount, targetType }) {
  const sourceLoc = -(slotIndex + 1);
  const options = [];
  for (let i = 1; i <= activeCount; i++) {
    if (validTargetLoc(i, sourceLoc, activeCount, targetType)) options.push({ loc: i, side: 'foe', index: i - 1 });
  }
  for (let i = 1; i <= activeCount; i++) {
    const loc = -i;
    if (validTargetLoc(loc, sourceLoc, activeCount, targetType)) {
      options.push({ loc, side: 'ally', index: i - 1, self: loc === sourceLoc });
    }
  }
  return options;
}
