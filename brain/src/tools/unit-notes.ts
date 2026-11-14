/** GT's fluid L is the Forge amount unit, not a conversion from litres to millilitres.
 * Keep the game's original text intact; add context only when a GT result actually shows this unit.
 * Verified against GT 5.09.54.265 MTEFluidPipe.getDescription/getInfo/distributeFluid.
 */
export function gtFluidUnitNote(id: string, lines: readonly string[]): string | undefined {
  if (!id.startsWith('gregtech:') || !lines.some((line) => /\d[\d,.\s]*L\b/.test(line))) return undefined
  return 'GregTech fluid units: 1 L = 1 mB (millibucket, not millilitre); 1 bucket = 1000 mB = 1000 GT L. Thus 200 L/s means 200 mB/s, not 200,000 mB/s. L/sec and L/s are the same; /t uses a nominal 20 ticks/s. A pipe rating is not measured flow.'
}
