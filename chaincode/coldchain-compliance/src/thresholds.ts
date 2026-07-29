export interface TemperatureRange {
  readonly minC: number;
  readonly maxC: number;
}

const RANGES: Readonly<
  Record<
    string,
    TemperatureRange
  >
> = {
  frozen: {
    minC: -25,
    maxC: -18,
  },

  chilled: {
    minC: 0,
    maxC: 4,
  },

  // The PoC domain is pasteurised milk. Keep `chilled` as the reusable
  // storage profile while accepting the concrete product name on the wire.
  'pasteurised-milk': {
    minC: 0,
    maxC: 4,
  },

  ambient: {
    minC: 5,
    maxC: 25,
  },
};

export const DEFAULT_RANGE:
TemperatureRange = RANGES.ambient;

/**
 * A batch is flagged after three consecutive
 * temperature violations.
 */
export const VIOLATIONS_BEFORE_FLAG =
  3;

/**
 * Return the temperature range for a food type.
 *
 * Food-type matching ignores spaces and letter case.
 * Unknown food types use the ambient range.
 */
export const rangeFor = (
  foodType: string,
): TemperatureRange =>
  RANGES[
    foodType
      .trim()
      .toLowerCase()
  ] ?? DEFAULT_RANGE;

/**
 * Return true when a temperature is outside the
 * accepted range.
 */
export const isBreach = (
  foodType: string,
  tempC: number,
): boolean => {
  const range =
    rangeFor(foodType);

  return (
    tempC < range.minC ||
    tempC > range.maxC
  );
};
