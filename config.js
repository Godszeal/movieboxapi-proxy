const port = Number(process.env.PORT || process.env.SERVER_PORT || 5000)

const config = {
  // Public Cloudflare hostname for this dedicated proxy service.
  publicBaseUrl: process.env.PUBLIC_BASE_URL || "https://proxy.cinemind.name.ng",
  cloudflareTunnelId: process.env.CLOUDFLARE_TUNNEL_ID || "f64fc570-6fcc-4dff-bce2-7a2478f31f7c",
  // cloudflared runs beside the proxy, so route to the local listener.
  cloudflareServiceUrl: process.env.CLOUDFLARE_SERVICE_URL || `http://127.0.0.1:${port}`,
  cloudflareTunnelToken: process.env.CLOUDFLARE_TUNNEL_TOKEN || "",
  cloudflaredBinary: process.env.CLOUDFLARED_BIN || "",
  port,
  // If empty, index.js detects the actual public outbound IPv4 at startup.
  proxyClientIp: process.env.PROXY_CLIENT_IP || "",
  cdnUserAgent: process.env.CDN_USER_AGENT || "okhttp/4.12.0",
  referer: process.env.FORCE_REFERER_DOMAIN || "https://fmoviesunblocked.net/",
}

export default config
