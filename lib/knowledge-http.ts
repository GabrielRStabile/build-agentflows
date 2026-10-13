import { lookup } from "node:dns/promises";
import { isIP, BlockList } from "node:net";
import { Agent, fetch as request } from "undici";
import { FlowError } from "./flow-store";

const blocked = new BlockList(), blockedV6 = new BlockList();
for (const [ip, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.168.0.0", 16],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const)
  blocked.addSubnet(ip, prefix, "ipv4");
for (const [ip, prefix] of [
  ["::", 128],
  ["::1", 128],
  ["::ffff:0:0", 96],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
] as const)
  blockedV6.addSubnet(ip, prefix, "ipv6");
// Node's BlockList also matches plain IPv4 against the ::ffff:0:0/96 rule, which would
// block every public IPv4. Check each family separately; dotted mapped IPv6 uses IPv4 rules.
export function privateKnowledgeAddress(address: string) {
  const value = address.replace(/^\[|\]$/g, "");
  const mapped = value.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i)?.[1];
  if (mapped || isIP(value) === 4) return blocked.check(mapped || value, "ipv4");
  return blockedV6.check(value, "ipv6");
}
export class KnowledgeServiceError extends FlowError {
  upstreamStatus: number;
  constructor(status: number) {
    super(
      `O serviço respondeu com erro ${status}. Confira a configuração e a permissão de acesso.`,
      502,
    );
    this.upstreamStatus = status;
  }
}
export function knowledgeUrl(value: string) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new FlowError("Informe um endereço HTTP ou HTTPS válido.");
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password
  )
    throw new FlowError(
      "Use um endereço HTTP ou HTTPS sem credenciais na URL.",
    );
  return url;
}
// Resolve once and pins the socket to the checked address, including after redirects.
// Private infrastructure is allowed only for explicitly configured embeddings/vector servers.
export async function knowledgeFetch(
  value: string,
  options: {
    method?: string;
    headers?: Record<string, string>;
    body?: unknown;
    signal?: AbortSignal;
    infrastructure?: boolean;
    maxBytes?: number;
    redirects?: boolean;
  } = {},
): Promise<Buffer> {
  const deadline = AbortSignal.timeout(120000);
  const signal = options.signal
    ? AbortSignal.any([deadline, options.signal])
    : deadline;
  let url = knowledgeUrl(value);
  for (let redirects = 0; redirects < 6; redirects++) {
    const host = url.hostname.replace(/^\[|\]$/g, "");
    const addresses = isIP(host)
      ? [{ address: host, family: isIP(host) }]
      : await lookup(host, { all: true });
    if (
      !addresses.length ||
      (!options.infrastructure &&
        addresses.some(({ address }) => privateKnowledgeAddress(address)))
    )
      throw new FlowError(
        "A fonte precisa usar um endereço público da internet.",
      );
    const address = addresses[0];
    const dispatcher = new Agent({
      connect: {
        autoSelectFamily: true,
        lookup: (_hostname, _options, callback) => {
          if (_options.all) callback(null, addresses);
          else callback(null, address.address, address.family);
        },
      },
    });
    try {
      const response = await request(url, {
        method: options.method || "GET",
        headers: {
          ...(options.body === undefined
            ? {}
            : { "Content-Type": "application/json" }),
          ...options.headers,
        },
        body:
          options.body === undefined ? undefined : JSON.stringify(options.body),
        signal,
        redirect: "manual",
        dispatcher,
      });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        await response.body?.cancel();
        if (options.redirects === false) throw new FlowError("O serviço redirecionou o pedido. Confira o endereço.");
        const next = knowledgeUrl(
          new URL(response.headers.get("location") || "", url).href,
        );
        // Never forward credentials or POST data to another origin.
        if (
          next.origin !== url.origin &&
          (Object.keys(options.headers || {}).length ||
            options.body !== undefined)
        )
          throw new FlowError(
            "O serviço redirecionou a credencial para outro domínio. Confira o endereço.",
          );
        url = next;
        continue;
      }
      if (!response.ok) {
        await response.body?.cancel();
        throw new KnowledgeServiceError(response.status);
      }
      const max = options.maxBytes || 10 * 1024 * 1024;
      if (Number(response.headers.get("content-length")) > max) {
        await response.body?.cancel();
        throw new FlowError("O documento excede o limite de 10 MB.", 413);
      }
      const parts: Buffer[] = [];
      let size = 0;
      if (response.body)
        for await (const part of response.body) {
          size += part.length;
          if (size > max) {
            await response.body.cancel().catch(() => {});
            throw new FlowError("O conteúdo excede o limite permitido.", 413);
          }
          parts.push(Buffer.from(part));
        }
      return Buffer.concat(parts);
    } finally {
      await dispatcher.close();
    }
  }
  throw new FlowError("O endereço fez redirecionamentos demais.");
}
export async function knowledgeJson<T>(
  url: string,
  options?: Parameters<typeof knowledgeFetch>[1],
): Promise<T> {
  const bytes = await knowledgeFetch(url, options);
  try {
    return JSON.parse(bytes.toString("utf8")) as T;
  } catch {
    throw new FlowError("O serviço não retornou um JSON válido.", 502);
  }
}
