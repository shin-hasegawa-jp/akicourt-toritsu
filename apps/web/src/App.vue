<script setup lang="ts">
import { computed, nextTick, reactive, ref, watch } from 'vue'
import { defaults, parks, weekdayNames, offset, type Conditions } from './availability/model'
import { restoreConditions, saveConditions } from './availability/preferences'
import { useAvailability } from './availability/useAvailability'
import ParkPicker from './components/ParkPicker.vue'

const form = reactive(defaults())
const preferenceMessage = ref('')
try {
  const saved = restoreConditions(localStorage)
  Object.assign(form, saved.conditions)
  preferenceMessage.value = saved.message
  if (form.timeFrom !== '00:00' || form.timeTo !== '24:00') {
    form.timeFrom = '00:00'
    form.timeTo = '24:00'
    preferenceMessage.value = '時間帯の選び方が変わりました。開始時刻を選び直してください。'
  }
} catch {
  preferenceMessage.value = 'ブラウザの条件保存を利用できません。検索は利用できます。'
}
watch(
  () => [
    form.targets,
    form.weekdays,
    form.includeHolidays,
    form.startTimes,
    form.minDurationMinutes,
  ],
  () => {
    try {
      preferenceMessage.value = saveConditions(localStorage, form)
    } catch {
      preferenceMessage.value = '条件を保存できません。ブラウザの保存設定を確認してください。'
    }
  },
  { deep: true },
)
const {
  result,
  appliedConditions,
  error,
  notice,
  loading,
  updating,
  jobs,
  pollFailed,
  changed,
  canUpdate,
  search: runSearch,
  update,
  retryPoll,
} = useAvailability(form)
const errorElement = ref<HTMLElement | null>(null)
const resultHeading = ref<HTMLElement | null>(null)
const picker = ref<InstanceType<typeof ParkPicker> | null>(null)
const conditionsOpen = ref(true)
const selectedDate = ref('')
const startTimes = ['09:00', '11:00', '13:00', '15:00', '17:00', '19:00']
const timeChoices = computed(() => [...new Set([...startTimes, ...form.startTimes])].sort())
const selectedParks = computed(() => parks.filter((park) => form.targets.includes(park.key)))
const parkSummary = computed(() =>
  selectedParks.value.length
    ? `${selectedParks.value[0]!.parkName}${selectedParks.value.length > 1 ? ` ほか${selectedParks.value.length - 1}対象` : ''}`
    : '公園を選択してください',
)
const dates = computed(() => {
  if (!result.value) return []
  const count =
    Math.round((Date.parse(result.value.dateTo) - Date.parse(result.value.dateFrom)) / 86400000) + 1
  return Array.from({ length: count }, (_, i) => offset(result.value!.dateFrom, i))
})
const groups = computed(() =>
  dates.value
    .filter((date) => !selectedDate.value || selectedDate.value === date)
    .map((date) => ({
      date,
      slots: result
        .value!.slots.filter((slot) => slot.date === date)
        .sort(
          (a, b) => a.start.localeCompare(b.start) || a.parkName.localeCompare(b.parkName, 'ja'),
        ),
    }))
    .filter((group) => selectedDate.value || group.slots.length),
)
function dateState(date: string) {
  const scopes =
    result.value?.scopes.filter(
      (scope) => scope.weekStart <= date && offset(scope.weekStart, 6) >= date,
    ) ?? []
  if (!scopes.length || scopes.every((scope) => scope.dataState === 'unavailable')) return '未確認'
  const count = result.value!.slots.filter((slot) => slot.date === date).length
  return `${count}枠${scopes.some((scope) => scope.dataState !== 'fresh') ? '・一部' : ''}`
}
function dateLabel(date: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(date))) return '未指定'
  return new Intl.DateTimeFormat('ja-JP', {
    timeZone: 'Asia/Tokyo',
    month: 'numeric',
    day: 'numeric',
  }).format(new Date(`${date}T00:00:00Z`))
}
function dayName(date: string) {
  return weekdayNames[new Date(`${date}T00:00:00Z`).getUTCDay()]
}
function summary(input: Conditions, includeParks = true) {
  const names = parks
    .filter((park) => input.targets.includes(park.key))
    .map((park) => `${park.parkName}（${park.label}）`)
    .join('・')
  const days =
    input.weekdays.length === 7
      ? '全曜日'
      : input.weekdays.map((day) => weekdayNames[day]).join('・')
  const time = input.startTimes.length ? `${input.startTimes.join('・')}開始` : '時間指定なし'
  return `${includeParks ? `${names} / ` : ''}${days}${input.includeHolidays ? '・祝日' : ''} / ${time}`
}
async function search() {
  if (!(await runSearch())) return
  await nextTick()
  if (error.value) errorElement.value?.focus()
  else if (result.value && !changed.value) {
    selectedDate.value = ''
    conditionsOpen.value = false
    resultHeading.value?.focus()
  }
}
function preset(kind: 'all' | 'weekend' | 'holiday') {
  form.weekdays = kind === 'all' ? [0, 1, 2, 3, 4, 5, 6] : kind === 'weekend' ? [0, 6] : []
  form.includeHolidays = kind === 'holiday'
}
function stamp(value: string | null): string {
  return value
    ? new Intl.DateTimeFormat('ja-JP', {
        timeZone: 'Asia/Tokyo',
        month: 'numeric',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      }).format(new Date(value))
    : '取得記録なし'
}
function parkName(id: string): string {
  return parks.find((p) => p.parkId === id)?.parkName ?? id
}
</script>

