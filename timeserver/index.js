// A millisecond time server for the crystal pages, in the format of time.akamai.com/?ms: Unix seconds with three
// decimals. Date.now() in a Worker is the time the request arrived (it doesn't advance while the Worker runs).

export default {
  fetch() {
    return new Response((Date.now() / 1000).toFixed(3), {
      headers: {
        "content-type": "text/plain",
        "access-control-allow-origin": "*",
        "cache-control": "no-store",
      },
    });
  },
};
