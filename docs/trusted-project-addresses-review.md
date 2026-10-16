# Trusted project addresses — isolated security review

This candidate covers request-address validation and bounded OIDC strategies,
not a provider/user/authentication migration. No owner Preview adoption.

## Trusted configuration and ordering

The publishing metadata read for this project identified exactly
`https://sre-of-me-replit.pmhlabs.org` and
`https://sre-of-me-replit.replit.app`. The exact platform-provided
REPLIT_DEV_DOMAIN is included only outside Production. No provider suffix,
wildcard, arbitrary IP, localhost alias, or caller-supplied address is trusted.
The current owner workspace was clean at
8c10cf64f66602cbd4608602d2e45fee7e336eba before isolation.

The shared request guard examines raw headers before authentication/session
middleware. It requires one Host matching a configured authority. DNS case and
the HTTPS default port normalize; trailing dots, URL syntax, other ports, lists,
duplicate Host/forwarded fields and ambiguous syntax are rejected.
X-Forwarded-Host, when present, must match Host. X-Forwarded-Proto, when present,
must be exactly https. RFC Forwarded is deliberately rejected, rather than
selecting an unverified element from a proxy chain.

This does NOT establish that forwarding headers originated at a trustworthy
edge. Headers cannot choose a new trusted address or callback scheme. HTTPS
callback origins come exclusively from matched configuration, even though
internal HTTP traffic may follow platform TLS termination. The existing
trust-proxy setting and secure-cookie behavior are unchanged.

OIDC strategies are registered once for the finite configuration, not created
from request.hostname. Login and callback select the strategy corresponding to
the guard's matched origin; its callback URL uses that same origin. Logout's
post-logout destination also uses that matched origin.

## Both Development launch paths

The standalone Vite configuration and Express middleware configuration retain
explicit Vite allowedHosts plus a shared stricter request/upgrade guard. This
also rejects Vite's built-in localhost/IP allowances when not project addresses.
Valid HMR still requires Vite's existing token and protocol. The upgrade guard
does not disable those checks. The existing repaired embedded WebSocket code
and all dependency resolutions remain unchanged.

The middleware launcher now preserves the original Vite server configuration
when overriding middleware/HMR settings, including strict file/secrets denial.
A bounded supporting correction prevents the existing custom logger from
terminating the server on Vite's normal file-access-denial message; all other
fatal logger handling is unchanged. setupVite returns its server handle for
deterministic isolated cleanup, with no change to callers that ignore it.
Production static serving is unchanged behind the application address guard.

## Verification and retained attempts

Synthetic tests use the actual setupAuth routes with fake provider/session/
passport implementations: no real discovery, login, owner identity, or database.
They assert rejected requests cause no session/authentication calls, repeated
untrusted authorities cannot grow strategies, and approved login/callback routes
choose matching strategy/callback origins.

Real isolated servers load the actual Vite configuration and setupVite function.
Both paths render allowed pages, reject unapproved hosts on HTML and client
routes, deny a uniquely created synthetic secret file, reject wrong-host and
wrong-token upgrades, and accept valid HMR/custom-message/full-reload exchanges.
Fixtures close servers/clients and remove their own synthetic file.

The initial run retained two assertion failures: native Vite returns 403 while
the custom guard returns 421 (both are denials), and an absent synthetic file
fell through to HTML instead of exercising file denial. Early shutdown also
interrupted the dependency optimizer. Tests now use an exclusively created real
synthetic file and await optimizer scanning before shutdown.
A second run exposed the fatal denial logger behavior; it is corrected above.
Initial standalone strict typing lacked application path aliases and needed
HTTP-server type annotations. The final strict check uses the project's aliases;
the annotation correction has no runtime effect.

## Compatibility and adoption boundaries

Actual owner-edge Host/forwarded-header combinations, deployment health checks,
signed-in OAuth round trips, custom-domain edge routing and Production runtime
are not verified by these isolated tests. In particular, an edge that rewrites
Host to an internal address or adds RFC Forwarded will be rejected, not silently
trusted. Those assumptions require explicit pre-adoption verification. No real
provider requests or external attack probes were made.

The existing private cloud recovery snapshot is retained; it is not refreshed
for this isolated candidate. A fresh newest-data snapshot, cloud download/hash
verification and isolated all-table restoration are required separately before
adoption. Never rewind owner history to roll back code.
