// Procedural low-poly vehicle models in a Kenney-like style (Kenney's kits have no train, aircraft
// or ferry). Conventions match the Kenney car kit: front on +Z, left on +X, up on +Y, ~2.75 units long.
import * as THREE from 'three';

const mat = (color: THREE.ColorRepresentation, opts: Partial<THREE.MeshStandardMaterialParameters> = {}) =>
  new THREE.MeshStandardMaterial({ color, roughness: 0.55, metalness: 0.05, flatShading: true, ...opts });

const WHITE = mat('#f4f6f8');
const GLASS = mat('#1c2a3a', { roughness: 0.25, metalness: 0.3 });
const GREY = mat('#8a94a0');
const DARK = mat('#2a2f36');
const RED_BOTTOM = mat('#9e2b25');

function box(w: number, h: number, l: number, m: THREE.Material, x = 0, y = 0, z = 0) {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, l), m);
  mesh.position.set(x, y, z);
  return mesh;
}

/** Side profile (in the ZY plane) extruded across the width → a body with a shaped nose. */
function profileBody(profile: [number, number][], width: number, m: THREE.Material) {
  const shape = new THREE.Shape(profile.map(([z, y]) => new THREE.Vector2(z, y)));
  const g = new THREE.ExtrudeGeometry(shape, { depth: width, bevelEnabled: false });
  g.translate(0, 0, -width / 2);
  g.rotateY(-Math.PI / 2); // shape X → +Z (forward), extrusion → X (width)
  return new THREE.Mesh(g, m);
}

function wheelSet(zs: number[], halfW: number, r = 0.26, y = 0.26) {
  const g = new THREE.Group();
  const geo = new THREE.CylinderGeometry(r, r, 0.18, 12).rotateZ(Math.PI / 2);
  for (const z of zs)
    for (const x of [-halfW, halfW]) {
      const w = new THREE.Mesh(geo, DARK);
      w.position.set(x, y, z);
      w.name = 'wheel';
      g.add(w);
    }
  return g;
}

export function coach(color: string): THREE.Group {
  const g = new THREE.Group();
  const livery = mat(color);
  g.add(box(1.25, 1.2, 2.75, WHITE, 0, 0.85, 0));
  g.add(box(1.27, 0.42, 2.45, GLASS, 0, 1.1, -0.1)); // side windows band
  g.add(box(1.1, 0.5, 0.05, GLASS, 0, 1.05, 1.38)); // windscreen
  g.add(box(1.27, 0.16, 2.76, livery, 0, 0.55, 0)); // stripe
  g.add(box(1.1, 0.12, 2.3, GREY, 0, 1.51, -0.1)); // roof unit
  g.add(wheelSet([0.85, -0.85], 0.56));
  return g;
}

/** One train car. `lead` cars get a sloped nose facing +Z (`tail` mirrors it). */
export function trainCar(color: string, kind: 'lead' | 'middle' | 'tail'): THREE.Group {
  const g = new THREE.Group();
  const livery = mat(color);
  const L = 2.7, H = 1.05, W = 1.0;
  const nose: [number, number][] = [
    [-L / 2, 0.25],
    [L / 2 - 0.55, 0.25],
    [L / 2, 0.45],
    [L / 2, 0.75],
    [L / 2 - 0.5, H + 0.25],
    [-L / 2, H + 0.25],
  ];
  const flat: [number, number][] = [
    [-L / 2, 0.25],
    [L / 2, 0.25],
    [L / 2, H + 0.25],
    [-L / 2, H + 0.25],
  ];
  const body = profileBody(kind === 'middle' ? flat : nose, W, WHITE);
  if (kind === 'tail') body.rotation.y = Math.PI;
  g.add(body);
  g.add(box(W + 0.02, 0.28, L - 0.7, GLASS, 0, 0.95, kind === 'lead' ? -0.2 : kind === 'tail' ? 0.2 : 0));
  g.add(box(W + 0.02, 0.12, L - 0.05, livery, 0, 0.6, 0));
  g.add(box(0.6, 0.08, L * 0.8, GREY, 0, H + 0.29, 0));
  g.add(box(0.8, 0.2, 0.5, DARK, 0, 0.15, L / 2 - 0.45), box(0.8, 0.2, 0.5, DARK, 0, 0.15, -L / 2 + 0.45)); // bogies
  if (kind !== 'middle') {
    const lights = box(0.7, 0.08, 0.04, mat('#fff3c4', { emissive: '#ffd27a', emissiveIntensity: 0.6 }), 0, 0.5, L / 2 + 0.01);
    if (kind === 'tail') lights.position.z = -L / 2 - 0.01;
    g.add(lights);
  }
  return g;
}

