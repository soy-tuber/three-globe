#!/usr/bin/env python3
"""Synthesise sound cues to a WAV (stdlib only; old ffmpeg builds lack the lavfi options this needs).

usage: cues.py out.wav SECONDS 'freq,start,dur,gain[,count,interval]' ...
  e.g. cues.py beeps.wav 30 '2400,18.175,0.13,0.45' '3000,26.017,0.07,0.35,5,0.12'
"""
import math, struct, sys, wave
out, secs, *specs = sys.argv[1:]
R = 48000
buf = [0.0] * int(float(secs) * R)
def tone(f, t0, d, g):
    s = int(t0 * R)
    for i in range(int(d * R)):
        t = i / R
        env = min(1, t / 0.005) * min(1, (d - t) / 0.02)  # click-free attack/release
        if s + i < len(buf): buf[s + i] += g * env * math.sin(2 * math.pi * f * t)
for spec in specs:
    v = [float(x) for x in spec.split(',')]
    f, t0, d, g = v[:4]
    n, gap = (int(v[4]), v[5]) if len(v) >= 6 else (1, 0)
    for k in range(n): tone(f, t0 + k * gap, d, g)
w = wave.open(out, 'wb'); w.setnchannels(2); w.setsampwidth(2); w.setframerate(R)
w.writeframes(b''.join(struct.pack('<hh', *(max(-32767, min(32767, int(x * 32767))),) * 2) for x in buf)); w.close()
