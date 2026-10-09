// Draws the app icons (icon-192.png, icon-512.png) with Playwright.
// Run: NODE_PATH=<global node_modules> node dominion/tools/icons.js
const { chromium } = require("playwright");
const path = require("path");
(async () => {
  const b = await chromium.launch({ executablePath: process.env.CHROMIUM || "/opt/pw-browsers/chromium" });
  const p = await b.newPage();
  for (const size of [192, 512]) {
    await p.setViewportSize({ width: size, height: size });
    await p.setContent("<canvas id=c width=" + size + " height=" + size + " style='display:block'></canvas><style>body{margin:0}</style>");
    await p.evaluate((n) => {
      const c = document.getElementById("c").getContext("2d"), k = n / 512;
      c.fillStyle = "#070b14"; c.fillRect(0, 0, n, n);
      // Lanes from the Throne to six wedges.
      c.strokeStyle = "rgba(125,155,200,.45)"; c.lineWidth = 10 * k;
      const pts = [];
      for (let i = 0; i < 6; i++) { const a = Math.PI / 2 + i * Math.PI / 3; pts.push([256 + Math.cos(a) * 170, 256 + Math.sin(a) * 170]); }
      for (const [x, y] of pts) { c.beginPath(); c.moveTo(256 * k, 256 * k); c.lineTo(x * k, y * k); c.stroke(); }
      const cols = ["#22d3ee", "#fb7185", "#fbbf24", "#a78bfa", "#a3e635", "#fb923c"];
      pts.forEach(([x, y], i) => { c.fillStyle = cols[i]; c.beginPath(); c.arc(x * k, y * k, 30 * k, 0, 7); c.fill(); });
      // The Throne.
      const g = c.createRadialGradient(236 * k, 236 * k, 10 * k, 256 * k, 256 * k, 90 * k);
      g.addColorStop(0, "#fff3c4"); g.addColorStop(0.5, "#ffd166"); g.addColorStop(1, "#b7791f");
      c.fillStyle = g; c.beginPath(); c.arc(256 * k, 256 * k, 88 * k, 0, 7); c.fill();
      c.strokeStyle = "#070b14"; c.lineWidth = 12 * k; c.beginPath(); c.arc(256 * k, 256 * k, 50 * k, 0, 7); c.stroke();
    }, size);
    await p.screenshot({ path: path.join(__dirname, "..", "icon-" + size + ".png") });
  }
  await b.close();
})();
