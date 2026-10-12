import { FastifyPluginAsync } from 'fastify'

const health: FastifyPluginAsync = async (fastify) => {
  fastify.get(
    '/health',
    {
      schema: {
        response: {
          200: {
            type: 'object',
            properties: { status: { type: 'string', const: 'ok' } },
            required: ['status'],
            additionalProperties: false,
          },
        },
      },
    },
    async () => ({ status: 'ok' }),
  )
}

export default health
