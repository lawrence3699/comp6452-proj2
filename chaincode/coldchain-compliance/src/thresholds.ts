export interface TemperatureRange {
  readonly minC: number;
  readonly maxC: number;
}

const RANGES: Readonly<Record<string, TemperatureRange>> = {
  frozen: { minC: -25, maxC: -18 },
  chilled: { minC: 0, maxC: 4 },
  ambient: { minC: 5, maxC: 25 },
};

export const DEFAULT_RANGE: TemperatureRange = RANGES.ambient;

export const VIOLATIONS_BEFORE_FLAG = 3;

export const rangeFor = (foodType: string): TemperatureRange =>
  RANGES[foodType] ?? DEFAULT_RANGE;

export const isBreach = (foodType: string, tempC: number): boolean => {
  const range = rangeFor(foodType);
  return tempC < range.minC || tempC > range.maxC;
};
