# Home-screen icon

`icon.png` is this app's tile on the Homeroom home screen, declared in
`dapp.json` as `"icon": { "image": "brand/icon.png" }`. The platform reads it at deploy time; the app never serves
it, which is why it lives outside `public/`.

The icon is a flat vector football tile:

- Tile: deep blue (`#005CA7`) filling the whole square.
- Ball: a football centred on the tile, lit from the top left, with white star-shaped panels and white rim bands.
- Wordmark: "GOAL" in heavy white capitals across the middle of the ball, drawn as `<path>` outlines (not
  `<text>`) so it looks the same everywhere, whatever fonts a device has. Only the tiny 32px favicon cannot fit
  the letters legibly; it uses the same design scaled down.
- 512 × 512 PNG, full bleed, no transparency. The platform rounds the tile itself.

`public/images/app-icon.svg` is the source. The four PNGs are rendered from it with the `sharp` devDependency:

- `brand/icon.png` 512 × 512, RGB (no alpha)
- `public/icon.png` 512 × 512
- `public/apple-touch-icon.png` 180 × 180
- `public/favicon-32.png` 32 × 32

To change the icon, edit the SVG, re-render the PNGs, and update this note. The change applies once the proposal
is voted in and deployed.
