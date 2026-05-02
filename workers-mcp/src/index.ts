import { WorkerEntrypoint } from 'cloudflare:workers'
import { ProxyToSelf } from 'workers-mcp'

export default class BleMonitorMcpWorker extends WorkerEntrypoint<Env> {
  /**
   * Returns a greeting from this MCP Worker so you can confirm the MCP bridge works.
   *
   * @param {string} name Who to greet
   * @return {string} Greeting message text
   */
  sayHello(name: string): string {
    return `Hello from Workers MCP (web-ble-monitor), ${name}!`
  }

  /** @ignore */
  async fetch(request: Request): Promise<Response> {
    return new ProxyToSelf(this).fetch(request)
  }
}
