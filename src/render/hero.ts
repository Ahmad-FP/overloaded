import {
  AmbientLight, BackSide, CanvasTexture, DirectionalLight, Fog, LinearFilter, Mesh,
  MeshBasicMaterial, MeshLambertMaterial, PCFSoftShadowMap, PerspectiveCamera,
  PlaneGeometry, RepeatWrapping, Scene, SphereGeometry, WebGLRenderer,
} from "three";
import { kits } from "./models";

/**
 * The title-screen render.
 *
 * A flat gradient behind the setup card said nothing about the game, so this is
 * the game's own geometry staged as a still: a piece in the foreground with its
 * muzzle up into a dawn sky, the fort on the skyline behind it, sun low and
 * behind them both so the parapet and the barrel rim-light.
 *
 * It renders one frame per resize -- a still, not a loop, so it costs nothing
 * to leave up. Every offset below is in metres against the real model bounds
 * (the fort is 25m across and 18.5m tall, the piece 2.8 x 4.8 x 2.0), because
 * eyeballing them once put the camera inside the fort wall.
 */

/** Sky dome UVs put the zenith at v=1 and the nadir at v=0, so the horizon is
 *  the middle row of the texture and the sun sits a touch above it. */
const HORIZON = 0.5;
/** Sun azimuth as a fraction of the dome: matches SUN below. */
const SUN_U = 0.821;
const SUN_V = 0.547;

const sky = () => {
  const canvas = document.createElement("canvas");
  canvas.width = 2048;
  canvas.height = 512;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  const { width: w, height: h } = canvas;

  const wash = ctx.createLinearGradient(0, 0, 0, h);
  for (const [at, tone] of [
    [0, "#060b16"], [0.26, "#101d36"], [0.4, "#24334f"], [0.455, "#4a5165"],
    [0.478, "#8d7a6a"], [0.492, "#c79463"], [0.4995, "#efc489"],
    [HORIZON + 0.0005, "#f7dcae"], [0.512, "#7d6a52"], [0.56, "#40382c"], [1, "#1d1a14"],
  ] as const) wash.addColorStop(at, tone);
  ctx.fillStyle = wash;
  ctx.fillRect(0, 0, w, h);

  // Cloud bank, thin and level, only in the lit half of the sky.
  ctx.filter = "blur(14px)";
  ctx.globalCompositeOperation = "lighter";
  for (const [u, v, rx, ry, alpha] of [
    [0.74, 0.545, 0.15, 0.011, 0.3], [0.86, 0.523, 0.11, 0.008, 0.34],
    [0.66, 0.512, 0.09, 0.006, 0.26], [0.94, 0.508, 0.07, 0.005, 0.2],
    [0.79, 0.578, 0.13, 0.009, 0.15], [0.9, 0.61, 0.1, 0.007, 0.1],
  ] as const) {
    ctx.fillStyle = `rgba(238,198,150,${alpha})`;
    ctx.beginPath();
    ctx.ellipse(u * w, (1 - v) * h, rx * w, ry * h, 0, 0, Math.PI * 2);
    ctx.fill();
  }

  // The sun's own glow, centred on the light's true bearing. Squashed about
  // its own row: a round glow this wide would wash the whole dome grey.
  const cx = SUN_U * w;
  const cy = (1 - SUN_V) * h;
  const squash = 0.13;
  ctx.filter = "none";
  ctx.save();
  ctx.setTransform(1, 0, 0, squash, 0, cy * (1 - squash));
  const glow = ctx.createRadialGradient(cx, cy, 0, cx, cy, 0.34 * w);
  glow.addColorStop(0, "rgba(255,238,198,0.95)");
  glow.addColorStop(0.12, "rgba(255,206,140,0.6)");
  glow.addColorStop(0.4, "rgba(232,158,92,0.24)");
  glow.addColorStop(1, "rgba(232,158,92,0)");
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, w, h / squash);
  ctx.restore();
  ctx.globalCompositeOperation = "source-over";

  const texture = new CanvasTexture(canvas);
  texture.generateMipmaps = false;
  texture.minFilter = LinearFilter;
  texture.magFilter = LinearFilter;
  texture.needsUpdate = true;
  return texture;
};

/** Mottled turf, so the foreground is not one flat sheet of green. */
const turf = () => {
  const canvas = document.createElement("canvas");
  canvas.width = 256;
  canvas.height = 256;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.fillStyle = "#3c452c";
  ctx.fillRect(0, 0, 256, 256);
  ctx.filter = "blur(6px)";
  let seed = 8;
  const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  for (let i = 0; i < 90; i++) {
    const tone = rand();
    ctx.fillStyle = tone > 0.55 ? "rgba(92,98,60,0.5)" : "rgba(44,50,32,0.5)";
    ctx.beginPath();
    ctx.ellipse(rand() * 256, rand() * 256, 8 + rand() * 26, 6 + rand() * 18, rand() * 3, 0, Math.PI * 2);
    ctx.fill();
  }
  const texture = new CanvasTexture(canvas);
  texture.wrapS = RepeatWrapping;
  texture.wrapT = RepeatWrapping;
  texture.repeat.set(26, 26);
  texture.needsUpdate = true;
  return texture;
};

