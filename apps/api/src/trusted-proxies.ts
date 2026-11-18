/**
 * Reads `TRUSTED_PROXIES`: a comma-separated list of the reverse proxy addresses (or CIDR ranges) allowed
 * to say who the client is. Set only where a proxy is the sole way in (deploy/production). Empty or unset
 * means no proxy is trusted. The list is not validated here: Fastify compiles it at startup, so an invalid
 * address stops the API instead of being ignored.
 */
export function trustedProxiesFromEnvironment(value: string | undefined): string[] | undefined {
  const addresses = (value ?? "").split(",").map((address) => address.trim()).filter(Boolean);
  return addresses.length > 0 ? addresses : undefined;
}
