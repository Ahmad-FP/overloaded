import {
  ACESFilmicToneMapping, AmbientLight, CanvasTexture, Color, DirectionalLight, DoubleSide,
  Fog, HemisphereLight, InstancedMesh,
  Mesh, MeshBasicMaterial, MeshLambertMaterial, Object3D, PCFSoftShadowMap, PerspectiveCamera,
  PlaneGeometry,
  Raycaster, Scene, SRGBColorSpace, Vector2, Vector3, WebGLRenderer,
} from "three";
import { TILE_M, WATER_LEVEL_M } from "../domain/constants";
import type { Match } from "../domain/match";
import { heightAt } from "../domain/terrain";
import type { Cell, Side, Structure, Unit, WorldMap } from "../domain/types";
import { bakeMap } from "../ui/terrainArt";
import { kits } from "./models";

/**
 * The board, in three dimensions.
 *
 * Not a 3D world — a 3D *board*. The ground is one mesh lifted out of the
 * height field and wearing the painted cartography as its skin, so every hour
 * spent on hypsometric wash, hedgerows and ribbon roads shows up here with the
 * hills actually standing. Everything that moves is a real model on that
 * ground: instanced, flat shaded, and casting a shadow into the same
 * north-west sun the texture was painted for.
 *
 * The camera is fixed in pitch and free in pan and dolly, which is the
 * arrangement every strategy game settles on because it keeps north up and
 * makes distance readable.
 */

const CAM_PITCH = 0.86;
const ZOOM_MIN = 90;
const ZOOM_MAX = 620;

/**
 * How much larger than life the cast stands.
 *
 * A man at life size is a fleck from this height. Every strategy game that
 * shows figures at all draws them well out of scale for exactly this reason:
 * the piece has to be legible, not measurable.
 */
const FIGURE_SCALE = 2.5;

const SIDE_COLOUR: Record<Side | "neutral", number> = {
  player: 0x2f5fa8,
  enemy: 0xa8392c,
  neutral: 0x8a7a52,
};

type Slot = { mesh: InstancedMesh; team: InstancedMesh | null; used: number };
type Prop = { x: number; z: number; spin: number; size: number };

const CAP = { infantry: 420, cavalry: 200, artillery: 60, tree: 2600, house: 320, main: 4, fob: 40, depot: 24 } as const;

export class Board {
  readonly canvas: HTMLCanvasElement;
  readonly renderer: WebGLRenderer;
  readonly scene = new Scene();
  readonly camera = new PerspectiveCamera(38, 1, 4, 2400);

  /** Where the camera looks, in tiles, and how far back it sits, in metres. */
  target = { x: 0, y: 0 };
  distance = 300;

  private world: WorldMap | null = null;
  private ground: Mesh | null = null;
  private veil: Mesh | null = null;
  private water: Mesh | null = null;
  private table: Mesh | null = null;
  private overlay = document.createElement("canvas");
  /** Veil resolution. One number: the canvas and the painter must agree. */
  private readonly veilPx = 12;
  private overlayTexture: CanvasTexture | null = null;
  private slots = new Map<string, Slot>();
  private scenery = { tree: [] as Prop[], house: [] as Prop[] };
  private vision: { seen: Uint8Array; explored: Uint8Array } | null = null;
  private visionStamp = -1;
  private sun = new DirectionalLight(0xfff0d6, 1.15);
  private dummy = new Object3D();
  private tint = new Color();
  private ray = new Raycaster();
  private pointer = new Vector2();
  private projected = new Vector3();

