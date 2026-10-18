import { FastifyPluginAsync, FastifyServerOptions } from 'fastify'
import availability, { AvailabilityService } from './routes/availability'
import health from './routes/health'

export interface AppOptions extends FastifyServerOptions {
  service?: AvailabilityService
}
const options: AppOptions = {}

// Public API only. Worker routes are registered by the separate runtime branch.
const app: FastifyPluginAsync<AppOptions> = async (fastify, opts) => {
  await fastify.register(health)
  await fastify.register(health, { prefix: '/api' })
  await fastify.register(availability, { prefix: '/api/availability', service: opts.service })
}
export default app
export { app, options }
