/**
 * Reads a configured service port without triggering a composition root's
 * unavailable-after-cutover `get` fallback. The fallback intentionally returns
 * a throwing function for retired surfaces, so a port's value is not a reliable
 * presence signal; Proxy property presence is.
 */
export function configuredServicePort<Service extends object, Port extends keyof Service>(
  services: Service,
  port: Port,
): Service[Port] | undefined {
  return Reflect.has(services, port) ? services[port] : undefined;
}
