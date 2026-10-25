# Firmware patch (optional, nothing has been flashed)

Two small edits to the existing sketch. The dashboard works without them. It shows **MIRRORED** and
re-runs the gait rules itself. With the patch it shows **FIRMWARE STATE** and gives the board's own decisions.

## Why

| | Bytes/line | Bits/s at 250 Hz | Load at 115 200 | Load at 921 600 |
|---|---|---|---|---|
| Today `Raw:1790, Envelope:370.2, Thresh:320.0\n` | 39 | 97 500 | **85 %** | 11 % |
| Patched `…, Pulses:1, Alert:0\n` | 58 | 145 000 | **126 %, won't fit** | 16 % |

At 115 200 baud the link is already ~85 % full during a tap, so any extra field makes `Serial.printf`
block and the 4 ms sample loop slip. That's why the baud rate goes up to 921 600 at the same time.

`dcBaseline` starts at 2048.0, but the piezo input rests at ≈0. For the first second or so `|raw − dcBaseline|`
is ≈2048, the envelope sits far above 320, and the gait logic counts a pulse every 350 ms. The result is a
**false ELEPHANT ALERT on every power-up and every USB reconnect**. The offline test reproduces it: the alert
is held for 3.7 s after boot. Opening the serial port usually reboots the ESP32, so this shows up at the
start of every live demo.

## Edit 1: `setup()`

```cpp
void setup() {
  Serial.begin(921600);                      // was 115200

  analogReadResolution(12);                  // keep your existing ADC / pin setup
  analogSetAttenuation(ADC_11db);
  // pinMode(LED_PIN, OUTPUT);  pinMode(BUZZER_PIN, OUTPUT);  ...

  // Seed the DC tracker with the real rest level instead of 2048.0.
  long sum = 0;
  for (int i = 0; i < 16; i++) sum += analogRead(34);   // piezo on GPIO34
  dcBaseline = sum / 16.0f;
  envelope   = 0.0f;
}
```

## Edit 2: the `Serial.printf` at the end of the per-sample block

Keep it **after** the gait-discriminator code, where it is now. On the sample where pulse 2 fires the
alert, the dashboard expects `Pulses` to have already reset to 0.

```cpp
Serial.printf("Raw:%d, Envelope:%.1f, Thresh:%.1f, Pulses:%d, Alert:%d\n",
              raw, envelope, (float)DETECTION_THRESHOLD, pulseCount, alertActive ? 1 : 0);
```

* The `(float)` cast is harmless if `DETECTION_THRESHOLD` is already a float, and required for `%.1f` if
  it's an integer `#define`.
* `alertActive` stands for whatever your sketch uses while the red LED (GPIO23) and buzzer (GPIO19) are on.
  If you only store a start time, use `(millis() - alertStartTime < 3000) ? 1 : 0`.

## After flashing

* Dashboard: set baud to **921600** before pressing Connect. The tile badge changes to FIRMWARE STATE, and
  the Decision source panel shows the pulse/alert counts from the firmware and from the browser mirror side
  by side.
* Arduino Serial Plotter / Monitor: also set to 921600. It will plot `Pulses` and `Alert` as two extra
  low lines, which is harmless.
