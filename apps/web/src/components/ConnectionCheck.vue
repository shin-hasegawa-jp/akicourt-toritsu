<script setup lang="ts">
import { ref } from 'vue'
import * as v from 'valibot'
import { HealthSchema } from '../availability/schemas'

const status = ref('未確認')
const checking = ref(false)
const note = ref('')

async function checkConnection() {
  if (checking.value) return
  checking.value = true
  status.value = '確認中'
  const controller = new AbortController()
  const timeout = window.setTimeout(() => controller.abort(), 5000)
  try {
    const response = await fetch('/api/health', { signal: controller.signal })
    if (!response.ok) throw new Error('HTTP error')
    const body: unknown = await response.json()
    if (!v.safeParse(HealthSchema, body).success) {
      throw new Error('Unexpected response')
    }
    status.value = '接続成功'
  } catch {
    status.value = '接続できません。APIの起動を確認して再試行してください。'
  } finally {
    window.clearTimeout(timeout)
    checking.value = false
  }
}
</script>

<template>
  <section>
    <h3>API接続</h3>
    <p>開発環境の接続確認</p>
    <button :disabled="checking" @click="checkConnection">API接続を確認</button>
    <p role="status">{{ status }}</p>
    <label for="note">メモ（通信中も入力できます）</label>
    <input id="note" v-model="note" type="text" />
  </section>
</template>

<style scoped>
section {
  max-width: 40rem;
}
h3 {
  margin-bottom: 1rem;
}
button,
input {
  font: inherit;
  padding: 0.6rem;
}
p {
  margin: 1rem 0;
}
label {
  display: block;
  margin-bottom: 0.4rem;
}
input {
  width: 100%;
}
</style>
