/**
 * Maps raw pattern enum values (from the API) to user-friendly display names.
 */
const PATTERN_LABELS: Record<string, { label: string; icon: string }> = {
  ANY_LINE:   { label: 'Any Line',     icon: '➖' },
  DIAGONAL:   { label: 'Diagonal',     icon: '↗️' },
  FULL_CARD:  { label: 'Full Card',    icon: '🃏' },
  X_PATTERN:  { label: 'X Pattern',    icon: '✖️' },
  CORNERS:    { label: 'Four Corners', icon: '◻️' },
}

export function usePatternLabel() {
  function patternLabel(raw: string): string {
    return PATTERN_LABELS[raw]?.label ?? raw.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
  }

  function patternIcon(raw: string): string {
    return PATTERN_LABELS[raw]?.icon ?? '🎯'
  }

  return { patternLabel, patternIcon }
}
