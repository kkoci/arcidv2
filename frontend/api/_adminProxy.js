// Shared helper — Vercel ignores files prefixed with "_", so this isn't itself
// a route. Forwards to the Phala oracle's /admin/<oraclePath> with the
// X-Fault-Token attached server-side (from a Vercel env var), so the browser
// never needs to know the token.
const PHALA_BASE = "https://9c3a144f929db3e05d05bb03839a04527bda9841-3001.dstack-pha-prod5.phala.network";

export async function proxyAdmin(req, res, oraclePath) {
  try {
    const upstream = await fetch(`${PHALA_BASE}/admin/${oraclePath}`, {
      method: req.method,
      headers: {
        "Content-Type": "application/json",
        "X-Fault-Token": process.env.FAULT_TOKEN || "",
      },
      body: ["GET", "HEAD"].includes(req.method) ? undefined : JSON.stringify(req.body || {}),
    });
    const text = await upstream.text();
    res.status(upstream.status);
    res.setHeader("Content-Type", upstream.headers.get("content-type") || "application/json");
    res.send(text);
  } catch (e) {
    res.status(502).json({ error: `Proxy to oracle failed: ${e.message}` });
  }
}
