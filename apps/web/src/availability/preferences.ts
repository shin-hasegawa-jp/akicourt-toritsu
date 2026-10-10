import * as v from 'valibot'
import { ConditionsSchema, type Conditions, type Slot } from './schemas'
import { defaults, parks, today, weekdayNames } from './model'

const key = 'akicourt.conditions.v1'
export function removeConditions(storage: Pick<Storage, 'removeItem'>): string {
  try {
    storage.removeItem(key)
    return '保存条件を削除しました。次回は初期条件で開きます。'
  } catch {
    return '保存条件を削除できません。ブラウザの保存設定を確認してください。'
  }
}
const SavedSchema = v.object({
  version: v.literal(1),
  conditions: v.pipe(
    ConditionsSchema,
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
    const conditions = saved.output.conditions
    if (conditions.dateFrom < today()) {
      conditions.dateFrom = fallback.dateFrom
      conditions.dateTo = fallback.dateTo
      return {
        conditions,
        message: '保存条件を復元しました。過去の期間は本日から7日間に戻しました。',
      }
    }
    return { conditions, message: 'このブラウザに保存した条件を復元しました。' }
  } catch {
    return {
      conditions: fallback,
      message: '保存条件を読み込めないため、初期条件を表示しています。',
    }
  }
}
export function saveConditions(storage: Pick<Storage, 'setItem'>, conditions: Conditions): string {
  const parsed = v.safeParse(ConditionsSchema, conditions)
  if (!parsed.success) return parsed.issues[0].message
  try {
    storage.setItem(key, JSON.stringify({ version: 1, conditions: parsed.output }))
    return 'このブラウザに条件を保存しました。'
  } catch {
    return '条件を保存できません。ブラウザの保存設定を確認してください。'
  }
}
export function conditionsText(input: Conditions): string {
  return [
    '都立公園テニス 検索条件',
    ...parks
      .filter((park) => input.targets.includes(park.key))
      .map((park) => `${park.parkName}・${park.label}`),
    `${input.dateFrom}〜${input.dateTo}`,
    `曜日：${input.weekdays.map((day) => weekdayNames[day]).join('・') || '指定なし'}${input.includeHolidays ? '／祝日も含む' : ''}`,
    `時間帯：${input.timeFrom}〜${input.timeTo}`,
    `1枠の最低時間：${input.minDurationMinutes ? `${input.minDurationMinutes}分` : '指定なし'}`,
    '公式サイトで現在の空き状況・予約可否を確認してください。',
  ].join('\n')
}
export function slotText(slot: Slot): string {
  return `${slot.parkName}\n${slot.facilityName}\n${slot.date} ${slot.start}〜${slot.end}\n取得時点：${slot.observedAt}\n公式サイトで現在の空き状況・予約可否を確認してください。`
}
