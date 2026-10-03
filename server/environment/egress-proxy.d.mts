// Types for egress-proxy.mjs (a self-contained script the service also runs inside a container).
import type { AddressInfo, Server } from "node:net";

export type Decision = { allowed: true; host: string; port: number } | { allowed: false; host: string; port?: number; reason: string };
export interface ProxyLine {
  orchestratorProxy: 1;
  host: string;
  port: number | null;
  allowed: boolean;
  reason?: string;
}
export interface ProxyConfig {
  hosts: string[];
  ports?: number[];
  port?: number;
  listen?: string;
  log?: (line: ProxyLine) => void;
  resolve?: (host: string) => Promise<string[]>;
  allowAddress?: (ip: string) => boolean;
  onListening?: (address: AddressInfo) => void;
}
export function isPublicAddress(ip: string): boolean;
export function decide(target: string, cfg: Pick<ProxyConfig, "hosts" | "ports">): Decision;
export function startProxy(cfg: ProxyConfig): Server;
