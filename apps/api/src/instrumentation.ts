// Loaded with `node --import` before `server.ts`, because an instrumentation can only patch Fastify,
// pino and pg if it is registered before they are first loaded. Does nothing when no OTLP endpoint is
// configured.
import { startTelemetry } from "./telemetry.js";

const sdk = startTelemetry({ environment: process.env });

if (sdk) {
  // Flush the spans still buffered before the process exits; the server closes itself on the same signals.
  const shutdown = () => {
    sdk.shutdown().catch(() => undefined);
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}
