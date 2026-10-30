# time.mfc.cx

The crystal pages' second time server, a Cloudflare Worker. It replies like `time.akamai.com/?ms`: Unix seconds to
the millisecond, readable from any site, never cached. `Date.now()` in a Worker is the time the request arrived.

Deploy from this folder with `wrangler deploy`. Cloudflare serves it at `time.mfc.cx` from the data centre nearest
each visitor. The workers.dev address is off.

The Workers Free plan allows 100,000 requests a day, and one 30 min page run sends it about 500 (three bursts of
120 plus the probes). Past the limit, Cloudflare answers with error 1027 instead of charging, and the pages
carry on with Akamai alone.
