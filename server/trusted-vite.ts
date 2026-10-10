import type { Plugin } from "vite";
import { matchTrustedOrigin, projectOrigins, trustedAddressGuard } from "../shared/trusted-addresses";

export function trustedVitePlugin(): Plugin {
  const origins=projectOrigins();
  return {
    name:"trusted-project-addresses",
    configureServer(server){
      server.middlewares.use(trustedAddressGuard(origins));
      const hmr=server.config.server.hmr;
      const http=server.httpServer || (typeof hmr==="object" ? hmr.server : undefined);
      if(!http) throw new Error("Missing Development upgrade server");
      const guard = (req: import("node:http").IncomingMessage,socket: import("node:stream").Duplex) => {
        if(!matchTrustedOrigin(req,origins)) {
          socket.write("HTTP/1.1 421 Misdirected Request\r\nConnection: close\r\n\r\n");
          socket.destroy();
        }
      };
      http.prependListener("upgrade",guard);
      http.once("close",()=>http.removeListener("upgrade",guard));
    },
  };
}
