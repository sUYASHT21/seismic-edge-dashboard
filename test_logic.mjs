// Offline check of the dashboard's decision logic:  node dashboard/test_logic.mjs
// Runs the CORE block of dashboard.html in Node and compares the browser mirror against FirmwareSim,
// a literal transcription of the sketch's per-sample loop (float32 math, millis() clock).
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const html = readFileSync(new URL('./dashboard.html', import.meta.url), 'utf8');
const core = html.match(/\/\/ ==== CORE BEGIN[\s\S]*?\/\/ ==== CORE END/)[0];
const C = vm.runInNewContext(core + '\n({ CFG, parseLine, MirrorEngine, FirmwareSim, Pipeline, buildScenario, mulberry32, TAP_LIGHT, TAP_HEAVY })', {});

let failures = 0;
function check(ok, msg) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${msg}`);
  if (!ok) failures++;
}
const near = (v, target, tol) => Math.abs(v - target) <= tol;

// Lines exactly as a sketch would print them for a raw sequence.
function firmwareLines(raw, { seedBaseline = 0, fields = false } = {}) {
  const sim = new C.FirmwareSim({ seedBaseline });
  return Array.from(raw, r => { sim.step(r); return sim.line(r, fields); });
}
const decisions = p => p.log.filter(e => e.type !== 'info');

console.log('\n— Parser');
{
  const pl = C.parseLine;
  const a = pl('Raw:1790, Envelope:370.2, Thresh:320.0');
  check(a && a.raw === 1790 && a.env === 370.2 && a.thr === 320 && Number.isNaN(a.pulses), 'stock line parsed');
  const b = pl('Raw:12, Envelope:3.4, Thresh:320.0, Pulses:1, Alert:0');
  check(b && b.pulses === 1 && b.alert === 0, 'patched line with Pulses/Alert parsed');
  check(pl('Raw:5, Envelope:1.0') && Number.isNaN(pl('Raw:5, Envelope:1.0').thr), 'missing Thresh tolerated');
  check(pl('Raw:5') && Number.isNaN(pl('Raw:5').env), 'missing Envelope tolerated (browser computes it)');
  check(pl('Raw:5, Envelope:1.0, Thresh:320.0, Temp:24.5, Note:hi') !== null, 'extra fields tolerated');
  check(pl('elope:120.5, Thresh:320.0') === null, 'leading fragment with no Raw/Envelope is garbled');
  const f = pl('34, Envelope:120.5, Thresh:320.0');
  check(f && Number.isNaN(f.raw) && f.env === 120.5, 'fragment that still has Envelope is used, Raw left blank');
  check(pl('Raw:0, Envelope:3.1, ThRaw:15, Envelope:2.9, Thresh:320.0') === null, 'two lines fused by dropped bytes are garbled');
  check(pl('rst:0x1 (POWERON_RESET),boot:0x13 (SPI_FAST_FLASH_BOOT)') === null, 'ESP32 boot banner is garbled');
  check(pl('ets Jun  8 2016 00:22:57') === null, 'boot timestamp line is garbled');
  check(pl('Raw:99999, Envelope:1.0') === null, 'out-of-range Raw is garbled');
  check(pl('��x�:') === null, 'wrong-baud noise is garbled');
}

console.log('\n— Line reassembly');
const demo = C.buildScenario('demo');
const demoLines = firmwareLines(demo.raw);
const whole = new C.Pipeline();
whole.ingestText(demoLines.join('\n') + '\n');
{
  const chunked = new C.Pipeline(), rnd = C.mulberry32(1), text = demoLines.join('\r\n') + '\r\n';
  for (let i = 0; i < text.length;) { const k = 1 + Math.floor(rnd() * 64); chunked.ingestText(text.slice(i, i + k)); i += k; }
  const sig = p => decisions(p).map(e => `${e.type}@${e.t.toFixed(3)}`).join(' ');
  check(sig(whole) === sig(chunked), 'random 1–64 byte chunks + CRLF give identical decisions');
  check(chunked.stats.garbled === 0 && chunked.stats.valid === demo.total, `no garbled lines (${chunked.stats.valid} valid of ${demo.total})`);
  const noisy = new C.Pipeline();
  noisy.ingestText('ope:12.0, Thresh:320.0\nrst:0x1 (POWERON_RESET)\n' + demoLines.join('\n') + '\n');
  check(noisy.stats.garbled === 2 && sig(noisy).split(' ').length === sig(whole).split(' ').length, 'partial first line and boot text counted as garbled, decisions unchanged');
}

console.log('\n— Replay demo (mirrored logic, stock 3-field line)');
{
  const d = decisions(whole);
  const types = d.map(e => e.type);
  check(JSON.stringify(types) === JSON.stringify(['rejected', 'pulse', 'timeout', 'pulse', 'pulse', 'alert']), `log sequence: ${types.join(' → ')}`);
  const [light, heavy1, timeout, p1, p2, alert] = d;
  check(near(light.peakEnv, 120, 15) && near(light.peakRaw, 1100, 50), `light tap: envelope peak ${light.peakEnv.toFixed(1)} (≈120), raw ${light.peakRaw} (≈1100) → rejected`);
  check(near(heavy1.peakEnv, 370, 25) && near(heavy1.peakRaw, 1790, 70), `heavy tap: envelope peak ${heavy1.peakEnv.toFixed(1)} (≈370), raw ${heavy1.peakRaw} (≈1790) → one pulse`);
  check(near(timeout.t - heavy1.t, 3.004, 0.001), `single heavy tap times out ${(timeout.t - heavy1.t).toFixed(3)} s after its pulse`);
  check(near(p2.t - p1.t, 0.8, 0.012) && alert.t === p2.t, `two heavy taps ${(p2.t - p1.t).toFixed(3)} s apart → ALERT on pulse 2`);

  const p = new C.Pipeline(), tr = [];
  let last = '';
  for (const l of demoLines) {
    p.processLine(l);
    const s = p.decision(), st = s.alertOn ? 'ALERT' : s.pulses ? `PULSE ${s.pulses} of 2` : 'ARMED';
    if (st !== last) { tr.push(`${st}@${(p.t / 1000).toFixed(2)}`); last = st; }
  }
  console.log('      tile: ' + tr.join(' → '));
  const states = tr.map(x => x.split('@')[0]);
  check(JSON.stringify(states) === JSON.stringify(['ARMED', 'PULSE 1 of 2', 'ARMED', 'PULSE 1 of 2', 'ALERT', 'ARMED']), 'tile visits ARMED → PULSE → (timeout) ARMED → PULSE → ALERT → ARMED');
  const tA = parseFloat(tr[4].split('@')[1]), tEnd = parseFloat(tr[5].split('@')[1]);
  check(near(tEnd - tA, 3.0, 0.005), `alert held ${(tEnd - tA).toFixed(3)} s`);
}

console.log('\n— Firmware rules on exact timings (single-sample envelope spikes)');
{
  function run(spikes, totalMs = 8000) {
    const out = [], m = new C.MirrorEngine(e => out.push(`${e.type}${e.n ?? ''}@${e.t}`)), at = new Set(spikes);
    for (let t = 4; t <= totalMs; t += 4) m.step(t, at.has(t) ? 400 : 0, 320);
    return out.join(' ');
  }
  const cases = [
    [[1000, 1348], 'pulse1@1000 timeout@4004', '2nd crossing 348 ms later is inside the refractory'],
    [[1000, 1352], 'pulse1@1000 pulse2@1352 alert@1352 alertEnd@4352', '2nd crossing 352 ms later counts → alert held 3000 ms'],
    [[1000, 4000], 'pulse1@1000 pulse2@4000 alert@4000 alertEnd@7000', '2nd pulse 3000 ms later still alerts'],
    [[1000, 4004], 'pulse1@1000 pulse2@4004 alert@4004 alertEnd@7004', '2nd pulse 3004 ms later alerts (pulse check runs before the timeout check)'],
    [[1000, 4008], 'pulse1@1000 timeout@4004 pulse1@4008 timeout@7012', '2nd pulse 3008 ms later starts a new window'],
    [[1000, 1500, 2000], 'pulse1@1000 pulse2@1500 alert@1500 pulse1@2000 alertEnd@4500 timeout@5004', 'count resets at alert; a 3rd pulse starts a fresh window'],
    [[1000, 1500, 2000, 2500], 'pulse1@1000 pulse2@1500 alert@1500 pulse1@2000 pulse2@2500 alert@2500 alertEnd@5500', 'a new pair during the hold restarts it'],
  ];
  for (const [spikes, want, why] of cases) {
    const got = run(spikes);
    check(got === want, why + (got === want ? '' : `\n        want ${want}\n        got  ${got}`));
  }
}

console.log('\n— Mirror vs firmware transcription, sample by sample');
{
  // precise: feed the mirror the full float envelope (tests the logic itself).
  // Otherwise it sees the real %.1f print, and a divergence may only start on a line printed as exactly 320.0.
  function compare(raw, seedBaseline, precise) {
    const sim = new C.FirmwareSim({ seedBaseline }), p = new C.Pipeline(), evM = [], evF = [];
    const mEmit = p.mirror.emit, fEmit = p.fw.emit;
    p.mirror.emit = e => { evM.push(`${e.type}${e.n ?? ''}@${e.t}`); mEmit(e); };
    p.fw.emit = e => { evF.push(`${e.type}${e.n ?? ''}@${e.t}`); fEmit(e); };
    let bad = 0, episodes = 0, unexplained = 0, wasBad = false;
    for (let n = 0; n < raw.length; n++) {
      sim.step(raw[n]);
      const line = precise
        ? `Raw:${raw[n]}, Envelope:${sim.envelope}, Thresh:320.0, Pulses:${sim.pulseCount}, Alert:${sim.alertActive ? 1 : 0}`
        : sim.line(raw[n], true);
      p.processLine(line);
      const isBad = p.mirror.pulses !== sim.pulseCount || p.mirror.alertOn !== sim.alertActive;
      if (isBad) {
        bad++;
        if (!wasBad) { episodes++; if (p.curEnv !== 320) unexplained++; }
      }
      wasBad = isBad;
    }
    return { bad, episodes, unexplained, evM, evF, pulses: evM.filter(x => x.startsWith('pulse')).length, alerts: evM.filter(x => x.startsWith('alert@')).length };
  }
  function addTap(raw, ms, tpl, g) {
    const n0 = Math.round(ms / 4);
    tpl.forEach((v, k) => { if (n0 + k < raw.length) raw[n0 + k] = Math.min(4095, raw[n0 + k] + Math.round(v * g)); });
  }
  function randomRaw(seed, durMs) {
    const rnd = C.mulberry32(seed), raw = new Int16Array(durMs / 4);
    for (let n = 0; n < raw.length; n++) raw[n] = Math.max(0, Math.round((rnd() - 0.5) * 12));
    for (let t = 300 + rnd() * 500; t < durMs - 100; t += 60 + rnd() * (rnd() < 0.5 ? 700 : 4200)) {
      const heavy = rnd() < 0.5;   // gains span well below to well above the threshold
      addTap(raw, t, heavy ? C.TAP_HEAVY : C.TAP_LIGHT, heavy ? 0.6 + rnd() * 0.8 : 1.5 + rnd() * 2.2);
    }
    return raw;
  }
  const sets = [];
  sets.push(['replay demo', demo.raw, 0]);
  sets.push(['power-on, unseeded', C.buildScenario('poweron').raw, 2048]);
  for (let s = 1; s <= 40; s++) sets.push([`random #${s}`, randomRaw(s, 60000), 0]);
  {
    const raw = new Int16Array(Math.round(60000 / 4));   // gap sweeps around the 350 ms and 3000 ms boundaries
    let t = 500;
    for (let gap = 332; gap <= 372; gap += 4) { addTap(raw, t, C.TAP_HEAVY, 1); addTap(raw, t + gap, C.TAP_HEAVY, 1); t += 4000; }
    sets.push(['refractory sweep 332–372 ms', raw.slice(), 0]);
    const raw2 = new Int16Array(Math.round(120000 / 4));
    t = 500;
    for (let gap = 2984; gap <= 3024; gap += 4) { addTap(raw2, t, C.TAP_HEAVY, 1); addTap(raw2, t + gap, C.TAP_HEAVY, 1); t += 9000; }
    sets.push(['gait-window sweep 2984–3024 ms', raw2, 0]);
  }
  {
    const raw = new Int16Array(Math.round(10000 / 4));  // 5 s of continuous vibration (e.g. a passing train)
    for (let n = 500; n < 1750; n++) raw[n] = Math.round(1500 * Math.abs(Math.sin(2 * Math.PI * 25 * n * 0.004)));
    sets.push(['continuous vibration 5 s', raw, 0]);
  }
  let samples = 0, bad = 0, pulses = 0, alerts = 0, evDiff = 0;
  for (const [name, raw, seed] of sets) {
    const r = compare(raw, seed, true);
    samples += raw.length; bad += r.bad; pulses += r.pulses; alerts += r.alerts;
    const same = r.evM.join(' ') === r.evF.join(' ');
    if (!same) evDiff++;
    if (r.bad || !same || !name.startsWith('random')) check(r.bad === 0 && same, `${name}: ${r.pulses} pulses, ${r.alerts} alerts, ${r.bad} state mismatches${same ? '' : ', field-engine events differ'}`);
  }
  check(bad === 0, `all ${sets.length} sequences (${samples.toLocaleString()} samples, ${pulses} pulses, ${alerts} alerts): mirror state identical to the firmware transcription on every sample`);
  check(evDiff === 0, `decoding the patched Pulses/Alert fields gives exactly the mirror's pulse/alert/timeout events in all ${sets.length} sequences`);

  let ep = 0, unexplained = 0, badSamples = 0;
  for (const [, raw, seed] of sets) { const r = compare(raw, seed, false); ep += r.episodes; unexplained += r.unexplained; badSamples += r.bad; }
  check(unexplained === 0, `with the real 1-decimal print: ${ep} divergence(s) in ${samples.toLocaleString()} samples, every one starting on a line printed as exactly "Envelope:320.0" (firmware float just above 320) — removed by the Pulses/Alert patch`);
}

