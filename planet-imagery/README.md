# Planet for ArcGIS Experience Builder Widget

Browse and visualize [Planet](https://planet.com) imagery from within ArcGIS Experience Builder.

## Widget modes

Experience Builder has no concept of widget variants — one folder is one entry in the Insert panel
with one settings panel. This widget therefore carries a **mode** in its config. The creator picks
one before anything else, and both the settings panel and the runtime branch on it. Because every
widget instance has its own config, the same app can hold several instances of this widget in
different modes.

| Mode | Status |
| --- | --- |
| `mosaics` — Planet mosaics | Implemented |
| `tasking` — Deep link to the tasking dashboard, plus the delivered-imagery beta | Implemented |
| `scenes` — Daily PlanetScope scenes via the Data API | Implemented |
| `data-collection` — Hosted collection streaming over WMTS | Removed, see below |

Per-mode settings live in their own config block (`config.mosaics`, `config.tasking`, …) so
switching modes never discards what was configured for another one. The API key and proxy URL are
shared, since every remaining mode talks to the same host.

A mode can carry `hidden: true` in `src/modes.ts`. It disappears from the chooser and the mode
dropdown but stays resolvable, so an instance already configured with it keeps working instead of
silently changing mode.

### Adding a mode

1. Add the id to `PlanetMode` in `src/config.ts`, plus a config block if it needs one.
2. Describe it in `MODES` in `src/modes.ts`.
3. Add `src/setting/modes/<mode>.tsx` and `src/runtime/modes/<mode>.tsx`, then register each in the
   `MODE_SETTINGS` / `MODE_RUNTIMES` map in `src/setting/setting.tsx` and `src/runtime/widget.tsx`.

Until a mode is registered it renders a placeholder rather than breaking the panel. The runtime
shell owns the map widget binding and the connection check, and hands each mode the active
`JimuMapView` and the resolved endpoints.

## Authentication

The **Authentication method** section offers three arrangements, saved as `config.authMode`. Configs
predating the setting infer one from what is filled in, so nothing needs migrating.

| Mode | Where the credential lives | Needs a server | Use when |
| --- | --- | --- | --- |
| `embedded` | App configuration | No | The app is behind your own authentication. |
| `proxy` | A server you run | Yes | The app is public, or the key must not leave your network. The proxy must be behind the same authentication as the app. |
| `user` | Each user's own browser | No | Sharing internally without exposing your key, on static hosting. |

`embedded` is the simplest and the least private: the key ships in the app JSON and is readable by
anyone who can open the app.

`proxy` puts no credential in the browser at all — but only protects anything if the proxy itself
is behind the same authentication as the app. An open proxy is the API key published on the
internet with an extra hop in front of it, so "no credential in the browser" is a property of the
deployment rather than of the mode.

 **Proxy base URL** replaces both Planet origins, so
the service must route on the subpath — see the table below. The `planet-proxy` folder in the repo is
an implementation of exactly that.

`user` asks each app user to paste their own key at runtime. It is held in that person's browser
(`sessionStorage`, or `localStorage` if they tick *Remember on this browser*) and never enters the
configuration, so the published app carries no secret and needs nothing running server-side. The key
is validated against `/basemaps/v1/series` before being stored — 401 rejects it, 403 is accepted,
since that means Planet recognised the key and merely declined that one product.

The trade is that everyone needs a Planet key of their own. If your organisation has a single shared
account, `user` mode keeps the key out of the published app but does not stop it being shared between
people; per-user keys are what make revocation and quota attribution work.

`src/planet/userKey.ts` owns the storage and validation; `src/planetKeyPrompt.tsx` is the prompt,
shared between the runtime and the settings panel — the settings panel needs a key too, to browse
mosaics while the creator picks which to expose, and it stores it the same way rather than writing it
to the config.

### Proxy routing

The proxy replaces both `api.planet.com` and `tiles.planet.com`, so it must route on the subpath:

| Path | Upstream |
| --- | --- |
| `/basemaps/v1/planet-tiles/**` | `tiles.planet.com` |
| `/basemaps/v1/**` | `api.planet.com` |
| `/data/v1/PSScene/**` | `tiles.planet.com` |
| `/data/v1/SkySatCollect/**`, `/data/v1/SkySatScene/**`, `/data/v1/PelicanScene/**` | `tiles.planet.com` |
| `/data/v1/**` | `api.planet.com` |

API calls authenticate with an `Authorization: api-key` header; tile URLs have no header option and
carry `api_key` as a query parameter, which is the one place the key reaches the browser's address
bar when no proxy is configured.

## Planet mosaics

Streams Planet mosaics directly from the [Basemaps API](https://docs.planet.com/develop/apis/basemaps/)
using API key authentication.

- **Settings** — enter a Planet API key (or a proxy base URL), then search and multi-select the
  mosaic series and individual mosaics that app users should see. One selected item can be marked
  with the radio button to switch itself on when the app loads, showing its most recent imagery.
  Only one, because mosaics are opaque and several would stack and hide each other.
- **Runtime** — toggle an item on to add it to the map. Series show the most recent imagery first
  and can be stepped through by date, compared two at a time, or animated as a time lapse. Surface reflectance mosaics can be re-rendered with Planet's
  spectral indices (NDVI, CIR, MSAVI2, and the rest of the `proc=` set).
- Imagery is added as an XYZ `WebTileLayer`, not WMTS, so the API key never appears in a service
  capabilities document.

### Keeping a layer on the map

The pin button hands the item's current layer over to the map. The widget stops tracking it, and
the item switches itself off in the same action — a hand-off, not a copy, so a pinned layer is
never stacked underneath an identical live one. Pinned layers survive the widget unmounting and
are listed under **Kept on the map** with a remove button. Switch the item back on to carry on
browsing dates.

Pinned layers are tagged with an `id` of `planet-pinned-<n>`, which is how a remounted widget finds
the ones a previous mount left behind rather than stranding them with no way to remove them. They
last for the browser session; nothing is written to the app configuration.

### Naming conventions

UI strings are **sentence case** throughout — `Planet mosaics`, `Time lapse`,
`Embedded API key`. Beta features are marked two ways by design: `(Beta)` in a
settings label, where a badge does not fit, and a `BETA` pill beside a runtime
heading.

### Compare and Time lapse

A series with more than one timestep gets two tools, side by side. They are exclusive, both within
an item and across items: each takes over the item's layers, and the parent tracks a single
`activeTool` of `{ itemId, tool }` rather than letting two run at once.

**Compare** adds a second `WebTileLayer` for the same series at a different date and puts an
`esri/widgets/Swipe` handle on the view: the comparison date renders to the left of the handle, the
item's own date to the right. Both use the same renderer, since the point is to isolate the change
over time. Not shown on a scene view, which cannot host a swipe widget.

**Time lapse** animates a range of the series. Pick the oldest and newest dates and it plays
through every timestep between them, with play/pause, step, a scrub slider, three speeds and a loop
toggle.

Nothing loads until Play is pressed. That is a deliberate constraint rather than laziness: the
range is fetched *in full* before the first frame shows (see below), so opening the tool and
loading it are separated, and the panel states the number of dates first. Opening a time lapse must
not be able to spend a customer's imagery quota on a range they had not chosen yet. For the same
reason the range opens at `DEFAULT_LAPSE_FRAMES` (6) rather than at the 12 cap, and moving either
end discards what was loaded and waits for Play again rather than silently refetching the lot.

#### Why every frame is loaded before the first one plays

Stepping through dates by rebuilding one layer flickers, and the flicker does not go away once the
tiles are in the browser cache. `showLayer` adds the new layer and removes the old one, so there is
always a moment where the outgoing layer is gone and the incoming one has not finished decoding its
tiles — the basemap shows through. Cached tiles shorten that moment; they do not remove it.

So the time lapse does not rebuild anything during playback. `prepareTimeLapse` puts **one layer per
frame on the map at once**, every one of them at `opacity: 0`, and waits for all of them to draw
before playback is allowed to start. Playing then only moves an opacity from one already-drawn
layer to another, which the next rendered frame picks up: no request, no decode, no gap.

`opacity: 0` rather than `visible: false` is the whole mechanism. A hidden layer has no live layer
view and fetches nothing; a transparent one is fetched, decoded and tracked exactly like a visible
one.

Readiness is `reactiveUtils.whenOnce(() => !layerView.updating)` per frame, which is what the
progress bar counts — settled for **twice**, a frame apart. `updating` is false both before the
first request goes out and after the last one comes back, so taking the first reading at face value
calls a frame ready before it has fetched anything, and it flashes on the opening pass.

#### The map is held still while frames are loaded

Every frame is a live layer with no `fullExtent` of its own, so a single pan or zoom would ask *all*
of them for a fresh set of tiles — a dozen times the cost of moving an ordinary mosaic, spent
without anyone asking, and it would void the preparation as well, since the promise of a seamless
playback only holds for ground that was drawn before it started.

Three guards, because none is sufficient alone. Each frame gets a `fullExtent` of the view it was
prepared for, so nothing outside it can be requested — the same bounding scenes and tasking already
had. Navigation is locked for the duration: there is no `view.navigation.enabled`, so this is Esri's
documented approach of swallowing the input events, and it is released in `clearTimeLapse` *before*
any early return, because a lock left attached is a map the user cannot move with no way to find out
why. And because swallowing events cannot stop the zoom buttons or another widget calling `goTo`, a
`stationary` watch bumps `viewMovedAt` if the view moves anyway; that value is part of the armed
signature, so a move retires the frames through the machinery already there rather than a new path.

A locked map has to announce itself, so the panel says so and carries an **Exit time lapse** button
rather than relying on the toggle that opened the tool. `MAX_LAPSE_FRAMES` is 12 — a year of monthly
imagery, and measurably easier on the compositor than the 24 it started at.

The tool lives in `src/runtime/mosaicTimeLapse.tsx` rather than in the layer item that hosts it. It
owns none of the map: it asks the mode to prepare frames, to show one, and to take them off again.
That split is not cosmetic — the range, the arming step, the preparation and the playback loop come
to nine effects over nine pieces of state, and sharing a scope with the timestep fetch and the
compare pair is what made the ordering between effects implicit. Every bug this feature has had was
that shape.

#### Two details that decide whether it actually looks seamless

**Setting an opacity is an animation, and has to be turned off.** This is the one that matters
most, and it is invisible in the public API. Every 2D layer view sets `fadeTransitionEnabled` on
its container and pipes `layer.opacity` into it, so the value actually rendered — `computedOpacity`
— walks toward the target over `mapview-transitions-duration`, **200 ms** by default. A swap
between two frames therefore crossfades: both are part transparent at the same time, and the
basemap shows through both. At the Fast speed the 200 ms ramp covers most of a 250 ms step, so it
reads less as a flicker than as the imagery washing out on every single frame.

`disableFadeTransition` clears that flag on each frame's layer view as it is prepared. `container`
is internal, so the helper is written to fail quietly — if a later version of the ArcGIS API moves
it, playback goes back to fading rather than breaking — and it is 2D-only, since a scene view has a
different layer view implementation. If it ever does disappear, the fallback shape is to stop
touching opacity at all: hold every frame at `opacity: 1` and use `map.reorder` to lift the current
one to the top. That needs no private API, at the cost of drawing every frame layer on every tick and
letting an older date show through any nodata gap in the current one.

**The swap raises before it lowers.** `showTimeLapseFrame` sets the incoming frame to `opacity: 1`
first, then drops every other frame to `0`. The other order leaves a turn of the render loop with
every frame transparent, and the basemap paints through as a pale flash. Two opaque frames drawn at
once costs nothing to look at, since they cover the same ground.

**Playback runs on an animation frame, not a timer.** A `setTimeout` re-armed from an effect has to
fire, set state, render, run the effect and arm the next one before the following frame is even
requested — and that round trip is not constant, so the dwell times were not either. The loop is
now started once when playback begins, lives across frames, and calls `onTimeLapseShow` itself the
moment a frame is due, ahead of the React state that only the slider and date label need. Each
deadline is measured from the advance that just happened rather than from the one that was
scheduled: clocking from the schedule is what makes a late frame steal time from the next one, which
reads as one step dragging and the next hurrying to catch up.

The cost moves rather than disappearing: the whole range is fetched up front, which is both the
wait the progress bar is explaining and a real number of mosaic tiles — every date fetches the
current view. That is why loading waits for Play, and why `MAX_LAPSE_FRAMES` caps a range at 12
dates — and because a dozen live tile layers is already a lot to keep
drawing — so moving one end of the range past the cap drags the other end along.

The frames carry `listMode: 'hide'`: a dozen entries in the map's layer list for one animation
would be noise, and none of them outlives the time lapse. The item's own layer comes off the map
while a lapse runs, since it would sit under every frame spending tiles on nothing; the date
stepper and the pin button are disabled to match, rather than left as controls that visibly do
nothing.

## Daily scenes

Searches individual PlanetScope acquisitions through the
[Data API](https://docs.planet.com/develop/apis/data/) and streams whole days to the map.

- **Settings** — three guard rails only: the largest search area a user may draw, the cloud
  ceiling the search opens with, and how far back the initial date range reaches. Everything else
  about a search belongs to the app user, because a scene search is a question about one place at
  one moment rather than a fixed set of layers.
- **Runtime** — draw a box on the map, set a date range and a cloud ceiling, then search. Results
  arrive as a scrollable list grouped by acquisition day, newest first. Expand a day to see its
  individual strips with acquisition time, cloud percentage and id; hovering a row outlines that
  strip's footprint on the map.

Only `PSScene` is searched. Widening that would mean reconciling different resolutions, asset names
and tile paths in one list, so `SCENE_ITEM_TYPE` in `src/planet/scenes.ts` is deliberately fixed.

### One layer per day

The switch on a day header puts that whole day on the map; the checkboxes underneath narrow it to
particular strips. Either way a day is **one** `WebTileLayer`, because Planet's tile service takes a
comma-separated list of item ids and composites them server-side. Days stack with the most recent
on top, and the search-area outline stays above all of them.

Scene layers belong to the widget and come off the map when it unmounts. There is no pin hand-off
here as there is for mosaics.

### A month at a time

The date range is searched one month at a time, walking backwards from the end date. A single
request for a year would either be truncated or take long enough to feel broken, and the result
would be unreadable anyway. **Load the previous month** fetches the next window; each window's upper
bound is the previous window's lower bound, so no day is searched twice or skipped, and the button
retires once the whole range is covered.

Editing a filter does not silently change what "load more" means. The results remember the filters
they were fetched with, and the list says so until the search is run again.

### Search area

The box is drawn with `SketchViewModel` and measured with `geometryEngine.geodesicArea` — geodesic
rather than planar, because a planar measurement in Web Mercator overstates by a factor of ten or
more away from the equator and would turn the cap into a latitude-dependent lottery. A box over the
configured limit is rejected with its measured size rather than silently clipped.

### Searching a map feature instead

The widget publishes a data action, `search-area`, so an app user can click any polygon on the map
and choose **Search Planet imagery here** from the popup's Actions menu instead of drawing a box.
The same option appears wherever else the app surfaces data actions, such as the Table widget.

`src/data-actions/useAsSearchArea.ts` is the whole of it. A data action runs outside the widget's
React tree, so it hands the geometry over through `MutableStoreManager`; the widget reads it from
`props.mutableStateProps` and `src/runtime/widget.tsx` passes it down as `featureArea`. The payload
carries a `stamp`, because choosing the same feature twice — after clearing the area, say — has to
take effect the second time, and an unchanged geometry would otherwise look like nothing happened.

`isSupported` decides whether the menu entry appears at all. It requires a single record and a
geometry with `rings`, which is what keeps the action off points and lines: neither has an area to
search.

**A broken layer anywhere on the map disables this action, and every other one.** Clicking a feature
runs ExB's `selectDataSourceOrFeatureByFeatures`, which walks *all* layer views through
`clearAllJimuLayerViewsSelectRecord` and `selectFeaturesByIds`. If any one of them cannot produce a
data source — `getOrCreateLayerDataSource` throwing `Can not find data source` — the chain never
completes, so no Records-level record set is built and **no data action is offered for any layer**,
not just the broken one.

ArcGIS's own popup actions (Zoom to, Table, Get directions) come from the popup rather than from
ExB, so they carry on working. That is what makes this look like the widget's action alone going
missing, and it is worth knowing before spending an afternoon inside `isSupported`: the failure
happens in the host, in the click handler, before any data action is consulted.

The layers that trigger it are ones added at runtime through an add-to-map data action — the Add
Data widget's path for a hosted feature service, worse for a multi-layer one, and worse again when
it duplicates a layer the web map already has. The diagnosis is the console: if a map is logging
`Can not find data source`, expect the whole Actions menu to be gone until that layer is removed.
Put the layers in the web map instead.

**It searches the record sets rather than taking the first.** A popup can carry one set per layer —
the same layer added to a map twice is the case that surfaced it, where a click lands on both copies
and the action is handed two. Demanding exactly one in the list made the entry vanish from precisely
the situation where the user is looking at the feature, while the built-in actions coped and made
ours look broken. `pickSearchable` finds a set that can actually be searched, which also makes it
robust to *which* shape gate a duplicate trips. `onExecute` calls the same function, so the check
that draws the menu entry and the check that acts on it cannot drift apart. `loadTaskedImagery` does
the same through `pickCapture`, where the configured layer settles any ambiguity by itself. It also checks that the widget's configured mode is `scenes`, so an instance set up for
mosaics or tasking does not clutter every popup in the app. Only one feature at a time is accepted —
combining a selection set would mean guessing at winding order to tell separate parts from holes.

**It deliberately does not require a data source.** An earlier version did, checking
`getStatus()` and `supportSpatialInfo()`, and that made the action disappear from exactly the layers
users most want it on. A layer added to the map at runtime — by the Add Data widget, or by another
widget's add-to-map data action — does not reliably get a data source Experience Builder can rebuild;
the console fills with `Can not find data source` from `getOrCreateLayerDataSource`, entirely inside
the map widget, and every data action on that layer vanishes with it. Neither check was load-bearing:
the geometry comes off the record, the label falls back on its own, and the polygon check already
excludes a standalone table, which has no geometry to offer. The tasking action is the opposite case
and stays strict — it needs the data source to confirm the record came from the configured layer,
which is that mode's access boundary.

**A selected feature's geometry is the geometry the map drew, not the geometry the service holds.**
Experience Builder's selection query runs with `returnGeometry=false`, so what reaches the record is
the rendered graphic — quantized to the resolution it was drawn at. Selecting while zoomed well out
therefore yields a search area visibly offset from the outline on screen, and the offset shrinks as
you zoom in before selecting. Worth knowing before reaching for a projection explanation: the query
also carries `outSR=102100`, so the spatial reference is the view's own and is not the problem. The
fix, if this needs to be exact, is to re-query the feature with `returnGeometry: true` and
`maxAllowableOffset: 0` rather than trusting the drawn copy.

An accepted feature then searches immediately, on the current filters, rather than waiting for the
Search button — the menu entry promises a search, so it runs one. A drawn box still waits, because
drawing is usually the first of several adjustments rather than the last. The search cannot be fired
from `adoptArea` itself, since the area has not reached state yet; a ref is raised there and an
effect picks it up on the following render. A rejected area never raises it and a drawn one lowers
it, so nothing searches that was not asked to.

Apart from that, a chosen feature goes through exactly what a drawn box does: projected to WGS84,
measured geodesically, and rejected if it is over the cap. The rejection is worded for the source, because
“draw a smaller one” is no use to someone who clicked a parcel. There is deliberately no fallback to
the feature's bounding box: a bounding box is always at least as large as the polygon inside it, so
falling back to one would *raise* the area rather than bring it under the cap.

Two things a real feature has that a drawn rectangle does not:

**Vertices.** A county or a coastline can carry tens of thousands of points, and every one of them
goes into the search body. Above `MAX_VERTICES` (1500) the outline is passed through
`geometryEngine.generalize`, starting at a deviation of 1e-5 degrees — roughly a metre — and doubling
until it fits. A shape already under budget is returned untouched. Past a certain deviation the shape
collapses to nothing, so the last result that survived is kept as the closest available fit. This
happens *after* the cap check, so a feature that is too big is rejected on the area it really has
rather than on a simplified version of it.

**Holes and parts.** Esri keeps every ring of every part in one flat list and tells them apart by
winding — clockwise opens a new part, counter-clockwise is a hole in the part before it — whereas
GeoJSON nests them. `toGeoJson` regroups the list with `Polygon.isClockwise`, producing a
`MultiPolygon` for a feature in several pieces and a `Polygon` for anything else. Ring winding is
left as it is: Planet's geometry filter reads nesting, not orientation.

One warning is worth the noise it makes. Tile culling works on the bounding box, not the outline (see
below), so a long thin feature — a river, a road corridor — fetches far more imagery than it shows.
When the box is three times the feature's area or more, the widget says so and gives the ratio: the
mask hides those tiles, but they are already paid for.

### Keeping tiles inside the box

Scene tiles are metered, so imagery must not be fetched for ground the user never asked about. Two
mechanisms handle that, and only the first one saves anything:

**`fullExtent`.** Every scene layer is constructed with `fullExtent` set to the drawn box, projected
into the layers' own spatial reference. The view then only requests tiles that intersect it, so
panning or zooming away from the search area costs no Planet requests at all. This is the quota
control; the rest is presentation.

**A blend mask.** `fullExtent` culls whole tiles, so the imagery still overhangs the box by up to one
tile — roughly 4.9 km at zoom 13, 300 m at zoom 17, but around 39 km at zoom 10. To trim that
overhang the scene layers live in a `GroupLayer` alongside a `GraphicsLayer` holding an opaque copy
of the search box with `blendMode: 'destination-in'`, ordered above them. `destination-in` keeps what
is painted beneath it only where it is opaque, and a `GroupLayer` composites its children in
isolation, so the erasure stops at the Planet imagery and never touches the basemap. Nothing is saved
by this — the tiles were already fetched — it only squares off the edge.

Two consequences worth knowing. An empty mask erases the whole group, so with no drawn box no scene
imagery renders; that is the correct failure rather than a bug. And layer `blendMode` is a MapView
feature: in a SceneView the mask does nothing and `fullExtent` culling is the whole behaviour.

### Filters sent to Planet

`buildSearchRequest` in `src/planet/scenes.ts` assembles an `AndFilter` of:

| Filter | Field | Note |
| --- | --- | --- |
| `GeometryFilter` | `geometry` | The drawn box, as a GeoJSON polygon in WGS84 |
| `DateRangeFilter` | `acquired` | `gte`/`lt` bounds of the current month window |
| `RangeFilter` | `cloud_cover` | **A 0-1 ratio, not a percentage.** The slider's 0-100 is divided by 100 |
| `PermissionFilter` | — | `assets:download`, so every listed scene is one whose tiles will render |

Scenes the account cannot download also cannot be streamed — their tiles come back 404 — so the
permission filter is what keeps every row in the list actionable.

`quick-search` is a `POST` with a JSON content type, the only call in the widget that triggers a CORS
preflight. If Planet declines the preflight from a browser origin, this mode needs the proxy.

## Tasking

Hands a location off to the [Planet tasking dashboard](https://www.planet.com/tasking/orders/new)
and stops there. No API calls, no order parameters, no attempt to reproduce the dashboard's rules —
the widget's only job is to save the user from transcribing coordinates. Submitting an order
requires a tasking plan on the account.

- **Settings** — none. The dashboard supplies every default from the user's own account.
- **Runtime** — click **Select location**, then click the map. The clicked point is projected to
  WGS84, marked with a graphic, and turned into `?geometry=POINT(lon lat)`. Map clicks are only
  intercepted while the tool is armed, so popups keep working the rest of the time.
- The URL is built in `src/planet/tasking.ts`, a pure function of the point.

The parameter follows Planet's
[tasking deeplinks](https://docs.planet.com/platform/get-started/access-data/task-imagery/#tasking-deeplinks)
documentation, which also lists optional order fields (`plNumber`, `product`, `orderType`, dates,
elevation angles). Those are deliberately not used: pre-filling them means duplicating the
dashboard's contract and product rules, and getting one wrong costs quota.

### Delivered imagery (beta)

Off by default. Switched on, the mode also streams imagery that past tasking orders already
delivered — SkySat or Pelican, true colour, inside each capture's own footprint.

It makes no Tasking API call. Everything it needs comes from a feature layer the creator points it
at, and from the [API Tile Service](https://docs.planet.com/develop/apis/tile-services/), which
serves any catalog item as XYZ tiles given its type and id:

```
https://tiles.planet.com/data/v1/{item_type}/{item_id}/{z}/{x}/{y}.png
```

That is the same endpoint daily scenes uses, so the beta adds no new API surface. There is no
renderer choice, unlike mosaics: the tile service returns a compressed form of the item's `visual`
asset and takes no band or index parameter.

**The layer is the access control.** An app user can stream the captures on that layer and nothing
else — there is no browsing the account's archive. Scoping who sees what is a matter of scoping the
layer, which is something ArcGIS already does well.

- **Settings** — a feature layer, an **item ID field**, and optional **item type** and **date**
  fields. Nothing else.
- **Item ID** is the catalog item id, such as `20260906_133038_ssc1_u0001`. A tasking *order* id will
  not stream. Several comma-separated ids stream as one capture, which is how a Pelican strip
  arrives.
- **Item type** is Planet's own spelling, such as `PelicanScene`. Required for Pelican; see below.
- **Date** is never sent to Planet. It labels each capture, orders the layers so the newest draws on
  top, and drives the widget's date filter.
- **Runtime** — click a feature, choose **Load tasked imagery here** from the popup's Actions menu.
  The capture appears in the widget with a checkbox, a date filter, and **Remove**.

The `planet-capture-layer` script in the widget's repository builds a layer in exactly this shape
from a [Planet SDK](https://planet-sdk-for-python.readthedocs.io/) search, grouping a strip's frames
into one row and filtering on `webtiles:stream` so unstreamable items never reach the layer.

#### Item type comes from the id, but only for SkySat

`src/planet/taskedImagery.ts` infers it where Planet's naming allows. A frame segment prefixed `u` is
a `SkySatCollect` (`20200815_091045_ssc6_u0002`), a bare number is a `SkySatScene`
(`20200814_162132_ssc4d3_0021`). The match also requires the satellite segment to begin with a
letter, which is what separates SkySat from everything else. So a SkySat-only layer needs no item
type column.

Pelican cannot be inferred at all:

```
20250614_043400_87_3009   PelicanScene
20240310_153114_78_24f4   PSScene
```

Nothing in the id distinguishes them, and guessing wrong streams empty tiles. That is what the **item
type field** setting is for, and why a Pelican layer must have one. A configured value wins over the
inference, because only the catalog really knows.

#### A Pelican strip is one capture, not several

Pelican has no Collect product — no equivalent of a `SkySatCollect`. A strip is captured by a
line-scan sensor and delivered as a run of framed scenes, so streaming the whole strip means naming
every frame in one URL:

```
https://tiles.planet.com/data/v1/PelicanScene/{id},{id},{id}/{z}/{x}/{y}.png
```

The id field therefore holds a list, comma-delimited, and the widget treats that list as one capture
throughout: one row in the panel, one group layer, one entry in the map's layer list. A single id is
just a list of one, so SkySat takes the same path. Ids are encoded individually and joined with a
literal comma — a comma is a legal path character and Planet documents the multi-item form that way,
whereas encoding the whole list would send `%2C`.

Grouping the frames of a strip back together is the authoring script's job, not the widget's: it
groups on `strip_id`, so a capture arrives already assembled.

#### One group layer per capture

Each capture gets its own `GroupLayer` holding a `WebTileLayer` and a `destination-in` mask, the same
clipping arrangement [daily scenes uses](#keeping-tiles-inside-the-box). Per capture rather than one
shared mask, because a `destination-in` layer holding several polygons keeps every pixel under their
*union* — one capture's whole-tile overhang would then show through another capture's footprint.

`fullExtent` on each `WebTileLayer` is what actually protects quota: it stops the view requesting
tiles outside the capture at all. The mask only trims the overhang that whole tiles leave behind. The
popup action therefore requires a polygon footprint, and hides itself without one.

#### What hides the action

`src/data-actions/loadTaskedImagery.ts` returns false from `isSupported` unless the mode is
`tasking`, the beta is on, a layer and item ID field are configured, the records came from *that*
layer, there is exactly one of them, it has a polygon, and its ids resolve to an item type this mode
can stream. A half-configured widget shows no action rather than an action that fails.

That last check is also where a Pelican layer with no item type column fails closed: the ids parse,
but nothing names their type, so the action stays hidden rather than streaming blanks.

The layer check compares the popup's data source id, its main data source and its root data source
against the ids in the widget's `useDataSources`, because a popup hands over whichever view of the
layer it is showing and the settings panel records the layer the creator picked.

#### It needs a Planet connection

The deep link needs no credential; streaming does. `needsPlanetConnection(definition, config)` in
`src/modes.ts` is what both the runtime and the settings panel ask, so the rule that tasking
*sometimes* needs a key lives in one place. With a proxy, the allowlist needs its tile route for
these item types — `planet-proxy` has it.

## Data collection (removed 2026-09-18)

Taken out of the widget pending a rework of its UX, which was the hard part rather than the
plumbing. Everything below is kept deliberately: it is the specification the mode was built from,
and re-adding it is much cheaper with these notes than without them.

**What was deleted and what survives.** Gone from the working tree are `src/collection/api.ts`,
`src/collection/types.ts`, `src/runtime/modes/dataCollection.tsx` and
`src/runtime/collectionSearchForm.tsx`. None of them had ever been committed, so they are not
recoverable from git — only the behaviour described here is. What does survive is the older
settings panel at `planet-widget-exbVersion1.15-latest/planet-imagery/src/setting/modes/dataCollection.tsx`
and the whole pre-rebuild implementation under `planet-widget-exbVersion1.14-latest/`
(`dateSelector.tsx`, `layerSelector.tsx`, `utilities.js`, `saveWMTS/`), which is where the original
token handling and date list came from.

`config.PlanetMode`, the `MODES` entry, the `DataCollectionConfig` interface and the
`config.dataCollection` block all went with it, so a re-add starts by putting those back.

---

It streamed a hosted imagery collection from a Sentinel Hub compatible service. The service is named
nowhere in the UI, but the configuration fields keep the names that service uses, so a setup copied
out of its console transfers across without translation.

Three of its APIs are used, and all three are proprietary to that service rather than generic OGC:

- `POST /oauth/token` — client-credentials OAuth. Everything below needs the bearer token.
- `GET /configuration/v1/wms/instances/{configuration_id}/layers` — the renderings. Each is an
  evalscript already published to the service, so the widget carries no band maths of its own and
  a rendering added later shows up without the app being edited.
- `POST /api/v1/catalog/1.0.0/search` — a STAC search over `byoc-{collection_id}`, which answers
  which dates actually have imagery over the current view. Paged through `context.next`.

Tiles come from `WMTSLayer` against `/ogc/wmts/{configuration_id}`, with
`customLayerParameters: { TIME, LAYER, transparent }`. The WMTS endpoint authenticates on the
instance id in its own URL, so no token is attached to tile requests.

### Settings

`service_base_url`, `configuration_id`, `collection_id`, `client_id`, `client_secret`. **Check
connection** in the settings panel mints a token and lists the renderings, because all four values
fail the same opaque way at runtime — an empty list — and finding out at configuration time saves
a round of guessing about which one is wrong.

The client secret is stored in the app configuration and is readable by anyone who can open the
app. It is a heavier risk than the Planet API key: it mints tokens for the whole account rather
than granting tile reads. Only set it for apps behind your own authentication. Otherwise leave it
blank and point `service_base_url` at a proxy that adds the credentials server-side; the proxy must
forward `/oauth/token`, `/configuration/v1/`, `/api/v1/catalog/` and `/ogc/`.

### Tokens

Tokens last about an hour. `src/collection/api.ts` caches one per credential set, refreshes a
minute before expiry, and collapses concurrent callers onto a single in-flight request. The cache
key includes the secret, so correcting a wrong secret takes effect immediately instead of reusing
the token minted from the previous attempt. A caller's `AbortSignal` rejects that caller's wait but
does not cancel the shared mint, since one component unmounting must not cancel the token every
other component is waiting on.

The legacy implementation fetched a token once on mount, so a session open longer than an hour
silently started returning 401s.

### Search area and dates

The search area is the current map view rather than a drawn box: a collection is a fixed archive
over a fixed footprint, so "what is available where I am looking" is the whole question, and the
mode needs none of the sketch machinery the scene search does. The extent is read at search time,
not tracked, so panning does not fire a request per frame.

Dates are searched one month at a time and listed newest first, sharing the window arithmetic in
`src/shared/dateWindows.ts` with the scene search. Each date is a switch; switching several on
gives one `WMTSLayer` per date inside a `GroupLayer`, ordered oldest first so the most recent sits
on top. Changing the rendering rebuilds the layers rather than mutating
`customLayerParameters`, which would otherwise leave already-fetched tiles on screen.

**Zoom to the collection** reads the `EPSG:4326` bounding box out of the configuration instance's
WMS `GetCapabilities`. A view nowhere near the data returns no dates, which looks exactly like an
empty collection; one click rules that out.

### What was dropped

The rebuild removed four npm packages that only this mode used — `@mui/material`,
`@mui/x-date-pickers`, `@date-io/date-fns`, and the direct `date-fns` dependency — along with
`esri/request` for non-ArcGIS hosts and a stray `import React from 'react'` that risked a second
copy of React alongside the one `jimu-core` provides. `date-fns` stays in `package.json` because
Experience Builder itself uses it.

`@mui/x-date-pickers` was load-bearing: the date list exists because a calendar cannot show which
days have imagery. Experience Builder does ship a `DatePicker` at `jimu-ui/basic/date-picker`, but
its props expose no hook for styling individual days, which is the one thing this mode needs.

Saving a WMTS layer to the portal (`saveWMTS.tsx`, `templateWMTSDefinition.json`) was dropped too,
matching the same decision in the mosaics mode. `dateSelector.tsx`, `layerSelector.tsx` and
`utilities.js` were replaced by `src/collection/api.ts`, `src/runtime/modes/dataCollection.tsx`
and `src/runtime/collectionSearchForm.tsx` — which have themselves now gone, as above.

## Shared helpers

`src/shared/dateWindows.ts` holds the UTC month-window arithmetic, used by the scene search and
previously by the collection date search too. The Planet client in `src/planet/api.ts` keeps
its own equivalent, because its auth header, pagination and error bodies are all Planet-shaped.