export function aircraft(color: string, kind: 'prop' | 'jet' | 'wide'): THREE.Group {
  const g = new THREE.Group();
  const livery = mat(color);
  const r = kind === 'wide' ? 0.3 : 0.23;
  const len = 2.5;
  const fus = new THREE.Mesh(new THREE.CylinderGeometry(r, r, len * 0.72, 14).rotateX(Math.PI / 2), WHITE);
  fus.position.set(0, 0.6, 0.05);
  const nose = new THREE.Mesh(new THREE.SphereGeometry(r, 14, 10, 0, Math.PI * 2, 0, Math.PI / 2).rotateX(Math.PI / 2), WHITE);
  nose.scale.set(1, 1, 1.5);
  nose.position.set(0, 0.6, 0.05 + len * 0.36);
  const tail = new THREE.Mesh(new THREE.ConeGeometry(r, len * 0.28, 14).rotateX(-Math.PI / 2), WHITE);
  tail.position.set(0, 0.6 + r * 0.3, 0.05 - len * 0.36 - len * 0.14);
  const cockpit = box(r * 1.2, r * 0.35, 0.18, GLASS, 0, 0.6 + r * 0.55, 0.05 + len * 0.36 + 0.05);
  g.add(fus, nose, tail, cockpit);
  // cheatline
  g.add(box(r * 2.02, r * 0.3, len * 0.7, livery, 0, 0.6 - r * 0.1, 0.05));

  // Wings: swept planform extruded thin.
  const span = kind === 'wide' ? 3.1 : kind === 'jet' ? 2.7 : 2.8;
  const sweep = kind === 'prop' ? 0.05 : 0.45;
  const chord = kind === 'wide' ? 0.62 : 0.5;
  const wingShape = new THREE.Shape([
    new THREE.Vector2(-span / 2, -sweep - chord * 0.5),
    new THREE.Vector2(-span / 2, -sweep - chord * 0.1),
    new THREE.Vector2(0, chord * 0.55),
    new THREE.Vector2(span / 2, -sweep - chord * 0.1),
    new THREE.Vector2(span / 2, -sweep - chord * 0.5),
    new THREE.Vector2(0, -chord * 0.35),
  ]);
  const wingGeo = new THREE.ExtrudeGeometry(wingShape, { depth: 0.05, bevelEnabled: false }).rotateX(Math.PI / 2);
  const wings = new THREE.Mesh(wingGeo, WHITE);
  wings.position.set(0, kind === 'prop' ? 0.6 + r * 0.9 : 0.6 - r * 0.4, 0.15);
  g.add(wings);

  // Tailplane and fin (fin in livery colour).
  const tpShape = new THREE.Shape([
    new THREE.Vector2(-0.55, -0.25),
    new THREE.Vector2(0, 0.12),
    new THREE.Vector2(0.55, -0.25),
    new THREE.Vector2(0.55, -0.4),
    new THREE.Vector2(-0.55, -0.4),
  ]);
  const tp = new THREE.Mesh(new THREE.ExtrudeGeometry(tpShape, { depth: 0.04, bevelEnabled: false }).rotateX(Math.PI / 2), WHITE);
  tp.position.set(0, 0.62 + (kind === 'prop' ? 0.55 : 0.05), -len * 0.5);
  const finShape = new THREE.Shape([
    new THREE.Vector2(0, 0),
    new THREE.Vector2(-0.55, 0),
    new THREE.Vector2(-0.75, 0.62),
    new THREE.Vector2(-0.45, 0.62),
  ]);
  const fin = new THREE.Mesh(new THREE.ExtrudeGeometry(finShape, { depth: 0.05, bevelEnabled: false }).rotateY(-Math.PI / 2), livery);
  fin.position.set(0.025, 0.6 + r * 0.6, -len * 0.3);
  g.add(tp, fin);

  // Engines.
  const engGeo = new THREE.CylinderGeometry(0.1, 0.12, 0.45, 12).rotateX(Math.PI / 2);
  const xs = kind === 'wide' ? [0.55, 1.05] : [0.7];
  for (const x of xs)
    for (const sx of [-1, 1]) {
      const e = new THREE.Mesh(engGeo, kind === 'prop' ? WHITE : GREY);
      const zOff = kind === 'prop' ? 0.35 : 0.3 - x * sweep * 0.7;
      e.position.set(sx * x, kind === 'prop' ? 0.6 + r * 0.9 : 0.6 - r * 0.9, zOff);
      g.add(e);
      if (kind === 'prop') {
        const prop = new THREE.Mesh(
          new THREE.CircleGeometry(0.28, 16),
          new THREE.MeshBasicMaterial({ color: '#223', transparent: true, opacity: 0.25, side: THREE.DoubleSide, depthWrite: false }),
        );
        prop.position.set(sx * x, e.position.y, zOff + 0.24);
        prop.name = 'propeller';
        g.add(prop);
      }
    }
  return g;
}

