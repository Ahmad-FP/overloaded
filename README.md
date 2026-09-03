# Overloaded

A browser real-time strategy game set in the Napoleonic period. You raise
infantry, cavalry and artillery, group them into named formations, and fight
over supply depots on a generated map.

It also exposes the running match to an agent over
[WebMCP](https://github.com/webmachinelearning/webmcp), so the same game can be
played by hand, by an agent, or by both at once.

![The board mid-deployment, with the standing-order book open on the right](docs/board.jpg)

## The game

Crates are the only resource. Your headquarters produces them continuously, and
so does every fort you raise and every depot you capture. Income
only arrives if a structure can trace a walkable route back to your
headquarters, so parking a formation across that route stops the money without
a shot being fired. Depots start neutral and change hands when someone stands
on one long enough.

Units belong to formations rather than being selected individually. A formation
has a shape, a spacing, a facing and its orders. Artillery limbers when
it marches and cannot fire until it stops; round shot is solved for the
elevation that reaches the target, so a battery has a minimum range as well as
a maximum one.

The match runs on a clock. Whoever holds more when it expires wins, and losing
your headquarters ends it early.

## Standing orders

Rather than clicking every reaction, you write orders the army carries out on
its own. An order is written to one named formation or one named base, and it
is set off by one named thing:

> **Alpha** attacks **the attacker** when it comes under fire.
> **Headquarters** raises **16 infantry** when the war chest passes 800 crates.

Nothing in an order is a wildcard and nothing in it is ground you cannot point
at. The thing being watched can be a formation, a base, or your own war chest.
A formation reports `under_fire`, `spotted`, `weakened`, `arrived`, `idle` and
`destroyed`; a base reports `threatened`, `supply_cut`, `supply_restored`,
`captured`, `lost` and `destroyed`; the chest reports `supply_above`. A
formation can be told to `move`, `hold`, `attack_area`, `retreat` or `reserve`,
cavalry can `charge` and artillery can `bombard`; a base can `recruit`. The
ground an order aims at is the attacker that set it off, a named formation, a
named base, or a spot you mark on the map.

An order belongs to the thing it watches. There is no sweep and no interval:
the instant that thing reports, its orders go out.

## Agent control

The game registers its tools on `document.modelContext` at load. That works in
ChatGPT's in-app browser, natively in Chrome 152, and in Chrome 149+ with
`chrome://flags/#enable-webmcp-testing` enabled. If `document.modelContext` is
absent the boot screen says so and the game plays normally.

Formations are addressed by name, so instructions read like orders:

> Call `overview`. Raise a battery at the headquarters and bind it as
> `Battery`. Then write Battery a standing order: it bombards the attacker
> when it comes under fire.

| Tool | Does |
|---|---|
| `overview` | Strength, income, formations, structures and their supply state |
| `inspect_binding` | One formation: members, order, position, casualties |
| `inspect_structure` | One base: build progress, yield, supply route |
| `inspect_cell` | Terrain, height, occupants and cover at a map cell |
| `inspect_contact` | What is known about a sighted enemy formation |
| `read_alerts` | The dispatch feed |
| `list_rules` | The standing orders, and the whole vocabulary for writing them |
| `recruit` | Raise infantry, cavalry or artillery at a connected base |
| `build_work` | Site a fort, barracks, stables, foundry or watchtower |
| `bind`, `unbind`, `rename_binding` | Regroup and name formations |
| `issue` | Give a formation its orders now |
| `add_rule`, `update_rule`, `remove_rule` | Write, amend and strike standing orders |
| `set_match`, `start_battle`, `set_paused` | Map, difficulty, clock |

The seven inspection tools carry `readOnlyHint`, so an agent can survey the
field without changing it.

## Running it

```bash
npm install
npm run dev
```

```bash
npm run typecheck
npm run lint
npm run build
```

Deploying is a static upload. For Cloudflare Pages:

```bash
npx wrangler login
npm run deploy
```

Any static host will serve `dist` as-is.

## Controls

| | |
|---|---|
| Select | Click a formation's banner, or drag a marquee |
| Order | Right-click the ground |
| <kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd> or arrows | Pan. Middle-drag works too, and the wheel zooms |
| <kbd>Q</kbd> <kbd>E</kbd> <kbd>R</kbd> <kbd>T</kbd> | March, hold, attack, bombard |
| <kbd>F</kbd> <kbd>G</kbd> <kbd>C</kbd> | Charge, fall back, reserve |
| Hold <kbd>Space</kbd> | Show every formation's orders at once |
| <kbd>B</kbd> <kbd>L</kbd> <kbd>Home</kbd> | Site a work, change the field lens, centre on headquarters |
| <kbd>P</kbd> <kbd>M</kbd> | Pause, mute |
| <kbd>1</kbd>-<kbd>4</kbd> | Game speed |
| <kbd>Esc</kbd> | Cancel the pending order, then the selection |

Every order shortcut is printed on its own button in the tray, so none of it
has to be memorised. The order keys sit to the right of WASD so one hand can
pan and order without moving.

## Layout

| Path | Contents |
|---|---|
| `src/domain/` | Match state, rules, supply routing, pathfinding, line of sight, map generation, the opposing AI |
| `src/webmcp/` | Tool registration and argument validation |
| `src/render/` | `models.ts` builds every unit and building from primitives and merges them into instanced meshes; `board.ts` is terrain, water, fog, camera and lighting |
| `src/ui/` | `terrainArt.ts` bakes the ground texture at load; `overlay.ts` draws fog, borders, supply lines and banners each frame; `hud.ts` and `ruleBook.ts` are the panels |
| `src/audio/` | Sound synthesis |

Nothing is loaded from an asset file. Models are built from boxes, cylinders
and spheres in code, the ground texture is drawn to a canvas at load, and every
sound is synthesised through the Web Audio API, including the bugle calls,
musketry, cannon and the reverb they sit in.

`src/domain` has no DOM or renderer imports.

## Built with

TypeScript, Vite, [three.js](https://threejs.org/), the Web Audio API and
Cloudflare Pages. Third-party notices are in
[`public/licenses/NOTICE.txt`](public/licenses/NOTICE.txt).

## Licence

MIT. See [`LICENSE`](LICENSE).