  constructor(host: HTMLElement) {
    this.canvas = document.createElement("canvas");
    this.canvas.className = "board";
    host.append(this.canvas);

    // preserveDrawingBuffer keeps the frame readable after the composite, which
    // is the only way the screenshot harness can tell a drawn board from a
    // cleared one. The cost is one buffer; the alternative is blind QA.
    this.renderer = new WebGLRenderer({
      canvas: this.canvas,
      antialias: true,
      powerPreference: "high-performance",
      preserveDrawingBuffer: true,
    });
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    this.renderer.outputColorSpace = SRGBColorSpace;
    this.renderer.toneMapping = ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.16;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = PCFSoftShadowMap;

    this.scene.background = new Color(0x1a1611);
    this.scene.fog = new Fog(0x1a1611, 640, 1500);

    // The ground texture already carries its own relief and colour, so the
    // lights are here to give the models form, not to relight the painting.
    this.scene.add(new AmbientLight(0xb9c6d8, 0.5));
    this.scene.add(new HemisphereLight(0xdfe8f2, 0x6b6244, 0.5));
    this.sun.position.set(-1, 1.35, -1).multiplyScalar(320);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    this.sun.shadow.bias = -0.0012;
    this.sun.shadow.normalBias = 0.6;
    const frustum = this.sun.shadow.camera;
    frustum.left = -240;
    frustum.right = 240;
    frustum.top = 240;
    frustum.bottom = -240;
    frustum.near = 10;
    frustum.far = 900;
    this.scene.add(this.sun);
    this.scene.add(this.sun.target);
    this.resize();
  }

