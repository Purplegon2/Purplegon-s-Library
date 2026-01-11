# Powder Sandbox (Pressure + Temperature)

A self-contained Powder Toy–style sandbox in plain HTML/CSS/JS.

Features:
- 3 primary particle states: solid, liquid, gas
- Temperature field (diffusion + optional per-material heat sources)
- Pressure field (derived from gas concentration + diffusion) that nudges movement (wind-like)
- Material settings (edit in UI): melt/freeze/boil/condense, density, viscosity, dispersion, decay, colors, etc.
- Paint/erase + heat/cool tools

## Run
Open `index.html` in a browser. (No server required.)

Controls:
- Left click: paint
- Right click: erase
- Hold Shift while painting: heat
- Hold Alt while painting: cool

Tips:
- Paint Lava, then paint Water over it to generate Steam.
- Increase dispersion on a gas to make it spread faster.
- Lower density makes particles get pushed around more by pressure gradients.

## Notes
This is a toy simulation, not physically accurate. The goal is responsiveness and “Powder Toy vibes”.
