# Vibe Machine

An audio-reactive fluid wallpaper that runs directly in [Lively Wallpaper](https://github.com/rocksdanister/lively). Vibe Machine uses Lively's live audio and now-playing interfaces; it does not need a separate Vibe Machine desktop app.

## What it does

- Turns live audio into an animated fluid simulation.
- Uses the current album artwork to guide the palette, with optional manual colors.
- Adds an optional on-wallpaper player card with album art, track title, and artist.
- Supports multi-monitor and Lively Span layouts, including per-monitor wave sizing and cross-screen movement.
- Includes performance controls for image quality and simulation detail.
- Lets you tune the waves, glow, background, and on-screen overlays from Lively's wallpaper settings.

## Color modes

- **America mode** recognizes red-and-blue artwork and builds a red, white, and blue flag palette.
- **Fireplace mode** recognizes bright red, orange, and yellow artwork and animates a shifting heat palette.
- **Neon boost** keeps bright, highly saturated artwork vivid in the fluid haze and glow.

These modes work with album-art color detection. Their controls can be enabled or adjusted in Lively's wallpaper settings.

## Install

1. Download `Vibe-Machine-v2.0.0.zip` from the [GitHub release](https://github.com/thriftshoppin/Vibe-Machine-v1/releases/latest).
2. In Lively, choose **Add Wallpaper → Choose file** and select the ZIP. Dragging the ZIP into the Lively window also imports it.
3. Open the wallpaper's settings from its library card to tune audio, color, performance, monitors, and overlays.

The release archive is a complete Lively wallpaper package with `LivelyInfo.json` at its root. No build step is needed.

## Project files

- `index.html` and `js/` contain the wallpaper and visualizer.
- `LivelyInfo.json` and `LivelyProperties.json` define Lively metadata and settings.
- `wallpapers/`, `lively_theme/`, `overlays/`, and `fonts/` contain the included assets.
- `PATCH_NOTES.txt` records detailed implementation notes.
- `LICENSE.txt` includes the project's MIT license and third-party notices.

## Compatibility

Requires Lively Wallpaper with its audio and now-playing interfaces enabled. `AppVersion` in `LivelyInfo.json` is Lively's package metadata field; the GitHub project release is version `v2.0.0`.