export function ship(color: string): THREE.Group {
  const g = new THREE.Group();
  const livery = mat(color);
  // Hull: top-view outline with a pointed bow, extruded upwards.
  const hullShape = new THREE.Shape([
    new THREE.Vector2(-0.55, -1.35),
    new THREE.Vector2(0.55, -1.35),
    new THREE.Vector2(0.58, 0.6),
    new THREE.Vector2(0, 1.4),
    new THREE.Vector2(-0.58, 0.6),
  ]);
  const hullGeo = (depth: number) => new THREE.ExtrudeGeometry(hullShape, { depth, bevelEnabled: false }).rotateX(-Math.PI / 2);
  const bottom = new THREE.Mesh(hullGeo(0.18), RED_BOTTOM);
  const hull = new THREE.Mesh(hullGeo(0.32), mat('#1d3f6e'));
  hull.position.y = 0.18;
  const deck = new THREE.Mesh(hullGeo(0.03), mat('#d9d2c3'));
  deck.position.y = 0.5;
  deck.scale.set(0.96, 1, 0.97);
  g.add(bottom, hull, deck);
  // Superstructure decks and bridge.
  g.add(box(0.95, 0.3, 1.5, WHITE, 0, 0.68, -0.25));
  g.add(box(1.0, 0.07, 1.5, GLASS, 0, 0.72, -0.25));
  g.add(box(0.85, 0.28, 1.15, WHITE, 0, 0.97, -0.3));
  g.add(box(0.87, 0.06, 1.15, GLASS, 0, 1.0, -0.3));
  g.add(box(0.9, 0.2, 0.35, WHITE, 0, 1.2, 0.12));
  g.add(box(0.92, 0.07, 0.36, GLASS, 0, 1.22, 0.13));
  const funnel = box(0.3, 0.42, 0.34, livery, 0, 1.33, -0.75);
  const funnelTop = box(0.31, 0.08, 0.35, DARK, 0, 1.58, -0.75);
  g.add(funnel, funnelTop);
  // Wake (scaled with speed by the vehicle layer).
  const wake = new THREE.Mesh(
    new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2).translate(0, 0.02, -0.5),
    new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      uniforms: { uStrength: { value: 1 } },
      vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
      fragmentShader: `uniform float uStrength; varying vec2 vUv;
        void main(){
          float along = 1.0 - vUv.y;                 // 1 at the stern, 0 far behind
          float spread = mix(0.15, 0.5, 1.0 - along);
          float d = abs(vUv.x - 0.5);
          float v = smoothstep(spread, spread - 0.12, d) * smoothstep(0.0, 0.6, along);
          gl_FragColor = vec4(1.0, 1.0, 1.0, v * 0.55 * uStrength);
        }`,
    }),
  );
  wake.scale.set(1.6, 1, 3.2);
  wake.position.z = -1.3;
  wake.name = 'wake';
  g.add(wake);
  return g;
}
