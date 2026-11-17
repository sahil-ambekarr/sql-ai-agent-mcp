/**
 * Turns the captured transcripts in docs/demo/*.txt into docs/screenshots/demo.gif.
 *
 * The text is rendered verbatim in a terminal-styled HTML page, Playwright
 * screenshots it line by line, and gifenc (pure JS) assembles the GIF. Nothing
 * is typed by hand: if a transcript changes, re-run this script.
 *
 *   npm run demo:gif
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { chromium } from 'playwright';
import { PNG } from 'pngjs';
import gifenc from 'gifenc';

const { GIFEncoder, quantize, applyPalette } = gifenc;

const SCENES = [
  { file: 'docs/demo/ask.txt', title: 'Agent answering a question (Ollama llama3.2, CPU)' },
  { file: 'docs/demo/blocked.txt', title: 'Guardrail blocking a stacked write' },
  { file: 'docs/demo/blocked-cte.txt', title: 'Guardrail blocking a write hidden in a CTE' },
];
const WIDTH = 980;
const HEIGHT = 640;
const LABEL = 'Rendered from real captured CLI output (docs/demo/*.txt), captured 2026-11-17';

const escape = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function colour(line: string): string {
  const e = escape(line);
  if (line.startsWith('$ ')) return `<span class="cmd">$</span> <span class="typed">${escape(line.slice(2))}</span>`;
  if (/BLOCKED|\[tool error\]/.test(line)) return `<span class="bad">${e}</span>`;
  if (line.startsWith('Answer:')) return `<span class="ok">${e}</span>`;
  if (/^\s+(->|<-)/.test(line)) return `<span class="dim">${e}</span>`;
  return e;
}

function page(title: string, lines: string[]): string {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
  html,body{margin:0;background:#0b0f14;}
  #term{width:${WIDTH}px;height:${HEIGHT}px;box-sizing:border-box;background:#0d1117;color:#d6deeb;font:14px/1.45 Consolas,"Cascadia Mono",monospace;display:flex;flex-direction:column;}
  .bar{background:#1f2630;color:#9aa7b5;padding:8px 14px;font:13px system-ui,sans-serif;display:flex;gap:8px;align-items:center}
  .dot{width:11px;height:11px;border-radius:50%;display:inline-block}
  pre{margin:0;padding:14px 16px;white-space:pre-wrap;word-break:break-word;flex:1;overflow:hidden}
  .cmd{color:#7ee787}.typed{color:#ffffff}.bad{color:#ff7b72}.ok{color:#79c0ff;font-weight:bold}.dim{color:#8b949e}
  .label{background:#161b22;color:#8b949e;font:12px system-ui,sans-serif;padding:6px 14px;border-top:1px solid #30363d}
  </style></head><body><div id="term">
  <div class="bar"><span class="dot" style="background:#ff5f56"></span><span class="dot" style="background:#ffbd2e"></span><span class="dot" style="background:#27c93f"></span>&nbsp;${escape(title)}</div>
  <pre>${lines.map(colour).join('\n')}</pre>
  <div class="label">${escape(LABEL)}</div></div></body></html>`;
}

const browser = await chromium.launch();
const tab = await browser.newPage({ viewport: { width: WIDTH, height: HEIGHT }, deviceScaleFactor: 1 });
const gif = GIFEncoder();
let frames = 0;

async function frame(title: string, lines: string[], delayMs: number) {
  await tab.setContent(page(title, lines));
  const buf = await tab.locator('#term').screenshot();
  const png = PNG.sync.read(buf);
  const rgba = new Uint8Array(png.data.buffer, png.data.byteOffset, png.data.length);
  const palette = quantize(rgba, 64);
  gif.writeFrame(applyPalette(rgba, palette), png.width, png.height, { palette, delay: delayMs });
  frames++;
}

for (const scene of SCENES) {
  const lines = readFileSync(scene.file, 'utf8').replace(/\r/g, '').trimEnd().split('\n');
  const [cmd = '', ...rest] = lines;
  // Type the command in a few chunks.
  const chunks = 6;
  for (let i = 1; i <= chunks; i++) await frame(scene.title, [cmd.slice(0, Math.ceil((cmd.length * i) / chunks))], 90);
  // Reveal output line by line (blank lines are folded into the next frame).
  for (let i = 1; i <= rest.length; i++) {
    if (rest[i - 1]?.trim() === '' && i < rest.length) continue;
    await frame(scene.title, [cmd, ...rest.slice(0, i)], 260);
  }
  await frame(scene.title, lines, 3500);
}

gif.finish();
await browser.close();
mkdirSync('docs/screenshots', { recursive: true });
writeFileSync('docs/screenshots/demo.gif', gif.bytes());
process.stderr.write(`wrote docs/screenshots/demo.gif (${frames} frames, ${(gif.bytes().length / 1024).toFixed(0)} KiB)\n`);
