# Planet imagery for ArcGIS Experience Builder

A custom widget that brings [Planet](https://planet.com) imagery into ArcGIS Experience Builder.
Everything streams as map tiles, so nothing is downloaded or copied into ArcGIS.

Built and tested against **Experience Builder 1.15** (Developer Edition) with ArcGIS Online.

> Provided as a code sample, not an officially supported Planet product. The APIs it uses are
> supported.

## What it does

One widget with three modes. Experience Builder has no notion of widget variants — one folder is one
entry in the Insert panel — so the mode is chosen in the settings panel, and several instances can
sit in the same app in different modes.

**Planet Mosaics** — cloud-free imagery published on a regular cadence over the same footprint. Step
through the dates in a series, compare two of them with a swipe handle, animate a range as a time
lapse, or re-render surface reflectance with spectral indices such as NDVI.

**Daily Scenes** — the PlanetScope archive, roughly daily coverage of the world's landmass. Search an
area by date range and cloud cover, drawing a box or using a polygon already on the map, then stream
a whole day's scenes as one layer.

**Tasking** — pick a location and open a pre-filled order in the Planet tasking dashboard. A beta
alongside it streams imagery a past order already delivered, from a feature layer of capture
footprints that you control.

Two data actions come with the widget, so an app user can right-click a feature on the map and
either search Planet imagery inside it or load the high-resolution imagery delivered for it.

## Installing

1. Install the [Experience Builder Developer Edition](https://developers.arcgis.com/experience-builder/guide/install-guide/)
   1.15.
2. Copy the `planet-imagery` folder into `client/your-extensions/widgets/`.
3. Start the client and server as usual. No extra dependencies are needed — the widget uses only
   what Experience Builder already ships.

If you add the widget while the client dev server is running, restart it. Experience Builder
computes data action entry points at startup, so the two map-popup actions will not appear until it
is restarted.

## Configuring

Add a Map widget to your experience, then add **Planet Imagery** and open its settings. Choose the
mode first; the rest of the panel follows from it. Point the widget at the map, choose how it should
authenticate, then configure the mode.

### Authentication

A Planet API key is a whole-account credential — it reads imagery and can also place orders — so the
real decision is not how to authenticate but **where the key lives**. A browser is a place anyone can
read. The widget offers three arrangements, and the right one depends entirely on who can open the
app.

| | Where the key lives | Needs a server | Use when |
| --- | --- | --- | --- |
| **Embedded API key** | The app configuration, readable by anyone who opens the app | No | The app is already behind your own authentication and firewall |
| **Proxy service** | A server you run, never in a browser | Yes | The security needs are stronger than just being on intranet — provided the proxy is itself behind that same authentication |
| **User provided API key** | Each visitor's own browser | No | Everyone has their own Planet account; the app can then sit on static hosting with no secret in it. This is primarily for testing and development. |

Embedded is the simplest and the least private. Proxy is the strongest, but only if the proxy sits
behind the same login as the app — an open proxy is the API key published on the internet with an
extra hop in front of it. User-provided asks each person for their own key, which is validated
before it is stored and never enters the app configuration.

A reference implementation of the proxy is not in this repository, yet.

## Documentation

[`planet-imagery/README.md`](planet-imagery/README.md) is the reference. It covers the architecture
and, more usefully, the reasoning — why tiles carry the key in a query parameter, why a scene search
is bounded by area and vertex count, why the tasking layer needs an item type column, how the time
lapse achieves a seamless playback, and a number of Experience Builder behaviors that are easier to
read about than to rediscover.

## Notes

- Requires a map in the experience. Put the widget in a container such as a Widget Controller so it
  opens after the map has loaded.
- Not tested against ArcGIS Enterprise.
- The tasking archive is a beta and is off until a creator turns it on and points it at a layer.

Found a bug or want a feature? Please open an issue.

## License

Copyright 2026 Planet Labs PBC

Licensed under the Apache License, Version 2.0 (the "License"); you may not use this file except in
compliance with the License. You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0
