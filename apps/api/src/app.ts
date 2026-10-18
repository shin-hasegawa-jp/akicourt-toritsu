import { FastifyPluginAsync, FastifyServerOptions } from 'fastify'
import availability from './routes/availability'
import health from './routes/health'

export interface AppOptions extends FastifyServerOptions {}
const options: AppOptions = {}

// Public API only. Worker routes are registered by the separate runtime branch.
const app: FastifyPluginAsync<AppOptions> = async (fastify) => {
  await fastify.register(health)
  await fastify.register(health, { prefix: '/api' })
  await fastify.register(availability, { prefix: '/api/availability' })
}
export default app
export { app, options }
