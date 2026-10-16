import type { IncomingMessage, ServerResponse } from "node:http";

// Verified project deployment configuration, not a provider-wide suffix.
export function projectOrigins(env: Readonly<Record<string, string | undefined>> = process.env): readonly string[] {
  const origins = ["https://sre-of-me-replit.replit.app", "https://sre-of-me-replit.pmhlabs.org"];
  if (env.NODE_ENV !== "production" && env.REPLIT_DEV_DOMAIN) {
    const host = authority(env.REPLIT_DEV_DOMAIN);
    if (!host) throw new Error("Invalid configured Preview address");
    origins.push(`https://${host}`);
  }
  return Object.freeze(Array.from(new Set(origins)));
}

function authority(value: string): string | undefined {
  // Deliberately exclude IP aliases, userinfo, whitespace, URL escapes, trailing
  // dots, leading-zero ports and ambiguous lists. HTTPS default port is canonical.
  if (!/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?::443)?$/i.test(value)) return;
  if (value.length > 253 || value.split(".").some(label => label.length > 63)) return;
  return value.toLowerCase().replace(/:443$/, "");
}

export function matchTrustedOrigin(req: Pick<IncomingMessage,"rawHeaders">, origins: readonly string[]): string | undefined {
  const headers = new Map<string,string[]>();
  for(let i=0;i<req.rawHeaders.length;i+=2){
    const key=req.rawHeaders[i].toLowerCase();
    headers.set(key,[...(headers.get(key)??[]),req.rawHeaders[i+1]]);
  }
  const hosts=headers.get("host");
  if(hosts?.length!==1) return;
  const host=authority(hosts[0]);
  if(!host) return;
  const origin=origins.find(origin=>origin===`https://${host}`);
  if(!origin || headers.has("forwarded")) return;
  const forwarded=headers.get("x-forwarded-host");
  if(forwarded && (forwarded.length!==1 || authority(forwarded[0])!==host)) return;
  const protocol=headers.get("x-forwarded-proto");
  if(protocol && (protocol.length!==1 || protocol[0]!=="https")) return;
  return origin;
}

const matched = new WeakMap<IncomingMessage,string>();
export function matchedOrigin(req: IncomingMessage): string {
  const origin=matched.get(req);
  if(!origin) throw new Error("Request has no validated project address");
  return origin;
}
export function trustedAddressGuard(origins: readonly string[] = projectOrigins()) {
  const fixed=Object.freeze([...origins]);
  return (req: IncomingMessage,res: ServerResponse,next:()=>void) => {
    const origin=matchTrustedOrigin(req,fixed);
    if(!origin){res.statusCode=421;res.end("Untrusted request address");return;}
    matched.set(req,origin);next();
  };
}
