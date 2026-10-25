# Seismic Edge Node: live decision dashboard

`dashboard.html` is one self-contained file. Open it in **desktop Chrome or Edge**, which have WebSerial.
It needs no install and no server.

* **Online:** <https://suyasht21.github.io/seismic-edge-dashboard/> in Chrome or Edge.
* **Offline (safest at the venue):** download `dashboard.html` and double-click it. It needs no internet.

Either way, the USB link runs straight from the ESP32 to the browser on that laptop. Nothing goes
through the website.

## Before the review

1. Open the dashboard on the demo laptop in Chrome or Edge. The log should say "Ready — WebSerial available".
2. Rehearse the backup once: **▶ Replay demo** (15 s).
3. Optional: run `node test_logic.mjs` in this folder and check that it ends with "All checks passed".

## Live demo

1. **Close the Arduino Serial Monitor and Serial Plotter** (and any other serial terminal). Only one app can
   own the COM port. "Could not open the port" means something else still has it.
2. Plug in the ESP32 and pick the baud rate: **115200** for the current firmware, **921600** after
   [FIRMWARE_PATCH.md](FIRMWARE_PATCH.md).
3. Press **Connect** and pick the port (CP210x / CH340 / "USB Serial").
4. Opening the port usually reboots the board. With the current firmware the first ~4 s show a **false
   ELEPHANT ALERT**: the DC baseline starts at 2048 while the piezo rests at 0. Wait for **ARMED**, then press
   **Clear**. This also makes a good talking point for the fix.
5. Tap script:
   * **Light tap**: the log shows *Rejected — below threshold*, margin ≈ 0.38× (−8.5 dB). The tile stays ARMED.
   * **One heavy tap**: the tile shows **PULSE 1 of 2** with a 3 s countdown and the chart shades the amber gait
     window. After 3 s the log shows *Timeout reset* and the tile goes back to ARMED.
   * **Two heavy taps ~0.8 s apart**: **ELEPHANT ALERT**, flashing red with a 3 s hold, at the same moment
     as the board's LED and buzzer.
   * Optional: two heavy taps < 350 ms apart. The second shows *Ignored — inside 350 ms refractory*.

## Backup if USB fails

Pick a scenario, then **▶ Replay demo**. A virtual ESP32 (a line-by-line transcription of the sketch's math)
prints the same `Raw:…, Envelope:…, Thresh:…` lines, and they go through the same parser and logic in
odd-sized chunks. The tile is tagged **REPLAY · SYNTHETIC**.

* **Demo**: quiet → light tap (rejected) → single heavy tap (times out) → two heavy taps 0.8 s apart (alert).
* **Demo with patched firmware fields**: the same taps, with decisions taken from `Pulses`/`Alert`.
  The tile says FIRMWARE STATE.
* **Power-on false alert**: what the unseeded baseline does at every boot.

## Reading the screen

* Top lane: raw ADC (blue). Bottom lane: envelope (orange) against the threshold (green dashed).
* White ▼ **P1/P2** marks a counted pulse. A hollow ▼ marks a crossing ignored by the refractory.
  Grey shading is the 350 ms refractory, amber the 3 s gait window, red the alert hold.
* **MIRRORED** badge: the current line has no decision fields, so the browser re-runs the firmware rules on
  the printed envelope, counting 4 ms per line as its clock. **FIRMWARE STATE**: `Pulses`/`Alert` came
  from the board.
* **Line rate** should read ≈250/s. **Serial link load** at 115200 reads ≈74 % at rest and ≈85 % during
  taps, which is why the patch moves to 921600.
* **Garbled lines**: a few after connecting are normal (the partial first line and the ESP32 boot text).
  A count that keeps climbing means the baud rate is wrong.

## Troubleshooting

| Symptom | Fix |
|---|---|
| Connect button greyed out, orange banner | Not Chrome/Edge, or not desktop. Replay still works. |
| ESP32 missing from the port list | Charge-only USB cable, or the CP210x/CH340 driver isn't installed. |
| "Could not open the port" | Close the Arduino Serial Monitor/Plotter, then Connect again. |
| Connected but WAITING / no data | Press EN on the board, or **Reset board**. Check the baud rate. |
| Garbled count climbing fast | Baud doesn't match `Serial.begin()`. Disconnect, change it, reconnect. |
| Line rate well under 250/s | Link saturated or the sketch's loop is slipping. See FIRMWARE_PATCH.md. |

## How exact is the mirror?

`test_logic.mjs` feeds 45 synthetic sequences (652,750 samples, 1,060 pulses, 411 alerts) through both the
browser mirror and a literal transcription of the firmware loop that uses float32 math and a `millis()`
clock. The sequences cover the demo, power-on, random taps, sweeps across the 350 ms and 3000 ms
boundaries, and continuous vibration. The state matches on every sample when the mirror sees the full
envelope value.

From the real 1-decimal print there was **1 disagreement in 652,750 samples**. That case was an envelope of
320.004, printed as `320.0`. The firmware counts it but the mirror cannot tell, and the log flags any line
printed as exactly the threshold. The firmware patch removes the gap.

The mirror assumes each sample runs the steps in the order the rules describe: pulse check, then alert,
then timeout. If the sketch checks the timeout first, the two disagree only when a second pulse lands
exactly 3004 ms after the first.

## Files

* `dashboard.html`: the dashboard (vanilla JS + canvas).
* `index.html`: redirects the site root to `dashboard.html`.
* `test_logic.mjs`: the offline logic test (`node test_logic.mjs`).
* `FIRMWARE_PATCH.md`: the optional sketch change (921600 baud, `Pulses`/`Alert` fields, seeded
  baseline). It has not been flashed.