console.log('\n— Power-on baseline (why the setup() seed matters)');
{
  const po = C.buildScenario('poweron');
  const alertMs = seed => { const sim = new C.FirmwareSim({ seedBaseline: seed }); let on = 0; for (const r of po.raw) { sim.step(r); if (sim.alertActive) on += 4; } return on; };
  const unseeded = alertMs(2048), seeded = alertMs(po.raw[0]);
  check(unseeded > 0, `dcBaseline = 2048 while rest reads 0: false alert held ${(unseeded / 1000).toFixed(2)} s right after boot`);
  check(seeded === 0, 'dcBaseline seeded from the first analogRead: no alert');
}

console.log('\n— Refractory classification');
{
  const raw = new Int16Array(2000);
  raw.set(C.TAP_HEAVY, 250); raw.set(C.TAP_HEAVY, 250 + 75);   // second tap 300 ms after the first
  const p = new C.Pipeline();
  for (const l of firmwareLines(raw)) p.processLine(l);
  const types = decisions(p).map(e => e.type);
  check(JSON.stringify(types) === JSON.stringify(['pulse', 'ignored', 'timeout']), `heavy tap 300 ms after a pulse is logged as "Ignored — refractory" (${types.join(' → ')})`);
}

console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll checks passed');
process.exit(failures ? 1 : 0);
