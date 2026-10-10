<script setup lang="ts">
import { computed, nextTick, reactive, ref } from 'vue'
import ConnectionCheck from './components/ConnectionCheck.vue'
import {
  defaults,
  parks,
  preview,
  validate,
  weekdayNames,
  type Scenario,
  type SearchResult,
} from './availability/model'

const form = reactive(defaults())
const scenario = ref<Scenario>('success')
const result = ref<SearchResult | null>(null)
const applied = ref('')
const error = ref('')
const errorElement = ref<HTMLElement | null>(null)
const resultHeading = ref<HTMLElement | null>(null)
const changed = computed(() => result.value !== null && applied.value !== JSON.stringify(form))
const times = Array.from(
  { length: 49 },
  (_, i) =>
    `${Math.floor(i / 2)
      .toString()
      .padStart(2, '0')}:${i % 2 ? '30' : '00'}`,
)
const scenarios: [Scenario, string][] = [
  ['success', '取得成功'],
  ['empty', '一致する枠なし'],
  ['none', '未取得'],
  ['partial', '一部失敗'],
  ['failed', '古い結果・最新取得失敗'],
  ['queued', '取得待ち'],
]
async function search() {
  error.value = validate(form) ?? ''
  if (error.value) {
    await nextTick()
    errorElement.value?.focus()
    return
  }
  result.value = preview(form, scenario.value)
  applied.value = JSON.stringify(form)
  await nextTick()
  resultHeading.value?.focus()
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
      <span class="preview-badge">画面レビュー用モック</span>
    </header>
    <aside class="notice">
      <strong>ここに表示する空き情報はすべて架空です。</strong
      >検索結果は実API・公式サイトへ接続せず生成しています。祝日も確認用の仮データで、開始日＋2日を祝日として扱います。
    </aside>
    <section class="preview-controls" aria-labelledby="preview-title">
      <h2 id="preview-title">表示状態の確認</h2>
      <label for="scenario">モックの状態</label
      ><select id="scenario" v-model="scenario">
        <option v-for="[value, label] in scenarios" :key="value" :value="value">{{ label }}</option>
      </select>
      <p>状態を選び、「モックで検索」で表示します。</p>
    </section>
    <div class="workspace">
      <section class="panel conditions" aria-labelledby="conditions-title">
        <h2 id="conditions-title">検索条件</h2>
        <p class="subtle">最大2対象・7日間。条件は検索後も編集できます。</p>
        <form novalidate @submit.prevent="search">
          <fieldset>
            <legend>公園・種目</legend>
            <label v-for="park in parks" :key="park.key" class="target-option"
              ><input v-model="form.targets" type="checkbox" :value="park.key" /><span
                >{{ park.parkName }}<small>{{ park.label }}</small></span
              ></label
            >
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
          <button class="primary" type="submit">モックで検索</button>
        </form>
      </section>
      <section class="panel results" aria-labelledby="results-title">
        <div class="section-heading">
          <h2 id="results-title" ref="resultHeading" tabindex="-1">検索結果</h2>
          <span v-if="result" class="count">{{ result.slots.length }}枠</span>
        </div>
        <p v-if="!result" class="empty">条件を選び、「モックで検索」を押してください。</p>
        <template v-else>
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
            前回の古い結果を表示しています。最新の取得は失敗しました。
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
                  >取得待ち（モック）</span
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
                ><small>取得 {{ stamp(slot.observedAt) }}（架空）</small>
              </div>
              <span class="courts">{{ slot.availableCourts }}面</span>
            </li>
          </ul>
          <p class="hint">
            これは取得時点の情報です。現在の空き状況と予約可否は公式サイトで確認してください。この画面のデータは架空です。
          </p>
        </template>
      </section>
    </div>
    <details class="connection">
      <summary>開発環境の接続確認</summary>
      <ConnectionCheck />
    </details>
  </main>
</template>
