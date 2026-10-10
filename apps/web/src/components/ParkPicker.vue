<script setup lang="ts">
import { computed, ref } from 'vue'
import { parks, parkGroups, type Conditions } from '../availability/model'

const props = defineProps<{ selected: Conditions['targets'] }>()
const emit = defineEmits<{ apply: [targets: Conditions['targets']] }>()
const dialog = ref<HTMLDialogElement | null>(null)
const query = ref('')
const draft = ref<Conditions['targets']>([])
const shown = computed(() =>
  parks.filter((park) =>
    park.parkName.normalize('NFKC').includes(query.value.trim().normalize('NFKC')),
  ),
)
function open() {
  query.value = ''
  draft.value = [...props.selected]
  dialog.value?.showModal()
}
function apply() {
  if (draft.value.length < 1 || draft.value.length > 2) return
  emit('apply', [...draft.value])
  dialog.value?.close()
}
defineExpose({ open })
</script>

<template>
  <dialog ref="dialog" class="modal park-modal" aria-labelledby="park-picker-title">
    <div class="modal-box park-dialog">
      <header class="section-heading">
        <div>
          <h2 id="park-picker-title">公園を選択</h2>
          <p class="hint">公園・種目を最大2対象まで選べます。</p>
        </div>
        <button
          class="btn btn-ghost"
          type="button"
          aria-label="公園選択を閉じる"
          @click="dialog?.close()"
        >
          閉じる
        </button>
      </header>
      <label class="picker-search" for="park-query">公園名で検索</label>
      <input
        id="park-query"
        v-model="query"
        class="input input-bordered w-full"
        type="search"
        placeholder="公園名を入力"
        autofocus
      />
      <div class="selected-parks" aria-live="polite">
        <p class="hint">{{ draft.length }} / 2対象を選択中</p>
        <button
          v-for="park in parks.filter((p) => draft.includes(p.key))"
          :key="park.key"
          class="btn btn-sm btn-outline"
          type="button"
          :aria-label="`${park.parkName} ${park.label}の選択を解除`"
          @click="draft = draft.filter((key) => key !== park.key)"
        >
          {{ park.parkName }} · {{ park.label }}（解除）
        </button>
      </div>
      <div class="target-options">
        <section
          v-for="group in parkGroups"
          :key="group.surface"
          :aria-label="`テニス（${group.label}）`"
        >
          <h3
            v-if="shown.some((park) => park.surface === group.surface)"
            class="target-group-title"
          >
            テニス（{{ group.label }}）
          </h3>
          <label
            v-for="park in shown.filter((p) => p.surface === group.surface)"
            :key="park.key"
            class="target-option"
          >
            <input
              v-model="draft"
              class="checkbox checkbox-primary"
              type="checkbox"
              :value="park.key"
              :aria-label="`${park.parkName} ${park.label}`"
              :disabled="draft.length >= 2 && !draft.includes(park.key)"
            />
            <span>{{ park.parkName }}</span>
          </label>
        </section>
        <p v-if="!shown.length" class="empty">
          一致する公園がありません。別の名前で検索してください。
        </p>
      </div>
      <footer class="picker-actions">
        <button class="btn btn-outline" type="button" @click="dialog?.close()">キャンセル</button>
        <button
          class="btn btn-primary"
          type="button"
          :disabled="!draft.length || draft.length > 2"
          @click="apply"
        >
          選択を適用（{{ draft.length }}対象）
        </button>
      </footer>
    </div>
    <form method="dialog" class="modal-backdrop">
      <button aria-label="公園選択を閉じる">閉じる</button>
    </form>
  </dialog>
</template>
