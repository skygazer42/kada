export function chartPage(nonce: string, chart: unknown) {
  const data = JSON.stringify(chart).replace(/</g, '\\u003c');
  return `<!doctype html>
<html lang="zh-CN">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Kada 图表</title>
<style>
  :root { color: #182a2a; background: #f5f7f4; font-family: Inter, "Segoe UI", "Microsoft YaHei", sans-serif; }
  * { box-sizing: border-box; }
  body { margin: 0; padding: clamp(16px, 5vw, 48px); }
  main { max-width: 980px; margin: auto; }
  h1 { margin: 0 0 18px; font-size: clamp(1.25rem, 4vw, 1.9rem); overflow-wrap: anywhere; }
  #legend { display: flex; flex-wrap: wrap; gap: 10px 16px; margin: 0 0 14px; }
  label { display: flex; gap: 5px; align-items: center; overflow-wrap: anywhere; }
  .swatch { width: .75rem; height: .75rem; border-radius: .15rem; flex: none; }
  canvas { display: block; width: 100%; height: auto; background: white; border: 1px solid #cbd8d0; border-radius: 8px; }
  button { margin-top: 12px; padding: 7px 12px; border: 1px solid #adc2b7; border-radius: 6px; background: white; color: #176b56; font: inherit; cursor: pointer; }
  details { margin-top: 16px; }
  summary { cursor: pointer; }
  .data { overflow-x: auto; }
  table { border-collapse: collapse; margin-top: 10px; width: 100%; font-variant-numeric: tabular-nums; }
  th, td { padding: 7px 10px; border-bottom: 1px solid #cbd8d0; text-align: start; }
  th { overflow-wrap: anywhere; }
</style>
<main>
  <h1 id="heading"></h1>
  <div id="legend" aria-label="图表序列"></div>
  <canvas id="plot" width="960" height="420" role="img" aria-labelledby="heading"></canvas>
  <button type="button" id="download">下载 PNG</button>
  <details><summary>图表数据</summary><div class="data"><table></table></div></details>
</main>
<script id="chart" type="application/json" nonce="${nonce}">${data}</script>
<script nonce="${nonce}">
const chart = JSON.parse(document.querySelector('#chart').textContent);
const canvas = document.querySelector('#plot');
const context = canvas.getContext('2d');
const colors = ['#176b56', '#a04c24', '#28569b', '#7d4a8b', '#656316', '#a23c5a'];
const visible = chart.series.map(() => true);
const active = document.querySelector('#legend');
document.querySelector('#heading').textContent = chart.title;
document.title = chart.title + ' · Kada';
document.querySelector('#download').addEventListener('click', () => {
  const link = document.createElement('a');
  link.href = canvas.toDataURL('image/png');
  link.download = 'kada-chart.png';
  link.click();
});
const table = document.querySelector('table'), head = table.createTHead().insertRow();
for (const value of ['类别', ...chart.series.map(series => series.name)]) {
  const cell = document.createElement('th'); cell.scope = 'col'; cell.textContent = value; head.append(cell);
}
const body = table.createTBody();
chart.labels.forEach((name, index) => {
  const row = body.insertRow(), label = document.createElement('th');
  label.scope = 'row'; label.textContent = name; row.append(label);
  for (const series of chart.series) row.insertCell().textContent = String(series.values[index]);
});
chart.series.forEach((series, index) => {
  const label = document.createElement('label'), control = document.createElement('input');
  const swatch = document.createElement('span');
  swatch.className = 'swatch'; swatch.style.backgroundColor = colors[index]; swatch.setAttribute('aria-hidden', 'true');
  control.type = 'checkbox'; control.checked = true;
  control.addEventListener('change', () => { visible[index] = control.checked; draw(); });
  label.append(control, swatch, series.name); active.append(label);
});
function draw() {
  const series = chart.series.map((value, index) => ({ ...value, color: colors[index] })).filter((_, index) => visible[index]);
  const values = series.flatMap(value => value.values);
  const low = Math.min(0, ...values), high = Math.max(0, ...values), span = high - low || 1;
  const left = 88, right = 920, top = 32, bottom = 360;
  const gap = (right - left) / chart.labels.length;
  const point = index => left + (index + .5) * gap;
  const height = value => bottom - (value - low) * (bottom - top) / span;
  context.clearRect(0, 0, canvas.width, canvas.height);
  context.font = '16px sans-serif';
  context.lineWidth = 1; context.strokeStyle = '#97a8a0'; context.beginPath();
  context.moveTo(left, top); context.lineTo(left, bottom);
  context.moveTo(left, height(0)); context.lineTo(right, height(0)); context.stroke();
  context.fillStyle = '#42534c'; context.textAlign = 'right';
  context.fillText(String(high), left - 10, top + 5, 72);
  if (low !== high) context.fillText(String(low), left - 10, bottom + 5, 72);
  context.textAlign = 'center';
  const step = Math.ceil(chart.labels.length / 8);
  chart.labels.forEach((label, index) => {
    if (index % step === 0) context.fillText(label, point(index), bottom + 28, Math.min(120, gap * step - 6));
  });
  const barWidth = Math.max(1, gap * .72 / Math.max(1, series.length));
  series.forEach((row, position) => {
    context.strokeStyle = context.fillStyle = row.color;
    if (chart.type === 'bar') {
      row.values.forEach((value, index) => {
        const x = point(index) + (position - series.length / 2) * barWidth;
        const y = height(value), baseline = height(0);
        context.fillRect(x, Math.min(y, baseline), Math.max(1, barWidth - 2), Math.abs(y - baseline));
      });
      return;
    }
    context.lineWidth = 3; context.beginPath();
    row.values.forEach((value, index) => {
      if (index === 0) context.moveTo(point(index), height(value));
      else context.lineTo(point(index), height(value));
    });
    context.stroke();
    row.values.forEach((value, index) => {
      context.beginPath(); context.arc(point(index), height(value), 4, 0, 2 * Math.PI); context.fill();
    });
  });
}
draw();
</script>
</html>`;
}
