import Fastify, { type FastifyInstance } from "fastify";

export interface DatabaseHealthcheck {
  query: (queryText: string) => Promise<unknown>;
}

export function createApp(
  database: DatabaseHealthcheck,
  options: { logger?: boolean } = {},
): FastifyInstance {
  const app = Fastify({ logger: options.logger ?? false });

  app.get("/health", async (_request, reply) => {
    try {
      await database.query("SELECT 1");
      return { status: "ok", database: "ok" };
    } catch {
      app.log.error("Database health check failed");
      return reply.code(503).send({
        status: "error",
        database: "unavailable",
      });
    }
  });

  return app;
}
