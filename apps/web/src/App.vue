<script setup lang="ts">
import { nextTick, reactive, ref, watch } from 'vue'
import { defaults, parks, parkGroups, weekdayNames } from './availability/model'
import { restoreConditions, saveConditions, slotText } from './availability/preferences'
import { useAvailability } from './availability/useAvailability'

const form = reactive(defaults())
const preferenceMessage = ref('')
try {
  const saved = restoreConditions(localStorage)
  Object.assign(form, saved.conditions)
  preferenceMessage.value = saved.message
} catch {
  preferenceMessage.value = 'ブラウザの条件保存を利用できません。検索は利用できます。'
}
const copyMessage = ref('')
const manualCopy = ref('')
function save() {
  try {
    preferenceMessage.value = saveConditions(localStorage, form)
  } catch {
    preferenceMessage.value = '条件を保存できません。ブラウザの保存設定を確認してください。'
  }
}
watch(
  () => [
    form.targets,
    form.weekdays,
    form.includeHolidays,
    form.timeFrom,
    form.timeTo,
    form.minDurationMinutes,
  ],
  save,
  { deep: true },
)
async function copy(text: string) {
  try {
    await navigator.clipboard.writeText(text)
    manualCopy.value = ''
    copyMessage.value = 'コピーしました。公式サイトで条件を指定して確認してください。'
  } catch {
    manualCopy.value = text
    copyMessage.value = '自動コピーを利用できません。下の内容を選択してコピーしてください。'
  }
}
const {
  result,
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
const times = Array.from(
  { length: 49 },
  (_, i) =>
    `${Math.floor(i / 2)
      .toString()
      .padStart(2, '0')}:${i % 2 ? '30' : '00'}`,
)
async function search() {
  if (!(await runSearch())) return
  await nextTick()
  if (error.value) errorElement.value?.focus()
  else if (!loading.value && !changed.value) resultHeading.value?.focus()
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
        <p>都立公園のテニスコートを、希望の条件で探す。</p>
      </div>
      <span class="preview-badge">保存済み情報の検索</span>
    </header>
    <aside class="notice">
      検索は保存済みの情報を表示します。「空き情報を更新」で取得を依頼できます。取得待ちの間も条件を編集できます。
    </aside>
    <div class="workspace">
      <section class="panel conditions" aria-labelledby="conditions-title">
        <h2 id="conditions-title">検索条件</h2>
        <p class="subtle">最大2対象・7日間。条件は検索後も編集できます。</p>
        <p v-if="preferenceMessage" class="hint" role="status">{{ preferenceMessage }}</p>
        <form novalidate @submit.prevent="search">
          <fieldset>
            <legend>公園・種目</legend>
            <p class="hint selected-targets">
              選択中：{{
                parks
                  .filter((park) => form.targets.includes(park.key))
                  .map((park) => `${park.parkName}（${park.label}）`)
                  .join('、') || 'なし'
              }}
            </p>
            <div class="target-options">
              <section
                v-for="group in parkGroups"
                :key="group.surface"
                :aria-label="`テニス（${group.label}）`"
              >
                <h3 class="target-group-title">テニス（{{ group.label }}）</h3>
                <label
                  v-for="park in parks.filter((park) => park.surface === group.surface)"
                  :key="park.key"
                  class="target-option"
                  ><input
                    v-model="form.targets"
                    type="checkbox"
                    :value="park.key"
                    :aria-label="`${park.parkName} ${park.label}`"
                  /><span>{{ park.parkName }}</span></label
                >
              </section>
            </div>
          </fieldset>
          <fieldset>
            <legend>利用する期間</legend>
            <div class="two-fields">
              <label for="date-from"
                >開始日<input id="date-from" v-model="form.dateFrom" type="date" /></label
              ><label for="date-to"
                >終了日<input id="date-to" v-model="form.dateTo" type="date"
              /></label>
            </div>
            <p class="hint">初期値は日本時間の本日から7日間。終了日を含みます。</p>
          </fieldset>
          <fieldset>
            <legend>曜日・祝日</legend>
            <div class="presets">
              <button type="button" @click="preset('all')">全曜日</button
              ><button type="button" @click="preset('weekend')">土日</button
              ><button type="button" @click="preset('holiday')">祝日のみ</button>
            </div>
            <div class="weekdays">
              <label v-for="(day, index) in weekdayNames" :key="day"
                ><input v-model="form.weekdays" type="checkbox" :value="index" />{{ day }}</label
              >
            </div>
            <label class="check"
              ><input v-model="form.includeHolidays" type="checkbox" />祝日も含める</label
            >
            <p class="hint">選んだ曜日、または祝日に一致する枠を表示します。</p>
          </fieldset>
          <fieldset>
            <legend>時間帯・枠の長さ</legend>
            <div class="two-fields">
              <label for="time-from"
                >開始時刻<select id="time-from" v-model="form.timeFrom">
                  <option v-for="time in times.slice(0, -1)" :key="time">{{ time }}</option>
                </select></label
              ><label for="time-to"
                >終了時刻<select id="time-to" v-model="form.timeTo">
                  <option v-for="time in times.slice(1)" :key="time">{{ time }}</option>
                </select></label
              >
            </div>
            <label for="duration"
              >1枠の最低時間<select id="duration" v-model="form.minDurationMinutes">
                <option :value="0">指定なし</option>
                <option :value="60">1時間以上</option>
                <option :value="120">2時間以上</option>
                <option :value="180">3時間以上</option>
              </select></label
            >
            <p class="hint">
              枠全体が時間帯に収まるもの。連続枠を結合せず、同じコートの連続利用も保証しません。
            </p>
          </fieldset>
          <p v-if="error" ref="errorElement" class="error" role="alert" tabindex="-1">
            {{ error }}
          </p>
          <button class="primary" type="submit">
            {{ loading ? '再検索（検索中）' : '保存済み情報を検索' }}
          </button>
        </form>
      </section>
      <section class="panel results" aria-labelledby="results-title">
        <aside class="notice">
          <a
            href="https://kouen.sports.metro.tokyo.lg.jp/web/"
            target="_blank"
            rel="noopener noreferrer"
            >公式サイトで確認（別タブ）</a
          >
          <p v-if="copyMessage" role="status">{{ copyMessage }}</p>
          <label v-if="manualCopy"
            >手動コピー用<textarea
              readonly
              :value="manualCopy"
              @focus="($event.target as HTMLTextAreaElement).select()"
            />
          </label>
        </aside>
        <div class="section-heading">
          <h2 id="results-title" ref="resultHeading" tabindex="-1">検索結果</h2>
          <span v-if="result" class="count">{{ result.slots.length }}枠</span>
        </div>
        <p v-if="!result" class="empty">条件を選び、「保存済み情報を検索」を押してください。</p>
        <p v-if="loading" role="status" class="notice">
          保存済み情報を検索しています。条件は引き続き編集できます。
        </p>
        <p v-if="notice" role="status" class="notice">{{ notice }}</p>
        <div v-if="result" class="update-controls">
          <button type="button" class="primary" :disabled="!canUpdate" @click="update">
            {{ updating ? '取得状況を確認中' : '空き情報を更新' }}
          </button>
          <p class="hint">
            表示中の対象・期間の取得を依頼します。条件を変更した場合は、先に再検索してください。
          </p>
        </div>
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
          <button v-if="pollFailed && !changed" type="button" @click="retryPoll">
            進捗を再確認
          </button>
        </div>
        <template v-if="result">
          <p class="subtle">{{ result.dateFrom }} 〜 {{ result.dateTo }}・取得時刻は日本時間</p>
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
          <details class="coverage" open>
            <summary>範囲ごとの取得状態</summary>
            <ul>
              <li
                v-for="scope in result.scopes"
                :key="`${scope.parkId}:${scope.surface}:${scope.weekStart}`"
              >
                <strong
                  >{{ parkName(scope.parkId) }}・{{
                    scope.surface === 'grass' ? '人工芝' : 'ハード'
                  }}</strong
                ><span>{{ scope.weekStart }}からの週</span
                ><span
                  >{{
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
          <p v-if="!result.slots.length && result.coverage !== 'none'" class="empty">
            {{
              result.coverage === 'complete'
                ? '保存済み情報に、条件に合う枠はありません。'
                : '確認済みの範囲に、条件に合う枠はありません。'
            }}
          </p>
          <ul v-if="result.slots.length" class="slot-list" aria-label="条件に一致する空き枠">
            <li
              v-for="slot in result.slots"
              :key="`${slot.snapshotId}:${slot.facilityId}:${slot.date}:${slot.start}`"
              class="slot"
            >
              <div class="slot-date">
                {{ slot.date }}<strong>{{ slot.start }}–{{ slot.end }}</strong>
              </div>
              <div class="slot-place">
                <strong>{{ slot.parkName }}</strong
                ><span>{{ slot.facilityName }}</span
                ><small>取得 {{ stamp(slot.observedAt) }}</small>
              </div>
              <span class="courts">{{ slot.availableCourts }}面</span>
              <button
                type="button"
                :aria-label="`${slot.parkName} ${slot.date} ${slot.start}の確認条件をコピー`"
                @click="copy(slotText(slot))"
              >
                この枠の条件をコピー
              </button>
            </li>
          </ul>
          <p class="hint">
            これは取得時点の情報です。現在の空き状況と予約可否は公式サイトで確認してください。
          </p>
        </template>
      </section>
    </div>
  </main>
</template>
