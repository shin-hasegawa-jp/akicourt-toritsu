import { afterEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import ConnectionCheck from '../ConnectionCheck.vue'

afterEach(() => vi.unstubAllGlobals())

describe('API connection', () => {
  it('keeps input available while waiting and displays success', async () => {
    let resolve!: (response: Response) => void
    vi.stubGlobal(
      'fetch',
      vi.fn(
        () =>
          new Promise<Response>((done) => {
            resolve = done
          }),
      ),
    )
    const wrapper = mount(ConnectionCheck)
    await wrapper.get('button').trigger('click')
    await wrapper.get('input').setValue('通信中の入力')
    expect((wrapper.get('input').element as HTMLInputElement).value).toBe('通信中の入力')
    expect(wrapper.get('button').attributes('disabled')).toBeDefined()
    resolve(new Response(JSON.stringify({ status: 'ok' })))
    await flushPromises()
    expect(wrapper.get('[role="status"]').text()).toBe('接続成功')
    expect(wrapper.get('button').attributes('disabled')).toBeUndefined()
    wrapper.unmount()
  })

  it('allows retry after a connection failure', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: 'ok' })))
    vi.stubGlobal('fetch', fetch)
    const wrapper = mount(ConnectionCheck)
    await wrapper.get('button').trigger('click')
    await flushPromises()
    expect(wrapper.text()).toContain('接続できません')
    await wrapper.get('button').trigger('click')
    await flushPromises()
    expect(wrapper.get('[role="status"]').text()).toBe('接続成功')
    wrapper.unmount()
  })
})
