import http from "node:http"
import { existsSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { Readable } from "node:stream"
import { URL } from "node:url"
import { fileURLToPath } from "node:url"
import { spawn } from "node:child_process"
import config from "./config.js"

const PORT = config.port
const CREATOR = "God's Zeal"
const root = dirname(fileURLToPath(import.meta.url))
let detectedProxyClientIp = config.proxyClientIp
let cloudflareConnected = false
let cloudflareLogBuffer = ""
let cloudflareChild = null
let restartTimer
let shuttingDown = false
const MEDIA_HOSTS = new Set([
  "bcdnxw.hakunaymatata.com",
  "pbcdnw.aoneroom.com",
  "cacdn.hakunaymatata.com",
  "api.zstlab.cyou",
  "zstlab.cyou",
])

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, Range, If-None-Match, If-Modified-Since, If-Range",
  "Access-Control-Expose-Headers": "Content-Length, Content-Range, Accept-Ranges, Content-Type, Content-Disposition, ETag, Last-Modified",
  "X-Content-Type-Options": "nosniff",
}

function writeJson(res, status, body) {
  res.writeHead(status, { ...cors, "Content-Type": "application/json; charset=utf-8" })
  res.end(JSON.stringify(body))
}

function identityHeaders(target) {
  if (!MEDIA_HOSTS.has(target.hostname.toLowerCase()) && !process.env.PROXY_CLIENT_IP) return {}
  const ip = detectedProxyClientIp || "1.1.1.1"
  return { "X-Forwarded-For": ip, "CF-Connecting-IP": ip, "X-Real-IP": ip }
}

async function detectPublicIp() {
  if (config.proxyClientIp) return config.proxyClientIp
  const providers = [
    "https://api.ipify.org?format=json",
    "https://ipv4.icanhazip.com",
    "https://ifconfig.me/ip",
  ]
  for (const endpoint of providers) {
    try {
      const response = await fetch(endpoint, { signal: AbortSignal.timeout(5000) })
      const text = await response.text()
      const candidate = (text.match(/\b(?:\d{1,3}\.){3}\d{1,3}\b/) || [])[0]
      if (candidate) return candidate
    } catch {
      // Try the next provider.
    }
  }
  return ""
}

function safeName(value, quality) {
  const base = (value || "gzmovie_download").replace(/\.[a-z0-9]{2,5}$/i, "").replace(/[^a-z0-9\s_-]/gi, "").trim().replace(/\s+/g, "_").slice(0, 120) || "gzmovie_download"
  return `${base}${quality ? `_${String(quality).replace(/[^a-z0-9_-]/gi, "")}` : ""}.mp4`
}

async function upstream(target, req) {
  const method = req.method === "HEAD" ? "HEAD" : "GET"
  const range = req.headers.range
  const base = {
    "User-Agent": config.cdnUserAgent,
    Referer: config.referer,
    Origin: config.referer.replace(/\/$/, ""),
    Accept: req.headers.accept || "*/*",
    "Accept-Language": "en-US,en;q=0.9",
    "Accept-Encoding": "identity",
    "X-Client-Info": '{"timezone":"Africa/Lagos"}',
    "Sec-Fetch-Site": "cross-site",
    "Sec-Fetch-Mode": "cors",
    "Sec-Fetch-Dest": "video",
    ...identityHeaders(target),
    ...(range ? { Range: range } : {}),
    ...(req.headers["if-none-match"] ? { "If-None-Match": req.headers["if-none-match"] } : {}),
    ...(req.headers["if-range"] ? { "If-Range": req.headers["if-range"] } : {}),
  }
  let response = await fetch(target, { method, headers: base, redirect: "follow" })
  if (![403, 426, 429].includes(response.status)) return response
  for (const referer of ["https://h5.aoneroom.com/", "https://movieboxapp.in/", "https://moviebox.pk/"]) {
    response = await fetch(target, { method, headers: { ...base, Referer: referer, Origin: referer.replace(/\/$/, "") }, redirect: "follow" })
    if (response.ok) return response
  }
  return response
}

async function handle(req, res) {
  const requestUrl = new URL(req.url, `http://${req.headers.host || "localhost"}`)
  if (req.method === "OPTIONS") return writeJson(res, 204, {})
  if (requestUrl.pathname === "/health" || requestUrl.pathname === "/api/health") return writeJson(res, 200, { status: "ok", service: "gzmoviebox-media-proxy", creator: CREATOR })
  if (requestUrl.pathname === "/") {
    const html = (await readFile(new URL("./landing.html", import.meta.url), "utf8"))
      .replaceAll("__PUBLIC_BASE_URL__", config.publicBaseUrl)
      .replaceAll("__PUBLIC_HOST__", requestUrl.host)
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" })
    return res.end(html)
  }
  if (requestUrl.pathname === "/api" || requestUrl.pathname === "/movieapi") return writeJson(res, 200, { status: "ok", service: "gzmoviebox-media-proxy", endpoints: ["/api/proxy", "/api/proxy-download", "/movieapi/proxy", "/movieapi/proxy-download", "/health"] })
  const proxyPath = requestUrl.pathname.replace(/^\/movieapi/, "/api")
  if (!["/api/proxy", "/api/proxy-download"].includes(proxyPath)) return writeJson(res, 404, { error: "Proxy endpoint not found" })
  const raw = requestUrl.searchParams.get("url")
  if (!raw) return writeJson(res, 400, { error: "URL parameter is required", creator: CREATOR })
  let target
  try { target = new URL(raw); if (!/^https?:$/.test(target.protocol)) throw new Error("Only http(s) URLs are allowed") } catch { return writeJson(res, 400, { error: "A valid http(s) URL is required" }) }
  try {
    const response = await upstream(target, req)
    if (!response.ok) return writeJson(res, response.status, { error: "Failed to fetch resource", status: response.status, creator: CREATOR })
    const headers = { ...cors, "Content-Type": response.headers.get("content-type") || "video/mp4", "Cache-Control": "no-store" }
    for (const name of ["content-length", "content-range", "accept-ranges", "etag", "last-modified"]) { const value = response.headers.get(name); if (value) headers[name] = value }
    if (proxyPath === "/api/proxy-download") headers["Content-Disposition"] = `attachment; filename="${safeName(requestUrl.searchParams.get("name"), requestUrl.searchParams.get("quality"))}"`
    res.writeHead(response.status, headers)
    if (req.method === "HEAD" || !response.body) return res.end()
    Readable.fromWeb(response.body).pipe(res)
  } catch (error) { writeJson(res, 502, { error: error instanceof Error ? error.message : "Proxy request failed" }) }
}

