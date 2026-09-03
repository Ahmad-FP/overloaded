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
so does every forward redoubt you build and every depot you capture. Income
only arrives if a structure can trace a walkable route back to your
headquarters, so parking a formation across that route stops the money without
a shot being fired. Depots start neutral and change hands when someone stands
on one long enough.

Units belong to formations rather than being selected individually. A formation
has a shape, a spacing, a facing and a standing order. Artillery limbers when
it marches and cannot fire until it stops; round shot is solved for the
elevation that reaches the target, so a battery has a minimum range as well as
a maximum one.

The match runs on a clock. Whoever holds more when it expires wins, and losing
your headquarters ends it early.

## Standing orders

Rather than clicking every reaction, you write rules the game applies for you.
A rule is an event, a subject, an actor and an action:

> When **any formation** **comes under fire**, **the nearest reserve** will
> **attack** at **the sighting**.

There are twelve events — `spotted`, `under_fire`, `weakened`, `arrived`,
`idle`, `threatened`, `supply_cut`, `supply_restored`, `captured`, `lost`,
`destroyed`, `timer` — and ten actions: `move`, `hold`, `attack_area`,
`bombard`, `charge`, `retreat`, `reserve`, `build_fob`, `recruit` and
`alert_only`. The actor can be a named formation, a named structure, the
subject itself, any formation, any structure, or whichever reserve is nearest.
The action can be aimed at the event, the subject, the actor, or a fixed cell.

Rules fire on the rising edge of their event and honour a cooldown, so
`under_fire` triggers when a formation starts taking casualties rather than on
every tick it keeps taking them.

## Agent control

The game registers its tools on `document.modelContext` at load. That works in
ChatGPT's in-app browser, and in Chrome 149+ with
`chrome://flags/#enable-webmcp-testing` enabled. If `document.modelContext` is
absent the boot screen says so and the game plays normally.

Formations are addressed by name, so instructions read like orders:

> Call `overview`. Raise a battery at the headquarters and bind it as
> `Battery`. Then add a rule: when any base loses its supply line, the nearest
> reserve attacks the caller.

| Tool | Does |
|---|---|
| `overview` | Strength, income, formations, structures and their supply state |
| `inspect_binding` | One formation: members, order, position, casualties |
| `inspect_structure` | One base: build progress, yield, supply route |
| `inspect_cell` | Terrain, height, occupants and cover at a map cell |
| `inspect_contact` | What is known about a sighted enemy formation |
| `read_alerts` | The dispatch feed |
| `list_rules` | The current order book |
| `recruit` | Raise infantry, cavalry or artillery at a connected base |
| `build_fob` | Site a forward redoubt |
| `bind`, `unbind`, `rename_binding` | Regroup and name formations |
| `issue` | Give a formation a standing order |
| `add_rule`, `update_rule`, `remove_rule` | Edit the order book |
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
| <kbd>V</kbd> <kbd>H</kbd> <kbd>A</kbd> | March, hold, attack |
| <kbd>G</kbd> <kbd>C</kbd> <kbd>F</kbd> <kbd>R</kbd> | Bombard, charge, fall back, reserve |
| <kbd>B</kbd> <kbd>E</kbd> | Site a redoubt, centre on headquarters |
| <kbd>P</kbd> <kbd>Space</kbd> <kbd>M</kbd> | Pause, pause, mute |
| <kbd>1</kbd>-<kbd>4</kbd> | Game speed |
| <kbd>Esc</kbd> | Cancel the pending order, then the selection |
| Wheel | Zoom. Middle-drag or the arrow keys to pan |

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
