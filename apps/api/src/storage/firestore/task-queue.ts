import * as v from 'valibot'
import { CloudTasksClient } from '@google-cloud/tasks'
import { ProjectId, parseValue } from '../../validation'

export const QueueConfig = v.object({
  projectId: ProjectId,
  location: v.pipe(v.string(), v.regex(/^[a-z][a-z0-9-]+$/)),
  queue: v.pipe(v.string(), v.regex(/^[a-zA-Z0-9_-]{1,100}$/)),
})
export interface QueueMaintenance {
  readonly name: string
  pauseAndPurge(): Promise<void>
  resume(): Promise<void>
}
export class CloudTaskQueue implements QueueMaintenance {
  readonly name: string
  constructor(
    config: v.InferOutput<typeof QueueConfig>,
    private readonly client = new CloudTasksClient(),
  ) {
    const value = parseValue(QueueConfig, config, () => new Error('invalid-queue-config'))
    this.name = `projects/${value.projectId}/locations/${value.location}/queues/${value.queue}`
  }
  async pauseAndPurge() {
    await this.client.pauseQueue({ name: this.name }, { timeout: 5000, retry: null })
    await this.client.purgeQueue({ name: this.name }, { timeout: 5000, retry: null })
  }
  async resume() {
    await this.client.resumeQueue({ name: this.name }, { timeout: 5000, retry: null })
  }
  async close() {
    await this.client.close()
  }
}