function printTunnelBanner() {
  console.log("\n╔══════════════════════════════════════════════════════════╗")
  console.log("║        CLOUDFLARE TUNNEL IS CONNECTED                   ║")
  console.log("╠══════════════════════════════════════════════════════════╣")
  console.log(`║  Domain: ${config.publicBaseUrl.padEnd(43)}║`)
  console.log(`║  Tunnel: ${config.cloudflareTunnelId.padEnd(43)}║`)
  console.log("╚══════════════════════════════════════════════════════════╝\n")
}

function resolveCloudflaredBinary() {
  if (config.cloudflaredBinary) return config.cloudflaredBinary
  const localBinary = resolve(root, "node_modules", ".bin", "cloudflared")
  if (existsSync(localBinary)) return localBinary
  return "cloudflared"
}

function startCloudflare() {
  if (shuttingDown || cloudflareChild || !config.cloudflareTunnelToken) return

  const command = resolveCloudflaredBinary()
  console.log(`[cloudflare] Starting token connector for ${config.cloudflareTunnelId}; origin=${config.cloudflareServiceUrl}`)

  const { CLOUDFLARE_TUNNEL_TOKEN: _cloudflareToken, ...safeProcessEnv } = process.env
  const child = spawn(command, ["tunnel", "--no-autoupdate", "run", "--url", config.cloudflareServiceUrl], {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...safeProcessEnv, TUNNEL_TOKEN: config.cloudflareTunnelToken },
  })
  cloudflareChild = child

  const handleCloudflareOutput = (chunk, stream) => {
    const text = chunk.toString()
    cloudflareLogBuffer = `${cloudflareLogBuffer}${text}`.slice(-8192)

    if (!cloudflareConnected && /registered tunnel connection|connection .*registered|tunnel connection established/i.test(cloudflareLogBuffer)) {
      cloudflareConnected = true
      console.log(`[cloudflare] Connected to tunnel ${config.cloudflareTunnelId} for ${config.publicBaseUrl}`)
      printTunnelBanner()
    }

    if (/provided tunnel token is not valid|authentication failed|unauthorized/i.test(text)) {
      console.error("[cloudflare] Authentication failed; rotate CLOUDFLARE_TUNNEL_TOKEN and update the environment secret")
    }

    process[stream].write(`[cloudflare] ${text}`)
  }

  child.stdout.on("data", (chunk) => handleCloudflareOutput(chunk, "stdout"))
  child.stderr.on("data", (chunk) => handleCloudflareOutput(chunk, "stderr"))
  child.on("error", (error) => console.error(`[cloudflare] Failed to start: ${error.message}`))
  child.on("exit", (code, signal) => {
    if (cloudflareChild === child) cloudflareChild = null
    cloudflareConnected = false
    cloudflareLogBuffer = ""

    if (!shuttingDown) {
      console.error(`[cloudflare] Connector stopped (code=${code ?? "none"}, signal=${signal ?? "none"}); restarting in 5s`)
      clearTimeout(restartTimer)
      restartTimer = setTimeout(startCloudflare, 5000)
    }
  })
}

const server = http.createServer((req, res) => handle(req, res))
detectPublicIp().then((ip) => {
  detectedProxyClientIp = ip
  console.log(`Detected public proxy IP: ${ip || "unavailable; using 1.1.1.1 fallback"}`)
  server.listen(PORT, "0.0.0.0", () => {
    console.log(`GZMovieBox proxy listening on 0.0.0.0:${PORT}`)
    if (config.cloudflareTunnelToken) startCloudflare()
    else console.warn("[cloudflare] CLOUDFLARE_TUNNEL_TOKEN is not set; proxy is running without a tunnel connector")
  })
})

function shutdown(signal) {
  if (shuttingDown) return
  shuttingDown = true
  clearTimeout(restartTimer)
  console.log(`[startup] Received ${signal}; stopping proxy and Cloudflare connector`)
  if (cloudflareChild) cloudflareChild.kill("SIGTERM")
  server.close(() => process.exit(0))
  setTimeout(() => process.exit(0), 1000).unref()
}

process.on("SIGINT", () => shutdown("SIGINT"))
process.on("SIGTERM", () => shutdown("SIGTERM"))