<template>
  <main>
    <header class="page-header">
      <div>
        <p class="eyebrow">TOKYO PARK TENNIS</p>
        <h1>AkiCourt <span>Toritsu</span></h1>
        <p class="tagline">都立公園のテニスコートを、希望の条件で探す。（非公式）</p>
      </div>
      <div class="official-link">
        <a
          class="btn btn-outline"
          href="https://kouen.sports.metro.tokyo.lg.jp/web/"
          target="_blank"
          rel="noopener noreferrer"
          >公式予約サイトを開く（別タブ）</a
        >
        <p class="hint">検索条件は引き継がれません。予約は公式サイトで行います。</p>
      </div>
    </header>
    <div class="workspace">
      <section class="panel conditions" aria-labelledby="conditions-title">
        <div class="section-heading">
          <div class="condition-title">
            <h2 id="conditions-title">検索条件</h2>
            <p class="hint">最大5対象・7日間</p>
          </div>
          <button
            class="btn btn-sm btn-outline mobile-condition-toggle"
            type="button"
            :aria-expanded="conditionsOpen"
            aria-controls="condition-form"
            @click="conditionsOpen = !conditionsOpen"
          >
            {{ conditionsOpen ? '条件を閉じる' : '条件を変更' }}
          </button>
        </div>
        <dl class="mobile-condition-summary">
          <div>
            <dt>公園</dt>
            <dd>{{ parkSummary }}</dd>
          </div>
          <div>
            <dt>期間</dt>
            <dd>{{ dateLabel(form.dateFrom) }} 〜 {{ dateLabel(form.dateTo) }}</dd>
          </div>
          <div>
            <dt>条件</dt>
            <dd>{{ summary(form, false) }}</dd>
          </div>
        </dl>
        <p v-if="preferenceMessage" class="hint" role="status">{{ preferenceMessage }}</p>
        <form
          id="condition-form"
          :class="{ 'mobile-collapsed': !conditionsOpen }"
          novalidate
          @submit.prevent="search"
        >
          <fieldset>
            <legend>公園</legend>
            <div class="park-summary">
              <strong
                :title="selectedParks.map((park) => `${park.parkName} ${park.label}`).join('、')"
                >{{ parkSummary }}</strong
              >
              <p class="hint">{{ form.targets.length }}対象を選択中</p>
              <button class="btn btn-outline w-full" type="button" @click="picker?.open()">
                公園を変更
              </button>
            </div>
          </fieldset>
          <fieldset>
            <legend>利用する期間</legend>
            <div class="two-fields">
              <label for="date-from"
                >開始日<input
                  id="date-from"
                  v-model="form.dateFrom"
                  class="input input-bordered w-full"
                  type="date" /></label
              ><label for="date-to"
                >終了日<input
                  id="date-to"
                  v-model="form.dateTo"
                  class="input input-bordered w-full"
                  type="date"
              /></label>
            </div>
            <p class="hint">開始日・終了日を含めて7日間まで。</p>
          </fieldset>
          <fieldset>
            <legend>曜日・祝日</legend>
            <div class="presets">
              <button
                class="btn btn-sm"
                type="button"
                :aria-pressed="form.weekdays.length === 7 && !form.includeHolidays"
                @click="preset('all')"
              >
                全曜日</button
              ><button
                class="btn btn-sm"
                type="button"
                :aria-pressed="
                  form.weekdays.length === 2 &&
                  form.weekdays.includes(0) &&
                  form.weekdays.includes(6) &&
                  !form.includeHolidays
                "
                @click="preset('weekend')"
              >
                土日</button
              ><button
                class="btn btn-sm"
                type="button"
                :aria-pressed="!form.weekdays.length && form.includeHolidays"
                @click="preset('holiday')"
              >
                祝日のみ
              </button>
            </div>
            <details class="weekday-details">
              <summary>曜日を個別に選ぶ</summary>
              <div class="weekdays">
                <label v-for="(day, index) in weekdayNames" :key="day"
                  ><input
                    v-model="form.weekdays"
                    class="checkbox checkbox-primary checkbox-sm"
                    type="checkbox"
                    :value="index"
                  />{{ day }}</label
                >
              </div>
            </details>
            <label class="check"
              ><input
                v-model="form.includeHolidays"
                class="checkbox checkbox-primary checkbox-sm"
                type="checkbox"
              />祝日も含める</label
            >
          </fieldset>
          <fieldset>
            <legend>時間帯</legend>
            <p class="time-summary">
              {{ form.startTimes.length ? `${form.startTimes.join('・')}開始` : '時間指定なし' }}
            </p>
            <details class="time-details">
              <summary>開始時刻を選ぶ（複数選択）</summary>
              <div class="time-choices">
                <label v-for="time in timeChoices" :key="time" class="time-choice"
                  ><input
                    v-model="form.startTimes"
                    type="checkbox"
                    :value="time"
                    :aria-label="`${time}開始`"
                  /><span>{{
                    time.endsWith(':00') ? `${Number(time.slice(0, 2))}時開始` : `${time}開始`
                  }}</span></label
                >
              </div>
              <button class="btn btn-sm btn-ghost" type="button" @click="form.startTimes = []">
                時間指定を解除
              </button>
              <p class="hint">
                終了時刻は公園・季節で異なります。選択した開始時刻の枠を表示します。
              </p>
            </details>
            <details class="duration-details">
              <summary>詳しい条件</summary>
              <label for="duration"
                >1枠の最低時間<select
                  id="duration"
                  v-model="form.minDurationMinutes"
                  class="select select-bordered w-full"
                >
                  <option :value="0">指定なし</option>
                  <option :value="60">1時間以上</option>
                  <option :value="120">2時間以上</option>
                  <option :value="180">3時間以上</option>
                </select></label
              >
              <p class="hint">連続枠は結合しません。同じコートでの連続利用は保証されません。</p>
            </details>
          </fieldset>
          <p v-if="error" ref="errorElement" class="error" role="alert" tabindex="-1">
            {{ error }}
          </p>
          <button class="btn btn-primary w-full search-button" type="submit">
            {{ loading ? '再検索（検索中）' : '空きを探す' }}
          </button>
        </form>
        <p v-if="error && !conditionsOpen" class="error mobile-error" role="alert">{{ error }}</p>
      </section>
      <section class="panel results" aria-labelledby="results-title">
        <div class="section-heading">
          <h2 id="results-title" ref="resultHeading" tabindex="-1">検索結果</h2>
          <div v-if="result" class="result-actions">
            <span v-if="result" class="badge badge-soft badge-primary">{{
              result.coverage === 'none'
                ? '未確認'
                : selectedDate
                  ? dateState(selectedDate)
                  : `${result.slots.length}枠`
            }}</span>
            <div class="update-controls">
              <button
                class="btn btn-sm btn-outline"
                type="button"
                :disabled="!canUpdate"
                @click="update"
              >
                {{ updating ? '取得状況を確認中' : '空き情報を更新' }}
              </button>
            </div>
          </div>
        </div>
        <p v-if="!result && !loading" class="empty">
          公園と期間を選び、「空きを探す」を押してください。
        </p>
        <p v-if="loading" role="status" class="notice">
          保存済み情報を検索しています。条件は引き続き編集できます。
        </p>
        <p v-if="notice" role="status" class="notice">{{ notice }}</p>
        <template v-if="result">
          <div class="date-nav" :class="{ 'has-selected-date': selectedDate }">
            <button
              v-if="selectedDate"
              class="btn btn-sm btn-ghost"
              type="button"
              :aria-pressed="!selectedDate"
              @click="selectedDate = ''"
            >
              すべての日付
            </button>
            <div class="date-strip" aria-label="検索結果の日付">
              <button
                v-for="date in dates"
                :key="date"
                class="date-button"
                type="button"
                :aria-pressed="selectedDate === date"
                :aria-label="`${dateLabel(date)} ${dayName(date)}曜日 ${dateState(date)}`"
                @click="selectedDate = selectedDate === date ? '' : date"
              >
                <strong>{{ dateLabel(date) }}</strong
                ><span>（{{ dayName(date) }}）</span><small>{{ dateState(date) }}</small>
              </button>
            </div>
          </div>
          <div
            v-if="appliedConditions"
            class="applied-summary"
            :class="{ 'summary-changed': changed }"
          >
            <strong>検索した条件</strong>
            <p>
              {{ dateLabel(result.dateFrom) }} 〜 {{ dateLabel(result.dateTo) }} ·
              {{ summary(appliedConditions) }}
            </p>
          </div>
          <p v-if="changed" class="notice" role="status">
            条件が変更されています。表示中の結果は前回検索時の条件です。再検索してください。
          </p>
          <p v-if="result.coverage === 'none'" class="notice" role="status">
            まだ確認できたデータがありません。「空きなし」という意味ではありません。
          </p>
          <p v-else-if="result.coverage === 'partial'" class="notice" role="status">
            一部の範囲が未確認です。確認済みの範囲だけを表示しています。
          </p>
          <p
            v-if="result.scopes.some((scope) => scope.dataState === 'stale')"
            class="notice"
            role="status"
          >
            前回の古い結果を表示しています。範囲ごとの最新の取得状態も確認してください。
          </p>
        </template>
        <div v-if="jobs.length" class="coverage" role="status">
          <p>更新状況（通信件数は完了率ではありません）</p>
          <ul>
            <li v-for="job in jobs" :key="job.jobId">
              {{ parkName(job.parkId) }} · {{ job.weekStart }}からの週 ·
              {{
                {
                  queued: '取得待ち',
                  running: '取得中',
                  succeeded: '取得成功',
                  failed: '取得失敗',
                }[job.state]
              }}
              · 通信{{ job.requestCount }}件<span v-if="job.retryAfter"
                >再要求まで{{ job.retryAfter }}秒（確認時点）</span
              >
            </li>
          </ul>
          <button
            v-if="pollFailed && !changed"
            class="btn btn-sm btn-outline"
            type="button"
            @click="retryPoll"
          >
            進捗を再確認
          </button>
        </div>
        <template v-if="result">
          <p
            v-if="!result.slots.length && !selectedDate && result.coverage !== 'none'"
            class="empty"
          >
            {{
              result.coverage === 'complete'
                ? '保存済み情報に、条件に合う枠はありません。'
                : '確認済みの範囲に、条件に合う枠はありません。'
            }}
          </p>
          <section
            v-for="group in groups"
            :key="group.date"
            class="day-group"
            :aria-label="`${dateLabel(group.date)}の空き枠`"
          >
            <div class="day-heading">
              <h3>
                {{ dateLabel(group.date) }}
                <span
                  :class="{
                    saturday: dayName(group.date) === '土',
                    sunday: dayName(group.date) === '日',
                  }"
                  >（{{ dayName(group.date) }}）</span
                >
              </h3>
              <span class="hint">{{ dateState(group.date) }}</span>
            </div>
            <p v-if="!group.slots.length" class="day-empty">
              {{
                dateState(group.date) === '未確認'
                  ? 'この日の情報は未確認です。'
                  : result.coverage === 'complete'
                    ? '保存済み情報に、条件に合う枠はありません。'
                    : '確認済みの範囲に、条件に合う枠はありません。'
              }}
            </p>
            <ul v-else class="slot-list" aria-label="条件に一致する空き枠">
              <li
                v-for="slot in group.slots"
                :key="`${slot.snapshotId}:${slot.facilityId}:${slot.date}:${slot.start}`"
                class="slot"
              >
                <div class="slot-time">
                  <strong>{{ slot.start }}–{{ slot.end }}</strong>
                </div>
                <div class="slot-place">
                  <strong>{{ slot.parkName }}</strong
                  ><span>{{ slot.facilityName }}</span
                  ><small>取得 {{ stamp(slot.observedAt) }}</small>
                </div>
                <div class="slot-courts">
                  <small>空きコート数</small
                  ><strong>{{ slot.availableCourts }} <span>面</span></strong>
                </div>
              </li>
            </ul>
          </section>
          <div class="freshness-row">
            <p class="hint">取得時点の情報です。現在の空き状況は公式サイトで確認してください。</p>
          </div>
          <details class="coverage">
            <summary>範囲ごとの取得状態</summary>
            <p class="hint">
              更新は検索した対象・期間に対して行います。取得待ちの間も条件を編集できます。
            </p>
            <ul>
              <li
                v-for="scope in result.scopes"
                :key="`${scope.parkId}:${scope.surface}:${scope.weekStart}`"
              >
                <strong
                  >{{ parkName(scope.parkId) }}・{{
                    scope.surface === 'grass' ? '人工芝' : 'ハード'
                  }}</strong
                ><span
                  >{{ scope.weekStart }}からの週 ·
                  {{
                    scope.dataState === 'unavailable'
                      ? '未取得'
                      : scope.dataState === 'stale'
                        ? '古い結果'
                        : '取得済み'
                  }}
                  · {{ stamp(scope.lastSuccessAt) }}</span
                ><span v-if="scope.latestAttempt?.state === 'failed'" class="failure"
                  >最新の取得に失敗（{{
                    scope.latestAttempt.errorCode === 'timeout' ? 'タイムアウト' : '取得エラー'
                  }}）</span
                ><span
                  v-if="
                    scope.latestAttempt?.state === 'running' ||
                    scope.latestAttempt?.state === 'queued'
                  "
                  >取得待ち・取得中</span
                >
              </li>
            </ul>
          </details>
        </template>
      </section>
    </div>
    <ParkPicker ref="picker" :selected="form.targets" @apply="form.targets = $event" />
  </main>
</template>
