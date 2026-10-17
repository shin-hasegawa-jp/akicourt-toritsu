import * as v from 'valibot'

export const NonNegativeInteger = v.pipe(v.number(), v.safeInteger(), v.minValue(0))
export const PositiveInteger = v.pipe(NonNegativeInteger, v.minValue(1))
export const NonEmptyString = v.pipe(
  v.string(),
  v.check((s) => !!s.trim()),
)
export const Id = v.pipe(v.string(), v.regex(/^[a-zA-Z0-9_-]{1,128}$/))
export const ProjectId = v.pipe(v.string(), v.regex(/^[a-z][a-z0-9-]{4,61}[a-z0-9]$/))
export const ParkId = v.pipe(v.string(), v.regex(/^\d{4}$/))
export const Surface = v.picklist(['grass', 'hard'])
export const DateString = v.pipe(
  v.string(),
  v.regex(/^\d{4}-\d{2}-\d{2}$/),
  v.check((s) => {
    const date = new Date(`${s}T00:00:00Z`)
    return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === s
  }),
)
export const Clock = v.pipe(v.string(), v.regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/))
export const TargetSchema = v.looseObject({
  parkId: ParkId,
  surface: Surface,
  startDate: DateString,
})

// Never expose Valibot issues: input values may contain official session cookies.
export function parseValue<S extends v.GenericSchema>(
  schema: S,
  value: unknown,
  error: () => Error,
): v.InferOutput<S> {
  const result = v.safeParse(schema, value)
  if (!result.success) throw error()
  return result.output
}
