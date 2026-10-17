import * as v from 'valibot'
const day = v.union([v.string(), v.number()])
export const ParksResponse = v.object({
  all: v.number(),
  results: v.pipe(
    v.array(
      v.object({
        bcd: v.pipe(v.string(), v.regex(/^\d+$/)),
        bcdNm: v.pipe(v.string(), v.minLength(1)),
      }),
    ),
    v.minLength(1),
  ),
})
export const WeekResponse = v.object({
  dayNum: v.literal(7),
  lendType: v.literal(3),
  weekDay: v.pipe(v.array(v.object({ useDay: day })), v.length(7)),
  result: v.pipe(
    v.array(
      v.object({
        tzoneNo: v.pipe(v.number(), v.integer()),
        timeResult: v.pipe(
          v.array(
            v.object({
              useDay: day,
              status: v.number(),
              alt: v.string(),
              startTime: v.number(),
              endTime: v.number(),
              rsvNum: v.pipe(v.number(), v.integer(), v.minValue(0)),
              selectNum: v.literal(0),
            }),
          ),
          v.length(7),
        ),
      }),
    ),
    v.minLength(1),
  ),
})
export const OfficialTime = v.pipe(
  v.number(),
  v.integer(),
  v.minValue(0),
  v.maxValue(2359),
  v.check((n) => n % 100 <= 59),
)
