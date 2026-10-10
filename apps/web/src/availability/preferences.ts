import * as v from 'valibot'
import { ConditionFieldsSchema, ConditionsSchema, type Conditions } from './schemas'
import { defaults } from './model'

const key = 'akicourt.conditions.v1'
const SavedSchema = v.object({
  version: v.union([v.literal(1), v.literal(2)]),
  conditions: v.pipe(
    v.omit(ConditionFieldsSchema, ['dateFrom', 'dateTo']),
    v.check((input) => v.safeParse(ConditionsSchema, { ...defaults(), ...input }).success),
    v.check(
      (input) =>
        [0, 60, 120, 180].includes(input.minDurationMinutes) &&
        /:(00|30)$/.test(input.timeFrom) &&
        /:(00|30)$/.test(input.timeTo),
    ),
  ),
})
export function restoreConditions(storage: Pick<Storage, 'getItem'>): {
  conditions: Conditions
  message: string
} {
  const fallback = defaults()
  try {
    const raw = storage.getItem(key)
    if (!raw) return { conditions: fallback, message: '' }
    const saved = v.safeParse(SavedSchema, JSON.parse(raw))
    if (!saved.success)
      return {
        conditions: fallback,
        message: '保存条件を読み込めないため、初期条件を表示しています。',
      }
    return {
      conditions: { ...fallback, ...saved.output.conditions },
      message: '',
    }
  } catch {
    return {
      conditions: fallback,
      message: '保存条件を読み込めないため、初期条件を表示しています。',
    }
  }
}
export function saveConditions(storage: Pick<Storage, 'setItem'>, conditions: Conditions): string {
  const parsed = v.safeParse(SavedSchema, { version: 2, conditions })
  if (!parsed.success) return parsed.issues[0].message
  try {
    storage.setItem(key, JSON.stringify(parsed.output))
    return ''
  } catch {
    return '条件を保存できません。ブラウザの保存設定を確認してください。'
  }
}
