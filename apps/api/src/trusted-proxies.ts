export function trustedProxiesFromEnvironment(value: string | undefined): string[] | undefined {
  // `TRUSTED_PROXIES`: comma-separated addresses (or CIDR ranges) of the reverse proxies allowed to say who
  // the client is, set only where a proxy is the sole way in (deploy/production). Empty or unset trusts no
  // proxy. The list is not validated here: Fastify compiles it at startup, so an invalid address stops the
  // API instead of being ignored. (The comment lives inside the function: Node's coverage counts comment
  // lines above a module's first statement as uncovered.)
  const addresses = (value ?? "").split(",").map((address) => address.trim()).filter(Boolean);
  return addresses.length > 0 ? addresses : undefined;
}
