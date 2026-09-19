import { mkdir, writeFile } from "node:fs/promises"

const repository = process.env.GITHUB_REPOSITORY || process.argv[2]
if (!repository) throw new Error("GITHUB_REPOSITORY or repository argument is required")
const token = process.env.GITHUB_TOKEN || ""
const headers = { Accept: "application/vnd.github+json", ...(token ? { Authorization: `Bearer ${token}` } : {}) }

async function github(path) {
  const response = await fetch(`https://api.github.com${path}`, { headers })
  if (!response.ok) throw new Error(`${path}: GitHub API ${response.status}`)
  return response.json()
}

const [repo, views, clones, releases] = await Promise.all([
  github(`/repos/${repository}`),
  github(`/repos/${repository}/traffic/views`),
  github(`/repos/${repository}/traffic/clones`),
  github(`/repos/${repository}/releases`),
])
const downloads = releases.reduce((total, release) => total + release.assets.reduce((n, asset) => n + asset.download_count, 0), 0)
const payload = {
  repository,
  generatedAt: new Date().toISOString(),
  stars: repo.stargazers_count,
  forks: repo.forks_count,
  watchers: repo.subscribers_count,
  viewsRolling: views.count,
  uniqueViewsRolling: views.uniques,
  clonesRolling: clones.count,
  uniqueClonesRolling: clones.uniques,
  releaseDownloads: downloads,
  views: views.views,
  clones: clones.clones,
}
await mkdir("docs", { recursive: true })
await writeFile("docs/metrics.json", JSON.stringify(payload, null, 2) + "\n")
const max = Math.max(...payload.views.map((item) => item.count), 1)
const points = payload.views.map((item, index) => {
  const x = 52 + index * (296 / Math.max(payload.views.length - 1, 1))
  const y = 96 - (item.count / max) * 58
  return `${x.toFixed(1)},${y.toFixed(1)}`
}).join(" ")
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="420" height="150" viewBox="0 0 420 150"><style>text{font-family:Arial,sans-serif}.pulse{animation:pulse 1.8s ease-in-out infinite}@keyframes pulse{0%,100%{opacity:.35}50%{opacity:1}}</style><rect width="420" height="150" rx="18" fill="#e7ecf3"/><text x="22" y="28" font-size="16" font-weight="700" fill="#27334a">Live GitHub metrics</text><text x="22" y="48" font-size="11" fill="#738097">${payload.repository} · rolling views</text><polyline points="${points}" fill="none" stroke="#526dff" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/><circle class="pulse" cx="${points.split(" ").at(-1).split(",")[0]}" cy="${points.split(" ").at(-1).split(",")[1]}" r="5" fill="#20b486"/><text x="22" y="132" font-size="11" fill="#738097">Views ${payload.viewsRolling} · Stars ${payload.stars} · Forks ${payload.forks} · Downloads ${payload.releaseDownloads}</text></svg>`
await writeFile("docs/metrics.svg", svg)
