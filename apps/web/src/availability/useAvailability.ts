import { computed, onBeforeUnmount, ref, watch } from 'vue'
import * as api from './api'
import { validate, type Conditions, type SearchResult } from './model'

export function useAvailability(form: Conditions) {
  const result = ref<SearchResult | null>(null)
  const applied = ref('')
  const error = ref('')
  const notice = ref('')
  const loading = ref(false)
  const updating = ref(false)
  const jobs = ref<api.Job[]>([])
  const pollFailed = ref(false)
  let generation = 0
  let controller: AbortController | undefined
  let sleepCancel: (() => void) | undefined
  const key = () => JSON.stringify(form)
  const changed = computed(() => result.value !== null && applied.value !== key())
  const canUpdate = computed(
    () => !!result.value && !changed.value && !loading.value && !updating.value,
  )
  function stop() {
    generation++
    controller?.abort()
    sleepCancel?.()
    controller = undefined
    loading.value = false
    updating.value = false
    pollFailed.value = false
  }
  function begin() {
    stop()
    controller = new AbortController()
    return {
      id: generation,
      signal: controller.signal,
      conditions: JSON.parse(key()) as Conditions,
    }
  }
  const current = (id: number) => id === generation
  const message = (e: unknown) =>
    e instanceof api.RequestError ? e.message : '処理を完了できません。再試行してください。'
  async function read(id: number, signal: AbortSignal, input: Conditions) {
    loading.value = true
    try {
      const found = await api.search(input, signal)
      if (!current(id)) return
      result.value = found
      applied.value = JSON.stringify(input)
      error.value = ''
    } catch (e) {
      if (current(id) && !signal.aborted) error.value = message(e)
    } finally {
      if (current(id)) loading.value = false
    }
  }
  async function search() {
    const invalid = validate(form)
    if (invalid) {
      error.value = invalid
      return true
    }
    const run = begin()
    jobs.value = []
    error.value = ''
    notice.value = ''
    await read(run.id, run.signal, run.conditions)
    return current(run.id)
  }
  function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        sleepCancel = undefined
        resolve()
      }, ms)
      sleepCancel = () => {
        clearTimeout(timer)
        sleepCancel = undefined
        resolve()
      }
    })
  }
  async function poll(id: number, signal: AbortSignal, input: Conditions, seconds: number) {
    const deadline = Date.now() + 15 * 60 * 1000
    try {
      while (current(id) && !signal.aborted) {
        if (jobs.value.every((j) => j.state === 'succeeded' || j.state === 'failed')) {
          const failed = jobs.value.some((j) => j.state === 'failed')
          notice.value = '取得処理が終了しました。保存済み情報を再検索しています。'
          await read(id, signal, input)
          if (current(id))
            notice.value = error.value
              ? '取得は終了しましたが、結果の再検索に失敗しました。保存済み情報を検索し直してください。'
              : failed
                ? '一部の取得が失敗しました。前回の成功結果を含めて再検索しました。'
                : '取得処理が完了しました。保存済み情報を再検索しました。'
          return
        }
        if (Date.now() > deadline)
          throw new api.RequestError(
            '進捗の自動確認を終了しました。「進捗を再確認」で続けられます。',
          )
        await sleep(seconds * 1000)
        if (!current(id) || signal.aborted) return
        const progress = await Promise.all(jobs.value.map((j) => api.job(j.jobId, signal)))
        if (!current(id)) return
        jobs.value = progress
      }
    } catch (e) {
      if (current(id) && !signal.aborted) {
        error.value = message(e)
        pollFailed.value = true
      }
    } finally {
      if (current(id)) updating.value = false
    }
  }
  async function update() {
    if (!canUpdate.value) return
    const run = begin()
    updating.value = true
    error.value = ''
    notice.value = ''
    jobs.value = []
    // Freeze exactly the period shown by the last search; never recalculate "today" here.
    run.conditions.dateFrom = result.value!.dateFrom
    run.conditions.dateTo = result.value!.dateTo
    try {
      const accepted = await api.updates(run.conditions, run.signal)
      if (!current(run.id)) return
      jobs.value = accepted.jobs
      await poll(run.id, run.signal, run.conditions, accepted.pollAfterSeconds)
    } catch (e) {
      if (current(run.id) && !run.signal.aborted) error.value = message(e)
    } finally {
      if (current(run.id)) updating.value = false
    }
  }
  async function retryPoll() {
    if (!pollFailed.value || changed.value || !jobs.value.length) return
    const run = begin()
    updating.value = true
    error.value = ''
    await poll(run.id, run.signal, run.conditions, 3)
  }
  watch(
    form,
    () => {
      const wasUpdating = updating.value
      stop()
      jobs.value = []
      error.value = ''
      notice.value = wasUpdating
        ? '条件変更のため進捗確認を停止しました。登録済みの取得処理はサーバーで継続します。'
        : ''
    },
    { deep: true, flush: 'sync' },
  )
  onBeforeUnmount(stop)
  return {
    result,
    error,
    notice,
    loading,
    updating,
    jobs,
    pollFailed,
    changed,
    canUpdate,
    search,
    update,
    retryPoll,
  }
}