  resize() {
    const rect = this.canvas.getBoundingClientRect();
    const w = Math.max(1, rect.width);
    const h = Math.max(1, rect.height);
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  get viewW() {
    return this.canvas.clientWidth || 1;
  }

  get viewH() {
    return this.canvas.clientHeight || 1;
  }

  // -- the ground ----------------------------------------------------------

  build(map: WorldMap) {
    if (this.world?.id === map.id && this.ground) return;
    this.world = map;
    for (const node of [this.ground, this.veil, this.water, this.table]) {
      if (!node) continue;
      this.scene.remove(node);
      node.geometry.dispose();
    }

    const wide = map.width * TILE_M;
    const deep = map.height * TILE_M;
    const geometry = new PlaneGeometry(wide, deep, map.width, map.height);
    geometry.rotateX(-Math.PI / 2);
    const position = geometry.getAttribute("position");
    const uv = geometry.getAttribute("uv");
    for (let j = 0; j <= map.height; j += 1) {
      for (let i = 0; i <= map.width; i += 1) {
        const index = j * (map.width + 1) + i;
        // Corner heights, so neighbouring tiles share an edge and the hills
        // come out smooth rather than terraced.
        position.setY(index, heightAt(map, i * TILE_M, j * TILE_M));
        uv.setXY(index, i / map.width, 1 - j / map.height);
      }
    }
    geometry.computeVertexNormals();

    const skin = new CanvasTexture(bakeMap(map, TILE_M).canvas);
    skin.colorSpace = SRGBColorSpace;
    skin.anisotropy = Math.min(8, this.renderer.capabilities.getMaxAnisotropy());
    const ground = new Mesh(geometry, new MeshLambertMaterial({ map: skin }));
    ground.position.set(wide / 2, 0, deep / 2);
    ground.receiveShadow = true;
    this.scene.add(ground);
    this.ground = ground;

    // The veil: territory, supply lines and fog, painted on a copy of the same
    // surface so it hugs every fold of the ground instead of floating over it.
    this.overlay.width = map.width * this.veilPx;
    this.overlay.height = map.height * this.veilPx;
    const texture = new CanvasTexture(this.overlay);
    texture.colorSpace = SRGBColorSpace;
    this.overlayTexture = texture;
    // Unlit: fog and borders are marks on the chart, and a sun that turns dark
    // vellum into bright tan makes unmapped country look like open field.
    const veil = new Mesh(geometry.clone(), new MeshBasicMaterial({
      map: texture,
      transparent: true,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -3,
      polygonOffsetUnits: -3,
    }));
    veil.position.copy(ground.position);
    this.scene.add(veil);
    this.veil = veil;

    const skirt = new PlaneGeometry(wide * 6, deep * 6, 1, 1);
    skirt.rotateX(-Math.PI / 2);
    const table = new Mesh(skirt, new MeshLambertMaterial({ color: 0x241d14 }));
    table.position.set(wide / 2, -3.2, deep / 2);
    table.receiveShadow = true;
    this.scene.add(table);
    this.table = table;

    const surface = new PlaneGeometry(wide, deep, 1, 1);
    surface.rotateX(-Math.PI / 2);
    const water = new Mesh(surface, new MeshLambertMaterial({
      color: 0x2c6f88,
      transparent: true,
      opacity: 0.72,
      side: DoubleSide,
    }));
    water.position.set(wide / 2, WATER_LEVEL_M, deep / 2);
    water.receiveShadow = true;
    this.scene.add(water);
    this.water = water;

    this.buildCast();
    this.dressCountry(map);
    this.target = { x: map.width / 2, y: map.height / 2 };
  }

  private buildCast() {
    for (const slot of this.slots.values()) {
      this.scene.remove(slot.mesh);
      if (slot.team) this.scene.remove(slot.team);
    }
    this.slots.clear();
    const cast = kits();
    for (const [name, cap] of Object.entries(CAP) as Array<[keyof typeof CAP, number]>) {
      const kit = cast[name];
      if (!kit) continue;
      const body = new InstancedMesh(kit.body, new MeshLambertMaterial({ vertexColors: true, flatShading: true }), cap);
      body.castShadow = true;
      body.receiveShadow = true;
      body.count = 0;
      body.frustumCulled = false;
      this.scene.add(body);
      let team: InstancedMesh | null = null;
      if (kit.team.getAttribute("position")) {
        team = new InstancedMesh(kit.team, new MeshLambertMaterial({ flatShading: true }), cap);
        team.castShadow = true;
        team.count = 0;
        team.frustumCulled = false;
        this.scene.add(team);
      }
      this.slots.set(name, { mesh: body, team, used: 0 });
    }
  }

  /** Trees and cottages, placed once from the terrain and never moved again. */
  private dressCountry(map: WorldMap) {
    const woods: Array<{ x: number; z: number; spin: number; size: number }> = [];
    const homes: Array<{ x: number; z: number; spin: number; size: number }> = [];
    let seed = 1337;
    const rnd = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    for (let y = 0; y < map.height; y += 1) {
      for (let x = 0; x < map.width; x += 1) {
        const kind = map.tiles[y * map.width + x];
        if (kind === "woods") {
          const n = 3 + Math.floor(rnd() * 3);
          for (let i = 0; i < n; i += 1) {
            woods.push({
              x: (x + 0.15 + rnd() * 0.7) * TILE_M,
              z: (y + 0.15 + rnd() * 0.7) * TILE_M,
              spin: rnd() * Math.PI * 2,
              size: 0.68 + rnd() * 0.5,
            });
          }
        } else if (kind === "building") {
          homes.push({
            x: (x + 0.5) * TILE_M,
            z: (y + 0.5) * TILE_M,
            spin: Math.round(rnd() * 4) * (Math.PI / 2) + (rnd() - 0.5) * 0.3,
            size: 0.85 + rnd() * 0.4,
          });
        }
      }
    }
    this.scenery.tree = woods;
    this.scenery.house = homes;
    this.settle("tree", woods, map);
    this.settle("house", homes, map);
  }

  private settle(name: string, items: Prop[], map: WorldMap) {
    const slot = this.slots.get(name);
    if (!slot) return;
    const cap = slot.mesh.instanceMatrix.count;
    const explored = this.vision?.explored;
    let used = 0;
    for (const item of items) {
      if (used >= cap) break;
      if (explored) {
        const tx = Math.floor(item.x / TILE_M);
        const ty = Math.floor(item.z / TILE_M);
        if (tx < 0 || ty < 0 || tx >= map.width || ty >= map.height) continue;
        if (!explored[ty * map.width + tx]) continue;
      }
      this.dummy.position.set(item.x, heightAt(map, item.x, item.z), item.z);
      this.dummy.rotation.set(0, item.spin, 0);
      this.dummy.scale.setScalar(item.size);
      this.dummy.updateMatrix();
      slot.mesh.setMatrixAt(used, this.dummy.matrix);
      used += 1;
    }
    slot.mesh.count = used;
    slot.mesh.instanceMatrix.needsUpdate = true;
  }

  /**
   * What the player has seen, handed over before the frame is placed.
   *
   * The board must not draw what the player has no business knowing: an
   * enemy battalion behind the fog, or a village nobody has walked to yet.
   * The overlay computes it once, and both layers read the same answer.
   */
  setVision(vision: { seen: Uint8Array; explored: Uint8Array }, stamp: number) {
    this.vision = vision;
    if (stamp === this.visionStamp || !this.world) return;
    this.visionStamp = stamp;
    this.settle("tree", this.scenery.tree, this.world);
    this.settle("house", this.scenery.house, this.world);
  }

  private knows(map: WorldMap, x: number, z: number, field: "seen" | "explored") {
    const vision = this.vision;
    if (!vision) return true;
    const tx = Math.floor(x / TILE_M);
    const ty = Math.floor(z / TILE_M);
    if (tx < 0 || ty < 0 || tx >= map.width || ty >= map.height) return false;
    return vision[field][ty * map.width + tx] === 1;
  }

  // -- camera --------------------------------------------------------------

  /** Metres of ground per screen pixel at the point the camera is looking at. */
  scale() {
    const height = 2 * Math.tan((this.camera.fov * Math.PI) / 360) * this.distance;
    return this.viewH / height;
  }

  centreOn(cell: Cell) {
    this.target = { x: cell.x + 0.5, y: cell.y + 0.5 };
  }

  panBy(dx: number, dy: number) {
    const perPixel = 1 / (this.scale() * TILE_M);
    this.target.x += dx * perPixel;
    this.target.y += dy * perPixel;
  }

  zoomBy(factor: number) {
    this.distance = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, this.distance / factor));
  }

  get zoom() {
    return 260 / this.distance;
  }

  /** Roughly how much ground the frame covers, in tiles. */
  private reach() {
    const half = Math.tan((this.camera.fov * Math.PI) / 360) * this.distance;
    return {
      x: (half * this.camera.aspect) / TILE_M,
      y: half / Math.max(0.35, Math.sin(CAM_PITCH)) / TILE_M,
    };
  }

  /**
   * Hold the view over the field.
   *
   * The same rule the flat board used: the camera may not push the map off
   * the screen, and when the whole field already fits it simply centres. The
   * margin is generous because a raised camera sees the far edge foreshortened
   * and a hard clamp there feels like a wall.
   */
  private clamp(map: WorldMap) {
    const reach = this.reach();
    const marginX = Math.min(reach.x * 1.02, map.width / 2);
    const marginY = Math.min(reach.y * 0.9, map.height / 2);
    this.target.x = Math.max(marginX, Math.min(map.width - marginX, this.target.x));
    this.target.y = Math.max(marginY - reach.y * 0.2, Math.min(map.height - marginY + reach.y * 0.3, this.target.y));
  }

  private aim(map: WorldMap) {
    this.clamp(map);
    const fx = this.target.x * TILE_M;
    const fz = this.target.y * TILE_M;
    const focus = new Vector3(fx, heightAt(map, fx, fz), fz);
    const back = Math.cos(CAM_PITCH) * this.distance;
    const up = Math.sin(CAM_PITCH) * this.distance;
    this.camera.position.set(focus.x, focus.y + up, focus.z + back);
    this.camera.lookAt(focus);
    this.sun.position.set(focus.x - 260, focus.y + 340, focus.z - 260);
    this.sun.target.position.copy(focus);
    this.sun.target.updateMatrixWorld();
  }

  /** Screen pixels for a point on the ground, for the flat overlay to use. */
  project(x: number, y: number, z: number) {
    this.projected.set(x, y, z).project(this.camera);
    return {
      x: (this.projected.x * 0.5 + 0.5) * this.viewW,
      y: (-this.projected.y * 0.5 + 0.5) * this.viewH,
      behind: this.projected.z > 1,
    };
  }

  /** The tile under a screen point, by casting at the ground itself. */
  toCell(px: number, py: number, fractional = false): Cell {
    const map = this.world;
    if (!map || !this.ground) return { x: 0, y: 0 };
    this.pointer.set((px / this.viewW) * 2 - 1, -(py / this.viewH) * 2 + 1);
    this.ray.setFromCamera(this.pointer, this.camera);
    const hit = this.ray.intersectObject(this.ground, false)[0];
    if (!hit) {
      // Past the horizon: fall back to the flat plane through the focus point.
      const dir = this.ray.ray.direction;
      const origin = this.ray.ray.origin;
      const t = dir.y === 0 ? 0 : -origin.y / dir.y;
      const x = (origin.x + dir.x * t) / TILE_M;
      const y = (origin.z + dir.z * t) / TILE_M;
      return fractional ? { x, y } : { x: Math.floor(x), y: Math.floor(y) };
    }
    const x = hit.point.x / TILE_M;
    const y = hit.point.z / TILE_M;
    return fractional ? { x, y } : { x: Math.floor(x), y: Math.floor(y) };
  }

  groundAt(cell: Cell) {
    const map = this.world;
    if (!map) return 0;
    return heightAt(map, (cell.x + 0.5) * TILE_M, (cell.y + 0.5) * TILE_M);
  }

  // -- the frame -----------------------------------------------------------

  sync(match: Match) {
    const map = match.world;
    this.build(map);
    this.aim(map);
    this.placeCast(match);
  }

  private begin() {
    for (const slot of this.slots.values()) {
      if (slot.mesh === this.slots.get("tree")?.mesh || slot.mesh === this.slots.get("house")?.mesh) continue;
      slot.used = 0;
    }
  }

  private add(name: string, x: number, z: number, y: number, spin: number, size: number, side: Side | "neutral") {
    const slot = this.slots.get(name);
    if (!slot) return;
    const cap = slot.mesh.instanceMatrix.count;
    if (slot.used >= cap) return;
    this.dummy.position.set(x, y, z);
    this.dummy.rotation.set(0, spin, 0);
    this.dummy.scale.setScalar(size);
    this.dummy.updateMatrix();
    slot.mesh.setMatrixAt(slot.used, this.dummy.matrix);
    if (slot.team) {
      slot.team.setMatrixAt(slot.used, this.dummy.matrix);
      slot.team.setColorAt(slot.used, this.tint.setHex(SIDE_COLOUR[side]));
    }
    slot.used += 1;
  }

  private placeCast(match: Match) {
    this.begin();
    const map = match.world;
    const figure = FIGURE_SCALE;
    for (const structure of match.structures.values()) {
      const x = (structure.cell.x + 0.5) * TILE_M;
      const z = (structure.cell.y + 0.5) * TILE_M;
      // A work you have walked past stays on the chart; who holds it now is
      // only current where you can still see it.
      if (!this.knows(map, x, z, "explored")) continue;
      // A headquarters should read as one at a glance, not as another cottage.
      const grown = structure.kind === "main" ? 1.55 : structure.kind === "fob" ? 1.2 : 1.1;
      const size = grown * (structure.build < 1 ? 0.55 + structure.build * 0.45 : 1);
      this.add(structure.kind, x, z, heightAt(map, x, z), 0, size, structure.side);
    }
    for (const unit of match.units.values()) {
      if (!unit.alive) continue;
      if (unit.side !== "player" && !this.knows(map, unit.x, unit.z, "seen")) continue;
      this.add(unit.type, unit.x, unit.z, heightAt(map, unit.x, unit.z), unit.heading, figure, unit.side);
    }
    for (const [name, slot] of this.slots) {
      if (name === "tree" || name === "house") continue;
      slot.mesh.count = slot.used;
      slot.mesh.instanceMatrix.needsUpdate = true;
      if (slot.team) {
        slot.team.count = slot.used;
        slot.team.instanceMatrix.needsUpdate = true;
        if (slot.team.instanceColor) slot.team.instanceColor.needsUpdate = true;
      }
    }
  }

  /** Hand the veil canvas out so the overlay can paint fog and borders on it. */
  veilCanvas() {
    return { canvas: this.overlay, pixelsPerTile: this.veilPx };
  }

  veilPainted() {
    if (this.overlayTexture) this.overlayTexture.needsUpdate = true;
  }

  render() {
    this.renderer.render(this.scene, this.camera);
  }

  /** Screen positions for every visible body, for picking and banners. */
  screenOf(unit: Unit) {
    const map = this.world;
    const y = map ? heightAt(map, unit.x, unit.z) : 0;
    return this.project(unit.x, y + 2, unit.z);
  }

  screenOfStructure(structure: Structure) {
    const x = (structure.cell.x + 0.5) * TILE_M;
    const z = (structure.cell.y + 0.5) * TILE_M;
    const map = this.world;
    return this.project(x, (map ? heightAt(map, x, z) : 0) + 14, z);
  }
}

export type { Slot };