const SUN: readonly [number, number, number] = [-60, 21, -126];

export class Hero {
  private renderer: WebGLRenderer | null = null;
  private scene = new Scene();
  private camera = new PerspectiveCamera(40, 16 / 9, 0.1, 1400);

  constructor(readonly canvas: HTMLCanvasElement) {
    try {
      this.renderer = new WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
    } catch {
      this.renderer = null;
      return;
    }
    this.renderer.setClearColor(0x0a1018, 1);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = PCFSoftShadowMap;
    this.build();
  }

  private build() {
    const cast = kits();
    const work = cast.main;
    const piece = cast.artillery;
    const bough = cast.tree;
    const home = cast.house;
    if (!work || !piece || !bough || !home) return;

    // Haze the colour of the sky just above the glow, so the skyline dissolves.
    this.scene.fog = new Fog(0x6c6f78, 72, 265);

    const dome = new Mesh(
      new SphereGeometry(620, 48, 28),
      new MeshBasicMaterial({ map: sky() ?? undefined, side: BackSide, fog: false }),
    );
    this.scene.add(dome);

    const ground = new Mesh(
      new PlaneGeometry(1400, 1400),
      new MeshLambertMaterial({ color: 0xffffff, map: turf() ?? undefined }),
    );
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    this.scene.add(ground);

    const clay = (geometry: typeof work.body, tint = 0xffffff) =>
      new Mesh(geometry, new MeshLambertMaterial({ color: tint, vertexColors: true }));

    // The fort: 25m across, set back and right so it fills the open half of
    // the frame beside the card, its parapet breaking the horizon.
    const fort = clay(work.body);
    fort.position.set(18, 0, -34);
    fort.rotation.y = -0.5;
    fort.castShadow = true;
    fort.receiveShadow = true;
    this.scene.add(fort);
    const colours = clay(work.team, 0x3f6fbe);
    colours.position.copy(fort.position);
    colours.rotation.copy(fort.rotation);
    this.scene.add(colours);

    // The piece: foreground right, turned three-quarters away and elevated so
    // the barrel crosses the sky. YXZ so the yaw lands before the elevation.
    const gun = clay(piece.body);
    gun.scale.setScalar(1.3);
    gun.position.set(12.6, 0.35, -7.5);
    gun.rotation.order = "YXZ";
    gun.rotation.set(-0.34, 1.06, 0.02);
    gun.castShadow = true;
    this.scene.add(gun);
    // No crew: the team mesh is a bare coat-coloured block that only reads
    // with a figure inside it, and on its own it looks like dropped kit.

    for (const [x, z, s] of [
      [-34, -44, 1.3], [-21, -66, 1.1], [46, -58, 1.2], [-48, -30, 1.05], [58, -84, 1.15],
    ] as const) {
      const tree = clay(bough.body);
      tree.scale.setScalar(s);
      tree.position.set(x, 0, z);
      tree.castShadow = true;
      this.scene.add(tree);
    }

    for (const [x, z, r] of [[-14, -78, 0.6], [-3, -88, -0.3]] as const) {
      const cottage = clay(home.body);
      cottage.position.set(x, 0, z);
      cottage.rotation.y = r;
      cottage.castShadow = true;
      this.scene.add(cottage);
    }

    this.scene.add(new AmbientLight(0x6a6f7d, 1.0));
    const sun = new DirectionalLight(0xffd7a0, 2.6);
    sun.position.set(...SUN);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    sun.shadow.camera.near = 1;
    sun.shadow.camera.far = 320;
    sun.shadow.camera.left = -90;
    sun.shadow.camera.right = 90;
    sun.shadow.camera.top = 90;
    sun.shadow.camera.bottom = -90;
    sun.shadow.bias = -0.0012;
    this.scene.add(sun);
    // Cool fill from the open sky, so the shadowed faces are not black.
    const fill = new DirectionalLight(0xb8b0a2, 0.6);
    fill.position.set(34, 26, 46);
    this.scene.add(fill);

    // Low and close, looking up past the gun to the parapet.
    this.camera.position.set(-2, 2.6, 14);
    this.camera.lookAt(14, 9, -30);
  }

  resize(width: number, height: number) {
    if (!this.renderer) return;
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    this.renderer.setSize(width, height, false);
    this.camera.aspect = Math.max(0.4, width / Math.max(1, height));
    this.camera.updateProjectionMatrix();
    this.renderer.render(this.scene, this.camera);
  }

  /** Free the context when the title screen is done with. */
  dispose() {
    this.renderer?.dispose();
    this.renderer = null;
    this.scene.clear();
    this.scene.background = null;
    this.scene.fog = null;
  }
}
