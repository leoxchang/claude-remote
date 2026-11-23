import { FastifyReply } from 'fastify';

/** 统一的契约错误体：code 为大写下划线稳定码，message 与 code 相同。 */
export function sendError(
  reply: FastifyReply,
  statusCode: number,
  code: string,
): FastifyReply {
  return reply.code(statusCode).send({ error: { code, message: code } });
}